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
			from: "\t\tthis.registerMarkdownPostProcessor((element) => {",
			to: "\t\tvoid ((element) => {",
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
	],
});
