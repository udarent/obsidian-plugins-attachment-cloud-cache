/**
 * 「从宿主读事实」的查询套件（`src/plugin/notes-query.ts`）。
 *
 * ## 为什么它值得一套穷举
 *
 * `referencedVaultPaths` 是**五处唯一判据之一**：它回答"这份文件还有没有人引用"。
 * 这个答案错了，两个方向都是静默的：
 * - **多算**：用户以为有人引用，于是该清的清不掉（烦，但安全）；
 * - **少算**：占用报告说"没人用"、命令也跳过它，用户看到的数字是错的（更糟）。
 *
 * 它同时是**唯一**一处把"宿主索引 + 我们自己解析正文 + 画布文本"三个来源合并起来的地方，
 * 而每一路都有独立的盲区（属性区 / 行内 HTML / 引用式 / 画布 JSON）。
 * 所以这里按**来源 × 写法**逐格钉住，而不是只测"能返回一个集合"。
 *
 * ⚠️ 两条容易写错的边界：
 * - **带 scheme 的目标不是本地引用**（`https://…/k.png` 不能被当成库里的 `k.png`）——
 *   错认的后果是"那份副本从此清不掉"（验收里真的发生过）；
 * - **同名歧义不收**（`a/x.png` 与 `b/x.png` 都存在时，`[[x.png]]` 不该猜）。
 */

import assert from "node:assert/strict";

function fileOf(path) {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return { path, name, extension: dot > 0 ? name.slice(dot + 1) : "" };
}

/**
 * 最小的宿主替身：只实现 `notes-query` 真正读的那几个口。
 * `disk` 只给 `adapter.exists` 用（用来测"索引滞后、磁盘上有"那一格）。
 */
function makeApp({ files = [], texts = {}, resolvedLinks = {}, disk = [] } = {}) {
	const vaultFiles = files.map(fileOf);
	return {
		vault: {
			getFiles: () => vaultFiles,
			getMarkdownFiles: () => vaultFiles.filter((file) => file.extension === "md"),
			read: async (file) => {
				const text = texts[file.path];
				if (typeof text !== "string") throw new Error(`读不到：${file.path}`);
				return text;
			},
			getAbstractFileByPath: (path) => vaultFiles.find((file) => file.path === path) ?? null,
			adapter: { exists: async (path) => disk.includes(path) },
		},
		metadataCache: { resolvedLinks },
	};
}

export async function runNotesQuerySuite(mod) {
	const { referencedVaultPaths, vaultPathExists } = mod;
	const baseFiles = ["notes/a.md", "img/x.png", "img/y.png"];

	// ============================================================
	// 1. 来源一：宿主的链接索引（`resolvedLinks`）
	// ============================================================
	{
		const app = makeApp({
			files: baseFiles,
			resolvedLinks: { "notes/a.md": { "img/x.png": 1 }, "": { "img/y.png": 1 } },
		});
		const refs = await referencedVaultPaths(app);
		assert.equal(refs.has("img/x.png"), true, "resolvedLinks 里的目标必须算被引用");
		assert.equal(refs.has("img/y.png"), false, "来源路径为空的那种形状不该被收（宿主不会给）");
	}

	// ============================================================
	// 2. 来源二：我们自己解析笔记正文（宿主索引有盲区）
	// ============================================================
	// 五种写法各一格 —— 每一格都是 D-32 之前真的会漏掉的（漏掉 = 判成"没人引用"）。
	const spellings = [
		["正文 wikilink", "图：![[img/x.png]]"],
		["Markdown 图片", "![](img/x.png)"],
		["属性区", "---\ncover: \"[[img/x.png]]\"\n---\n\n正文"],
		["行内 HTML", '<img src="img/x.png">'],
		["引用式定义行", "![alt][r]\n\n[r]: img/x.png"],
	];
	for (const [label, text] of spellings) {
		const app = makeApp({ files: baseFiles, texts: { "notes/a.md": text } });
		const refs = await referencedVaultPaths(app);
		assert.equal(refs.has("img/x.png"), true, `${label}里的引用必须算被引用（否则会被判成没人用）`);
	}

	// ⭐⭐ 带 scheme 的目标**不是**本地引用：库里有 `k.png`，正文写的是别人的 `…/k.png`。
	// 只按短名比会把两者混为一谈 —— 后果是那份本地副本"永远清不掉"。
	{
		const app = makeApp({
			files: ["notes/a.md", "k.png"],
			texts: { "notes/a.md": "![](https://cdn.example.com/k.png)" },
		});
		const refs = await referencedVaultPaths(app);
		assert.equal(refs.has("k.png"), false, "带 scheme 的目标不算本地引用（不能按短名认成库里的 k.png）");
	}

	// ============================================================
	// 3. 来源三：画布文本节点（文本内容，宿主是否索引没有保证）
	// ============================================================
	{
		const canvas = JSON.stringify({ nodes: [{ id: "1", type: "text", text: "![[img/x.png]]" }] });
		const app = makeApp({
			files: [...baseFiles, "boards/b.canvas"],
			texts: { "boards/b.canvas": canvas },
		});
		const refs = await referencedVaultPaths(app);
		assert.equal(refs.has("img/x.png"), true, "画布文本里的引用必须算被引用（R16：画布与笔记同等算数）");
	}

	// 画布读不到 → 跳过，不抛错、也不把"读不到"当成"没有引用"之外的结论。
	{
		const app = makeApp({ files: [...baseFiles, "boards/broken.canvas"] });
		const refs = await referencedVaultPaths(app);
		assert.equal(refs.has("img/x.png"), false, "没有其它来源时，唯一的引用在坏画布里 ⇒ 只能判成没有");
	}

	// ============================================================
	// 4. 同名歧义与两种归一（与改写器同一套）
	// ============================================================
	// 同名歧义：只写短名时不猜（猜错就是改错了别人的链接）。
	{
		const app = makeApp({
			files: ["notes/a.md", "a/x.png", "b/x.png"],
			texts: { "notes/a.md": "![[x.png]]" },
		});
		assert.equal(
			(await referencedVaultPaths(app)).has("a/x.png"),
			false,
			"同名歧义（a/x.png 与 b/x.png）时短名不该被猜成其中任意一个"
		);
	}
	// 写全路径时当然能认。
	{
		const app = makeApp({
			files: ["notes/a.md", "a/x.png", "b/x.png"],
			texts: { "notes/a.md": "![[a/x.png]]" },
		});
		assert.equal((await referencedVaultPaths(app)).has("a/x.png"), true, "写全路径时必须认出是哪一份");
	}
	// 百分号编码（从别处粘来的画布/笔记里很常见）。
	{
		const app = makeApp({
			files: ["notes/a.md", "img/Pasted image.png"],
			texts: { "notes/a.md": "![[img/Pasted%20image.png]]" },
		});
		assert.equal(
			(await referencedVaultPaths(app)).has("img/Pasted image.png"),
			true,
			"百分号编码的目标必须能归一（少认一形＝那份附件永远不被处理）"
		);
	}
	// 表格里转义的竖线：`![[x.png\|600]]` 的那个反斜杠不属于路径。
	{
		const app = makeApp({
			files: baseFiles,
			texts: { "notes/a.md": "| ![[img/x.png\\|600]] |" },
		});
		assert.equal(
			(await referencedVaultPaths(app)).has("img/x.png"),
			true,
			"表格里 `\\|` 的反斜杠不属于路径（带上它就对不上任何文件）"
		);
	}

	// ============================================================
	// 5. 显式传入的正文优先（不再去读宿主）
	// ============================================================
	{
		const app = makeApp({ files: baseFiles });
		const refs = await referencedVaultPaths(app, {
			notes: [{ path: "virtual.md", text: "![[img/x.png]]" }],
		});
		assert.equal(refs.has("img/x.png"), true, "传入 notes 时应直接用它（不依赖宿主的 getMarkdownFiles）");
	}

	// ============================================================
	// 6. `vaultPathExists`：错误默认值的**方向**是不对称的
	// ============================================================
	{
		const app = makeApp({ files: ["img/x.png"] });
		assert.equal(await vaultPathExists(app, "img/x.png"), true, "宿主索引里有 ⇒ 在");
		assert.equal(await vaultPathExists(app, "img/y.png"), false, "两条路都说不存在 ⇒ 才认失效");

		const diskOnly = makeApp({ files: [], disk: ["img/z.png"] });
		assert.equal(await vaultPathExists(diskOnly, "img/z.png"), true, "适配器说在 ⇒ 在（索引可能滞后）");

		const broken = {
			vault: {
				getAbstractFileByPath: () => null,
				adapter: {
					exists: async () => {
						throw new Error("宿主的 exists 抛错");
					},
				},
			},
		};
		assert.equal(
			await vaultPathExists(broken, "img/w.png"),
			true,
			"查询出错必须按「在」处理（误摘记录比多留一条更糟；与 download 的方向相反）"
		);
	}

	return { sources: 3, spellings: spellings.length };
}
