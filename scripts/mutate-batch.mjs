import { runMutations } from "./lib/mutate.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 变异验证：批量上传的**候选挑选**（`src/maintenance/batch.ts`）。
 *
 * 这一层决定"哪些文件/哪些外链图会被真的下载、上传、并改写笔记"。
 * 它坏掉的两类症状都不报错：
 * - **选出太多**（把网页当图片、把用户明确拒绝过的站点也照抓）——
 *   用户的机器会去访问他从未同意过的地方；
 * - **选出太少**（同一篇文章里的图被漏掉一半）——
 *   表现为"迁移完了，可有些图还指着原来的地方"。
 *
 * ⚠️ 库内文件那部分的判定由 `mutate-maintenance-audit.mjs` 覆盖（它用同一套套件）。
 * 这里只加**外链**这一类 —— `runMutations` 一个文件只能调一次，
 * 所以新的一类判定就该有新的一份变异文件。
 */
await runMutations({
	source: "src/maintenance/batch.ts",
	entries: [
		"src/maintenance/audit",
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/settings",
		"src/types",
		"src/render/external-decide",
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// ⚠️ 2026-10-15（D-32）：行内 HTML 的正则搬成了**共用一份**（`references.ts` 的
			// `HTML_ATTRIBUTE`）—— 原来这里自己写了一串，于是「改写认得、候选不认得」迟早分叉。
			// 锚点因此改成打在**调用**上（那个正则本身在另一个文件里）。
			name: "★ 外链候选漏掉行内 HTML（普通链接指向的文件永远进不了候选）",
			from:
				"\tfor (const { value } of htmlAttributeTargets(text)) {\n" +
				"\t\tif (isHttpUrl(value)) urls.add(value);",
			to:
				"\tfor (const { value } of []) {\n" +
				"\t\tif (isHttpUrl(value)) urls.add(value);",
			expect: "行内 HTML",
		},
		{
			// 后果：判定层被绕过 ⇒ **用户自己的存储地址、回环/链路本地地址、
			// 以及存储未就绪时的每一张外链**都会变成候选。这是这条命令最严重的一种坏法：
			// 它会去访问用户从未同意过的地方，甚至去请求本机与云元数据端点。
			// ⚠️ 名单与功能开关**不在**这条判据里（那是自动那一路的事）：见 `purpose: "manual"`。
			name: "★ 外链候选不再经过判定层（自己的存储、回环地址、未就绪的存储都会被下载）",
			from: '\t\t\tif (decision.action === "ignore") {\n',
			to: "\t\t\tif (false) {\n",
			expect: "候选要带上",
		},
		{
			// 后果：**没有任何笔记引用**的文件也被当成候选 ⇒ 命令会把它们
			// 上传、移进缓存目录并改名。而它们没有任何链接会把用户引到新位置，
			// 用户看到的只是"我放在附件目录里的东西被搬走了"。
			name: "★ 未引用的文件也进候选（把用户放在附件目录里的东西搬走）",
			from: '\t\tif (!options.referencedPaths.has(file.path)) {\n',
			to: "\t\tif (false) {\n",
			expect: "只有被笔记引用的才处理",
		},
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

		// ── ⭐ 本机文件（`file:///D:/…`，2026-10-15 用户要的"与站外同一套"）──
		{
			// 后果：**手机端也去列本机文件** —— 那些路径在移动端不存在，用户勾了也读不到，
			// 只会换来一串"文件不在了"。平台判据的意义就是让它们**根本不出现**。
			name: "★ 候选项不再问平台（手机端也列出读不到的本机文件）",
			from: "\t\t\tconst localDecision = decideLocalFile({ src: url, isDesktop: options.isDesktop });",
			to: "\t\t\tconst localDecision = decideLocalFile({ src: url, isDesktop: true });",
			expect: "手机端不列本机文件",
		},
		{
			// 后果：Markdown 的标题尾巴没切掉 ⇒ 候选里出现 `file:///D:/a/图.png "标题"`，
			// 而按它去读磁盘**一定读不到**（那是另一串字符）。
			name: "★ Markdown 标题尾巴没切（带标题的那条一定读不到）",
			from: "\t\tconst raw = stripMarkdownTitle(stripAngles(match[1]));",
			to: "\t\tconst raw = stripAngles(match[1]);",
			expect: "四条都要收全",
		},
		{
			// 后果：本机文件被塞进**站点汇总** ⇒ 确认框里那句"来自 N 个站点"把一条本机路径数成站点
			//（用户以为要去访问一台叫 `local` 的服务器）。本机路径没有主机，只能单独计数。
			// ⚠️ 这条**必须连 `bySite.set` 一起写进 `to`**：本机那条路原本根本**不碰** `bySite`
			//（所以只改 `host` 字段是**看不出效果**的 —— 第一版就这么写，运行器报"漏过（测试无牙）"）。
			// ⚠️ 同时**保留 `localFiles += 1`**：去掉它会让"本机文件单独计数"先红，报错就不是这条规则了。
			name: "★ 本机文件被算进「站点汇总」（把本机路径说成一个站点）",
			from:
				'\t\t\t\tcandidates.push({ url, notePath: path, host: "", local: true });\n' +
				"\t\t\t\tlocalFiles += 1;\n" +
				"\t\t\t\tcontinue;",
			to:
				'\t\t\t\tcandidates.push({ url, notePath: path, host: "local", local: true });\n' +
				"\t\t\t\tlocalFiles += 1;\n" +
				'\t\t\t\tbySite.set("local", { host: "local", count: 1 });\n' +
				"\t\t\t\tcontinue;",
			expect: "不进站点汇总",
		},
		{
			// 后果：候选丢了"这是本机文件"这个标记 ⇒ 界面无法据此说明"要读的是你电脑上这条路径"，
			// 于是"逐份勾选"那次同意就失去了前提（看不见风险就点了确认）。
			name: "★ 本机文件的标记丢了（界面说不出「要读哪条路径」）",
			from: '\t\t\t\tcandidates.push({ url, notePath: path, host: "", local: true });',
			to: '\t\t\t\tcandidates.push({ url, notePath: path, host: "", local: false });',
			expect: "本机文件要标出来",
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
	],
});
