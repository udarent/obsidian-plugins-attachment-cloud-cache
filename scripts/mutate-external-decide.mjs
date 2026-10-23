import { runMutations } from "./lib/mutate.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 变异验证：站外文件判定（`src/render/external-decide.ts`）。
 *
 * 这一层的每条分支坏掉都不报错，只是行为变成另一个样子：功能关了却还在搬、
 * 对着自己的存储发问、把内网地址也拿去请求、或者**名单形同虚设**
 *（用户在设置里把某个站点拉黑，插件照旧自动去搬它的文件并改写笔记）。
 *
 * ⚠️ 1.2.0 把旧的三态（`ignore` / `wait` / `cache`）收敛成了两态，判定多了
 * `purpose` 这一维，所以这里锚定的东西也换了：
 * - 从前守的是"默认行为别判反"，现在守的是"**别把开关 / 名单也套到显式工具上**" ——
 *   那会让「挑选要缓存的文件」随开关一起消失（入口消失比行为错更难发现）。
 *
 * ⚠️ 站点记忆那一套（`allow` / `deny`）已经整条拆掉，所以相关的锚点也随之删除 ——
 * 留着它们只会得到"变异点未找到"。
 */
await runMutations({
	source: "src/render/external-decide.ts",
	entries: ["src/render/external-decide"],
	suite: runExternalDecideSuite,
	mutations: [
		{
			// 后果：**安装包 / 镜像又回到清单里**（D-58 之前的行为）：用户笔记里一条
			// `[下载地址](…/Cherry-Studio-0.9.19-setup.exe)`（84.6 MB）会被下载、传进桶、
			// 库里留一份 84 MB 副本，并把「下载地址」改成桶地址 —— 他要的是"资料跟着笔记走"，
			// 不是"桶变成软件分发站"。⚠️ 这条判据是**黑名单**（只收程序分发），
			// 别顺手扩成"认不认识这个后缀"（`.psd` / `.bin` 会被静默拦掉）。
			name: "★★ 安装包/镜像不再被拦（84 MB 的安装包会进清单并被搬进桶）",
			from: "\tif (isProgramExtension(extension)) {",
			to: "\tif (false) {",
			expect: "安装包/镜像不许进候选",
		},
		{
			// 后果：用户**关掉了功能却仍在被自动处理** —— 关不掉的开关比没有开关更糟。
			name: "★ 不看总开关（关掉功能仍会被自动处理）",
			from: '\tif (input.purpose === "auto" && !input.settings.externalImageCache) {\n',
			to: '\tif (input.purpose === "auto" && false) {\n',
			expect: "功能关着",
		},
		{
			// 后果：**把总开关也套到显式工具上** ⇒ 关掉自动处理的人连
			// 「挑选要缓存的文件」都列不出候选。入口悄无声息地消失，用户只会以为"功能没了"。
			name: "★ 把总开关套到显式工具上（关掉开关后挑不出候选）",
			from: '\tif (input.purpose === "auto" && !input.settings.externalImageCache) {\n',
			to: '\tif (!input.settings.externalImageCache) {\n',
			expect: "显式工具不受开关约束",
		},
		{
			// 后果：**名单也套到了显式工具上** ⇒ 用户手动勾中的文件搬不动，
			// 而界面上没有任何提示（勾选本身就是同意，不该被一份"自动搬的准入"否掉）。
			name: "★ 把名单也套到显式工具上（手动勾选的被名单挡住）",
			from: '\t\tinput.purpose === "auto" &&\n\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n',
			to: '\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n',
			expect: "显式工具不受名单约束",
		},
		{
			// 后果：**名单形同虚设** —— 用户把站点拉黑（或只留白名单），插件照旧自动去搬。
			// 这是"设置改了、没有任何效果"的典型：用户查不出为什么名单不起作用。
			name: "★ 名单形同虚设（自动处理无视黑/白名单）",
			from: "\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n",
			to: "\t\tfalse\n",
			expect: "黑名单",
		},
		{
			// 后果：对着**用户自己的存储端点**列出候选（换过桶、或改过 publicUrlBase 的旧链接
			// 会走到这里），荒谬且会让清单里塞满他自己的地址。
			name: "★ 不再按主机识别本存储（对着自己的端点发问）",
			from: '\tif (ownHosts(input.settings.s3).has(host)) {\n\t\treturn { action: "ignore", reason: "属于本存储（主机匹配）" };\n\t}\n',
			to: "\t// 变异：不看主机\n",
			expect: "主机匹配",
		},
		{
			// 后果：把回环/链路本地地址也纳入处理 ⇒ 笔记里一张图就能让插件去请求
			// `127.0.0.1` 或云元数据端点（那是别人机器上的探测原语）。
			name: "★ 不再拦回环与链路本地地址（把内网探测发出去）",
			from: '\tif (isBlocked(host)) return { action: "ignore", reason: "本地/链路本地地址（安全）" };\n',
			to: "\t// 变异：不拦本地地址\n",
			expect: "回环",
		},
		{
			// 后果：没配好存储时也把文件算成"可搬" ⇒ 渲染路径上每张图都会试一次，
			// 候选清单里也会出现勾了也做不成的条目。
			name: "★ 不再检查是否已配好（未配置时也当可搬）",
			from: '\tif (!input.configured) return { action: "ignore", reason: "存储未就绪" };\n',
			to: "\t// 变异：不看配置状态\n",
			expect: "未配置时不该动手",
		},
		{
			// 后果：**指向笔记 / 画布 / 数据库的地址会被搬进库** —— 搬下来那份落进库里
			// 就变成一篇笔记（宿主按后缀识别），于是用户的库里凭空多出一篇笔记、
			// 候选清单上多一行"看起来像附件"的东西。2026-10-16 用户实测报的正是这个症状
			//（笔记里链接的远程 `.md` 出现在「上传附件」的清单里）。
			// ⚠️ 判据本体住在 `vault-files.ts`，这里锚的是**调用**那一侧 ——
			// 与 `mutate-vault-files` / `mutate-batch` 的两条一起覆盖完整通路。
			name: "★ 不再拦「指向笔记/画布/数据库」的地址（把远程 .md 搬进库）",
			from: '\tif (isNoteLikeExtension(extension)) {\n\t\treturn { action: "ignore", reason: NOTE_LIKE_REASON };\n\t}\n',
			to: "\t// 变异：不拦笔记类文件\n",
			expect: "不该被搬走",
		},
		{
			// 后果：**"只被指向"的地址不再判形状** ⇒ 网页 / 目录 / 接口 / 分支名形态的地址
			// 又进了候选清单 —— 用户看到的是一张"待上传文件"的清单里列着搬不下来的页面。
			//（2026-10-16 用户实测连着报的第二次与第五次，他的原话：
			// 「那个文件压根就不该进入列表选项」/「实际上这是一个网页地址」。）
			name: "★★ 站外候选不再判形状（网页 / 分支名又进了清单）",
			from:
				"\tif (!input.embedded) {\n" +
				"\t\tif (!urlLooksLikeFileName(src)) {\n" +
				"\t\t\treturn { action: \"ignore\", reason: NOT_A_FILE_REASON };\n" +
				"\t\t}\n" +
				"\t\tif (!urlHasFileTypeSuffix(src)) {\n" +
				"\t\t\treturn { action: \"ignore\", reason: NOT_FILE_TYPE_REASON };\n" +
				"\t\t}\n" +
				"\t}\n",
			to: "\t// 变异：不判形状\n",
			expect: "只被指向的地址必须看起来像个文件",
		},
		{
			// 后果：**形状判据没有闸门**（对每一条地址都施加）⇒ 笔记在**显示**的真实图被反手拦下：
			// 图片 CDN 的令牌形状地址（`…OIP-C.sPb8lvTxu-…`）取不出扩展名 ⇒ 不再进候选；
			// `auto` 那一路（宿主渲染 `<img>` 时）同样全军覆没 —— 而且**不报错**，
			// 用户只会发现"图缓存不了了"。
			// ⚠️ 这正是 D-36 时代的原样（当时那两句判据没有闸门），所以必须有一条锚点守着它。
			name: "★★ 形状判据没有闸门（被显示的图也要过形状判据，令牌形状的图被误伤）",
			from: "\tif (!input.embedded) {\n",
			to: "\tif (true) {\n",
			expect: "同一条地址被**显示**时不受形状约束",
		},
		{
			// 后果：**第二道判据（"后缀得像文件类型"）没了** ⇒ `…/tree/5.1-translation_terms`
			//（GitHub 分支名 —— 点在 `5` 与 `1` 之间）、`…/tree/v1.2.3`（版本号，点后面是纯数字）
			// 这类地址又混进候选清单，而它们**永远搬不成**（那是一条页面）。
			// 2026-10-16 用户**第五次**实测报的正是这个。
			name: "★★ 漏掉「后缀得像文件类型」那道（分支名 / 版本号又进清单）",
			from:
				"\t\tif (!urlHasFileTypeSuffix(src)) {\n" +
				"\t\t\treturn { action: \"ignore\", reason: NOT_FILE_TYPE_REASON };\n" +
				"\t\t}\n",
			to: "\t\t// 变异：只看「尾巴有没有点」，不问后缀像不像文件类型\n",
			expect: "后缀不像文件类型的地址不该进清单",
		},
		{
			// 后果：**网页地址又进了候选**（`.html` 尾巴有点，能过"像个文件名"那条）⇒
			// 用户看到的是一张"待上传文件"的清单里列着一个**永远搬不成**的页面
			//（下载端必拒 `text/html`）。2026-10-16 用户第二、三次实测报的正是这个：
			// 先是 B站播放器的 `<iframe src="…/player.html?…">`，后是企业系统的
			// `[原文链接](…/pd.jsp?id=172#:~:text=…)`。
			name: "★★ 不拦网页地址（.html 页 / .jsp 页面程序又进清单）",
			from:
				'\tif (isWebPageExtension(extension)) {\n' +
				"\t\treturn { action: \"ignore\", reason: PAGE_REASON };\n" +
				"\t}\n",
			to: "\t// 变异：不拦网页\n",
			expect: "网页地址不许进候选",
		},
		{
			// 后果：**判据放宽成"把真实文件后缀也拦掉"** ⇒ 用户笔记里那些
			// `[下载](…/readme.txt)` 这类**可以缓存**的链接再也不出现（功能静默少一半）。
			// ⚠️ 最先失败的断言是**更早**那条"不许过度拦截"（2b 节直接问 `a.mp3` / `readme.txt`），
			// 所以 `expect` 抄的是它 —— 后面 2c 那组反向断言守的是同一件事的另一半。
			name: "★★ 网页判据放宽成「顺手把真实文本后缀也拦掉」（过度拦截）",
			from: '\tif (isWebPageExtension(extension)) {',
			to: '\tif (isWebPageExtension(extension) || ["txt", "csv", "json", "xml", "py"].includes(String(extension))) {',
			expect: "不许过度拦截",
		},
	],
});
