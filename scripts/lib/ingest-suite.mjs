/**
 * 上传编排（`src/core/ingest.ts`）的断言套件。
 *
 * ## 这套断言为什么必须用**真实磁盘 + 真实 HTTP**
 *
 * 编排层要保证的性质，没有一条能在 mock 层面验证：
 * - 「缓存文件真的落盘了」→ 必须 `stat` 真实文件；
 * - 「上传的字节逐字节一致」→ 必须有一个真实服务端收下并比对；
 * - 「上传失败时字节仍在」→ 必须真的去读那个文件；
 * - 「恰好 1 次 PUT、0 次 GET」→ 必须数真实请求。
 *
 * 所以这里同时接上 `mock-s3`（真实 HTTP，服务端**独立重算**签名）与
 * `mock-obsidian`（真实磁盘 + 可模拟移动端的受限 API）。
 *
 * ## 哈希用**独立实现**算
 *
 * 期望的 key 里含内容哈希。这里用 `node:crypto` 现算，而不是调被测代码的
 * `sha256Hex` —— 后者只能证明"它等于它自己"。顺带这也把
 * 哈希 → key → 缓存路径 这条链整体与一个独立实现对齐了。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppMock } from "./mock-obsidian.mjs";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "test-bucket";
const FIXED_NOW = new Date("2026-10-06T05:06:58Z");

const sha256Hex = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** 刻意包含 0x00 / 0xFF / 非法 UTF-8：文本通道会悄悄改掉这些字节。 */
const HOSTILE_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f, 0xed, 0xfd,
]);

/**
 * 搭一个完整的运行环境：临时 vault（真实磁盘）+ 本地 S3（真实 HTTP）+ 客户端 + 索引。
 *
 * 每次用例都重建，避免互相污染 —— 上一轮吃过"用例之间靠共享状态传递"的苦。
 */
async function makeHarness(mod, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "acc-ingest-"));
	// ⚠️ `createAppMock` 返回的是**包装对象**（`{ app, calls, ... }`），
	// 真正要交给被测代码的是 `.app`。传错这一层会让 `app.fileManager` 变成 undefined，
	// 而报错是一句莫名的 "Cannot read properties of undefined"。
	const harness = createAppMock(root);
	const app = harness.app;

	const server = createMockS3({
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: "auto",
		bucket: BUCKET,
		...options.s3,
	});
	const endpoint = await server.start();

	const sent = [];
	const baseTransport = nodeTransport();
	const client = new mod.S3Client(
		{
			endpoint,
			region: "auto",
			bucket: BUCKET,
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			forcePathStyle: true,
			...options.client,
		},
		{
			transport: async (request) => {
				sent.push(request);
				return baseTransport(request);
			},
			now: () => FIXED_NOW,
			sleep: async () => {},
		}
	);

	const settings = {
		...mod.SETTINGS_DEFAULTS,
		...options.settings,
		s3: { ...mod.SETTINGS_DEFAULTS.s3, ...options.settings?.s3 },
	};

	const index = new mod.CacheIndex();
	const notices = [];
	let persistCount = 0;
	let persistError = null;

	const deps = {
		app,
		settings,
		client,
		index,
		persistIndex: async () => {
			persistCount += 1;
			if (persistError) throw persistError;
		},
		notify: (message) => notices.push(message),
		now: () => FIXED_NOW,
	};

	return {
		root,
		app,
		appCalls: harness.calls,
		server,
		endpoint,
		client,
		settings,
		index,
		deps,
		sent,
		notices,
		get persistCount() {
			return persistCount;
		},
		setPersistError(error) {
			persistError = error;
		},
		/** 磁盘上读文件；不存在返回 null（避免用例里到处写 try/catch）。 */
		async read(vaultPath) {
			try {
				return await readFile(join(root, ...vaultPath.split("/")));
			} catch {
				return null;
			}
		},
		async exists(vaultPath) {
			try {
				await stat(join(root, ...vaultPath.split("/")));
				return true;
			} catch {
				return false;
			}
		},
		async write(vaultPath, data) {
			const abs = join(root, ...vaultPath.split("/"));
			await mkdir(join(abs, ".."), { recursive: true });
			await writeFile(abs, data);
		},
		/** 直接从磁盘删掉（模拟"用户清空了缓存目录"，不经过宿主的 API）。 */
		async remove(vaultPath) {
			await rm(join(root, ...vaultPath.split("/")), { force: true });
		},
		async cleanup() {
			await server.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** 跑一个用 harness 的用例，无论成败都收掉临时资源。 */
async function withHarness(mod, options, fn) {
	const harness = await makeHarness(mod, options);
	try {
		return await fn(harness);
	} finally {
		await harness.cleanup();
	}
}

export async function runIngestSuite(mod) {
	const { ingestAttachment, planLocalCopy } = mod;

	// ============================================================
	// 1. planLocalCopy —— 纯函数，先穷举（它把"用户选了什么"翻译成"我们做什么"）
	//
	// ⚠️ 签名从 (action, cacheEnabled, cachePathUsable) 变成了 (action, cachePathUsable)。
	// 旧签名里 `action: "cache"` + `cacheEnabled: false` 是一个**静默矛盾**组合：
	// 用户选了"移入缓存"，实际得到"原地保留"，而界面上看不出任何异常。
	// 合并成一个 LocalCopyAction 之后，这种状态在类型上就不存在了 ——
	// 所以这里的用例少了一维，而每一维都唯一对应一个结果。
	// ============================================================
	assert.equal(planLocalCopy("trash", true), "trash", "选回收站就是回收站（不留本地副本 ⇒ 离线看不了）");
	assert.equal(planLocalCopy("trash", false), "trash", "回收站与缓存路径能否推导无关");
	assert.equal(planLocalCopy("cache", true), "move-to-cache", "默认组合应搬进缓存");
	assert.equal(planLocalCopy("cache", false), "keep-in-place", "缓存路径不可推导时原地保留（宁可留文件，不丢图）");
	assert.equal(planLocalCopy("keep", true), "keep-in-place", "原地保留就是原地保留");
	// 「三个取值必须产生三个不同结果」这条曾经单独asserted过，现已删除：
	// 上面五条已经逐一把每个取值钉到唯一的结果上，于是"互不相同"是被**蕴含**的，
	// 任何破坏互不相同的改动都会先撞上其中某一条 —— 它永远轮不到自己失败。
	// 一条永远不红的断言就是影子断言，留着只会让"变异全都抓住了"这句话变得不可信。
	// （真正要防的"假选项"由 `isLocalCopyAction("ask") === false` 与选项集断言守着。）
	// 反向守护：不能出现"任何输入都返回 move-to-cache"
	assert.notEqual(planLocalCopy("keep", true), "move-to-cache", "keep 不得被当成 cache");

	// ============================================================
	// 2. 正常路径：上传 → 搬进缓存 → 登记索引
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "photo.png",
			mime: "image/png",
		});

		const expectedHash = sha256Hex(HOSTILE_BYTES);
		const expectedKey = `${expectedHash}.png`;

		assert.equal(result.status, "uploaded", `应上传成功，实际 ${result.status}`);
		assert.equal(result.key, expectedKey, "key 应由**独立算出的**内容哈希决定");
		assert.equal(
			result.remoteUrl,
			`${h.endpoint}/${BUCKET}/${expectedKey}`,
			"远端 URL 应是端点/桶/key（没配 publicUrlBase 时）"
		);
		assert.equal(
			result.localPath,
			`_attachment-cache/${expectedKey}`,
			"默认布局是 mirror，缓存路径应与 key 一一对应"
		);

		// ── 网络：恰好 1 次 PUT、0 次 GET ──
		assert.equal(h.server.countByMethod("PUT"), 1, "上传应当**恰好** 1 次 PUT");
		assert.equal(h.server.countByMethod("GET"), 0, "上传过程里不得有任何 GET");
		assert.equal(h.server.requests[0].signatureOk, true, `服务端独立重算的签名必须通过：${h.server.requests[0].signatureReason}`);
		assert.equal(
			h.server.requests[0].headers["content-type"],
			"image/png",
			"应声明 Content-Type（否则浏览器里是下载而不是显示）"
		);

		// ── 磁盘：缓存文件真的存在，且字节与本地逐字节一致 ──
		const cached = await h.read(result.localPath);
		assert.ok(cached, `缓存文件必须真的落盘：${result.localPath}`);
		assert.equal(Buffer.compare(cached, Buffer.from(HOSTILE_BYTES)), 0, "缓存副本必须与原始字节逐字节一致");
		assert.equal(
			Buffer.compare(h.server.stored(expectedKey), Buffer.from(HOSTILE_BYTES)),
			0,
			"服务端收到的字节必须与原始字节逐字节一致"
		);

		// ── "移动"而不是"复制"：附件目录里不应留下副本 ──
		assert.equal(
			await h.exists("photo.png"),
			false,
			"上传成功后原文件应被**移动**进缓存目录，附件目录里不该留副本"
		);

		// ── 索引登记 ──
		const entry = h.index.get(expectedKey);
		assert.ok(entry, "索引里应登记这条对象");
		assert.equal(entry.cachePath, result.localPath, "索引应记录**真实**的本地副本路径");
		assert.equal(entry.remoteUrl, result.remoteUrl, "索引应记录写入笔记的那个 URL");
		assert.equal(entry.size, HOSTILE_BYTES.length, "索引应记录字节数");
		assert.equal(entry.etag, result.etag, "索引应记录 ETag");
		assert.equal(entry.sourceName, "photo.png", "索引应记录原始文件名（仅用于报告）");
		assert.ok(h.persistCount >= 1, "索引变更后应落盘");

		// ── 索引应能被序列化并原样读回 ──
		const reloaded = mod.CacheIndex.fromJSON(JSON.parse(JSON.stringify(h.index.toJSON())));
		assert.equal(reloaded.skipped.length, 0, "自己写出的索引不该有被丢弃的条目");
		assert.deepEqual(
			reloaded.index.get(expectedKey),
			entry,
			"索引落盘再读回后，条目内容应完全一致"
		);
	});

	// ============================================================
	// 3. 内容寻址：同一份内容重复粘贴 → 跳过上传（零网络请求）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.equal(h.server.countByMethod("PUT"), 1, "第一次应上传");

		// ⚠️ 换个文件名，但内容相同 → 哈希相同 → key 相同
		const second = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "另一个名字.png", mime: "image/png" });
		assert.equal(second.status, "reused", "内容与 URL 都已知时应复用，而不是重新上传");
		assert.equal(second.key, first.key, "同一份内容必须得到同一个 key");
		assert.equal(second.remoteUrl, first.remoteUrl, "复用时 URL 应与首次一致");
		assert.equal(second.localPath, first.localPath, "复用时本地副本路径应一致");
		assert.equal(
			h.server.countByMethod("PUT"),
			1,
			"重复粘贴同一张图**不得**再发 PUT —— 省掉一次可能几十 MB 的上行"
		);
		assert.equal(h.server.countByMethod("GET"), 0, "复用路径上不该有任何下载");
	});

	// ⚠️ 复用的前提是**索引里有记录**，而不是"缓存目录里恰好有个同名文件"。
	// 那个文件可能是同步过来的、或用户手工放进去的 —— 我们并不确定它上传过。
	//
	// 这一条同时记录了一个**刻意的取舍**：目标路径已占用时，实现一律另取序号
	// （`… .png` → `… 1.png`），而**不是**判断"内容相同就直接复用"。
	// 理由：只有当 key 完全由内容决定（模板含 `{hash}` 且不含 `{filename}`/`{date}`）时，
	// "同路径 ⇒ 同内容"才成立；用户可以把模板改成 `{filename}`，那时同路径可能是**不同内容**，
	// 直接复用就等于认错了文件。另取序号的代价只是"索引丢失后重贴同一张图会多一份副本"，
	// 而多出来的那份会被 Phase 6 的"清理未使用缓存"收掉 —— 用一点可回收的空间
	// 换"任何模板下都不会认错文件"，这个交换是划算的。
	await withHarness(mod, {}, async (h) => {
		const key = `${sha256Hex(HOSTILE_BYTES)}.png`;
		const cachePath = `_attachment-cache/${key}`;
		await h.write(cachePath, Buffer.from(HOSTILE_BYTES)); // 只放文件，不登记索引

		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "索引里没有记录时必须真的上传（不能只看文件在不在）");
		assert.equal(h.server.countByMethod("PUT"), 1, "应发出 1 次 PUT");

		// 已存在的那份**不得被改动**
		assert.equal(
			Buffer.compare(await h.read(cachePath), Buffer.from(HOSTILE_BYTES)),
			0,
			"已存在的缓存文件必须原封不动（它可能是同步来的、也可能是用户自己放的）"
		);
		// 新的副本落在缓存目录内的另一个名字下，且内容一致
		assert.ok(
			result.localPath.startsWith("_attachment-cache/"),
			`新副本仍应落在缓存目录里，实际 ${result.localPath}`
		);
		assert.notEqual(result.localPath, cachePath, "目标已占用时应另取序号，绝不覆盖");
		assert.equal(
			Buffer.compare(await h.read(result.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"新副本的字节应与原始内容一致"
		);
		// 索引指向**真实**位置，而不是推导值
		assert.equal(h.index.get(key)?.cachePath, result.localPath, "索引必须记录真实路径");
	});

	// ⭐ 索引里有记录、但本地副本**已被删掉** → 不能复用，必须重新落盘。
	//
	// 这是"缓存可随时删除"这条承诺的直接后果：用户清空了缓存目录，
	// 索引却还在插件目录里。若只看索引就复用，返回的 localPath 会指向一个不存在的文件，
	// 于是笔记里链接有效、但离线渲染找不到本地副本 —— 而且不会报任何错。
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.ok(await h.exists(first.localPath), "先确认副本存在");

		// 模拟"用户清空了缓存目录"
		await h.remove(first.localPath);
		assert.equal(await h.exists(first.localPath), false, "副本已删除");

		const second = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.ok(
			second.status !== "reused" || (await h.exists(second.localPath)),
			`本地副本不在时不得直接复用并返回一个不存在的路径（实际 ${second.status} → ${second.localPath}）`
		);
		assert.equal(
			await h.exists(second.localPath),
			true,
			"⭐ 结果里的 localPath 必须指向**真实存在**的文件 —— 否则离线渲染会静默失效"
		);
		assert.equal(
			Buffer.compare(await h.read(second.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"重建的副本内容应正确"
		);
	});

	// ============================================================
	// 4. ⭐ 上传失败：字节必须留下（"绝不丢图"）
	// ============================================================
	await withHarness(mod, { s3: { intercept: () => ({ status: 403, code: "AccessDenied" }) } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });

		assert.equal(result.status, "fallback", "上传失败应走降级");
		assert.equal(result.remoteUrl, "", "降级时没有远端 URL 可用");
		assert.ok(result.localPath, "⭐ 降级时**必须**给出本地路径 —— 否则用户粘贴的图就没了");
		assert.equal(result.error?.kind, "auth", "应把失败归为鉴权问题");
		assert.equal(h.server.countByMethod("PUT"), 1, "403 不可重试 → 只应发 1 次请求");

		const kept = await h.read(result.localPath);
		assert.ok(kept, `降级的副本必须真的在磁盘上：${result.localPath}`);
		assert.equal(Buffer.compare(kept, Buffer.from(HOSTILE_BYTES)), 0, "降级副本必须与原始字节逐字节一致");

		// 降级时副本留在附件目录（而不是缓存目录）—— 缓存是"可随时删除"的，
		// 把用户唯一的副本放进会被清掉的地方等于埋雷。
		assert.equal(
			result.localPath.includes("_attachment-cache"),
			false,
			"降级副本不应落在缓存目录里（缓存被清理时用户就真的丢了）"
		);

		// 索引不该登记一条没上传成功的记录（否则渲染时会以为远端有这个对象）
		assert.equal(h.index.get(result.key), undefined, "上传失败不得登记索引");

		// 附件目录里确实有那个文件
		assert.equal(await h.exists(result.localPath), true, "附件目录里应有那个文件");
	});

	// 降级路径也要能重试成功（用户改好设置后再粘一次）
	await withHarness(mod, {}, async (h) => {
		const bad = await ingestAttachment(
			{ ...h.deps, client: makeFailingClient(mod, h, 500) },
			{ bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" }
		);
		assert.equal(bad.status, "fallback", "先制造一次失败");
		assert.ok(await h.exists(bad.localPath), "失败后本地有副本");
		const before = h.server.countByMethod("PUT");

		const good = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(good.status, "uploaded", "换回可用客户端后应成功");
		assert.ok(h.server.countByMethod("PUT") > before, "应真的发了 PUT");
		assert.ok(await h.exists(good.localPath), "成功后缓存里有副本");
	});

	// ============================================================
	// 5. ⭐ 同名文件绝不覆盖
	// ============================================================
	// 这是本项目里少数会造成**不可逆**损失的操作：粘贴时若允许覆盖，
	// 用户可能抹掉一个同名的、完全无关的、没有其它副本的文件。
	await withHarness(mod, { settings: { localCopy: "keep" } }, async (h) => {
		const original = Buffer.from("这是我原本就有的文件，绝不能被覆盖");
		await h.write("photo.png", original);

		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });

		assert.equal(result.status, "uploaded");
		assert.notEqual(result.localPath, "photo.png", "目标已占用时必须另取名字，不得覆盖");
		assert.equal(result.localPath, "photo 1.png", "同名策略应是加序号（与宿主自己的行为一致）");

		assert.equal(
			Buffer.compare(await h.read("photo.png"), original),
			0,
			"⭐ 已存在的同名文件必须**原封不动**"
		);
		assert.equal(
			Buffer.compare(await h.read("photo 1.png"), Buffer.from(HOSTILE_BYTES)),
			0,
			"新文件应写到另取的名字下，且内容正确"
		);

		// 再来一次 → 应拿 2
		const again = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(again.status, "reused", "同样的内容第二次应命中索引复用");
		assert.equal(again.localPath, "photo 1.png", "复用的应是上次那份");
		assert.equal(Buffer.compare(await h.read("photo.png"), original), 0, "原文件仍然不能被动到");
	});

	// ============================================================
	// 6. localCopy = keep → 副本留在附件目录，索引指向它
	// ============================================================
	await withHarness(mod, { settings: { localCopy: "keep" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "keep-me.png", mime: "image/png" });
		assert.equal(result.status, "uploaded");
		assert.equal(result.localPath, "keep-me.png", "原地保留就该留在附件目录");
		assert.equal(
			result.localPath.includes("_attachment-cache"),
			false,
			"选「原地保留」时不该往缓存目录里搬"
		);
		assert.ok(await h.exists("keep-me.png"), "文件应真的在那里");
		// 原先是单独一条用例（`cacheEnabled = false` → 原地保留、不建缓存目录）。
		// 那个状态**已经不存在了**：它正是"选了移入缓存却得到原地保留"这个静默矛盾的来源，
		// 合并成单个 `localCopy` 之后，`keep` 是表达"原地保留"的唯一方式。
		// 所以这里把那条断言收进来，而不是让一个已删除的状态继续留在测试里。
		assert.equal(await h.exists("_attachment-cache"), false, "原地保留时不该建出缓存目录");
		assert.equal(
			h.index.get(result.key)?.cachePath,
			"keep-me.png",
			"⭐ 索引要记录**真实**位置 —— 否则离线渲染按 key 推导出的缓存路径会找不到文件"
		);
	});

	// ============================================================
	// 7. localCopy = trash → 不留本地副本，也不登记索引
	// ============================================================
	await withHarness(mod, { settings: { localCopy: "trash" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "temp.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "即使不留本地副本，上传本身要成功");
		assert.equal(result.localPath, "", "回收站处置后本地没有副本");
		assert.equal(await h.exists("temp.png"), false, "暂存的文件应已被移入回收站");
		assert.equal(
			h.index.get(result.key),
			undefined,
			"没有本地副本时不该登记索引（索引的用途是「按 URL 找本地副本」）"
		);
	});

	// ============================================================
	// 8.（已删除）原「cacheEnabled = false → 原地保留」用例
	//
	// 那个状态随参数重设计一起消失了：`cacheEnabled` 与 `localFileAction` 不正交，
	// 二者能组成"选了移入缓存却得到原地保留"的静默矛盾，所以合并成了单个 `localCopy`。
	// 它唯一独有的断言（不建缓存目录）已并入上面的 `localCopy = keep` 用例。
	// 这里保留说明而不是留一个测不到东西的空壳 —— 空壳测试比没有测试更糟，
	// 它会让人以为那个状态仍然存在。
	// ============================================================

	// ============================================================
	// 9. 嵌套 key（{date}/...）→ 缓存目录要按需建出中间层
	// ============================================================
	await withHarness(mod, { settings: { s3: { objectKeyTemplate: "{date}/{hash}.{ext}" } } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "nested.png", mime: "image/png" });
		assert.equal(result.status, "uploaded");
		const expectedKey = `2026-10-06/${sha256Hex(HOSTILE_BYTES)}.png`;
		assert.equal(result.key, expectedKey, "key 应按模板带上日期目录");
		assert.equal(result.localPath, `_attachment-cache/${expectedKey}`, "mirror 布局下缓存路径应与 key 同构");
		assert.ok(await h.exists(result.localPath), "嵌套的缓存文件必须真的落盘（中间目录要能自动建出）");
		assert.equal(
			Buffer.compare(await h.read(result.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"嵌套路径下的缓存副本字节应一致"
		);
		// 服务端存的是带目录的 key
		assert.ok(h.server.stored(expectedKey), "服务端应存下带目录的 key");
	});

	// ============================================================
	// 10. 截图粘贴：没有文件名，靠 MIME 推扩展名
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, mime: "image/png" });
		assert.equal(result.status, "uploaded");
		assert.ok(result.key.endsWith(".png"), `无文件名时应由 MIME 推出扩展名，实际 key=${result.key}`);
		assert.ok(
			h.index.get(result.key)?.sourceName.includes("Pasted image"),
			"无文件名时应造一个可读的名字，方便用户在附件目录里辨认"
		);
		assert.ok(await h.exists(result.localPath), "缓存副本应落盘");
	});

	// ============================================================
	// 11. ⭐ 扩展名完全未知：不得产出以点结尾的 key
	//
	// `{hash}.{ext}` 在 ext 为空时会渲染成 `abc.` —— Windows **会静默丢掉结尾的点**，
	// 于是同一个 key 在 Windows 上变成 `abc`、在别处还是 `abc.`：
	// 缓存文件名与索引记录对不上，且只在部分平台上出现。
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, mime: "application/octet-stream" });
		assert.equal(result.status, "uploaded");
		assert.ok(!result.key.endsWith("."), `key 不得以点结尾（Windows 会丢掉它）：${result.key}`);
		assert.ok(result.key.endsWith(".bin"), `未知类型应兜底成 .bin，实际 ${result.key}`);
		assert.ok(!result.localPath.endsWith("."), "缓存路径同样不得以点结尾");
		// 无扩展名可推时，Content-Type 应是通用二进制类型
		assert.equal(
			h.server.requests[0].headers["content-type"],
			"application/octet-stream",
			"未知类型应声明通用二进制类型"
		);
	});

	// ============================================================
	// 12. publicUrlBase 改了 → 不能复用旧 URL，必须重新上传并更新记录
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "a.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.equal(h.server.countByMethod("PUT"), 1);

		// 用户换了公开域名（例如从直连桶改成挂 CDN）
		const movedClient = new mod.S3Client(
			{
				endpoint: h.endpoint,
				region: "auto",
				bucket: BUCKET,
				accessKeyId: ACCESS_KEY_ID,
				secretAccessKey: SECRET_ACCESS_KEY,
				forcePathStyle: true,
				publicUrlBase: "https://img.example.com",
			},
			{ transport: nodeTransport(), now: () => FIXED_NOW, sleep: async () => {} }
		);
		h.deps.settings.s3.publicUrlBase = "https://img.example.com";

		const second = await ingestAttachment({ ...h.deps, client: movedClient }, {
			bytes: HOSTILE_BYTES,
			name: "a.png",
			mime: "image/png",
		});
		assert.ok(
			second.status === "uploaded" || second.status === "reused",
			`换了公开域名后不应沿用旧 URL，实际状态 ${second.status}`
		);
		assert.equal(
			second.remoteUrl,
			`https://img.example.com/${first.key}`,
			"应使用新的公开地址"
		);
		assert.equal(
			h.index.get(first.key)?.remoteUrl,
			`https://img.example.com/${first.key}`,
			"索引里的 URL 必须同步更新，否则渲染时会按旧域名找不到"
		);
	});

	// ============================================================
	// 13. 索引落盘失败：上传仍算成功，但必须**说出来**
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		h.setPersistError(new Error("磁盘只读"));
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "b.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "索引存不上不该让上传算失败（URL 已经能用了）");
		assert.equal(h.server.countByMethod("PUT"), 1);
		assert.ok(await h.exists(result.localPath), "缓存副本仍然应落盘");
		assert.ok(
			h.notices.some((message) => message.includes("索引")),
			`索引保存失败必须让用户知道，实际提示：${JSON.stringify(h.notices)}`
		);
	});

	// ============================================================
	// 14. 缓存路径不可推导（缓存目录配成空）→ 降级为原地保留，而不是崩
	// ============================================================
	await withHarness(mod, { settings: { cacheFolder: "" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "c.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "缓存路径推导不出来时也要能上传（用户的图不能因为配置怪就传不上去）");
		assert.equal(result.localPath, "c.png", "退化为原地保留");
		assert.ok(await h.exists("c.png"), "文件应留在附件目录");
	});

	// ============================================================
	// 15. 空的字节数组不能崩（粘贴到空内容 / 上游出了岔子）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: new Uint8Array(0), name: "empty.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "零字节也应能走完流程而不抛错");
		assert.equal(result.localPath.length > 0, true, "零字节也该有个本地路径");
		assert.ok(await h.exists(result.localPath), "零字节文件应真的落盘");
	});

	// ============================================================
	// 16. 索引持久化（真实适配器 + 真实磁盘）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const adapter = h.app.vault.adapter;
		const path = mod.indexFilePath(".obsidian/plugins/attachment-cloud-cache");

		// 16a. 文件不存在 → 空索引，且**不算错误**（首次运行是正常状态）
		const missing = await mod.loadCacheIndex(adapter, path);
		assert.equal(missing.existed, false, "首次运行时应报告文件不存在");
		assert.equal(missing.error, "", "文件不存在不是错误");
		assert.equal(missing.index.size, 0);

		// 16b. 存 → 读 往返
		const index = new mod.CacheIndex();
		index.set({
			key: "a.png",
			cachePath: "_attachment-cache/a.png",
			remoteUrl: "https://img.example.com/a.png",
			size: 12,
			contentType: "image/png",
			etag: "abc",
			uploadedAt: FIXED_NOW.toISOString(),
			sourceName: "a.png",
		});
		await mod.saveCacheIndex(adapter, path, index);

		const reloaded = await mod.loadCacheIndex(adapter, path);
		assert.equal(reloaded.error, "", "刚写出的索引应能无错读回");
		assert.equal(reloaded.skipped.length, 0);
		assert.deepEqual(reloaded.index.get("a.png"), index.get("a.png"), "往返后条目应完全一致");
		// 临时文件不得残留
		assert.equal(await h.exists(`${path}.tmp`), false, "原子写入用的临时文件不应残留");

		// 16c. 坏 JSON → 空索引 + 记录原因，绝不抛错（抛错会让插件在启动时挂掉）
		await h.write(path, "{ 这不是合法 JSON");
		const broken = await mod.loadCacheIndex(adapter, path);
		assert.equal(broken.index.size, 0, "坏 JSON 应降级为空索引");
		assert.ok(broken.error.includes("JSON"), `应记录解析失败的原因，实际：${broken.error}`);

		// 16d. 结构合法但条目半坏 → 坏条目丢弃并计数，好条目保留
		await h.write(
			path,
			JSON.stringify({
				version: 1,
				entries: [
					{ key: "good.png", cachePath: "c/good.png" },
					{ key: "no-path.png" },
					{ cachePath: "c/no-key.png" },
					"完全不是对象",
					{ key: "good.png", cachePath: "c/duplicate.png" },
				],
			})
		);
		const partial = await mod.loadCacheIndex(adapter, path);
		assert.equal(partial.index.size, 1, "只应保留唯一那条完整记录");
		assert.ok(partial.index.get("good.png"), "完整的那条应保留");
		assert.equal(partial.index.get("good.png").cachePath, "c/good.png", "重复 key 应保留**先出现**的那条");
		assert.equal(partial.skipped.length, 4, `应记录 4 条被丢弃的条目，实际 ${partial.skipped.length}`);
		assert.ok(
			partial.skipped.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0),
			"每条被丢弃的记录都要给出原因（沉默丢弃等于把问题藏起来）"
		);
	});

	// 16e. 索引文件路径
	assert.equal(
		mod.indexFilePath(".obsidian/plugins/attachment-cloud-cache"),
		".obsidian/plugins/attachment-cloud-cache/.cache-index.json",
		"索引应放在插件目录下（缓存是每设备独立的，跟着 vault 同步会造成跨设备路径错乱）"
	);
	assert.equal(mod.indexFilePath(""), ".cache-index.json", "目录为空时应退化到相对路径而不是抛错");

	return { scenarios: 16 };
}

/** 造一个"总是失败"的客户端，用来构造降级路径。 */
function makeFailingClient(mod, harness, status) {
	const base = nodeTransport();
	return new mod.S3Client(
		{
			endpoint: harness.endpoint,
			region: "auto",
			bucket: BUCKET,
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			forcePathStyle: true,
		},
		{
			transport: async (request) => {
				// 先让真实服务端收下（签名校验照跑），再强行改写成失败响应，
				// 这样失败是"真的经过了网络"，不是凭空造的
				const response = await base(request);
				return { ...response, status, body: new TextEncoder().encode("<Error><Code>InternalError</Code></Error>") };
			},
			now: () => FIXED_NOW,
			sleep: async () => {},
			maxAttempts: 1,
		}
	);
}
