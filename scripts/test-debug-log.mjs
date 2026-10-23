import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDebugLogSuite } from "./lib/debug-log-suite.mjs";

/**
 * 排障日志的测试。
 *
 * 它只有两个函数，但守着一个**做错后没人发现**的方向：开关。反过来的两种错法
 * （关着还打 / 开着不打）都不报错，只会让"排障"本身失效 —— 用户勾了设置、跑完命令、
 * 控制台空空，结论就变成"插件坏了"。所以这里逐条钉住：关着零输出、开着带前缀与数据、
 * 没有数据时不塞空对象、耗时从调用方给的时刻算起且不出现负数。
 *
 * 断言在 `lib/debug-log-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/debug-log", async (mod) => {
	const stats = await runDebugLogSuite(mod);
	console.log(
		`Debug-log tests passed (${stats.cases} cases: nothing is written while the switch is off, ` +
			"one line per stage while it is on, every line carries the filterable prefix (the only way to pick " +
			"ours out of the host's own output), both outlets actually emit - the one without counts is the path " +
			"almost every stage takes, so it is pinned separately - a line without " +
			"counts does not get an empty object appended, and the millisecond figure comes from the " +
			"caller's start time — never negative, even if the clock jumps back)."
	);
});
