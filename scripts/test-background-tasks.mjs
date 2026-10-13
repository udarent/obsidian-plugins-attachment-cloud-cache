import { withLoadedTs } from "./lib/load-ts.mjs";
import { runBackgroundTasksSuite } from "./lib/background-tasks-suite.mjs";

/**
 * **后台任务**（启动延迟 + 周期兜底）的测试 —— 设计里的"后台任务"一节（A3）。
 *
 * 这个模块的职责只有一条：**排上的每一条定时器都要在卸载时被取消**。在它之前，
 * 那条不变量是 `onunload` 里手写的四行 `clearTimeout` / `clearInterval` ——
 * 漏一行的后果是插件卸载后仍然去改用户的笔记（热重载时表现为"改了两次"），
 * 而且**不报错**。现在它变成了"表里有几条 → 就登记几条 → 就取消几条"的可数断言。
 *
 * 顺带把**触发点矩阵**钉住：轮换有四个触发点（类型 \`RotationReason\`），
 * 其中两条是这里的定时线、另两条在事件现场。断言要求矩阵覆盖全部四个 ——
 * 于是"加了第五个触发点却没说谁触发它"会当场变红，而不是等下一次 P8 / N11。
 *
 * 断言在 \`lib/background-tasks-suite.mjs\`（与变异验证共用）。
 */
await withLoadedTs("src/plugin/background-tasks", (mod) => {
	const stats = runBackgroundTasksSuite(mod);
	console.log(
		`Background tasks passed (${stats.cases} cases: every task in the table is scheduled with the API that ` +
			"matches its kind, every one registers its own cancellation, dispose clears all of them with the " +
			"matching API (and is idempotent), the callbacks reach the right injected dependency, the rotation " +
			"trigger matrix accounts for all four triggers of RotationReason with the two timer-driven ones " +
			"present in this table, and each task carries its interval and its reason for existing.)"
	);
});
