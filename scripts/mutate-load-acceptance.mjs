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
			// 后果：维护命令不再请求确认 ⇒ 用户在命令面板里点错一下就开始改笔记、
			// 下载站外图（"取消 = 什么都没发生"这条路径整个不存在了）。
			// ⚠️ 1.2.0（D-17）：原锚点钉的是 `clean-cache` 的确认闸（随命令退役），
			// 现在改钉**批量上传**的同一道闸 —— 它是同一类风险，且套件里有会红的断言。
			name: "★ 维护命令不再请求确认（点错命令即改笔记、下载站外图）",
			from: "\t\tif (!confirmed) {\n\t\t\tnew Notice(this.t(\"maintainCancelled\"));\n\t\t\treturn;\n\t\t}\n\n\t\tconst result = await runBatchUpload(deps, { external, referencedPaths });",
			to: "\t\tvoid confirmed;\n\t\tconst result = await runBatchUpload(deps, { external, referencedPaths });",
			expect: "取消之后",
		},
		{
			// 后果：整条站外链路在入口上断掉 —— 用户开了功能、也被问了，
			// 但点了「缓存」之后什么都没发生（除了一个再也不会来的通知）。
			name: "★ 后处理器里不接站外编排（用户点了「缓存」却什么都不发生）",
			from: "\t\t\tthis.externalHook?.process(element, ctx);\n",
			to: "\t\t\t// 变异：不接站外编排\n",
			expect: "站外图被下载",
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
			// ⚠️ 这条的判据必须是"保存设置**调用过**检查"，而不是"最终确实淘汰了" ——
			// 后者"索引长大"那条触发线也能做到，于是删掉这行调用套件照样通过（实测漏过）。
			expect: "保存设置必须立刻触发一轮上限检查",
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
			// 后果：确认框不再说清"文件留在原地、只有链接会变"。
			// 用户的预期是从前那句"会被搬进缓存目录"来的 —— 少了这句，他跑完发现
			// 文件还在会以为没生效（反过来也可能以为文件被搬走了）。
			// 而"这动作动不动我的文件"正是他按下按钮前唯一的依据。
			// ⚠️ 1.2.0（D-17）：原锚点钉的是 `maintainCleanSafety`（键随 clean-cache 退役），
			// 现在改钉批量上传确认框里那句"文件留在附件目录"。
			name: "★ 确认框不再说清文件留在原地（用户以为没生效或以为文件被搬走）",
			from: '\t\t\tthis.t("maintainBatchOriginalsStay"),\n',
			to: "\t\t\t// 变异：去掉'留在原地'的说明\n",
			expect: "留在附件目录",
		},
		{
			// 后果：算出了外链候选却不交给执行层 ⇒ 命令只搬库内文件、外链图原样留着，
			// 而确认框刚刚向用户承诺过会处理它们（用户以为搬完了）。
			name: "★ 算出了外链候选却不交给执行层（确认框承诺了却没做）",
			// ⚠️ 只摘掉 `external` —— 把整份 options 都去掉会让它变成"少传参数"的报错，
			// 那样测到的就不是"外链那趟被跳过"了（这是本项目说的"变异的原因要对得上"）。
			from: "runBatchUpload(deps, { external, referencedPaths });",
			to: "runBatchUpload(deps, { referencedPaths });",
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
			// 后果：站外图那条判定是**渲染时**做的，改设置不会让它重跑 ⇒
			// 用户把默认值改成「直接缓存」之后什么都看不到，要等下次重开笔记才生效
			//（"改了设置没反应"是本项目一直在防的一类症状）。
			name: "★ 改完设置不重看当前打开的笔记（改了默认行为却看不到效果）",
			from: "\t\tif (this.settings.externalImageCache) this.reprocessOpenNotes();\n",
			to: "\t\t// 变异：不重看当前打开的笔记\n",
			expect: "立刻重看当前打开的笔记",
		},
		{
			// ⚠️ F18（2026-10-12 / D-19）的**入口**：切到「不留副本」那一刻问一次。
			// 后果：不问 ⇒ 库里的存量副本永远留着，而用户以为"选了不留副本就都清了"
			//（这一档的承诺只兑现了一半，且界面上看不出来）。
			name: "★ 切到「不留副本」不再问一次（存量副本永远留着）",
			from: '\t\tif (\n\t\t\tpreviousLocalCopy !== undefined &&\n\t\t\tpreviousLocalCopy !== this.settings.localCopy &&\n\t\t\tthis.settings.localCopy === "trash"\n\t\t) {',
			to: "\t\tif (false) {",
			expect: "切档时**问一次**",
		},
		{
			// 后果：候选不再要求"该对象**被笔记引用着**" ⇒ 连**孤儿**一起清 ——
			// 而孤儿正是"用户可能还想留着"的那一类（笔记删了、图还在），
			// 且它越过了与 R17 三档询问的分工线（那条线是**逐次询问**）。
			name: "★ 存量清理不再要求「带远端链接」（孤儿也被一起清掉）",
			from: "\t\t\treferencedKeys,\n\t\t});",
			to: "\t\t\treferencedKeys: new Set(entries.map((entry) => entry.key)),\n\t\t});",
			expect: "孤儿（没有任何笔记引用）不归它管",
		},
		{
			// 后果：候选不再要求"这个对象是我们传上去的" ⇒ 一个**从没上传成功**的
			// 本地附件也会被删，而它云端可能根本没有 —— 那是真正丢数据的一条。
			name: "★★ 存量清理不再查上传台账（没传成功过的本地文件也会被删）",
			from: "\t\t\tuploaded: new Set(index.uploadedKeys()),",
			to: "\t\t\tuploaded: new Set(entries.map((entry) => entry.key)),",
			expect: "台账里没有的对象不得删",
		},
	],
});
