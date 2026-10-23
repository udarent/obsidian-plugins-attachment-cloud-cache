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
 * ⚠️ 库内文件那部分（`selectUploadCandidates` 自己那一半）由本文件覆盖；
 * 2026-10-22（D-75）之前它挂在 `mutate-maintenance-audit.mjs` 上 —— 那个脚本守的是
 * `audit.ts`（「查看本地副本占用」命令），命令退役后一起删了，它那条链没有别的入口。
 *
 * 这里只加**外链**这一类 —— `runMutations` 一个文件只能调一次，
 * 所以新的一类判定就该有新的一份变异文件。
 */
await runMutations({
	source: "src/maintenance/batch.ts",
	entries: [
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
			// 后果：站外地址里带成对括号（`…/Foo_(bar).pdf`）时被截成 `…/Foo_(bar` ⇒
			// 拿半截地址去下载：404，或者下到一个**别的东西**而用户不知道。
			// 2026-10-21 把位置判据收进 `references.ts::markdownLinks` 之后，这里只留切法 ——
			// 这条锚点守的就是"别在切法里又把 `)` 当分隔符"。
			name: "★★ 站外地址按第一个 `)` 切（括号被截断，下载到半截地址或别的东西）",
			// ⚠️ 只改**切法**里的分隔符（不动尖括号那一支）：否则变异会先撞上
			// "尖括号包住的地址要认得出来"，报错原因就不再指向这里了（实测踩过）。
			from: "\treturn trimmed.split(/\\s/)[0] ?? \"\";",
			to: "\treturn trimmed.split(/[)\\s]/)[0] ?? \"\";",
			expect: "站外地址里的成对括号不许截断",
		},
		{
			// 后果：本机路径里带成对括号（`file:///D:/tmp/报告(1).pdf`）时被截断 ⇒
			// `localFileExists` 说"不在" ⇒ `dropMissingLocalCandidates` 把它**静默摘掉**，
			// 用户永远等不到这一条被处理（同 D-56 的用户可见现象）。
			name: "★★ 本机路径按第一个 `)` 切（文件被判成「不在了」而静默摘掉）",
			// ⚠️ 只在本机那条切法里加一个 `)` 分隔符（标题照旧要切）——
			// 换掉整句的话，变异会先撞上"四条都要收全"里那条带标题的用例，原因就不再指向括号了。
			from: "\tif (angle !== null) return angle;\n\treturn stripMarkdownTitle(body);",
			to: '\tif (angle !== null) return angle;\n\treturn stripMarkdownTitle(body.split(")")[0]);',
			expect: "本机路径里的成对括号不许截断",
		},
		{
			// 后果：**顺序退回**（先问"有没有被引用"、再问"处理过没有"）⇒ 已经迁移好的文件
			// 正文里只剩远端 URL，于是它撞上「没有被任何笔记引用」—— 而同一批文件在
			// 「查看缓存占用」里是"在用"、在「检查未引用的云端附件」里也不问 ⇒
			// 三条命令对同一件事说三种话（2026-10-22 审计在演示库上实测到 2 个）。
			name: "★★ 先问引用再问已索引（已迁移的文件被说成「没有被任何笔记引用」）",
			from: "\t\tif (options.index.findByCachePath(file.path)) {",
			to: "\t\tif (options.referencedPaths.has(file.path) && options.index.findByCachePath(file.path)) {",
			expect: "已迁移的仍跳过",
		},
		{
			// 后果：已经传过、而正文里那条链接还是本地的文件被当成"处理过了"跳过 ⇒
			// 「重新上传附件」永远修不好它（用户 2026-10-21 报的正是这个：他以为再传一次就好了）。
			name: "★★ 已索引的文件一律跳过（「重新上传」再也修不好一条没改掉的链接）",
			from: "\t\t\tif (!options.repairablePaths.has(file.path)) {",
			to: "\t\t\tif (true) {",
			expect: "已传过、但正文里还指着本地文件的必须重新进候选",
		},
		{
			// ⚠️ 2026-10-15（D-32）：行内 HTML 的正则搬成了**共用一份**（`references.ts` 的
			// `HTML_ATTRIBUTE`）—— 原来这里自己写了一串，于是「改写认得、候选不认得」迟早分叉。
			// 锚点因此改成打在**调用**上（那个正则本身在另一个文件里）。
			name: "★ 外链候选漏掉行内 HTML（普通链接指向的文件永远进不了候选）",
			from:
				"\tfor (const { value, tag } of htmlAttributeTargets(text)) {\n" +
				"\t\tif (isHttpUrl(value)) add(http, value, EMBED_TAGS.has(tag));\n" +
				"\t}\n",
			to: "\t// 变异：漏掉行内 HTML\n",
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
			// 后果：引用判据失效 ⇒ **没被引用的文件被当成"被引用"**，自动接管那条路会抢在链接写入之前
			// 搬走它（死链），而用户只是把文件放进了附件目录（D-68 之后这类文件默认不该进候选）。
			name: "★ 未引用的文件被当成被引用（绕过引用判据）",
			from: '\t\tif (!options.referencedPaths.has(file.path)) {\n',
			to: "\t\tif (false) {\n",
			expect: "默认**不**收未引用的",
		},

		// ── ⭐ 本机文件（`file:///D:/…`，2026-10-15 用户要的"与站外同一套"）──
		{
			// 后果：**范围过滤失效** ⇒ 勾了「只看当前笔记」，清单里仍然列着全库的地址
			//（用户以为在处理这一篇，实际把别的笔记指向的附件也勾上一起传了）。
			// ⚠️ 这一条守的是"过滤真的发生在判定层"：如果只在调用方筛结果，
			// 站点汇总（`sites`）与跳过统计仍是全库的数字 —— 摘要会说谎。
			name: "★★ 范围过滤失效（「只看当前笔记」时仍列出全库的地址）",
			from: "\t\tif (options.notePaths && !options.notePaths.has(path)) continue;",
			to: "\t\tif (false) continue;",
			expect: "只看当前笔记时，只列这一篇里的地址",
		},
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
			from: "\treturn stripMarkdownTitle(body);",
			to: "\treturn body;",
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
			// ⚠️ 2026-10-16：判据本身住在 `vault-files.ts`（站外那一路也要用它），
			// 所以这里锚的是**调用**（与 `mutate-vault-files` 那条一起才覆盖完整通路）。
			// 后果：**笔记被当附件上传** —— 它正文里的链接会被改写成远端地址，
			// 而宿主仍按后缀把它当笔记索引 ⇒ 一篇笔记被当成图片对象，wikilink 也跟着断。
			name: "★ 库内候选不再排除笔记/画布/数据库文件（把笔记当附件上传）",
			from: "\t\tif (isNoteLikeExtension(extension)) {\n",
			to: "\t\tif (false) {\n",
			expect: "笔记文件不是附件",
		},
		{
			// 后果：**已经不在了的本机文件候选不会被摘掉** ⇒ 清单里出现"点了一定失败"的条目
			//（2026-10-16 用户实测报的：WPS 的 `Temp/ksohtml/wpsDD.tmp.jpg` —— 文件早被删了）。
			// ⚠️ "在不在"是 I/O（探测由调用方注入），所以这里锚的是**分流**那一句。
			name: "★★ 不按探测结果摘掉已不在的本机文件（清单里留一条必然失败的条目）",
			from: "\t\tif (!path || !(await probe(path))) {\n",
			to: "\t\tif (!path) {\n",
			expect: "已经不在的本机文件必须摘掉",
		},
		{
			// 后果：**采集层把每条地址都当成"笔记在显示它"** ⇒ 判定层那两道形状判据整个失效，
			// 正文里的**普通链接**（wiki 页、GitHub 分支名、版本号）又出现在候选清单里 ——
			// 而它们在笔记里只是一条**链接**，不是附件。
			// ⚠️ 这一条锚在**采集层**（`!` 前缀那一格）：判据住在判定层，
			// 而"这条地址是不是被显示"这个**输入**是从这里喂过去的 —— 喂错了，判据再对也没用。
			name: "★★ 采集层不看「是显示还是指向」（普通链接绕开形状判据）",
			from: "\t\tadd(http, raw, link.embed);\n",
			to: "\t\tadd(http, raw, true);\n",
			expect: "都不算候选",
		},
	],
});
