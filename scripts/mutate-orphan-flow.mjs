import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**孤儿流程的编排**（`src/plugin/orphan-flow.ts`）。
 *
 * 与 `mutate-orphan-watch.mjs` / `mutate-orphan-removal.mjs` 的分工：那两个变异的是
 * **判定层**（谁算候选、冷却怎么算、本地该删哪一份）；这里变异的是**编排层** ——
 * 判定层说得再对，编排层把"要不要绕开冷却"接错、把"没有候选"这件事吞掉，
 * 用户看到的同样是"这条命令没用"。
 *
 * ⚠️ 这一段的行为**只在验收环境里观察得到**（要真的读全库正文、真的按档位出声），
 * 所以套件用 `runLoadAcceptance`（与 `mutate-maintenance-run` 同一套做法）。
 *
 * ⚠️ 已知缺口（如实记，别在这里假装测了）：**`always` 档的弹窗被误关 ⇒ 指路那条提示**
 * 需要驱动弹窗（替身里没有真按钮可点），套件覆盖不到 ⇒ 它没有锚点。
 */
await runMutations({
	source: "src/plugin/orphan-flow.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			// 后果：命令也吃冷却 ⇒ 用户想"再来一次"时**什么都不发生**（那个 key 在自动那条路上
			// 已经被问过并记进 `asked`）⇒ 他以为命令坏了，而云端对象永远留着。
			// 这正是用户 2026-10-14 要这条命令的原因（那次询问只自动出现一次）。
			name: "★ 命令也吃冷却（用户想重来一次时什么都不发生）",
			from: "\t\t\thasAsked: (key) => (bypassCooldown ? false : asked.has(key)),",
			to: "\t\t\thasAsked: (key) => asked.has(key),",
			expect: "★ 命令必须能**重来一次**那次询问",
		},
		{
			// 后果：没有候选时**静默** —— 用户按了命令、界面毫无反应 ⇒ 以为它坏了
			//（而这恰恰是"我确实清干净了"的正常结果，必须说出来）。
			name: "★ 没有候选时静默（用户以为命令坏了）",
			from: '\t\tif (orphans.length === 0) {\n\t\t\tnew Notice(ctx.t("orphanNoneToCheck"));\n\t\t\treturn;\n\t\t}',
			to: "\t\tif (orphans.length === 0) {\n\t\t\treturn;\n\t\t}",
			expect: "★ 没有候选时必须如实说",
		},
	],
});
