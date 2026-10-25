import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**孤儿流程的编排层**（`src/plugin/orphan-flow.ts`）。
 *
 * 与 `mutate-orphan-watch.mjs` 的分工：那个变异的是**判定层**（谁算候选、冷却怎么算）；
 * 这里变异的是**编排层** —— 判定层说得再对，编排层把"该不该出声"接错、把"没有候选"
 * 这件事吞掉，用户看到的同样是"删了引用但插件什么都不做"。
 *
 * ## ⚠️ 2026-10-25：弹窗那半随设置项一起退役
 *
 * 从前这里守的是三选一弹窗的编排（标题/正文/两个删除档的按钮数字）。设置页的
 * 「云端清理」组取消之后，这条流程**只剩一个出口**：一条不阻塞的通知
 * （删除动作全部收在附件管理的「待清理」筛选里）。
 * ⇒ 锚点改成守那个出口本身 —— 它现在是这条链**唯一**能被观察到的东西。
 */
await runMutations({
	source: "src/plugin/orphan-flow.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			// 后果：**一声不吭** —— 用户删掉了最后一条引用，插件什么都不说，
			// 那个附件于是既不在笔记里出现、也没人提醒他「待清理」里有一份可以处理的东西
			//（而 R17 的全部价值就是"让他知道可以清"）。
			name: "★ 有候选却不出声（删了引用后什么都没发生）",
			from: "\t\tif (selection.asks.length === 0) return;",
			to: "\t\tif (true) return;",
			expect: "★ 引用消失了 ⇒ 必须出声（`notice` 档：一条通知，且数量如实）",
		},
	],
});
