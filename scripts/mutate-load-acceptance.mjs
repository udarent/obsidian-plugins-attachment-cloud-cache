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
		// ⚠️ 原有两条盯着**定时器登记**的锚点（"忘了登记周期/启动定时器"）——
		// 2026-10-13（A1 第八批）定时器收进 `plugin/background-tasks.ts` 的那张表之后，
		// 它们**被更强的断言取代了**（见 `mutate-background-tasks.mjs`）：
		// 那里不再靠"端到端跑一遍时有没有清理回调"，而是直接断言
		// "表里有几条 → 就该排上几条 → 就该登记几条取消 → dispose 就该取消几条"。
		// ⚠️ 原来那两条的意图（"周期线整条没了" / "启动那轮没了"）也各有对应锚点：
		// 删掉表里那一条、以及"漏登记取消"那条。
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
			// ⭐ R17 的**接线**（用户 2026-10-14 报"删掉最后一个副本后没问要不要删云端"时，
			// 本地无法证伪 —— 因为替身的 `vault.on` 以前把注册吞掉、这条链一次都跑不到）。
			// 后果：引用消失了也**没人知道** ⇒ 孤儿询问永不出现（对象再也回不来）。
			// ⚠️ 打的是**接线内部那一句**，不是整行 `registerEvent`：后者会先撞上
			// "四条事件必须真的接上线"那条注册断言，报出来的原因就成了"没注册"，
			// 而这条锚点要证明的是**更深的**那件事 —— 注册在、流程却收不到通知。
			name: "★ 笔记改动不再喂给孤儿流程（引用消失不问，云端对象永远留着）",
			from: "(file) => this.orphanFlow?.fileChanged(file)",
			to: "() => {}",
			expect: "引用消失了 ⇒ 必须出声",
		},
		{
			// ⭐ 上传前的云端探测**没接线**（用户 2026-10-14 报的第二件事）。
			// 后果：撞名副本照样把整份字节重传一遍（"并不需要上传，只要更新链接"）——
			// 而模块层的套件照样全绿：`ingest.ts` 那条路是对的，只是**没人给它这个能力**。
			// 这正是"层坏了"与"没人调用"必须分开盯的例子（本项目踩过多次）。
			name: "★ 上传前不问云端（撞名副本把整份字节又传一遍）",
			from: "\t\t\t\t\t\tprobeRemote: (key) => this.probeRemoteObject(key),\n",
			to: "\t\t\t\t\t\t// 变异：不接云端探测\n",
			expect: "一个字节都不许重传",
		},
		// ⚠️ 这里原有两条盯着"存量清理的两条准入判据"（台账 / 带远端链接）的锚点 ——
		// 2026-10-13（A1 第四批）它们随 `localSpaceSelection` 搬进
		// `src/plugin/release-space-flow.ts` 时**一并搬走了**（见 `mutate-release-space-flow.mjs`）。
		// ⚠️ 这不是锚点失效，而是锚点当时**指向了文件**（main.ts）而不是**通路**：
		// 实现搬到哪，锚点就跟到哪；原地留着只会变成"找不到目标"（假绿）。
		// 本文件（入口接线）继续管它自己那摊事。
		// ⚠️ 这里原有四条盯着**「上传已有附件」那条命令**的锚点（确认闸 / "文件留在原地" /
		// 外链候选被交给执行层 / 确认框列出站点）—— 2026-10-13（A1 第六批）它们随那条流程的编排
		// 搬进 `src/plugin/upload-existing-flow.ts` 时**一并搬走了**（见 `mutate-upload-existing-flow.mjs`）。
		// ⭐ 判据没变（还是本文件用的那个端到端验收套件），换的只是"打坏哪一行"。
		// ⚠️ 锚点"找不到目标"= 它从来没在跑（假绿），比"跑失败"更糟 —— 所以必须跟着实现搬。
		{
			// 后果：这条命令**没注册** ⇒ 功能"写了但用户找不到"（用户在 Android 上要的正是它：
			// 那次三档询问被误关之后能自己重来一次）。
			// 套件里"六条维护命令都要注册"那条断言（逐个 id 比对）会先说话。
			name: "★ 新命令没注册（功能写了但用户找不到）",
			from: '\t\t\tid: "check-orphans",',
			to: '\t\t\tid: "check-orphans-disabled",',
			expect: "★ 六条维护命令都要注册",
		},

	],
});
