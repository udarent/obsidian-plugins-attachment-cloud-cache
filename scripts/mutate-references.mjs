import { runMutations } from "./lib/mutate.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 变异验证：引用改写（`src/maintenance/references.ts`）—— **唯一会改动用户笔记/画布的地方**。
 *
 * 为什么要单独一个文件：`runMutations` 一个文件只能调一次（结束时会 `process.exit`），
 * 而这一层与"候选挑选"（`mutate-batch.mjs`）守的是完全不同的后果：
 *
 * - 那边错了 → **该处理的没处理**（少搬几个文件），用户看得见；
 * - 这边错了 → **笔记/画布被改坏或改到别的东西上**，而且改坏了不报错。
 *
 * 1.1.0 新增的两块都在这里守：可嵌入/不可嵌入的**改写形态**、以及**画布 JSON 的字节级安全**
 * （file 节点只能指库内；text 节点按 Markdown 规则；解不开的转义必须跳过并计数）。
 */
await runMutations({
	source: "src/maintenance/references.ts",
	entries: [
		"src/maintenance/audit",
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/settings",
		"src/types",
		"src/render/external-decide",
		"src/vault-files",
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// 后果：`[说明](report)`（笔记里没写扩展名）匹配不上 `report.pdf` 那条规则 ⇒
			// **那个附件永远不会被改写**（链接一直是本地的），而命令报告"成功"。
			// 这是"支持所有格式"之后新出现的一类漏改：以前白名单里只有图片后缀。
			name: "★ 归一化只剥图片后缀（非图片附件的链接永远改不到）",
			from: '\tif (dot > slash + 1 && PLAUSIBLE_EXTENSION.test(value.slice(dot + 1))) {\n\t\tvalue = value.slice(0, dot);\n\t}',
			to: '\tif (dot > slash + 1) {\n\t\tvalue = value.slice(0, dot);\n\t}',
			// ⚠️ 这条变异的**实际表现**是"把目录名里的点也当扩展名"（`notes.v2/photo` → `notes`），
			// 于是短名匹配算出的名字变了 ⇒ 匹配不上。取那句最贴近的报错。
			expect: "只有'像扩展名'的后缀才该被剥掉",
		},
		{
			// 后果：wikilink 只换路径那一段 ⇒ 产出 `![[https://…]]`，而**wiki 语法只解析库内文件**
			// ⇒ 那条链接在宿主里根本不显示（真机实测过）。
			name: "★ wikilink 指向 URL 时不整条换形态（产出宿主不显示的 `![[https://…]]`）",
			from: '\t\tif (span.kind === "wikilink" && hasScheme(replacement)) {',
			to: "\t\tif (false) {",
			expect: "别名/尺寸必须保留",
		},
		{
			// 后果：画布 file 节点被改成**远端 URL** ⇒ 画布按库内路径取文件，
			// 于是那个节点变成空的/坏的（用户看不见他摆在画布上的东西）。
			name: "★ 画布 file 节点不按本地规则改（被改成远端 URL，画布上什么都看不到）",
			from: "\tif (resolveFile) {\n\t\tcollect(\"file\", (value) => {",
			to: "\tif (false) {\n\t\tcollect(\"file\", (value) => {",
			expect: "只该有一处被改（file 节点）",
		},
		{
			// 后果：画布 text 节点里的链接不改 ⇒ 只有画布引用的附件被搬进缓存之后，
			// 画布里的那条引用还指着旧位置（死链）。
			name: "★ 画布 text 节点被忽略（画布里的链接原地不动，搬完就死链）",
			from: "\tif (resolveLink) {\n\t\tcollect(\"text\", (value) => {",
			to: "\tif (false) {\n\t\tcollect(\"text\", (value) => {",
			expect: "text 节点的内容算**一处**改写",
		},
		{
			// 后果：新值不按 JSON 规则编码 ⇒ 含换行/引号的文本会把画布写成**非法 JSON**，
			// 宿主再打开时整张画布都废了。
			name: "★ 写回时不按 JSON 编码（含换行的画布被写成非法 JSON）",
			from: "\t\t\tedits.push({ start: span.start, end: span.end, next: encodeJsonString(next) });",
			to: "\t\t\tedits.push({ start: span.start, end: span.end, next });",
			expect: "换行必须仍是转义形态",
		},
		{
			// 后果：从 `file` 节点而不是 `text` 节点里取引用目标 ⇒ "只被画布文本引用的附件"
			// 永远进不了候选（用户把图放在画布的**文字**里就是常态），且不报错。
			name: "★ 画布引用目标从错误的键上取（只被画布文本引用的附件永远不被处理）",
			from: '\tfor (const span of jsonStringSpans(text, "text")) {',
			to: '\tfor (const span of jsonStringSpans(text, "file")) {',
			expect: "只从 **text 节点**里取目标",
		},
		{
			// 后果：解不开的转义被**静默忽略** ⇒ 用户以为全改好了，而某处引用还指着旧位置。
			name: "★ 解不开的 JSON 字符串不计数（用户以为全改好了）",
			from: "\t\t\t\tskipped += 1;\n\t\t\t\tcontinue;",
			to: "\t\t\t\tcontinue;",
			expect: "跳过要**计数**",
		},
	],
});
