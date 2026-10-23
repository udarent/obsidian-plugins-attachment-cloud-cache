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
	const { referenceSnapshot, referencedVaultPaths, referencesInNote, vaultPathExists } = mod;
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

	// ⭐⭐ 目标里带**成对括号**（`… 4年(1).pdf` 是浏览器给重名下载文件加后缀的常态）。
	// "遇到第一个 `)` 就停"会把它截成 `… 4年(1` ⇒ 与真实文件名对不上 ⇒ 判成"没人引用"，
	// 于是「上传附件」的候选里**根本没有它**（笔记里的链接原样留着，用户看到的是"没上传"；
	// 2026-10-21 实测报的正是这一条 —— 对象其实早就传上去了）。
	{
		const pdf = "assets/【FPGA工程师_长沙 11-19K】游立强 4年(1).pdf";
		const app = makeApp({
			files: ["notes/a.md", pdf],
			texts: { "notes/a.md": "[说明](../assets/【FPGA工程师_长沙%2011-19K】游立强%204年(1).pdf)" },
		});
		const snapshot = await referenceSnapshot(app);
		assert.equal(
			snapshot.referenced.has(pdf),
			true,
			"目标里带成对括号（`…(1).pdf`）时也要认出引用（否则那条附件永远不进候选）"
		);
		assert.equal(
			snapshot.rewritable.has(pdf),
			true,
			"★ 同一条也要算「能靠改写修好」（重跑「上传附件」时才可能把它修掉）"
		);
	}

	// ⭐⭐ `rewritable` 与 `referenced` **刻意不一样**（两份答案，用途相反）：
	// - 画布的 `file` 节点**只能**指向库内文件（宿主限制）⇒ 永远改不成 URL ⇒ 不算"可修"。
	//   算进去的话，每个摆在画布上的附件每轮都会进「上传附件」的待修清单、还要读一遍字节。
	// - 宿主的链接索引只说"有人指着它"，不说"以什么写法指着" ⇒ 也不进 `rewritable`。
	// - 画布**文本节点**里的链接与笔记同规则（`planCanvasRewrites` 的 linkRules）⇒ 算。
	{
		const canvasFile = JSON.stringify({ nodes: [{ id: "1", type: "file", file: "img/pinned.png" }] });
		const canvasText = JSON.stringify({ nodes: [{ id: "2", type: "text", text: "![[img/typed.png]]" }] });
		const app = makeApp({
			files: ["notes/a.md", "img/pinned.png", "img/typed.png", "img/host-only.png", "boards/pin.canvas", "boards/text.canvas"],
			texts: { "boards/pin.canvas": canvasFile, "boards/text.canvas": canvasText },
			// 画布 file 节点与"宿主认得、我们自己不认"的那一类都只出现在链接索引里
			resolvedLinks: { "boards/pin.canvas": { "img/pinned.png": 1 }, "notes/a.md": { "img/host-only.png": 1 } },
		});
		const snapshot = await referenceSnapshot(app);
		assert.equal(snapshot.referenced.has("img/pinned.png"), true, "画布 file 节点上的附件当然算「有人指着」");
		assert.equal(
			snapshot.rewritable.has("img/pinned.png"),
			false,
			"★ 但它**不算可修**：画布 file 节点永远不会被改成远端地址（算进去会每轮都进待修清单）"
		);
		assert.equal(
			snapshot.rewritable.has("img/typed.png"),
			true,
			"★ 画布**文本节点**里的链接与笔记同规则 ⇒ 算可修（改写器真的会改它）"
		);
		assert.equal(
			snapshot.rewritable.has("img/host-only.png"),
			false,
			"★ 只有宿主索引提到、我们自己解析不到的目标不算可修（我们不知道它是什么写法）"
		);
	}

	// ⭐⭐ 2026-10-22（D-61 / D-62）：**"被引用"与"可修"是两个集合**，而代码块连前者都不是。
	//
	// | 位置 | 算引用？ | 算可修？ |
	// |---|---|---|
	// | 正文 | ✓ | ✓ |
	// | 属性区（`cover: "[[x.png]]"`） | ✓（宿主真的在用它） | ✗（属性不接受 Markdown 图片，换路径又成死链） |
	// | 代码块 / 行内代码 / `%%注释%%` | ✗（宿主不渲染，`resolvedLinks` 里也没有） | ✗ |
	//
	// 两格的后果：把"不可修"算成"可修" ⇒ 那个文件在「上传附件」里**每次**都列为待修、
	// 每次改 0 处（永远修不好）；把代码块算成引用 ⇒ 只在样例里被提到的文件被白传一次，
	// 清理流程还会一直保着它（用户 2026-10-22 明确否掉了这一侧）。
	{
		const only = async (text) => {
			const app = makeApp({ files: ["notes/a.md", "img/x.png"], texts: { "notes/a.md": text } });
			const snapshot = await referenceSnapshot(app);
			return { referenced: snapshot.referenced.has("img/x.png"), rewritable: snapshot.rewritable.has("img/x.png") };
		};
		const cases = [
			['---\ncover: "[[img/x.png]]"\n---\n\n正文\n', true, false],
			["```md\n![](img/x.png)\n```\n", false, false],
			["~~~\n![](img/x.png)\n~~~\n", false, false],
			["写法是 `![](img/x.png)` 这样\n", false, false],
			["%%![](img/x.png)%%\n", false, false],
			["普通正文 ![](img/x.png)\n", true, true],
		];
		for (const [text, referencedExpected, rewritableExpected] of cases) {
			const got = await only(text);
			const label = JSON.stringify(text);
			assert.equal(
				got.referenced,
				referencedExpected,
				referencedExpected
					? `★ 这算「有人指着它」：${label}`
					: `★★ 代码块/行内代码/注释里的目标**不算引用**（否则会被白传一次）：${label}`
			);
			assert.equal(
				got.rewritable,
				rewritableExpected,
				rewritableExpected
					? `★ 正文里的引用算"可修"：${label}`
					: `★★ 属性区 / 代码块 / 注释里的一律**不算可修**（否则永远待修）：${label}`
			);
		}
	}

	// ⭐⭐ 2026-10-22（D-67）：**排障开关的接线**。
	//
	// 这条钉的不是日志函数（那在 `debug-log-suite` 里），而是**选项有没有真的接进来**：
	// `debugLog` 写对了、但调用方忘了把 `debug` 传下去，症状是"勾了开关、控制台什么也没有"
	// —— 与日志函数本身写错完全一样，而单测最容易漏的正是这一段（替身里的空方法会掩盖接线缺口）。
	{
		const captured = [];
		const original = console.debug;
		console.debug = (...args) => void captured.push(args);
		try {
			const app = makeApp({
				files: ["notes/a.md", "img/x.png"],
				texts: { "notes/a.md": "![](img/x.png)\n" },
			});
			// 开着 ⇒ 一条
			captured.length = 0;
			await referenceSnapshot(app, { debug: true });
			assert.equal(captured.length, 1, "★★ debug: true 时必须**真的**打一条（选项没接上就一条都没有）");
			assert.ok(
				String(captured[0][0]).includes("引用快照"),
				`★ 文案要能认出是哪一段：${captured[0][0]}`
			);
			assert.equal(
				typeof captured[0][1],
				"object",
				"★ 要带上计数对象（笔记/目标/引用路径那几个数）"
			);

			// 关着 ⇒ 一条都不打（默认值就是关，用户没勾过）
			captured.length = 0;
			await referenceSnapshot(app);
			assert.deepEqual(captured, [], "★★ 不传 debug 时一条都不许打（默认关）");
		} finally {
			console.debug = original;
		}
	}

	// ============================================================
	// 4b. 单篇视角（「只看当前笔记」那个勾选项的数据来源）
	// ============================================================
	//
	// ⭐⭐ 这一节钉的不是"能返回集合"，而是**与全库快照同一套判据** ——
	// 两份各写一遍的后果是：清单里冒出全库有、这篇其实没有的行（或反过来漏掉它真的引用的行），
	// 而两侧都不报错。
	const noteVaultPaths = ["notes/a.md", "notes/b.md", "img/x.png", "img/y.png"];
	{
		const note = referencesInNote("正文 ![[img/x.png]]", noteVaultPaths);
		assert.equal(note.referenced.has("img/x.png"), true, "当前笔记自己引用的那份要在清单里");
		assert.equal(note.referenced.has("img/y.png"), false, "★★ 另一篇笔记引用的**不该**出现（只看这一篇）");
	}
	// 代码块 / 行内代码 / 注释：全库快照不算，单篇视角也**不许**算（D-62 的口径只能有一份）。
	for (const text of ["```md\n![[img/x.png]]\n```\n", "写法是 `![[img/x.png]]` 这样\n", "%%![[img/x.png]]%%\n"]) {
		const note = referencesInNote(text, noteVaultPaths);
		assert.equal(
			note.referenced.has("img/x.png"),
			false,
			`★★ 单篇视角也不许把代码块/行内代码/注释算成引用：${JSON.stringify(text)}`
		);
	}
	// 属性区：**认**（清单要看得见它），但**不改**（与全库快照同一条边界，D-61）。
	{
		const note = referencesInNote('---\ncover: "[[img/x.png]]"\n---\n\n正文\n', noteVaultPaths);
		assert.equal(note.referenced.has("img/x.png"), true, "属性区的引用在单篇视角里也算（否则清单看不见它）");
		assert.equal(note.rewritable.has("img/x.png"), false, "★ 但不算可修（算了就永远待修、每次改 0 处）");
	}
	// 带 scheme 的目标不是本地引用 —— 这一条在单篇视角里同样不能松。
	{
		const note = referencesInNote("![](https://cdn.example.com/img/x.png)", noteVaultPaths);
		assert.equal(note.referenced.has("img/x.png"), false, "带 scheme 的目标不算本地引用（单篇视角同口径）");
	}
	// 同名歧义：与全库一样**不猜**。
	{
		const note = referencesInNote("![[x.png]]", ["notes/a.md", "a/x.png", "b/x.png"]);
		assert.equal(note.referenced.size, 0, "同名歧义时单篇视角也不猜（猜错就是把别人的图列进来）");
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
