/**
 * 排障日志的断言套件（正式测试与变异验证共用）。
 *
 * ## 这些断言守的是什么
 *
 * `debug-log.ts` 只有两个函数、二十行，但它守着一个很容易做错、且**做错后没人发现**的东西：
 * 开关的方向。反过来的两种错法都不会报错，只会让"排障"这件事本身失效：
 * - **关着还打** ⇒ 用户的控制台被刷屏，而支持者收到一堆与本次无关的日志（更糟：他以为那是本次的）；
 * - **开着不打** ⇒ 用户在设置里勾了、按了命令、控制台空空，于是结论变成"插件坏了"。
 *
 * 另外两条：前缀（`[attachment-cloud-cache]`）是**唯一**能在混着宿主与其他插件输出的控制台里
 * 筛出来的东西；耗时必须是**这次**的（`startedAt` 由调用方给，不能是 0）。
 *
 * ⚠️ 这里直接替换 `console.debug` 来观察：日志是这种横切关注点里**唯一**的可观测出口，
 * 替身比"让调用方返回字符串"更贴近真实行为（真的写进了控制台）。
 * ⚠️ 出口**只能**是 `console.debug`（Obsidian 的 `no-console` 只允许 warn/error/debug，
 * 且 `obsidianmd/*` 被配置为不可 disable）—— 所以"级别"没有第二选项可验，这里只验"真的打出来了"。
 */

import assert from "node:assert/strict";

/** 与 `src/debug-log.ts` 一致的过滤前缀（测试**不**从模块里拿它：它没导出，而这里要独立断言）。 */
const PREFIX = "[attachment-cloud-cache]";

export function runDebugLogSuite(mod) {
	const { debugLog, debugTimed } = mod;
	const calls = [];
	const original = console.debug;
	console.debug = (...args) => void calls.push(args);
	try {
		// ① 关着：**一行都不打**（连参数都不碰）
		calls.length = 0;
		debugLog(false, "不该出现");
		debugTimed(false, "也不该出现", Date.now());
		assert.deepEqual(calls, [], "★★ 关着时不许往控制台写任何东西");

		// ② 开着：带前缀、带数据
		calls.length = 0;
		debugLog(true, "引用快照", { 笔记: 3 });
		assert.equal(calls.length, 1, "开着时应当恰好一条");
		assert.equal(calls[0][0], `${PREFIX} 引用快照`, "★ 首参是「前缀 + 文案」（前缀是唯一的过滤依据）");
		assert.deepEqual(calls[0][1], { 笔记: 3 }, "★ 计数对象原样传出（控制台里可展开）");

		// ③ 没有数据时**只给一个参数**：别塞一个空对象，那会让控制台多一行空白。
		// ⚠️ 先断言"这一行确实打出来了"：两条出口是**两行代码**，
		// 只钉带 data 的那条，另一条（大多数阶段日志走的正是它）可以悄悄不输出。
		calls.length = 0;
		debugLog(true, "只有一句话");
		assert.equal(calls.length, 1, "★★ 无数据的出口也必须打出来（大多数阶段日志走这一条）");
		assert.equal(calls[0].length, 1, "没有数据时不该补一个空对象");

		// ④ 耗时：用的是**调用方给的时刻**，不是 0、也不是模块加载时刻
		calls.length = 0;
		debugTimed(true, "占用报告", Date.now() - 40, { 条目: 2 });
		assert.equal(calls.length, 1, "耗时那条也要打");
		assert.match(
			calls[0][0],
			/^\[attachment-cloud-cache\] 占用报告（\d+ ms）$/,
			"★★ 文本形如「<文案>（N ms）」"
		);
		const ms = Number(calls[0][0].match(/（(\d+) ms）/)[1]);
		assert.ok(ms >= 40, `★★ 耗时必须是这次的（从 startedAt 算起），实际 ${ms} ms`);

		// ⑤ 时钟被倒拨 / 传入未来时刻 ⇒ 不许出现负数（负数会让人以为写错了单位）
		calls.length = 0;
		debugTimed(true, "时钟倒退", Date.now() + 60000);
		assert.match(calls[0][0], /（0 ms）/, "★★ 算不出正数时按 0 报（不写负数）");
	} finally {
		console.debug = original;
	}

	return { cases: 5 };
}
