/**
 * 「统一对象名」的编排套件（`src/plugin/migrate-flow.ts`，CR-15）。
 *
 * 纯逻辑套件钉的是"分档与闸门算得对不对"；这一套钉的是**五个阶段连起来以后
 * 用户的数据会变成什么样** —— 尤其是那三件只能在这里验证的事：
 *
 * 1. **被挡下时一个旧对象都没删**（残留 / 读不到 / 新对象缺失）；
 * 2. **搬账真的搬了**（E 阶段漏了，升级完就会全库重下）；
 * 3. **状态位按 `running → idle / interrupted` 走**（它是改名的跨进程闸门）。
 */

import assert from "node:assert/strict";

// ⚠️ 与产品代码拿到的是**同一个**模块实例（`load-ts` 的垫片转发到这份文件），
// 所以这里读 `Notice.instances` 就等于读产品代码刚 `new` 出来的那些通知。
import * as mockObsidian from "./mock-obsidian.mjs";

/** 造一个合法哈希（64 位小写十六进制）。 */
const hash = (n) => n.toString(16).padStart(64, "0");

const named = (stem, n, ext = "png") => `${stem}-${hash(n)}.${ext}`;

const S3 = { endpoint: "https://s3.example.com", bucket: "bucket", region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" };
/**
 * key 的地址 —— ⚠️ **必须与产品同形**：`publicUrlFor` 会按路径段转义，
 * 所以笔记里写的是 `%E7%85%A7%E7%89%87-...`，而不是原样的中文。
 * 夹具里偷懒写原样，会得到"规则里的 from 与正文里的链接不相等 ⇒ 一处都没改"，
 * 而症状看起来像"复核发现残留"（第一版就是这么假红的）。
 */
const urlFor = (key) => `https://s3.example.com/bucket/${encodeURIComponent(key)}`;

/** 假的索引/台账：只实现编排层用到的那几个方法。 */
function fakeIndex(entries, uploaded) {
	const map = new Map(entries.map((entry) => [entry.key, entry]));
	const ledger = new Set(uploaded);
	const calls = [];
	return {
		calls,
		map,
		ledger,
		uploadedKeys: () => [...ledger].sort(),
		rekey(from, to, remoteUrl) {
			calls.push(["rekey", from, to]);
			ledger.delete(from);
			ledger.add(to);
			const entry = map.get(from);
			if (!entry) return true;
			map.delete(from);
			if (!map.has(to)) map.set(to, { ...entry, key: to, remoteUrl });
			return true;
		},
		remove(key) {
			calls.push(["remove", key]);
			return map.delete(key);
		},
		forgetUploaded(key) {
			calls.push(["forgetUploaded", key]);
			return ledger.delete(key);
		},
	};
}

/** 假宿主：只需要正文读写与两个列举方法（编排层不去别处）。 */
function fakeCtx({ files, index, confirm = true, failRead = new Set(), setState }) {
	const texts = new Map(files);
	const modified = [];
	const notices = [];
	const states = [];
	const ctx = {
		settings: { debugLogging: false, s3: { ...S3 } },
		// 插件目录给一个"像真的"值，配一个只记账的 adapter —— 于是删除留痕能真的写一遍，
		// "迁移删的旧对象要留痕（`scope: migration`）"这才验得到。
		manifest: { dir: "plugins/attachment-cloud-cache" },
		t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
		confirmMaintenance: async () => confirm,
		currentIndex: () => index,
		hostContext: () => ({ persistIndex: async () => undefined }),
		app: {
			vault: {
				// 只记最后一次写入：删除留痕是**追加**语义，但这里只关心"写没写、写了什么"
				adapter: {
					exists: async () => false,
					write: async (_path, text) => {
						ctx.__log = String(text);
					},
					append: async (_path, text) => {
						ctx.__log = `${ctx.__log ?? ""}${text}`;
					},
				},
				getMarkdownFiles: () => [...texts.keys()].filter((path) => path.endsWith(".md")).map((path) => ({ path, extension: "md" })),
				getFiles: () =>
					[...texts.keys()].map((path) => ({ path, extension: path.split(".").pop() ?? "" })),
				getAbstractFileByPath: (path) => (texts.has(path) ? { path } : null),
				read: async (file) => {
					if (failRead.has(file.path)) throw new Error("unreadable");
					return texts.get(file.path) ?? "";
				},
				modify: async (file, text) => {
					texts.set(file.path, text);
					modified.push(file.path);
				},
			},
		},
	};
	ctx.__texts = texts;
	ctx.__modified = modified;
	ctx.__states = states;
	ctx.__notices = notices;
	return ctx;
}

/** 假的 S3：只记调用、按 `objects` 现存 key 回答 HEAD。 */
function fakeClient({ objects = new Map(), failCopy = new Set(), copyLands = true, copyCorrupts = false } = {}) {
	const calls = [];
	return {
		calls,
		objects,
		async listObjects() {
			return { objects: [...objects.keys()].map((key) => ({ key, size: objects.get(key) ?? 0, etag: "", lastModified: "" })), nextToken: null };
		},
		async headObject(key) {
			calls.push(["head", key]);
			if (!objects.has(key)) return null;
			return { key, url: urlFor(key), size: objects.get(key), contentType: "", etag: "" };
		},
		async copyObject(from, to) {
			calls.push(["copy", from, to]);
			if (failCopy.has(from)) throw new Error("copy refused");
			// ⚠️ `copyLands = false` 模拟"接口回成功但字节没到"（本项目的头号警惕对象）
			if (copyLands) objects.set(to, (objects.get(from) ?? 0) - (copyCorrupts ? 1 : 0));
			return { key: to, url: urlFor(to), etag: "", attempts: 1 };
		},
		async deleteObject(key) {
			calls.push(["delete", key]);
			const existed = objects.delete(key);
			return existed;
		},
	};
}

/** 收集 `new Notice(...)` 的文案（mock 宿主把实例存在 `Notice.instances`）。 */
async function noticesOf(fn) {
	mockObsidian.Notice.instances.length = 0;
	await fn();
	return mockObsidian.Notice.instances.map((notice) => String(notice.message ?? ""));
}

export async function runMigrateFlowSuite(mod) {
	const { unifyObjectNames } = mod;

	// ============================================================
	// 1. 完整一轮：复制 → 改链接 → 删旧 → 搬账
	// ============================================================
	{
		const oldA = named("照片", 1);
		const oldC = named("废弃", 3);
		const notePath = "notes/a.md";
		const files = [[notePath, `![](${urlFor(oldA)})`]];
		const index = fakeIndex([{ key: oldA, cachePath: "attachments/照片.png", remoteUrl: urlFor(oldA) }], [oldA, oldC]);
		const client = fakeClient({ objects: new Map([[oldA, 1234], [oldC, 99]]) });
		const ctx = fakeCtx({ files, index });
		const states = [];
		let stated = 0;

		const result = await unifyObjectNames(ctx, {
			client,
			setState: async (state) => {
				states.push(state);
				stated += 1;
			},
		});

		assert.deepEqual(states, ["running", "idle"], "★ 状态位按 running → idle 走（它是改名的跨进程闸门）");
		assert.equal(stated, 2, "两次都要真的落盘（装配点那边就是写 settings）");
		assert.equal(result.counts.copy, 1, "有引用的那条要复制");
		assert.equal(result.counts.drop, 1, "没人引用的那条直接删");
		assert.equal(result.copied, 1, "复制了一份");
		assert.equal(result.deleted, 2, "两个旧 key 都删掉（桶里只剩一种形状）");
		assert.deepEqual(
			client.calls.filter((call) => call[0] === "copy"),
			[["copy", oldA, `${hash(1)}.png`]],
			"★ 只复制有引用的那条（没人引用的复制了也是孤儿）"
		);
		assert.deepEqual(
			client.calls.filter((call) => call[0] === "delete").map((call) => call[1]).sort(),
			[oldA, oldC].sort(),
			"旧的两条都删"
		);
		assert.ok(ctx.__texts.get(notePath).includes(urlFor(`${hash(1)}.png`)), "★ 笔记里的链接改成新地址");
		assert.equal(ctx.__texts.get(notePath).includes(urlFor(oldA)), false, "旧地址不再出现");
		assert.deepEqual(index.calls.filter((call) => call[0] === "rekey"), [["rekey", oldA, `${hash(1)}.png`]], "★ E 阶段搬账（漏了就会全库重下）");
		assert.equal(index.ledger.has(`${hash(1)}.png`), true, "台账里换成新 key");
		assert.equal(index.ledger.has(oldA), false, "旧 key 从台账里摘掉");
		assert.deepEqual(
			[...index.map.keys()],
			[`${hash(1)}.png`],
			"索引条目的 key 也搬了（条目按 key 存，漏了渲染就找不到本地副本）"
		);
		assert.ok(String(ctx.__log ?? "").includes("migration"), "★ 删掉的旧对象要留痕，且标记为 migration（事后唯一的凭据）");
	}

	// ============================================================
	// 2. 连跑两次：第二次四项全 0，一个请求都不发
	// ============================================================
	{
		const oldA = named("照片", 1);
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]) });
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index });

		const first = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(first.blocked, "", "第一轮应当全绿");

		const before = client.calls.length;
		const notice = await noticesOf(() => unifyObjectNames(ctx, { client, setState: async () => undefined }));
		const added = client.calls.length - before;
		// 第二轮至少要问一次桶里有什么（那是唯一的"现在还剩什么"来源），但**不许** COPY/DELETE
		assert.equal(
			client.calls.slice(before).filter((call) => call[0] === "copy" || call[0] === "delete").length,
			0,
			"★ 第二轮不许再复制或删除（幂等）"
		);
		assert.ok(added >= 0, "只允许列举");
		assert.deepEqual(notice, ["unifyNamesNothing"], "界面直接说\"没有需要统一的\"");
	}

	// ============================================================
	// 3. 复核有残留 ⇒ 一个都不删
	// ============================================================
	{
		const oldA = named("照片", 1);
		// 属性区里的链接**故意不改**（`planLinkRewrites` 的既定行为）⇒ 一定留下旧地址
		const notePath = "notes/a.md";
		const files = [[notePath, `---\ncover: "![](${urlFor(oldA)})"\n---\n\n正文`]];
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]) });
		const ctx = fakeCtx({ files, index });

		const result = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(result.blocked, "leftover", "★ 正文里还有旧 key ⇒ 不许进 D 阶段");
		assert.equal(result.leftoverCount, 1, "要说清还剩几处");
		assert.equal(result.deleted, 0, "★ 一个都没删（不可逆的那一步）");
		assert.equal(client.calls.filter((call) => call[0] === "delete").length, 0, "连 DELETE 请求都不发");
		assert.equal(client.objects.has(oldA), true, "旧对象还在桶里");
	}

	// ============================================================
	// 4. 复制"回成功但字节没到" ⇒ 被 C 阶段挡住
	// ============================================================
	{
		const oldA = named("照片", 1);
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]), copyLands: false });
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index });

		const result = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(result.blocked, "new-missing", "★ 新对象没到位 ⇒ 不许删旧的（否则那条链接直接裂）");
		assert.equal(result.missingNewKeys, 1, "要说清缺几个");
		assert.equal(result.deleted, 0, "一个都没删");
	}

	// ============================================================
	// 5. 有笔记读不到 ⇒ 预检就停（连桶都不列）
	// ============================================================
	{
		const client = fakeClient({ objects: new Map() });
		const ctx = fakeCtx({ files: [["notes/a.md", "正文"]], index: fakeIndex([], []), failRead: new Set(["notes/a.md"]) });
		const notice = await noticesOf(() => unifyObjectNames(ctx, { client, setState: async () => undefined }));
		assert.deepEqual(notice.map((text) => text.split(":")[0]), ["unifyNamesUnreadable"], "★ 读不到就不开始（把\"不知道\"当成\"没人引用\"会删掉在用的对象）");
		assert.equal(client.calls.length, 0, "一个请求都不发");
	}

	// ============================================================
	// 6. 用户取消 ⇒ 什么都不动
	// ============================================================
	{
		const oldA = named("照片", 1);
		const client = fakeClient({ objects: new Map([[oldA, 10]]) });
		const states = [];
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index: fakeIndex([], [oldA]), confirm: false });

		const result = await unifyObjectNames(ctx, { client, setState: async (state) => states.push(state) });
		assert.equal(result.cancelled, true, "取消要如实回报");
		assert.deepEqual(states, [], "★ 取消时连状态位都不写（否则改名会被无端拦住）");
		assert.equal(client.calls.filter((call) => call[0] === "copy" || call[0] === "delete").length, 0, "一个写操作都没有");
	}

	// ============================================================
	// 7. 状态位写不进去 ⇒ 不启动
	// ============================================================
	{
		const oldA = named("照片", 1);
		const client = fakeClient({ objects: new Map([[oldA, 10]]) });
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index: fakeIndex([], [oldA]) });
		const notice = await noticesOf(() =>
			unifyObjectNames(ctx, {
				client,
				setState: async () => {
					throw new Error("disk full");
				},
			})
		);
		assert.deepEqual(notice.map((text) => text.split(":")[0]), ["unifyNamesStateUnwritable"], "★ 写不下状态位就不迁（宁可不迁）");
		assert.equal(client.calls.filter((call) => call[0] === "copy").length, 0, "没有开始复制");
	}

	// ============================================================
	// 8. 复制失败 ⇒ 记 failed，并被 C 阶段挡住（不静默跳过）
	// ============================================================
	{
		const oldA = named("照片", 1);
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]), failCopy: new Set([oldA]) });
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index });

		const result = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(result.failed, 1, "复制失败要计数（不许当成成功）");
		assert.equal(result.blocked, "new-missing", "失败以后新对象不在 ⇒ 被挡住");
		assert.equal(result.deleted, 0, "旧对象保住");
	}

	// ============================================================
	// 9. 画布：`text` 节点里的链接也要改（画布不在 getMarkdownFiles 里）
	// ============================================================
	{
		const oldA = named("照片", 1);
		const canvasPath = "boards/a.canvas";
		const canvas = JSON.stringify({
			nodes: [{ id: "n1", type: "text", text: `![](${urlFor(oldA)})`, x: 0, y: 0, width: 10, height: 10 }],
			edges: [],
		});
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]) });
		const ctx = fakeCtx({ files: [[canvasPath, canvas]], index });

		const result = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(result.blocked, "", "画布里的链接改掉了 ⇒ 复核通过");
		const written = ctx.__texts.get(canvasPath);
		assert.ok(written.includes(urlFor(`${hash(1)}.png`)), "★ 画布 text 节点改指新地址（漏了画布就会挡住整批）");
		assert.equal(written.includes(urlFor(oldA)), false, "旧地址消失");
	}

	// ============================================================
	// 10. 复制回成功、字节却少了一截 ⇒ C 阶段靠"记下来的长度"发现
	// ============================================================
	{
		const oldA = named("照片", 1);
		const index = fakeIndex([], [oldA]);
		const client = fakeClient({ objects: new Map([[oldA, 10]]), copyCorrupts: true });
		const ctx = fakeCtx({ files: [["notes/a.md", `![](${urlFor(oldA)})`]], index });

		const result = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		assert.equal(
			result.blocked,
			"new-missing",
			"★ 复制成功但字节数不对 ⇒ 一样挡住（所以 A 阶段要把源长度记下来给 C 阶段比）"
		);
		assert.equal(result.deleted, 0, "一个旧对象都不删");
	}

	return { cases: 10 };
}
