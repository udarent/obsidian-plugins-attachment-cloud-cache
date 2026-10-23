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
 *
 * ⚠️ 2026-10-22（D-74）**删掉了一条锚点**（原来守"台账空 ⇒ 必须说'没有发现'"）：
 * 那条早退已经不存在了 —— 台账空 ≠ 没事可清（本地孤立文件与台账无关），命令会弹清单。
 * 而"两类都空"在这套夹具里造不出来（库是全局的，前面几十节留下的文件里必然有
 * 没人引用的本地文件）⇒ `orphanNoneToCheck` 这条出口在验收里无法被单独触发。
 * 它的近亲判据仍在：§8i② 断言"云端候选为空时**不许静默**（弹清单或说没有发现）"。
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
			// 后果：**本地孤立文件根本进不了清单** ⇒ 用户要求的"把本地孤立文件也纳入清理"
			// 等于没做（清单里只有云端对象那一类）。
			name: "★★ 本地孤立文件不进清单（只列云端对象）",
			from: "? await collectLocalOrphans(ctx, index, selection.asks, locallyReferenced, notes)",
			to: "? { targets: [], cached: [], skipped: [] }",
			expect: "★★ 从来没有上传过、也没有任何引用的本地文件也要列出来",
		},
		{
			// 后果：**默认把本地孤立文件也勾上** ⇒ 用户顺手点一个"删除"就把从没上传过、
			// 也没有云端可依的文件删了（与「上传附件」里"未引用项默认不勾"同一条纪律的反面）。
			name: "★★ 默认把本地孤立文件也勾上（一次点击就能删掉唯一副本）",
			from: "\t\t\t\tinitiallySelected: cloudInputs.map((input) => input.id),",
			to: "\t\t\t\tinitiallySelected: [...cloudInputs, ...vaultInputs].map((input) => input.id),",
			expect: "★★ 默认只勾云端对象",
		},
		{
			// 后果：**两个类别开关点了没反应** ⇒ 用户想"只看本地"或"只看云端"时清单不动
			//（用户 2026-10-22 明确要的过滤能力）。
			name: "★★ 类别过滤开关点了没反应（清单永远全量）",
			from: "\t\t\t\tonFiltersChange: (state) => Promise.resolve(buildView(state)),",
			to: "\t\t\t\tonFiltersChange: () => Promise.resolve(buildView({ cloud: true, local: true })),",
			expect: "★★ 关掉「云端对象」后只剩本地文件那一类",
		},
		{
			// 后果：**标题又变成一句疑问**（"要清理这些…吗？"）⇒ 与「上传附件」那张
			// 名词式标题（＝命令名）不是一个产品，而用户 2026-10-22 明确要求两屏统一风格。
			name: "★★ 清单弹窗的标题又是疑问句（与命令名不一致）",
			from: '\t\t\t\ttitle: ctx.t("orphanListTitle"),',
			to: '\t\t\t\ttitle: ctx.t("orphanTitle"),',
			expect: "清单弹窗的标题 = 命令名",
		},
		{
			// 后果：**顶部又随内容变**（把行数拼进那句固定说明）⇒ 用户换一次过滤，
			// 顶部就变一次 —— 正是 D-72 / D-76 要消掉的东西（数量该在按钮上）。
			name: "★★ 顶部又把数量拼进去（换过滤器就变一次）",
			from: "\t\t\t\t\tlines: [ctx.t(\"orphanListBody\")],",
			to: "\t\t\t\t\tlines: [ctx.t(\"orphanListBody\") + \" \" + shown.length],",
			expect: "顶部是**固定说明**",
		},
		{
			// 后果：**按下去之前不知道会动几个** —— 两个删除档的文案退化成固定字数，
			// 而这两下都是不可撤销的（云端那半删掉找不回来）。
			name: "★★ 删除档的文案不带数量（按下去之前不知道动几个）",
			from: '\t\t\t\t\t{ key: "local", label: (count) => ctx.t("orphanLocalOnly", { count }) },',
			to: '\t\t\t\t\t{ key: "local", label: () => ctx.t("orphanLocalOnly", { count: 1 }) },',
			expect: "这一档要说清**动几个**",
		},
	],
});
