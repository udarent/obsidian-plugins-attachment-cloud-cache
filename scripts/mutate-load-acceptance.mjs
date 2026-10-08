import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**入口接线**（`src/main.ts`）。
 *
 * 这一条防的是本项目真实发生过的一次漂移：八个模块全有测试、全绿，
 * 而入口只注册了设置页 —— 装进 vault 的插件除了设置界面什么都不做，
 * 且没有任何测试会失败。所以这里直接打坏入口的注册语句，
 * 每条都必须让验收套件变红。
 *
 * ⚠️ 加载方式与正式测试**不同**，必须说清楚：
 * 正式测试加载的是**真实构建产物** `main.js`（顺带覆盖打包格式），
 * 而这里要变异 `src/main.ts`，产物不会跟着变 —— 所以传 `loadPluginClass`
 * 让它用现场打出的 ESM bundle。代价是这条变异**不覆盖打包格式**，
 * 那部分由 `npm run test`（先 build 再跑）覆盖。
 */
await runMutations({
	source: "src/main.ts",
	entries: ["src/main"],
	// ⚠️ 必须显式再导一次 default：barrel 用的是 `export *`，而它按 ESM 规范
	// **不含 default**，`src/main.ts` 又只有默认导出 —— 不写这行，
	// 套件拿到的是模块命名空间对象，报一句看不出原因的 `not a constructor`。
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			name: "★ 忘了注册粘贴钩子（插件装上去但粘贴完全没反应）",
			from: '\t\tthis.registerEvent(this.app.workspace.on("editor-paste", handlers.onPaste));\n',
			to: "\t\t// 变异：不注册粘贴\n",
			expect: "粘贴处理器",
		},
		{
			name: "★ 忘了注册拖拽钩子（拖进来的图不会被上传）",
			from: '\t\tthis.registerEvent(this.app.workspace.on("editor-drop", handlers.onDrop));\n',
			to: "\t\t// 变异：不注册拖拽\n",
			expect: "拖拽处理器",
		},
		{
			name: "★ 忘了注册设置页（用户可以装但无处配置）",
			from: "\t\tthis.addSettingTab(new SettingsTab(this.app, this));\n",
			to: "\t\t// 变异：不注册设置页\n",
			expect: "设置页必须被注册",
		},
		{
			// 后果：索引从不加载 ⇒ 每次粘贴都从空索引开始 ⇒ 同一张图会被反复上传，
			// 而界面上看不出任何异常（只有流量与时间在涨）。
			name: "★ 忘了读缓存索引（同一张图每次粘贴都重传）",
			from: "\t\tawait this.loadCacheIndex();\n",
			to: "\t\t// 变异：不加载索引\n",
			expect: "索引",
		},
		{
			// 后果：阅读视图里的图仍然走远端 ⇒ 断网就是破图（"离线可用"名存实亡）。
			name: "★ 忘了注册渲染后处理器（阅读视图仍然联网取图，断网是破图）",
			from: "\t\tthis.registerMarkdownPostProcessor((element, ctx) => {",
			to: "\t\tvoid ((element, ctx) => {",
			expect: "渲染后处理器",
		},
		{
			// 后果：实时预览的图片（编辑器自己造的）不走本地副本 ⇒ 离线编辑时满屏破图。
			name: "★ 实时预览的拦截没有生效（它在拿不到 prototype 时会静默跳过）",
			from: "\t\t\tview: typeof window === \"undefined\" ? null : window,",
			to: "\t\t\tview: null, // 变异：不接 DOM",
			expect: "实时预览",
		},
		{
			// 后果：维护命令全都不存在 ⇒ "缓存会持续变大"没有任何出路（P1 #9/#10 的落点）。
			name: "★ 忘了注册维护命令（缓存无法查看/修复/清理）",
			from: "\t\tthis.registerMaintenanceCommands();\n",
			to: "\t\t// 变异：不注册维护命令\n",
			expect: "维护命令",
		},
		{
			// 后果：清理命令不再请求确认 ⇒ 用户在命令面板里点错一下就删了文件。
			name: "★ 清理不再请求确认（点错命令即删文件）",
			from: "\t\tif (!confirmed) {\n\t\t\tnew Notice(this.t(\"maintainCancelled\"));\n\t\t\treturn;\n\t\t}\n\n\t\tconst result = await runCleanup(deps, plan);",
			to: "\t\tvoid confirmed;\n\t\tconst result = await runCleanup(deps, plan);",
			expect: "一个文件都不能动",
		},
		{
			// 后果：整条站外链路在入口上断掉 —— 用户开了功能、也被问了，
			// 但点了「缓存」之后什么都没发生（除了一个再也不会来的通知）。
			name: "★ 后处理器里不接站外编排（用户点了「缓存」却什么都不发生）",
			from: "\t\t\tthis.externalHook?.process(element, ctx);\n",
			to: "\t\t\t// 变异：不接站外编排\n",
			expect: "应询问一次",
		},
		{
			// 后果：决定只活在内存里 ⇒ 用户重启后再打开同一篇笔记，又被问一遍，
			// 而他确信自己已经答过了。
			name: "★ 站点决定不落盘（重启后用户被重新问一遍）",
			from: "\t\tawait this.serialize(() => store.save());\n",
			to: "\t\tvoid store;\n",
			expect: "记忆文件",
		},
		{
			// 后果：上限默认是 0（不限制），于是"忘了装配轮换器"在界面上**毫无痕迹** ——
			// 用户设了上限、保存了设置，然后什么都不会发生。
			name: "★ 入口不装配缓存轮换器（设了上限也不会生效）",
			from: "\t\tthis.rotation = createCacheRotator({\n",
			to: "\t\tthis.rotation = null;\n\t\tvoid createCacheRotator({\n",
			expect: "轮换器",
		},
		{
			// 后果：用户把上限调小之后要等下一次周期检查（最多 10 分钟）才生效 ——
			// 而"改完设置立刻看到效果"正是用户的期待。
			name: "★ 保存设置后不触发轮换（改了上限不立刻生效）",
			from: '\t\tvoid this.rotation?.maybeRotate("settings");\n',
			to: "\t\t// 变异：不触发\n",
			expect: "自动淘汰",
		},
		{
			// 后果：周期检查不再登记 ⇒ 插件**永远不会自己发现超限**，
			// 缓存会一直涨到用户手动改一次设置为止。
			name: "★ 忘了登记周期定时器（永远不会自己发现超限）",
			from: "\t\tthis.register(() => window.clearInterval(intervalTimer));\n",
			to: "\t\t// 变异：不登记周期定时器的清理\n",
			expect: "清理回调",
		},
		{
			// 后果：同上，但少的是"启动那一轮" —— 它恰好是**唯一**会在索引坏掉时
			// 直接量磁盘的一轮；缺了它，那种情况下上限形同虚设。
			name: "★ 忘了登记启动定时器（索引坏掉时上限永久失效）",
			from: "\t\tthis.register(() => window.clearTimeout(startupTimer));\n",
			to: "\t\t// 变异：不登记启动定时器的清理\n",
			expect: "清理回调",
		},
		{
			// 后果：确认框不再说明后果。用户按下的按钮是**不可逆**的，
			// 而那句话是他在按下之前唯一读到的安全信息 ——
			// 少了它，"删掉就找不回来"这件事只存在于文档里。
			name: "★ 确认框不再说明「无法撤销」（不可逆动作失去唯一的安全提示）",
			from: '\t\t\t\tthis.t("maintainCleanSafety"),\n',
			to: "\t\t\t\t// 变异：去掉安全说明\n",
			expect: "无法撤销",
		},
		{
			// 后果：算出了外链候选却不交给执行层 ⇒ 命令只搬库内文件、外链图原样留着，
			// 而确认框刚刚向用户承诺过会处理它们（用户以为搬完了）。
			name: "★ 算出了外链候选却不交给执行层（确认框承诺了却没做）",
			from: "runBatchUpload(deps, { external });",
			to: "runBatchUpload(deps);",
			expect: "外链图被下载、上传，笔记里的链接被改写",
		},
		{
			// 后果：确认框不再列出即将访问的站点 ⇒ 用户是在**盲签**一份下载许可。
			// 这条命令会真的去访问那些站点，而他看不到是谁。
			name: "★ 确认框不列出即将访问的站点（用户盲签下载许可）",
			from: '\t\t\t\t\thosts: external.sites.map((site) => site.host).join(", "),',
			to: '\t\t\t\t\thosts: "",',
			expect: "确认框必须列出即将访问的站点",
		},
		{
			// 后果：确认了却不记授权 ⇒ 以后每看一次那篇笔记，都会为同一个站点再问一遍。
			name: "★ 确认之后不记住授权（同一个站点每次看笔记都再问一遍）",
			from: '\t\t\t\tif (site.needsConsent) this.siteDecisionsSnapshot().set(site.host, "allow");',
			to: "\t\t\t\t// 变异：不记住授权",
			expect: "确认即授权",
		},
		{
			// 后果：记忆清空了，但**已经渲染出来的图不会自己重跑判定** ⇒
			// 用户点完「清除站点记忆」什么都看不到，只会以为按钮坏了。
			//（另一半原因在编排层：那张"问过就永久记住"的表，见 `mutate-external-hook.mjs`。）
			name: "★ 清除站点记忆后不重看当前打开的笔记（点完按钮什么都没发生）",
			from: "\t\tthis.reprocessOpenNotes();\n",
			to: "\t\t// 变异：不重看当前打开的笔记\n",
			expect: "清除站点记忆之后重新询问当前显示的站外图",
		},
	],
});
