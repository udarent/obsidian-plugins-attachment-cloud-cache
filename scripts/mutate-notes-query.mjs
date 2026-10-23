import { runMutations } from "./lib/mutate.mjs";
import { runNotesQuerySuite } from "./lib/notes-query-suite.mjs";

/**
 * 变异验证：`src/plugin/notes-query.ts`（"还有谁在引用"的判据）。
 *
 * 每一条都对应一个**静默**后果：多算（该清的清不掉）或**少算**（报告说没人用，
 * 而其实有人指着）—— 后者更糟，因为它会让用户相信一个错的数字。
 */
await runMutations({
	source: "src/plugin/notes-query.ts",
	entries: ["src/plugin/notes-query"],
	suite: runNotesQuerySuite,
	mutations: [
		{
			// 后果：**不可改写的位置进了"可修"集合** ⇒ 那个文件在「上传附件」里每次都被列为
			// 待修、而改写器（正确地）每次改 0 处 ⇒ 永远修不好（用户只能手工改笔记）。
			name: "★★ 属性区里的链接被算成「可修」（永远待修、永远改不动）",
			from: "\t\tif (!span.inFrontmatter) rewritableTargets.push(span.raw);",
			to: "\t\trewritableTargets.push(span.raw);",
			expect: "不算可修",
		},
		{
			// 后果：`rewritable` 直接别名到 `referenced` ⇒ 画布的 `file` 节点（只能指库内文件、
			// 永远改不成 URL）也被当成"待修" ⇒ 每个摆在画布上的附件每轮都进「上传附件」的
			// 待修清单、还要读一遍字节，而它们**根本改不了**（用户看到的是永远清不掉的清单）。
			name: "★★ 可修集合别名到引用集合（画布 file 节点成了永远修不完的待办）",
			from: "\tconst rewritable = new Set<string>();",
			to: "\tconst rewritable = referenced as Set<string>;",
			expect: "画布 file 节点永远不会被改成远端地址",
		},
		{
			// 后果：画布**文本节点**里的链接不算"可修" ⇒ 它们与笔记同规则（改写器真的会改），
			// 却被判成"修不了" ⇒ 那些附件永远不重进候选，用户重跑多少次都没用。
			name: "★★ 画布文本节点的链接不算可修（它们其实改得掉）",
			from: "\t\t\trewritable.add(path);",
			to: "\t\t\t// 变异：画布文本不算可修",
			expect: "画布**文本节点**里的链接与笔记同规则",
		},
		{
			// 后果：云端地址里的文件名被错认成库里的同名文件 ⇒ 那份副本"永远清不掉"
			// （验收里真的发生过：release-target 被这条误判挡住）。
			name: "★ 不再排除带 scheme 的目标（别人的 URL 被当成库内引用）",
			from: "\t\tif (hasScheme(span.raw)) continue;",
			to: "\t\tif (false) continue;",
			expect: "带 scheme 的目标不算本地引用",
		},
		{
			// 后果：属性区 / 行内 HTML / 引用式链接里的引用全部看不见 ⇒ 那几类附件被判"没人用"。
			name: "★ 不再自己解析正文（只信宿主索引）",
			from: "\tconst notes = options.notes ?? (await readAllNoteTexts(app));",
			to: "\tconst notes = options.notes ?? [];",
			expect: "正文 wikilink里的引用必须算被引用",
		},
		{
			// 后果：只被画布文本引用的附件永远不被处理（需求 R16 直接失效）。
			name: "★ 不再扫画布文本节点",
			from: '\t\tif (file.extension !== "canvas") continue;',
			to: "\t\tif (true) continue;",
			expect: "画布文本里的引用必须算被引用",
		},
		{
			// 后果：宿主的链接索引这一路整个丢掉（笔记里的常规写法全看不见）。
			name: "不再读宿主的链接索引",
			from: "\tconst referenced = new Set(referencedPathsFrom(app.metadataCache?.resolvedLinks));",
			to: "\tconst referenced = new Set();",
			expect: "resolvedLinks 里的目标必须算被引用",
		},
		{
			// 后果：查询出错时返回 false ⇒ 记录被当成失效摘掉 ⇒ 那张图的离线可用性被悄悄拿掉。
			// （方向与 `download.ts` 的 exists **相反**，合并必然弄反一边。）
			name: "★ exists 出错时按「不在」处理（把记录误摘掉）",
			from: '\t\tconsole.error("[attachment-cloud-cache] 查询本地副本是否存在失败", error);\n\t\treturn true;',
			to: '\t\tconsole.error("[attachment-cloud-cache] 查询本地副本是否存在失败", error);\n\t\treturn false;',
			expect: "查询出错必须按「在」处理",
		},
	],
});
