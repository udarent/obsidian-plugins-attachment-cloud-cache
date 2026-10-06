import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCachePathSuite } from "./lib/cache-path-suite.mjs";

/**
 * 缓存路径推导的测试。
 *
 * 两条硬要求：**确定性**（同一 key 永远推出同一路径，否则缓存永远命中不了）
 * 与**单射**（不同 key 不撞同一路径，否则两张图互相覆盖 —— 而且覆盖是静默的）。
 *
 * 断言在 `lib/cache-path-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/cache-path.ts", (mod) => {
	runCachePathSuite(mod);
	console.log(
		"Cache-path tests passed (the cache path is 1:1 with the object key, dirty cache folders are " +
			"normalized, distinct keys never collide (including case), traversal and empty keys are " +
			"rejected, and isUnderCacheFolder guards cleanup against deleting notes)."
	);
});
