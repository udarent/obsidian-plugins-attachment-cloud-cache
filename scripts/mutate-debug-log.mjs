import { runMutations } from "./lib/mutate.mjs";
import { runDebugLogSuite } from "./lib/debug-log-suite.mjs";

/**
 * 变异验证：排障日志。
 *
 * 这个模块没有业务后果，它守的是**排障本身能不能用**。五种错法都不报错：
 * - **关着还打** ⇒ 控制台刷屏，支持者收到一堆与本次无关的日志，还会当成本次的；
 * - **开着不打** ⇒ 用户勾了设置、跑完命令、控制台空空 ⇒ 结论变成"插件坏了"；
 * - **丢前缀** ⇒ 混在宿主与其他插件的输出里筛不出来（前缀是唯一的过滤依据）；
 * - **耗时不算** ⇒ 永远 `0 ms`，于是"哪一段慢"这个唯一的问题答不了。
 *
 * ⚠️ 两条出口（有 data / 无 data）是**两行代码**，各钉一条：
 * 只钉带 data 的那条会漏掉真实路径 —— **几乎所有阶段日志都不带 data**。
 */
await runMutations({
	source: "src/debug-log.ts",
	suite: runDebugLogSuite,
	mutations: [
		{
			// 后果：关着也在写控制台 —— 而这条路的默认值就是关（出厂 `false`），
			// 于是每个用户都在刷屏，且没人知道哪些行是本次的。
			// ⚠️ `if (!enabled) return;` 在文件里出现两次（`debugLog` 与 `debugTimed`），
			// `from` 必须带下一行才唯一。
			name: "★★ 开关关着时仍然写控制台（每个用户的控制台都被刷屏）",
			from: "\tif (!enabled) return;\n\tif (data === undefined)",
			to: "\tif (false) return;\n\tif (data === undefined)",
			expect: "关着时不许往控制台写任何东西",
		},
		{
			// 后果：**带耗时的那条不受开关管** ⇒ 用户关掉之后还是会看到「占用报告（N ms）」，
			// 于是他会以为"开关没生效"（而这正是他最可能去确认的一件事）。
			name: "★★ 带耗时那条无视开关（关掉之后还在打）",
			from: "\tif (!enabled) return;\n\tdebugLog(true,",
			to: "\tif (false) return;\n\tdebugLog(true,",
			expect: "关着时不许往控制台写任何东西",
		},
		{
			// 后果：**控制台里筛不出来** —— 宿主的日志、其他插件的日志与我们的混在一起，
			// 而用户被要求"把相关的那几行贴过来"时无法分辨哪几行是相关的。
			name: "★★ 丢了过滤前缀（在控制台里筛不出来）",
			from: 'console.debug(`${PREFIX} ${message}`, data);',
			to: 'console.debug(`${message}`, data);',
			expect: "首参是「前缀 + 文案」",
		},
		{
			// 后果：**无数据的那条不再输出** —— 而它正是**几乎所有阶段日志**走的路径
			//（只有少数带计数对象）⇒ 开关开了、控制台只剩零星几行。
			name: "★★ 无数据的出口不再输出（大多数阶段日志消失）",
			from: 'console.debug(`${PREFIX} ${message}`);',
			to: "void 0;",
			expect: "无数据的出口也必须打出来",
		},
		{
			// 后果：**耗时永远是 0 ms** ⇒ "哪一段慢"这个唯一要靠它回答的问题答不了，
			// 而 0 又看起来像"这段根本没跑"。
			name: "★★ 耗时永远算成 0（分不清哪一段慢）",
			from: "Math.max(0, Date.now() - startedAt)",
			to: "0",
			expect: "耗时必须是这次的",
		},
	],
});
