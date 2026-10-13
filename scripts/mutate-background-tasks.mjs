import { runMutations } from "./lib/mutate.mjs";
import { runBackgroundTasksSuite } from "./lib/background-tasks-suite.mjs";

/**
 * 变异验证：**后台任务**（`src/plugin/background-tasks.ts`）。
 *
 * 锚点的选法与前几个模块不同：这里没有业务判定，只有一条不变量 ——
 * **排上的每一条定时器都要被取消**。所以锚点全部冲着"让某一条漏掉"去：
 * 漏登记、漏取消、用错取消 API、表与矩阵对不上。
 *
 * ⚠️ 这几条在真机上**不报错**，只在插件卸载后（热重载 / 切库）表现为
 * "它还在跑"：改用户的笔记、弹一个"要不要删云端"。靠人读 `onload` 是防不住的。
 *
 * 断言套件与正式测试共用（`lib/background-tasks-suite.mjs`）。
 */
await runMutations({
	source: "src/plugin/background-tasks.ts",
	suite: runBackgroundTasksSuite,
	mutations: [
		{
			// 后果：有一条定时器**没有登记取消** ⇒ 插件卸载后它还在跑（`onunload` 里没有手写兜底了）。
			name: "★★ 有一条定时器没登记取消（卸载后它还在跑）",
			from: '\t\tregister(() => clear(task.id));',
			to: "\t\t// 变异：不登记取消",
			expect: "每条都要登记取消",
		},
		{
			// 后果：卸载时只清掉"延迟一次"那两条，**周期线全都留着** ——
			// 而周期线正是那个"每隔十分钟去改用户笔记"的东西。
			// ⚠️ 锚点**只取这一行**（2026-10-13 修）：它上面是三条承重注释（为什么先取快照、
			// 为什么 `[...keys()]` 看起来多余却必须留）。原来的锚点从 `dispose() {` 一路跨到这一行，
			// 于是在某次给那段加注释时**静默失效** —— 预检报"找不到目标"，也就是它**从来没在跑**。
			// 教训：锚点别跨注释块；跨了就会在注释被改的那天无声死掉。
			name: "★★ dispose 漏掉周期线（卸载后每 10 分钟还会跑一轮）",
			from: '\t\t\tfor (const id of [...handles.keys()]) clear(id);',
			to: '\t\t\tfor (const id of [...handles.keys()]) if (handles.get(id)?.kind !== "interval") clear(id);',
			expect: "排上几条就该取消几条",
		},
		{
			// ⚠️ 从 mutate-load-acceptance 搬来（A1 第八批）。后果：**周期线整条没了** ⇒
			// 插件永远不会自己发现超限，缓存会一直涨到用户手动改一次设置为止。
			// ⚠️ 原锚点钉的是 `main.ts` 里那行 `this.register(() => window.clearInterval(...))`
			//（删掉它 = 既不排也不清）。现在定时器排在哪由这张表说了算，
			// 所以锚点也跟着挪到这里：**删掉表里那一条**就是同一个后果。
			name: "★ 表里删掉周期线（永远不会自己发现超限）",
			from: '\t\t{\n\t\t\tid: "rotation-interval",\n\t\t\tkind: "interval",\n\t\t\teveryMs: ROTATION_CHECK_INTERVAL_MS,\n\t\t\twhy: "周期性兜底：先走便宜的门槛（内存求和），没超就直接返回",\n\t\t\trun: () => deps.rotate("interval"),\n\t\t},\n',
			to: "",
			// ⚠️ 照实跑写：先说话的是"周期线是两条"那条（表里少一条，先撞上它）
			expect: "周期线是两条",
		},
		{
			// 后果：把周期线排成"只跑一次" ⇒ 兜底永远不会发生（那条线看起来还在，实际只跑一遍）。
			name: "★ 周期线用 setTimeout 排（兜底只跑一次）",
			from: "\t\t\t\t? window.setInterval(task.run, task.everyMs)",
			to: "\t\t\t\t? window.setTimeout(task.run, task.everyMs)",
			// ⚠️ 照实跑写：先说话的是「这条任务没有对应的定时器」（比「周期线是两条」更精确）
			expect: "没有对应的定时器",
		},
		{
			// 后果：取消时不看种类，一律 `clearTimeout` —— 对 interval **不生效**，而且不报错。
			name: "★ 取消一律用 clearTimeout（对周期线不生效，且不报错）",
			from: '\t\tif (entry.kind === "interval") window.clearInterval(entry.handle);\n\t\telse window.clearTimeout(entry.handle);',
			to: "\t\twindow.clearTimeout(entry.handle);",
			expect: "取消的 API 必须与排的配对",
		},
		{
			// 后果：矩阵漏掉一个触发点 ⇒ "某个触发点整条线没接上"（P8 / N11 同形）又变得看不出来。
			name: "★★ 触发点矩阵漏掉一个（谁触发它？没人知道）",
			from: '\t{ reason: "growth", by: "一次上传让占用涨了", where: "main.ts 的粘贴/上传那条链" },\n',
			to: "",
			// ⚠️ 照实跑写：先说话的是「个数变了」那条（漏一条必然个数不对）
			expect: "触发点个数变了",
		},
		{
			// 后果：自愈排在轮换**之前**（或同刻）⇒ 与索引加载、渲染钩子挂载、引用快照建快照抢同一段启动窗口。
			name: "★ 自愈的启动时机提到轮换之前（抢启动窗口）",
			from: "export const SELF_HEAL_STARTUP_DELAY_MS = 8 * 1000;",
			to: "export const SELF_HEAL_STARTUP_DELAY_MS = 2 * 1000;",
			expect: "自愈的启动延迟必须晚于轮换那一轮",
		},
	],
});
