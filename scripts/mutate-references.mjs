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
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/settings",
		"src/types",
		"src/render/external-decide",
		"src/vault-files",
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// 后果：同名歧义时"两个都算被引用" ⇒ 命令把 a/dup.png 与 b/dup.png 都搬进缓存，
			// 而改写器在歧义时**拒绝改写**（它分不清 `![[dup.png]]` 指哪个）⇒ 两处链接
			// 全成死链。宁可少处理。
			name: "★ 画布引用的同名歧义被当成「都算引用」（搬走却改不掉 ⇒ 死链）",
			from:
				"\t\t\tif (candidates && candidates.length === 1) {\n" +
				"\t\t\t\tout.add(candidates[0]);\n" +
				"\t\t\t\tbreak;\n" +
				"\t\t\t}",
			to: "\t\t\tfor (const hit of candidates ?? []) out.add(hit);",
			expect: "同名歧义一个都不收",
		},
		// ── ⭐ 2026-10-22（D-65）：下面两条随 `referencedPathsFrom` / `resolveVaultTargets` 一起
		// 从 `mutate-batch.mjs` 搬过来 —— 判据归位到 references.ts，锚点跟着判据走。
		{
			// 后果：**画布里的引用被丢掉** ⇒ 只被画布引用的附件永远进不了候选
			//（用户把图摆在画布里是最常见的用法之一，而需求 R16 明确要求"同等算数"）。
			// ⚠️ 方向与 1.1.0 之前相反：那时是"画布必须排除"（画布里的引用改不了），
			// 现在改写器会改画布，所以"漏掉画布"才是缺陷。
			name: "★ 画布里的引用被丢掉（只被画布引用的附件永远不被处理）",
			from: "\t\t// \u2b50 来源**不筛**：Markdown 笔记与画布同等算数（需求 R16，2026-10-09 拍板）。\n\t\t// 空的来源路径仍然跳过 —— 那不是宿主会给的形状。\n\t\tif (!sourcePath) continue;",
			to: "\t\tif (!/\\.md$/i.test(sourcePath)) continue;\n\t\tif (!sourcePath) continue;",
			expect: "画布里的引用**算数**",
		},
		{
			// 后果：画布文本节点里的**编码写法**解析不到真实文件 ⇒ "只被画布文本引用的附件"
			// 永远不被处理（与需求 R16 冲突），而且不报错。
			// ⚠️ 与改写器共用同一份归一（`linkTargetForms`）：两边各写一遍的话，
			// 就是"正文里认得出、画布里认不出"（或反过来）那类静默分叉。
			name: "★ 画布文本里的编码写法解析不到文件（只被画布引用的附件永远不被处理）",
			from: "\t\tconst forms = linkTargetForms(target);",
			to: "\t\tconst forms = linkTargetForms(target).slice(0, 1);",
			expect: "画布文本里的编码写法也要解析到真实文件",
		},
		{
			// 后果：**画布文本里的远端地址不算"仍被引用"** ⇒ 一张只被画布卡片引用着的图，
			// 占用报告说"没有人引用 / 可回收"，而云端清理根本不问它（2026-10-22 审计查出的
			// 第三处不一致：报告的扫描漏了画布那一半）。
			name: "★★ 画布文本里的地址不取 key（报告说没人引用、清理却不问 —— 三条命令各说各的）",
			from: "\tfor (const raw of canvasTextTargets(text)) {\n\t\tfor (const key of keysInText(raw, keyFromUrl)) keys.add(key);",
			to: "\tfor (const raw of []) {\n\t\tfor (const key of keysInText(raw, keyFromUrl)) keys.add(key);",
			expect: "画布**文本节点**里的远端地址要算进",
		},
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
		{
			// 后果：wikilink 整条换形态时**不把显示名传下去** ⇒ 显示位退回"原路径最后一段"：
			// 宿主撞名另落的重复副本（`照片 1.png`）会把序号留在链接文字里，而地址里是
			// 主干名字 —— 用户 2026-10-14 报的第五件事（同一个链接两个名字）。
			name: "★ 换形态时不传显示名（链接文字里留着宿主的「 1」）",
			from: "wikilinkToMarkdown(span, replacement, resolved.display);",
			to: "wikilinkToMarkdown(span, replacement);",
			expect: "★ 显示位必须与**链接目标**一致，不能用原文件名（它带着宿主的序号）",
		},
		{
			// 后果：Markdown 目标的"分界"退回**第一个空白** ⇒ 含空格、又没加尖括号的目标
			// （`![](attachments/照片 1.png)`，很常见的写法）被截成 `attachments/照片`：
			// ① 这条链接不会被改写；② `stillMentionsPath` 判它**不存在** ⇒ 那个文件
			// 哪怕还有人指着也可能被删（两个后果都不报错）。
			name: "★★ 目标按第一个空白切（含空格的链接既不改写、也被当成没人引用）",
			from: "\t\tconst quoteAt = firstIndexOf(body, ['\"', \"'\"]);",
			to: "\t\tconst quoteAt = firstIndexOf(body, [\" \", '\"', \"'\"]);",
			// ⚠️ 实际先说话的是 §3 那条**既有**断言（"五种链接写法的路径段都要取对…"）——
			// 目标被截短，第一个表现出来的就是路径段取错了。
			expect: "五种链接写法的路径段都要取对",
		},
		{
			// 后果：归一只剩"原样"那一形 ⇒ **百分号编码**的链接（宿主的「相对路径」链接格式
			// 自己就这么写：`../assets/Pasted%20image%20….png`）在改写那一侧永远认不出来
			// ⇒ 文件上传成功、而笔记里那条链接还是本地路径，用户看到的就是"没上传"
			//（2026-10-15 用户实测报的正是这一条）。
			name: "★ 归一丢掉解码那一形（编码写法传上去了、笔记一处都不改）",
			from: "\t\tconst forms = linkTargetForms(raw);",
			to: "\t\tconst forms = linkTargetForms(raw).slice(0, 1);",
			expect: "编码 + `../` 相对前缀的目标必须能改写",
		},
		{
			// 后果：判"这份文件还有人引用吗"时**只比完整路径** ⇒ 带相对前缀的引用
			//（`../assets/图.png`）被判成"没人指着它" ⇒ 宿主撞名另落的重复副本会被删掉，
			// 而正文里那条链接还指着它（用户看到的就是「图没了」）。
			// ⚠️ 这一侧的代价不对称：漏认会丢文件，多认只是少删一份 ⇒ 必须偏保守。
			name: "★★ 判据不按短名比（带相对前缀的引用被判成没人引用 ⇒ 删掉仍被指的文件）",
			from: "\t\tif (names.has(baseNameOf(form))) return true;",
			to: "\t\t// 变异：只比完整路径",
			expect: "编码 + 相对前缀也要算「还指着它」",
		},
		{
			// 后果：目标里带**成对括号**时被截断（`… 4年(1).pdf` → `… 4年(1`）⇒
			// 「还有人引用吗」答否、改写一处不改。2026-10-21 用户实测报的就是这一条：
			// 对象早传上去了，而笔记里那条链接还是本地路径（他看到的现象是「没有被上传」）。
			name: "★★ Markdown 目标按「第一个 `)`」截断（带括号的文件名永远改不到、也判成没人用）",
			from: "\t\t\tif (depth === 0) return { bodyEnd: i, closeEnd: i + 1 };",
			to: "\t\t\tif (true) return { bodyEnd: i, closeEnd: i + 1 };",
			expect: "目标里的成对括号不许截断路径段",
		},
		{
			// 后果：括号没配平时（标题里半个 `(`）整条链接**不被认作引用** ——
			// 这条兜底看着像"以防万一"，没有它，那种写法会从"能改"退化成"不认"。
			name: "★★ 括号不配平时不退回「第一个 `)`」（标题里半个括号的链接整条失效）",
			from: '\tconst fallback = text.indexOf(")", from);',
			to: "\tconst fallback = -1;",
			expect: "标题里的括号不配平时要退回",
		},
		{
			// 后果：路径段的起点按 `indexOf("(")` 算 ⇒ 显示文字里带括号时（`[图 (1)](…)`）
			// 起点落进标签里，读到的是 `(1` 这种碎片 —— 与截断同一类失效。
			name: "★★ 路径段起点用了 `indexOf`（显示文字带括号时起点落进标签里）",
			from: "\t\tlet start = linkStart + match[0].length;",
			to: '\t\tlet start = linkStart + match[0].indexOf("(") + 1;',
			expect: "显示文字里的括号不许把路径段的起点带偏",
		},
		{
			// 后果：`![[图.png\|600]]`（表格里的常见写法）取到的路径是 `图.png\` ⇒
			// 归一之后对不上任何文件 ⇒ **判据说没人指着它、改写也不改**（两侧一起静默失效）。
			name: "★★ wikilink 的转义竖线没剥掉（那种写法判据与改写一起失效）",
			from: "\t\tconst raw = body.slice(0, cut > 0 && body[cut - 1] === \"\\\\\" ? cut - 1 : cut);",
			to: "\t\tconst raw = body.slice(0, cut);",
			expect: "取对路径段",
		},
		{
			// 后果：行内 HTML（`<img src=…>` / `<a href=…>`）整类不被认作引用 ⇒
			// 只被它引用的附件会被判成没人用、命令也不会改写它（Obsidian 1.8 起这些标签会渲染）。
			name: "★★ 行内 HTML 标签里的地址不被认作引用",
			from: "\tfor (const target of htmlAttributeTargets(text)) {",
			to: "\tfor (const target of []) {",
			expect: "取对路径段",
		},
		{
			// 后果：引用式链接（`![alt][ref]` + `[ref]: path`）不被认作引用 —— 同上，两侧一起失效。
			name: "★★ 引用式链接的定义行不被认作引用",
			from: "\tfor (const match of text.matchAll(REFERENCE_DEFINITION)) {",
			to: "\tfor (const match of text.matchAll(/$^/gm)) {",
			expect: "取对路径段",
		},
		{
			// 后果：**代码块 / 行内代码 / `%%注释%%` 里的 Markdown 地址仍被当成链接**（D-62）。
			// ⚠️ 这一条钉的是 `markdownLinks`（站外/本机候选也从这里拿位置）：候选收进来就会
			// **下载 + 上传**，而改写那一趟看不到它（`findLinkSpans` 已剔掉）⇒ 链接永远改不掉。
			name: "★★ 代码块里的 Markdown 地址仍被当成链接（下载上传了、链接却永远不改）",
			from: "\t\tif (frozen.some((range) => linkStart >= range.start && linkStart < range.end)) continue;",
			to: "\t\tif (false) continue;",
			expect: "不算候选",
		},
		{
			// 后果：**惰性区域里的远端地址仍被算成"仍被引用"**（`keysInText` 这条扫描与
			// `findLinkSpans` 是两份实现）：一句"我们生成的地址长这样"的代码块样例
			// 会把那个对象永久钉住 ⇒ 云端清理永远不问它、占用报告也说"在用"。
			name: "★★ 代码块里的远端地址仍算「仍被引用」（对象永远清不掉）",
			from: "\t\tif (frozen.length > 0 && insideInert(match.index ?? 0)) continue;",
			to: "\t\tif (false) continue;",
			expect: "惰性区域里的地址不算引用",
		},
		{
			// 后果：**转义的链接被当成引用**（`\![](x.png)` 在宿主里是字面文本）⇒
			// 用户把一条链接"转义掉"（想让它显示成文字）之后，那个文件仍被算作"有人在用"，
			// 于是清理流程永远不碰它、上传清单里也一直有它。
			name: "★★ 转义（`\\![](...)`）的链接仍被当成引用",
			from: "\t\tif (isEscaped(text, linkStart)) continue;",
			to: "\t\tif (false) continue;",
			expect: "一条都不产出",
		},
		{
			// 后果：**行内代码 / 注释 / 公式 / `<code>` 里的目标被当成引用**（2026-10-22，D-62/D-63）——
			// 于是"只在样例里被提到"的文件进「上传附件」白传一次，清理流程还会一直保着它；
			// 而宿主自己（`resolvedLinks`）根本不认这些位置 ⇒ 两条链对同一份文件说法不同。
			name: "★★ 代码块/行内代码/注释里的目标仍被算成引用（白传一次、清理也不删）",
			from: "\tconst spansOutsideCode = frozen.length === 0\n\t\t? spans\n\t\t: spans.filter((span) => !frozen.some((range) => span.start >= range.start && span.end <= range.end));",
			to: "\tconst spansOutsideCode = spans;",
			expect: "一条都不产出",
		},
		{
			// 后果：属性区里的 wikilink 被换成 Markdown 图片（`cover: ![x.png](url)`）⇒
			// **属性值被写坏**（属性不接受 Markdown 图片）；只换路径那段又会得到死链。
			name: "★★ 属性区（frontmatter）里也去改写（把属性值写坏）",
			from: "\t\tif (span.inFrontmatter) continue;",
			to: "\t\tif (false) continue;",
			expect: "属性区里的一律不碰",
		},
	],
});
