import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**孤儿流程的编排层**（`src/plugin/orphan-flow.ts`）。
 *
 * 与 `mutate-orphan-watch.mjs` / `mutate-orphan-removal.mjs` 的分工：那两个变异的是
 * **判定层**（谁算候选、冷却怎么算、本地该删哪一份）；这里变异的是**编排层** ——
 * 判定层说得再对，编排层把"该不该出声"接错、把"没有候选"这件事吞掉，
 * 用户看到的同样是"删了引用但插件什么都不做"。
 *
 * ## ⚠️ 2026-10-24：从 7 条缩到 1 条，删掉的 6 条都**失去了对象**
 *
 * 原先这 7 条守的是**命令那条路**（`presentOrphans(keys, true)` 的清单弹窗：两个类别开关、
 * 默认勾选、两个删除档的按钮数字、标题/正文的措辞）。命令面板收敛成「附件管理」之后，
 * `bypassCooldown` **恒为 `false`** ⇒ 那条路整段不可达，对应断言也随清单在 CR-02 一起退役
 * ⇒ 那 6 条全部报「漏过（测试无牙）」。它们连同那段代码一起删掉了（不是把断言改软）。
 *
 * ⚠️ 剩下这一条是这条路**唯一还能被观察到的出口**：`notice` 档必须出声。
 * `always` 档要驱动弹窗上的三个按钮（`askOrphanCloudDelete` 直接 `new Modal`，
 * 替身里没有真按钮可点）⇒ 它**仍然是已知缺口**，别在这里假装测了（要测就得先给那个弹窗
 * 做一层可驱动的替身）。
 */
await runMutations({
	source: "src/plugin/orphan-flow.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			// 后果：**`notice` 档一声不吭** —— 用户删掉了最后一条引用，插件什么都不说，
			// 那个云端对象永远留着（而 R17 的全部价值就是"让他知道可以清"）。
			// ⚠️ 变异成 `never` 之后代码**继续往下走**去弹 always 那个三选一，
			// 于是症状是"该出声时没出声、反倒弹了个窗" —— 正是接线接错的样子。
			name: "★ `notice` 档不出声（删了引用却什么都没发生）",
			from: '\t\tif (mode === "notice") {',
			to: '\t\tif (mode === "never") {',
			expect: "★ 引用消失了 ⇒ 必须出声（`notice` 档：一条通知，且数量如实）",
		},
	],
});
