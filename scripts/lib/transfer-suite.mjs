/**
 * 粘贴 / 拖拽判定与执行的断言套件（正式测试与变异验证共用）。
 *
 * ## 为什么判定部分要穷举到"啰嗦"的程度
 *
 * 两种错误的代价极不对称：**漏接管**只是"这张图没上传"（无害），
 * **接管错了**却是"用户的正文/文字/别的文件凭空消失"（不可逆，且没有痕迹）。
 * 所以这里对每个"该不该接管"的边界都单独设一条断言，
 * 而不是抽几个例子看看。
 *
 * ## 执行部分为什么用假编辑器
 *
 * 要验证的是"**插了什么文本**"与"**插到哪里**"，这两件事用一个记录调用的假编辑器
 * 就能精确断言，比接真实编辑器（要 CDP）可靠得多。真机路径留给真机验收阶段。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppMock } from "./mock-obsidian.mjs";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "test-bucket";
const FIXED_NOW = new Date("2026-10-06T05:06:58Z");
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);

/** 造一个文件对象（只要实现 `arrayBuffer`，是真的 `ArrayBuffer` 切片）。 */
function makeFile(name, type, bytes = IMAGE_BYTES, extra = {}) {
	return {
		name,
		type,
		size: bytes.length,
		lastModified: 1,
		async arrayBuffer() {
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
		...extra,
	};
}

/** 造一个"像真实 File 一样"的对象：字段放在**原型 getter** 上，不在自身属性里。 */
function makeProtoFile(name, type, size) {
	class ProtoFile {
		get name() {
			return name;
		}
		get type() {
			return type;
		}
		get size() {
			return size;
		}
		get lastModified() {
			return 1;
		}
		async arrayBuffer() {
			return new Uint8Array([1]).buffer;
		}
	}
	return new ProtoFile();
}

/** 造一个 DataTransfer 载荷。`text` 非空表示剪贴板里还有文本。 */
function makeTransfer({ files = [], items = [], text = null } = {}) {
	return {
		files,
		items,
		getData: (format) => (format === "text/plain" ? (text ?? "") : ""),
	};
}

/** 记录调用的假编辑器。 */
function makeEditor({ withRange = true } = {}) {
	const calls = { selection: [], range: [] };
	const editor = {
		replaceSelection(text) {
			calls.selection.push(text);
		},
	};
	if (withRange) {
		editor.replaceRange = (text, from, to) => {
			calls.range.push({ text, from, to });
		};
	}
	return { editor, calls };
}

/** 收集提示。 */
function makeNotices() {
	const list = [];
	return { list, notify: (message) => list.push(message) };
}

/** 最简的可翻译函数：直接把 key 与占位符拼出来，便于断言"提示里提到了原因"。 */
function makeT() {
	return (key, params = {}) =>
		`${key}${Object.keys(params).length ? `(${Object.values(params).join(",")})` : ""}`;
}

/** 搭一个真实环境（真实磁盘 + 真实 HTTP），用于执行部分。 */
async function makeHarness(mod, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "acc-transfer-"));
	const appMock = createAppMock(root);
	const server = createMockS3({
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: "auto",
		bucket: BUCKET,
		...options.s3,
	});
	const endpoint = await server.start();
	const client = new mod.S3Client(
		{
			endpoint,
			region: "auto",
			bucket: BUCKET,
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			forcePathStyle: true,
		},
		{ transport: nodeTransport(), now: () => FIXED_NOW, sleep: async () => {}, maxAttempts: 1 }
	);

	const settings = {
		...mod.SETTINGS_DEFAULTS,
		...options.settings,
		s3: { ...mod.SETTINGS_DEFAULTS.s3, ...options.settings?.s3 },
	};
	const index = new mod.CacheIndex();
	const notices = makeNotices();

	const deps = {
		settings,
		ingest: (request) => mod.ingestAttachment({ app: appMock.app, settings, client, index, persistIndex: async () => {}, notify: notices.notify, now: () => FIXED_NOW }, request),
		notify: notices.notify,
		t: makeT(),
		// 降级链接的宿主生成器：真机用 `fileManager.generateMarkdownLink`，
		// 替身里那份**不产出 `!`**（与真机实测一致），嵌入与否由链接层按类型表补。
		generatedLocalLink: (vaultPath) => {
			const file = appMock.app.vault.getAbstractFileByPath(vaultPath);
			if (!file) return null;
			return appMock.app.fileManager.generateMarkdownLink(file, "notes/note.md");
		},
		sourcePath: "notes/note.md",
	};

	return {
		root,
		app: appMock.app,
		server,
		deps,
		index,
		notices: notices.list,
		async exists(vaultPath) {
			try {
				await (await import("node:fs/promises")).stat(join(root, ...vaultPath.split("/")));
				return true;
			} catch {
				return false;
			}
		},
		async cleanup() {
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function withHarness(mod, options, fn) {
	const harness = await makeHarness(mod, options);
	try {
		return await fn(harness);
	} finally {
		await harness.cleanup();
	}
}

export async function runTransferSuite(mod) {
	const {
		shouldInterceptPaste,
		shouldInterceptDrop,
		filesFromTransfer,
		isHookableFile,
		fileIdentity,
		buildRemoteLink,
		buildLocalLink,
		displayNameOf,
		processTransfer,
	} = mod;

	const settings = { ...mod.SETTINGS_DEFAULTS };
	const png = () => makeFile("shot.png", "image/png");
	const pdf = () => makeFile("doc.pdf", "application/pdf");

	// ============================================================
	// 1. fileIdentity —— 去重的依据
	// ============================================================
	assert.equal(fileIdentity(png()), fileIdentity(png()), "同名字/大小/类型的文件应得到同一个身份");
	assert.notEqual(fileIdentity(png()), fileIdentity(makeFile("other.png", "image/png")), "不同名字应不同身份");
	assert.notEqual(
		fileIdentity(makeFile("a.png", "image/png", IMAGE_BYTES)),
		fileIdentity(makeFile("a.png", "image/jpeg")),
		"不同类型应不同身份"
	);
	// ⭐ 一个字段都没有时返回 null（表示"别参与去重"）——
	// 否则两个都缺字段的文件会被误判成同一个，于是**少传一张图**
	assert.equal(fileIdentity({}), null, "没有任何可用字段时不该给出身份（免得误合并）");
	assert.equal(fileIdentity({ name: "" }), null, "空名字不算可用字段");
	assert.equal(fileIdentity(null), null);
	assert.equal(fileIdentity(undefined), null);
	assert.equal(fileIdentity("not-a-file"), null, "非对象不该抛错");
	// 有 size 但没名字 → 仍然算有身份
	assert.notEqual(fileIdentity({ size: 1 }), null, "有 size 就足以区分");
	// ⭐⭐ `lastModified` **不属于**"这是哪张图"。
	//
	// 同一个剪贴板条目的两个包装对象（`clipboardData.files[0]` 与 `items[i].getAsFile()`）
	// 是**两个不同的 File**，而宿主给它们的时间戳**不保证相同**
	//（Chromium 那份是调用 `getAsFile()` 时才新建的，时间戳自然是那一刻）。
	// 把它算进身份串，去重就会漏 —— 实测症状是**一次粘贴插入 2~3 条一模一样的外链**
	//（用户报的"复制粘贴图片时出现了两张相同图片"）。
	assert.equal(
		fileIdentity(png()),
		fileIdentity(makeFile("shot.png", "image/png", IMAGE_BYTES, { lastModified: 99 })),
		"★ 时间戳不是身份的一部分：同一张图的两个包装对象必须同身份"
	);

	// ============================================================
	// 2. filesFromTransfer —— 两个来源都要看，并且去重
	// ============================================================
	{
		const a = makeFile("a.png", "image/png");
		const b = makeFile("b.png", "image/png");

		assert.deepEqual(filesFromTransfer(makeTransfer({ files: [a, b] })), [a, b], "常规路径：从 files 取");
		assert.deepEqual(filesFromTransfer(makeTransfer({})), [], "空载荷应得空列表");
		assert.deepEqual(filesFromTransfer(null), [], "null 载荷不该抛错");
		assert.deepEqual(filesFromTransfer(undefined), []);

		// ⭐ 粘贴时某些宿主只在 items 里给文件 —— 只看 files 会整体漏掉
		const fromItems = filesFromTransfer(
			makeTransfer({ items: [{ kind: "file", type: "image/png", getAsFile: () => a }] })
		);
		assert.deepEqual(fromItems, [a], "只有 items 时也要能取到文件");

		// ⭐ 同一个文件同时出现在 files 与 items（两个不同的包装对象）→ 必须去重
		// 否则会**重复上传两次**并在笔记里插入两条链接
		const duplicated = filesFromTransfer(
			makeTransfer({ files: [a], items: [{ kind: "file", type: "image/png", getAsFile: () => ({ ...a }) }] })
		);
		assert.equal(duplicated.length, 1, "同一文件出现在两处时必须去重（否则重复上传 + 插两条链接）");
		assert.equal(duplicated[0], a, "应保留 files 里的那个");

		// ⭐⭐ 去重必须按**内容身份**，不能靠"把对象序列化后比较"。
		// 真实的 `File` 把 name/size/type 都放在**原型**的 getter 上，
		// 所以 `JSON.stringify(file)` 对任何文件都是 `"{}"` —— 用它去重会把
		// **所有**文件都当成同一个，最后只剩第一张。这里用原型 getter 造两个
		// 不同的文件来钉住这一点（用字面量对象造不出来，那正是第一版漏掉的原因）。
		const protoFiles = [
			makeProtoFile("one.png", "image/png", 10),
			makeProtoFile("two.png", "image/png", 20),
		];
		assert.equal(
			JSON.stringify(protoFiles[0]),
			"{}",
			"前置条件：原型 getter 的字段不该出现在 JSON 里（这正是真实 File 的样子）"
		);
		assert.deepEqual(
			filesFromTransfer(makeTransfer({ files: protoFiles })),
			protoFiles,
			"⭐ 两个不同的文件都必须保留 —— 去重不能退化成『按序列化结果比较』，那会把所有文件合成一个"
		);

		// ⭐⭐ 真实剪贴板的形状：`files[0]` 与 `items[0].getAsFile()` 是**两个不同的 File**，
		// 而时间戳可以不同（宿主新建那个对象时取的是"此刻"）。
		// 这一条是用户实测报的场景 —— 一次粘贴，笔记里出现 3 条一模一样的链接。
		// ⚠️ 放在上面那条**之后**：套件是"第一条失败的断言决定报错"，
		// 插到前面会把"去重退化成序列化比较"那条变异的报错换掉（它的 `expect` 就对不上了）。
		const realClipboard = filesFromTransfer(
			makeTransfer({
				files: [makeFile("image.png", "image/png")],
				items: [
					{
						kind: "file",
						type: "image/png",
						getAsFile: () => makeFile("image.png", "image/png", IMAGE_BYTES, { lastModified: 12345 }),
					},
				],
			})
		);
		assert.equal(
			realClipboard.length,
			1,
			`★ 同一张图的两个包装对象（时间戳不同）必须去重 —— 否则一次粘贴插入两条相同链接（实际 ${realClipboard.length} 条）`
		);

		// 非文件类型的 item 要跳过（text/plain 之类）
		assert.deepEqual(
			filesFromTransfer(makeTransfer({ items: [{ kind: "string", type: "text/plain", getAsFile: () => a }] })),
			[],
			"kind 不是 file 的项应跳过"
		);
		// 没有 getAsFile 的 item 要跳过而不是崩
		assert.deepEqual(filesFromTransfer(makeTransfer({ items: [{ kind: "file" }] })), [], "缺少 getAsFile 应跳过");
		// getAsFile 抛错时要能继续（失效条目在真实环境里会出现）
		//
		// ⚠️ 自己 try/catch 并喊出规则：否则实现一旦让它冒出去，
		// 测试会以「条目已失效」失败，而那句话完全没说清"它本该继续处理"。
		let fromThrowingItems;
		try {
			fromThrowingItems = filesFromTransfer(
				makeTransfer({
					items: [
						{
							kind: "file",
							getAsFile: () => {
								throw new Error("条目已失效");
							},
						},
						{ kind: "file", getAsFile: () => a },
					],
				})
			);
		} catch (error) {
			assert.fail(
				`⭐ 某个条目 getAsFile 抛错时必须**继续处理其余条目**，而不是让整次粘贴失败 —— ` +
					`否则用户会看到"图没了"。实际抛出：${error?.message ?? error}`
			);
		}
		assert.deepEqual(fromThrowingItems, [a], "某个条目抛错时后续条目仍要处理");
		// getAsFile 返回 null 时跳过
		assert.deepEqual(
			filesFromTransfer(makeTransfer({ items: [{ kind: "file", getAsFile: () => null }] })),
			[],
			"getAsFile 返回 null 应跳过"
		);
	}

	// ============================================================
	// 3. isHookableFile —— ⭐ 1.1.0 起**任何真实文件**都算（需求 R15）
	//
	// 判据从"类型在用户勾选的清单里"变成"这是个文件"：
	// 用户粘一个文件的意思就是"帮我传上去"，而不是"帮我传上去，但前提是我
	// 二十个字符之前在设置里勾过这个后缀"。所以下面的断言整体**反向**了 ——
	// 以前"不在清单里 ⇒ false"的那些，现在都必须是 true。
	// ============================================================
	assert.equal(isHookableFile(png(), settings), true, "图片当然要处理");
	assert.equal(isHookableFile(pdf(), settings), true, "⭐ PDF 也要处理（类型闸门已移除）");
	assert.equal(isHookableFile(makeFile("noext", ""), settings), true, "没有扩展名的文件也要处理");
	assert.equal(isHookableFile(makeFile("archive.zip", "application/zip"), settings), true, "压缩包同理");
	assert.equal(isHookableFile(makeFile("x.png", "application/octet-stream"), settings), true, "类型不明也处理");
	assert.equal(isHookableFile(makeFile("", ""), settings), true, "连名字都没有（截图粘贴）也处理");
	// 只有"不是文件"的东西才被挡在外面（`accept()` 的整批放行防线守着这条）
	assert.equal(isHookableFile(null, settings), false, "null 不是文件");
	assert.equal(isHookableFile(undefined, settings), false, "undefined 不是文件");
	assert.equal(isHookableFile("a.png", settings), false, "字符串不是文件");

	// ============================================================
	// 4. ⭐ shouldInterceptPaste
	// ============================================================
	const pastePlan = (transfer, overrides = {}) =>
		shouldInterceptPaste(transfer, { ...settings, ...overrides });

	assert.equal(pastePlan(makeTransfer({ files: [png()] })).intercept, true, "单张图粘贴应接管");
	assert.equal(pastePlan(makeTransfer({ files: [png()] })).files.length, 1, "应给出要处理的文件");

	// 开关
	// ⚠️ 这里原本有三条断言（enabled / pasteUpload / dropUpload 各一），现已合并为一条：
	// `enabled` 虽然叫"插件启用"，实现里**只被粘贴/拖拽的拦截读取**，与另外两个完全同义；
	// 而"停用整个插件"由 Obsidian 自己的插件开关提供，不需要我们再造一个。
	assert.equal(
		pastePlan(makeTransfer({ files: [png()] }), { autoUpload: false }).intercept,
		false,
		"关闭自动上传后不该接管粘贴"
	);

	// 没有文件 → 不接管（否则会 preventDefault 掉一次普通粘贴，把内容吞掉）
	assert.equal(pastePlan(makeTransfer({})).intercept, false, "没有文件时绝不能接管");
	assert.equal(pastePlan(makeTransfer({ text: "一段文字" })).intercept, false, "纯文字粘贴不该接管");
	assert.equal(
		pastePlan(makeTransfer({})).intercept === false && pastePlan(makeTransfer({})).files.length === 0,
		true,
		"不接管时不应给出任何文件（调用方据此保证不会误插内容）"
	);

	// ⭐ 剪贴板里同时有文本 → 不接管（用户可能在粘文字，抢过来会丢文字）
	assert.equal(
		pastePlan(makeTransfer({ files: [png()], text: "hello" })).intercept,
		false,
		"⭐ 同时有文本时不该接管 —— 抢过来会丢掉那段文字"
	);
	assert.equal(
		pastePlan(makeTransfer({ files: [png()], text: "" })).intercept,
		true,
		"文本为空串时应照常接管（空串不表示用户在粘文字）"
	);

	// ⭐ 1.1.0：混合载荷（图 + PDF）→ **照样整批接管**。
	// 以前这里是"有一个不认识就整批放行"；类型闸门移除之后不再有"不认识"的文件，
	// 这条断言因此反向 —— 它守的是"用户粘什么就传什么"这个新语义。
	assert.equal(
		pastePlan(makeTransfer({ files: [png(), pdf()] })).intercept,
		true,
		"⭐ 混合载荷要整批接管（含 PDF/压缩包/无扩展名）"
	);
	assert.equal(pastePlan(makeTransfer({ files: [pdf()] })).intercept, true, "只粘一个 PDF 也要接管");
	assert.equal(pastePlan(makeTransfer({ files: [png(), makeFile("b.jpg", "image/jpeg")] })).intercept, true, "全是图片应接管");

	// getData 缺失时按"没有文本"处理（否则功能会静默失效）
	const noGetData = { files: [png()] };
	assert.equal(
		pastePlan(noGetData).intercept,
		true,
		"没有 getData 时应按『没有文本』处理，而不是永远不接管"
	);
	const throwingGetData = {
		files: [png()],
		getData: () => {
			throw new Error("读不到");
		},
	};
	assert.equal(pastePlan(throwingGetData).intercept, true, "getData 抛错时同样按『没有文本』处理");

	// ============================================================
	// 5. ⭐ shouldInterceptDrop
	// ============================================================
	const dropPlan = (transfer, overrides = {}) =>
		shouldInterceptDrop(transfer, { ...settings, ...overrides });

	assert.equal(dropPlan(makeTransfer({ files: [png()] })).intercept, true, "外部拖入图片应接管");
	// ⚠️ 与粘贴同理：原本 dropUpload 与 enabled 各一条断言，合并成 autoUpload 后只剩一条。
	// 消息刻意与粘贴那条**不同**：变异只改第一处出现（`String.replace` 的行为），
	// 两条消息若一样，就分不清红的是粘贴那条还是拖拽那条。
	assert.equal(
		dropPlan(makeTransfer({ files: [png()] }), { autoUpload: false }).intercept,
		false,
		"关闭自动上传后不该接管拖拽"
	);

	// ⭐ 库内拖动（拖笔记 / 拖已有附件）**没有 files** → 必须放行
	//
	// ⚠️ 这里除了断言"不接管"，还要断言**原因就是『库内拖动』**：
	// 空载荷本来就会因为"没有可用文件"而不接管，只断言 `intercept === false`
	// 会在这个原因上"对的理由、错的题目"地通过 —— 那样这条断言等于没测到 files 检查。
	const noFilesPlan = dropPlan(makeTransfer({}));
	assert.equal(noFilesPlan.intercept, false, "没有 files 就不接管");
	assert.ok(
		noFilesPlan.reason.includes("库内拖动"),
		`拒绝原因必须点明是『库内拖动』（而不是恰好因为没有可用文件）：${noFilesPlan.reason}`
	);
	assert.equal(
		dropPlan(makeTransfer({ items: [{ kind: "file", type: "image/png", getAsFile: () => png() }] })).intercept,
		false,
		"⭐ 只有 items 没有 files 时同样放行（仍是库内拖动）"
	);
	assert.equal(
		dropPlan(makeTransfer({ text: "notes/other.md" })).intercept,
		false,
		"拖入库内链接文本时不该接管"
	);
	// 混合与"以前不可处理"的文件 —— 现在都要接管
	assert.equal(dropPlan(makeTransfer({ files: [png(), pdf()] })).intercept, true, "混合载荷也要接管");
	assert.equal(dropPlan(makeTransfer({ files: [pdf()] })).intercept, true, "拖入 PDF 同样要接管");

	// ============================================================
	// 6. 链接构造 —— `!` 与否由**可嵌入类型表**决定（不是"是不是图片"）
	// ============================================================
	// 表内类型 ⇒ `![]()`（宿主会渲染成可预览的元素）
	assert.equal(
		buildRemoteLink("https://img.example.com/a.png", "shot.png", "png"),
		"![shot.png](https://img.example.com/a.png)",
		"远端可嵌入文件用 Markdown 图片语法（wikilink 只能指向库内文件）"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a.mp3", "song.mp3", "mp3"),
		"![song.mp3](https://img.example.com/a.mp3)",
		"⭐ 音频也是可嵌入类型 ⇒ 照样 `![]()`（宿主的 embedRegistry 认它）"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a.pdf", "doc.pdf", "pdf"),
		"![doc.pdf](https://img.example.com/a.pdf)",
		"⭐ PDF 同理"
	);
	// 表外/未知 ⇒ 普通链接（一个点得开的链接，而不是一个坏图）
	assert.equal(
		buildRemoteLink("https://img.example.com/a.zip", "pack.zip", "zip"),
		"[pack.zip](https://img.example.com/a.zip)",
		"⭐ 表外类型必须是普通链接 —— 加 `!` 只会得到一个坏图（原则④）"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a.tiff", "scan.tiff", "tiff"),
		"[scan.tiff](https://img.example.com/a.tiff)",
		"⭐ tiff 在宿主里**不可嵌入**（1.14.4 取证）：1.0.x 把它嵌成图，1.1.0 起降级为链接"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a.heic", "p.heic", "heic"),
		"[p.heic](https://img.example.com/a.heic)",
		"⭐ heic 同理（这是对老用户可见的变化，发版说明里写明）"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a.bin", "blob.bin", ""),
		"[blob.bin](https://img.example.com/a.bin)",
		"类型推不出来 ⇒ 普通链接（未知类型一律保守）"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a", "", "png"),
		"![](https://img.example.com/a)",
		"没有显示名时也应是合法语法"
	);
	assert.equal(
		buildRemoteLink("https://img.example.com/a%20b.png", "", "png"),
		"![](https://img.example.com/a%20b.png)",
		"⭐ 百分号编码必须原样保留（再编一次会得到 %25，链接就打不开了）"
	);
	// 显示名里的方括号会破坏语法 → 必须清掉
	assert.equal(
		buildRemoteLink("https://x/a.png", "a]b[c", "png"),
		"![a b c](https://x/a.png)",
		"显示名里的方括号必须清掉，否则会提前闭合 alt、把后面变成正文"
	);
	assert.equal(
		buildRemoteLink("https://x/a.png", "line1\nline2", "png"),
		"![line1 line2](https://x/a.png)",
		"显示名里的换行必须清掉，否则一条链接会被拆成两条"
	);
	// 非字符串显示名不该渲染成 [object Object]，也不该抛错
	let nonStringAlt;
	try {
		nonStringAlt = buildRemoteLink("https://x/a.png", { name: "x" }, "png");
	} catch (error) {
		assert.fail(
			`⭐ 非字符串显示名必须被当成空串，而不是抛错 —— 抛错会让整次插入失败。实际抛出：${error?.message ?? error}`
		);
	}
	assert.equal(nonStringAlt, "![](https://x/a.png)", "非字符串显示名应视为空");
	assert.equal(buildRemoteLink("  https://x/a.png  ", "", "png"), "![](https://x/a.png)", "URL 应去空白");

	// ── 本地链接（降级路径）：宿主生成器 + 我们按表补 `!` ──
	assert.equal(
		buildLocalLink("[[attachments/a.png]]", "attachments/a.png", "png"),
		"![[attachments/a.png]]",
		"⭐ 宿主生成器不产出 `!`（真机实测），嵌入与否由我们按类型表补"
	);
	assert.equal(
		buildLocalLink("[[attachments/a.zip]]", "attachments/a.zip", "zip"),
		"[[attachments/a.zip]]",
		"⭐ 表外类型**不加** `!`：它应当是一个可点开的链接"
	);
	assert.equal(
		buildLocalLink("[a](attachments/a.png)", "attachments/a.png", "png"),
		"![a](attachments/a.png)",
		"宿主按用户的「新链接格式」给出 Markdown 形态时也应被认（形态交回宿主）"
	);
	// ⚠️ 幂等：宿主若某天带上 `!`，我们不能产出 `!![[x]]`（那是坏链接）
	assert.equal(
		buildLocalLink("![[attachments/a.png]]", "attachments/a.png", "png"),
		"![[attachments/a.png]]",
		"⭐ 已有的 `!` 要先剥掉再按表决定 —— `!![[x]]` 在宿主里是坏链接"
	);
	// 拿不到宿主生成器 ⇒ 退回我们自己拼的**普通** wikilink（比什么都不插好）
	assert.equal(
		buildLocalLink(null, "attachments/a.png", "png"),
		"![[attachments/a.png]]",
		"⭐ 取不到 TFile 时要退回保守形态（内容不能丢）"
	);
	assert.equal(buildLocalLink(null, "attachments\\a.zip", "zip"), "[[attachments/a.zip]]", "反斜杠要归一化");
	assert.equal(buildLocalLink("", "/attachments/a.zip", "zip"), "[[attachments/a.zip]]", "前导斜杠要清掉");
	assert.equal(buildLocalLink(null, "", "png"), "", "没有路径时不该产出畸形链接");

	// 显示名 = **原文件名**（含扩展名）：用户要靠它认出"这是哪个文件"
	assert.equal(displayNameOf(makeFile("shot.png", "image/png")), "shot.png", "含扩展名");
	assert.equal(displayNameOf(makeFile("dir/shot.png", "image/png")), "shot.png", "带目录时只取文件名");
	assert.equal(displayNameOf(makeFile("noext", "")), "noext", "没有扩展名时整体作名字");
	assert.equal(displayNameOf(makeFile(".gitignore", "")), ".gitignore", "隐藏文件整体作名字");
	assert.equal(displayNameOf(null), "", "没有文件时给空串");

	// ============================================================
	// 7. ⭐ processTransfer —— 执行部分（真实磁盘 + 真实 HTTP）
	// ============================================================
	// 7a. 成功：插入远端链接、缓存落盘、恰好 1 次 PUT
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const outcome = await processTransfer(h.deps, editor, [makeFile("shot.png", "image/png")]);

		assert.equal(outcome.uploaded, 1, "应上传 1 张");
		assert.equal(outcome.lost, 0, "不应丢任何文件");
		assert.equal(outcome.fallback, 0, "不应走降级");
		assert.equal(h.server.countByMethod("PUT"), 1, "恰好 1 次 PUT");
		assert.equal(h.server.countByMethod("GET"), 0, "不得有任何 GET");

		assert.equal(calls.selection.length, 1, "应插入一次文本（一次撤销就能回退）");
		assert.match(
			calls.selection[0],
			/^!\[shot\.png\]\(http:\/\/127\.0\.0\.1:\d+\/test-bucket\/[0-9a-f]{64}\.png\)$/,
			`插入的应是远端嵌入链接（显示名＝原文件名），实际：${calls.selection[0]}`
		);
		assert.equal(outcome.text, calls.selection[0], "返回的文本应与插入的一致");
		// 缓存文件真的落盘
		const entry = h.index.toArray()[0];
		assert.ok(entry, "索引里应有登记");
		assert.equal(await h.exists(entry.cachePath), true, "缓存副本应真的在磁盘上");
	});

	// 7a2. ⭐⭐ 同一张图在列表里出现两次 → **只插一条链接**。
	//
	// 这是兜底，也是最要紧的一条：即使上游没去掉重复条目，用户也**不该**看到两张一样的图。
	// 判据落在**结果**上（同一份字节 = 同一个 key = 同一个 URL），
	// 所以它不依赖剪贴板的元数据是否一致 —— 那是我们控制不了的东西。
	// ⚠️ 用户实测报的就是这个："复制粘贴图片的时候，发现出现了两张相同图片"。
	await withHarness(mod, {}, async (h) => {
		const { editor } = makeEditor();
		const same = () => makeFile("shot.png", "image/png");
		const outcome = await processTransfer(h.deps, editor, [same(), same()]);

		const lines = outcome.text.split("\n").filter((line) => line !== "");
		assert.equal(lines.length, 1, `★ 同一张图重复出现时只该插一条链接（实际 ${JSON.stringify(outcome.text)}）`);
		assert.equal(h.server.countByMethod("PUT"), 1, "只该上传一次（第二次命中缓存）");
		assert.equal(h.index.size, 1, "索引里也只该有一条记录");
	});

	// 7a3. 反向：**两张不同的图**必须各插一条。
	//
	// ⚠️ 这一条是给上面那条兜底用的：去重若按"名字 + 大小"这种粗口径做，
	// 两张都叫 `image.png` 的图会被合并成一条 —— 那就变成"少插一张"，比重复更坏
	//（用户以为图没粘上）。所以去重只能按**同一份字节**判。
	await withHarness(mod, {}, async (h) => {
		const { editor } = makeEditor();
		const otherBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x99, 0x88]);
		const outcome = await processTransfer(h.deps, editor, [
			makeFile("image.png", "image/png"),
			makeFile("image.png", "image/png", otherBytes),
		]);

		const lines = outcome.text.split("\n").filter((line) => line !== "");
		assert.equal(lines.length, 2, `★ 两张不同的图必须各插一条（实际 ${JSON.stringify(outcome.text)}）`);
		assert.equal(h.index.size, 2, "两张不同内容应当各有一条记录");
	});

	// 7b. 捕获好的插入位置优先于当前位置（上传耗时期间用户可能已经点走）
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const anchor = { from: { line: 3, ch: 0 }, to: { line: 3, ch: 0 } };
		await processTransfer(h.deps, editor, [makeFile("shot.png", "image/png")], anchor);

		assert.equal(calls.range.length, 1, "⭐ 给了插入位置时应使用 replaceRange 插回原位");
		assert.deepEqual(calls.range[0].from, anchor.from, "应插在**同步阶段捕获**的位置");
		assert.equal(calls.selection.length, 0, "不该退回到『当前选区』（那会把图插到用户已经移到的光标处）");
	});
	// 编辑器不支持 replaceRange 时退回 replaceSelection，而不是什么都不插
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor({ withRange: false });
		await processTransfer(h.deps, editor, [makeFile("shot.png", "image/png")], { from: 0, to: 0 });
		assert.equal(calls.selection.length, 1, "没有 replaceRange 时应退回 replaceSelection（内容不能丢）");
	});

	// 7c. ⭐ 上传失败 → 插本地嵌入 + 提示原因（绝不丢图）
	//
	// ⚠️ 断言顺序刻意是"插入行为 → 计数"：若先断言 `fallback === 1`，
	// 那么"降级时不插入"与"降级被记成 lost"两种缺陷都会先在这一句上失败，
	// 报出来是同一句"应走降级" —— 变异验证就分不出到底是哪条规则坏了。
	await withHarness(mod, { s3: { intercept: () => ({ status: 403, code: "AccessDenied" }) } }, async (h) => {
		const { editor, calls } = makeEditor();
		const outcome = await processTransfer(h.deps, editor, [makeFile("shot.png", "image/png")]);

		assert.equal(calls.selection.length, 1, "降级也必须插回内容 —— 否则等于把用户的图吞了");
		assert.equal(
			outcome.text.startsWith("![["),
			true,
			`降级时应插入库内嵌入链接，实际：${outcome.text}`
		);
		// 嵌入链接指向的文件真的存在。
		// ⚠️ 解析时要跳过 `|别名` 那一段 —— 带 alt 的 wikilink 是 `![[path|alt]]`，
		// 直接把整段当路径会得到一个不存在的名字（第一版就是这么写错的）。
		const embedMatch = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(outcome.text);
		assert.ok(embedMatch, `降级插入的应是一个库内嵌入链接，实际：${outcome.text}`);
		assert.equal(
			await h.exists(embedMatch[1]),
			true,
			`降级插入的链接必须指向真实存在的文件，实际指向 ${embedMatch[1]}`
		);
		assert.ok(
			h.notices.some((message) => message.includes("hookUploadFailedKeptLocal")),
			`应提示上传失败并说明已保留本地，实际提示：${JSON.stringify(h.notices)}`
		);
		// 计数放最后
		assert.equal(outcome.lost, 0, "⭐ 降级不等于丢图 —— lost 必须是 0");
		assert.equal(outcome.fallback, 1, "应走降级");
	});

	// 7d. 连字节都读不出来 → 明确报错，且不插入任何东西
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const broken = { name: "broken.png", type: "image/png" }; // 没有 arrayBuffer
		const outcome = await processTransfer(h.deps, editor, [broken]);

		// 先断言"有没有告诉用户"：这是最要紧的性质（用户必须知道有东西没成）
		assert.ok(
			h.notices.some((message) => message.includes("hookLocalFallbackFailed")),
			`这种情况必须明确报错，实际提示：${JSON.stringify(h.notices)}`
		);
		assert.equal(calls.selection.length, 0, "不该插入任何东西（插一个指向不存在文件的链接等于埋雷）");
		assert.equal(outcome.text, "", "没有任何内容可插时不该产出文本");
		assert.equal(outcome.lost, 1, "读不出字节应记为 lost");
	});

	// 7e. ingest 意外抛错 → 收住，后续文件继续处理
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		let call = 0;
		const flaky = {
			...h.deps,
			ingest: async (request) => {
				call += 1;
				if (call === 1) throw new Error("编排层炸了");
				return h.deps.ingest(request);
			},
		};

		// ⚠️ 自己 try/catch 并喊出规则：否则异常一直冒到套件外，
		// 测试会以「编排层炸了」失败 —— 那句话完全没说清"它本该收住"。
		let outcome;
		try {
			outcome = await processTransfer(flaky, editor, [
				makeFile("first.png", "image/png"),
				makeFile("second.png", "image/png"),
			]);
		} catch (error) {
			assert.fail(
				`⭐ 某个文件出错时必须**收住并继续处理其余文件**，而不是让整次粘贴失败 —— ` +
					`一个失败带走整批，用户会以为所有图都丢了。实际抛出：${error?.message ?? error}`
			);
		}

		assert.equal(outcome.uploaded, 1, "⭐ 第二个仍要被处理（一个失败不该让整批都不做）");
		assert.equal(calls.selection.length, 1, "应插入后一个的链接");
		assert.equal(outcome.lost, 1, "第一个应记为 lost");
		assert.ok(h.notices.some((message) => message.includes("hookLocalFallbackFailed")), "必须报错");
	});

	// 7f. 多张**不同内容**的图 → 一次插入、按顺序、内部换行
	// ⚠️ 必须用不同字节：内容寻址下相同字节会命中复用，那是**正确行为**（见 7g）。
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const outcome = await processTransfer(h.deps, editor, [
			makeFile("a.png", "image/png", new Uint8Array([1, 2, 3])),
			makeFile("b.png", "image/png", new Uint8Array([4, 5, 6])),
		]);

		assert.equal(outcome.uploaded, 2, "两张不同内容都应上传");
		assert.equal(outcome.reused, 0, "不同内容不该命中复用");
		assert.equal(calls.selection.length, 1, "⭐ 只插入一次 —— 这样在编辑器里只占一步撤销");
		const lines = calls.selection[0].split("\n");
		assert.equal(lines.length, 2, "两条链接应各占一行");
		assert.ok(lines[0].startsWith("![a.png]("), `第一条应是 a.png，实际 ${lines[0]}`);
		assert.ok(lines[1].startsWith("![b.png]("), `第二条应是 b.png，实际 ${lines[1]}`);
		assert.equal(h.server.countByMethod("PUT"), 2, "两张图应发两次 PUT");
	});

	// 7f-2. 同一批里粘两张**相同内容**的图 → 第二张命中复用，但两条链接都要插入
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const outcome = await processTransfer(h.deps, editor, [
			makeFile("a.png", "image/png", IMAGE_BYTES),
			makeFile("a-copy.png", "image/png", IMAGE_BYTES),
		]);

		assert.equal(outcome.uploaded, 1, "第一张上传");
		assert.equal(outcome.reused, 1, "第二张内容相同 → 复用");
		assert.equal(h.server.countByMethod("PUT"), 1, "相同内容只应发 1 次 PUT");
		assert.equal(calls.selection[0].split("\n").length, 2, "⭐ 两张图都要插入链接（不能因为复用就少插一条）");
	});

	// 7g. 复用的那一张不该再发 PUT（内容寻址在粘贴路径上同样生效）
	await withHarness(mod, {}, async (h) => {
		const { editor } = makeEditor();
		await processTransfer(h.deps, editor, [makeFile("first.png", "image/png")]);
		assert.equal(h.server.countByMethod("PUT"), 1);

		const outcome = await processTransfer(h.deps, editor, [makeFile("again.png", "image/png")]);
		assert.equal(outcome.reused, 1, "同一份内容第二次粘贴应命中复用");
		assert.equal(h.server.countByMethod("PUT"), 1, "⭐ 重复粘贴同一张图不得再发 PUT");
	});

	// 7h. ⭐ 非 ASCII 文件名不得被**双重编码**（P0 验收标准之一）
	//
	// 用 `{filename}` 模板，让中文名真的进入 URL —— 默认模板 `{hash}.{ext}` 里没有文件名，
	// 那样这条断言就测不到编码路径（是个"看着在测其实没测"的假断言）。
	await withHarness(mod, { settings: { s3: { objectKeyTemplate: "{filename}" } } }, async (h) => {
		const { editor, calls } = makeEditor();
		await processTransfer(h.deps, editor, [makeFile("中文 名字.png", "image/png")]);
		const markdown = calls.selection[0];

		// ⚠️ 只检查链接里的 URL 部分：alt 文字里**可以**有空格（它是说明文字），
		// 第一版对着整串断言"不得有裸空格"，于是把合法的 alt 当成了缺陷。
		const urlMatch = /\]\(([^)]*)\)\s*$/.exec(markdown);
		assert.ok(urlMatch, `应能从中解析出 URL，实际：${markdown}`);
		const url = urlMatch[1];

		assert.ok(!url.includes(" "), `URL 里不得有裸空格（会被 Markdown 截断）：${url}`);
		assert.ok(!url.includes("%25"), `⭐ URL 里不得出现二次编码：${url}`);
		assert.ok(
			url.endsWith("/%E4%B8%AD%E6%96%87%20%E5%90%8D%E5%AD%97.png"),
			`⭐ 非 ASCII 与空格必须**恰好编码一次**，实际 ${url}`
		);
		// 服务端解出来的 key 应与写入笔记的那串一致（否则链接指向一个不存在的对象）
		assert.equal(
			h.server.requests[0].key,
			"中文 名字.png",
			"服务端解出的 key 应是原始文件名（编码只发生在 URL 层）"
		);
	});

	// 7i. 空文件列表 → 不插入、不发请求
	await withHarness(mod, {}, async (h) => {
		const { editor, calls } = makeEditor();
		const outcome = await processTransfer(h.deps, editor, []);
		assert.equal(outcome.text, "", "空列表不该产出文本");
		assert.equal(calls.selection.length, 0, "空列表不该插入任何东西");
		assert.equal(h.server.requestCount(), 0, "空列表不该发任何请求");
	});

	return { pasteCases: 18, dropCases: 10, executionCases: 9 };
}
