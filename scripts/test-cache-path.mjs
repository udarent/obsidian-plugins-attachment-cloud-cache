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
		"Cache-path tests passed (mirror is 1:1 with the bucket, flat/byExt stay injective, " +
			"all layouts reject traversal and empty keys, isUnderCacheFolder guards cleanup)."
	);
});
