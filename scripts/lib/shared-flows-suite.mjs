/**
 * 跨流程共享动作的套件（`src/plugin/shared-flows.ts`）。
 *
 * ## 为什么这三件事必须在一起测
 *
 * 它们各自都是**两条流程共用**的（见模块头）：孤儿询问与云端清理都要留痕、
 * 云端清理与上传都要问"哪些对象仍被引用"、孤儿监视两个入口共用取数口。
 * 共用点的失效是**成对**的：一处错，两条流程同时错，而两条流程的套件各测各的，
 * 谁都可能以为"另一边测过了"。
 *
 * ## 两条最要紧的边界
 *
 * - `cloudReferencedKeys` **读不到必须抛**（不能"就当那篇没有引用"）：
 *   漏掉的那一篇可能正引用着待删对象 ⇒ 候选凭空变大 = **多删**。
 * - `writeDeleteLog` **写失败必须不抛**：删除本身已经完成且不可恢复，
 *   为一个附属功能把主流程炸断，代价完全不成比例。
 */

import assert from "node:assert/strict";

const S3 = {
	endpoint: "https://s3.example.com",
	bucket: "b",
	region: "auto",
	accessKeyId: "AK",
	secretAccessKeyRef: "slot",
	publicUrlBase: "",
	forcePathStyle: true,
};

/** 本存储里某个 key 的公开地址（与 `publicUrlFor` 的形状一致：逐段编码）。 */
function urlFor(key) {
	return `https://s3.example.com/b/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function fileOf(path) {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return { path, name, extension: dot > 0 ? name.slice(dot + 1) : "" };
}

function makeCtx({
	files = [],
	texts = {},
	manifestDir = ".obsidian/plugins/attachment-cloud-cache",
	exists = async () => true,
	appendFails = false,
} = {}) {
	const vaultFiles = files.map(fileOf);
	const calls = { exists: [], append: [], write: [] };
	const ctx = {
		app: {
			vault: {
				getFiles: () => vaultFiles,
				getMarkdownFiles: () => vaultFiles.filter((file) => file.extension === "md"),
				read: async (file) => {
					const text = texts[file.path];
					if (typeof text !== "string") throw new Error(`读不到：${file.path}`);
					return text;
				},
				adapter: {
					exists: async (path) => {
						calls.exists.push(path);
						return exists(path);
					},
					append: async (path, text) => {
						calls.append.push([path, text]);
						if (appendFails) throw new Error("磁盘满");
					},
					write: async (path, text) => {
						calls.write.push([path, text]);
					},
				},
			},
		},
		settings: { s3: S3 },
		manifest: { dir: manifestDir },
		// 与其它套件同一形状：键 + 参数值（不依赖具体语言）
		t: (key, params = {}) =>
			`${key}${Object.keys(params).length ? `(${Object.values(params).join(",")})` : ""}`,
		calls,
	};
	return ctx;
}

export async function runSharedFlowsSuite(mod) {
	const { extractStoredKeys, cloudReferencedKeys, writeDeleteLog } = mod;
	const key = "img/x.png";

	// ============================================================
	// 1. extractStoredKeys：Markdown 正文
	// ============================================================
	{
		const ctx = makeCtx();
		const keys = extractStoredKeys(ctx, "md", `图：![](${urlFor(key)})`);
		assert.equal(keys.has(key), true, "正文里的本存储地址必须换算成 key");
		// 别人的地址（主机不同）不算。
		const other = extractStoredKeys(ctx, "md", "![](https://cdn.example.com/img/x.png)");
		assert.equal(other.size, 0, "不是本存储的地址不该产生 key");
	}

	// ============================================================
	// 2. extractStoredKeys：画布文本节点（JSON 里包着的文本）
	// ============================================================
	{
		const ctx = makeCtx();
		const canvas = JSON.stringify({
			nodes: [{ id: "1", type: "text", text: `![](${urlFor(key)})` }],
		});
		const keys = extractStoredKeys(ctx, "canvas", canvas);
		assert.equal(keys.has(key), true, "画布里的 key 必须能被取出来（否则那份对象被判成没人引用）");

		// ⭐ 这一格才是"必须先解 JSON"的判据：`\/` 在 JSON 里合法，而**原始文本**里
		// `https:\/\/…` 不会被裸 URL 正则认出来 —— 只有先解出 text 字段的字符串才行。
		// （没有这一格，`extractStoredKeys` 的画布分支可以整个删掉而测试照样绿 ——
		// 变异验证当场抓到过。）
		const escaped =
			'{"nodes":[{"id":"1","type":"text","text":"![](https:\\/\\/s3.example.com\\/b\\/img\\/escaped.png)"}]}';
		const escapedKeys = extractStoredKeys(ctx, "canvas", escaped);
		assert.equal(
			escapedKeys.has("img/escaped.png"),
			true,
			"画布里的转义地址必须能被解出来（JSON 的 `\\/` 是合法写法）"
		);
	}

	// ============================================================
	// 3. cloudReferencedKeys：笔记 + 画布两处来源都算
	// ============================================================
	{
		const noteKey = "img/note.png";
		const canvasKey = "img/canvas.png";
		const ctx = makeCtx({
			files: ["notes/a.md", "boards/b.canvas"],
			texts: {
				"notes/a.md": `![](${urlFor(noteKey)})`,
				"boards/b.canvas": JSON.stringify({
					nodes: [{ id: "1", type: "text", text: `![](${urlFor(canvasKey)})` }],
				}),
			},
		});
		const keys = await cloudReferencedKeys(ctx);
		assert.equal(keys.has(noteKey), true, "笔记里引用的对象必须在集合里");
		assert.equal(keys.has(canvasKey), true, "画布里的引用也要算（R16）");
		assert.equal(keys.size, 2, "只该有这两个被引用的对象");
	}

	// ============================================================
	// 4. cloudReferencedKeys：读不到**必须抛**（不许"就当没有"）
	// ============================================================
	{
		const ctx = makeCtx({ files: ["notes/a.md", "notes/broken.md"], texts: { "notes/a.md": "" } });
		await assert.rejects(
			() => cloudReferencedKeys(ctx),
			(error) => String(error.message).includes("cloudCleanupUnreadableNote"),
			"读不到笔记时必须抛错（跳过继续 = 把'不知道'当成'没有引用' ⇒ 可能多删）"
		);
	}
	{
		const ctx = makeCtx({ files: ["notes/a.md", "boards/broken.canvas"], texts: { "notes/a.md": "" } });
		await assert.rejects(
			() => cloudReferencedKeys(ctx),
			(error) => String(error.message).includes("cloudCleanupUnreadableNote"),
			"读不到画布时同样必须抛（与笔记同一条理由）"
		);
	}

	// ============================================================
	// 5. writeDeleteLog：写在哪、写什么、失败怎么处置
	// ============================================================
	const logPath = ".obsidian/plugins/attachment-cloud-cache/.deleted-objects.log";
	{
		const ctx = makeCtx();
		await writeDeleteLog(ctx, []);
		assert.equal(ctx.calls.exists.length + ctx.calls.append.length + ctx.calls.write.length, 0, "空清单不该触发任何写入");
	}
	{
		// 插件目录未知 ⇒ 不写（兜底名会落到 vault 根，跟着同步出去）。
		const ctx = makeCtx({ manifestDir: "" });
		await writeDeleteLog(ctx, [{ key, name: "x.png", outcome: "deleted", scope: "orphan" }]);
		assert.equal(ctx.calls.exists.length, 0, "插件目录未知时不能写（也不该去问 adapter）");
		assert.equal(ctx.calls.append.length + ctx.calls.write.length, 0, "插件目录未知时不能有任何写入");
	}
	{
		// 文件不存在 ⇒ write（不依赖宿主的"append 会建文件"这条假设）。
		const ctx = makeCtx({ exists: async () => false });
		await writeDeleteLog(ctx, [{ key, name: "x.png", outcome: "deleted", scope: "orphan" }]);
		assert.equal(ctx.calls.write.length, 1, "文件不存在时必须 write（append 建文件只是宿主约定，不能依赖）");
		assert.equal(ctx.calls.append.length, 0, "文件不存在时不该 append");
		assert.equal(ctx.calls.write[0][0], logPath, "日志必须写在插件目录下");
		const line = ctx.calls.write[0][1].trim();
		const record = JSON.parse(line);
		assert.equal(record.key, key, "日志行必须带对象 key");
		assert.equal(record.scope, "orphan", "日志行要记走的是哪条入口");
		assert.equal(record.outcome, "deleted", "日志行要记结果");
	}
	{
		// 文件已在 ⇒ append（不覆盖历史记录）。
		const ctx = makeCtx({ exists: async () => true });
		await writeDeleteLog(ctx, [{ key, name: "x.png", outcome: "alreadyGone", scope: "command" }]);
		assert.equal(ctx.calls.append.length, 1, "文件已存在时必须 append（不能覆盖历史）");
		assert.equal(ctx.calls.write.length, 0, "文件已存在时不该 write");
	}
	{
		// 写入失败 ⇒ 不抛（删除已经完成且不可恢复，附属功能不许炸断主流程）。
		const ctx = makeCtx({ exists: async () => true, appendFails: true });
		await writeDeleteLog(ctx, [{ key, name: "x.png", outcome: "deleted", scope: "orphan" }]);
		assert.equal(ctx.calls.append.length, 1, "应该尝试写过（失败也要尝试）");
	}

	return { cases: 10 };
}
