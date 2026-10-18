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
			// 后果：云端地址里的文件名被错认成库里的同名文件 ⇒ 那份副本"永远清不掉"
			// （验收里真的发生过：release-target 被这条误判挡住）。
			name: "★ 不再排除带 scheme 的目标（别人的 URL 被当成库内引用）",
			from: "\t\t\tif (hasScheme(span.raw)) continue;",
			to: "\t\t\tif (false) continue;",
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
