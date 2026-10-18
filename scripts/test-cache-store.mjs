import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCacheStoreSuite } from "./lib/cache-store-suite.mjs";

/**
 * 索引持久化的测试（`src/cache/store.ts`）。
 *
 * 读失败必须能继续跑（它是启动路径），写必须原子（不能留半截文件）。
 * 断言在 `lib/cache-store-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/cache/store"], async (mod) => {
	const stats = await runCacheStoreSuite(mod);
	console.log(
		`Cache-store tests passed (${stats.loadCases} load cases: index path normalisation, missing file is ` +
			"first-run (not an error), unreadable file and broken JSON both degrade to an empty index with the " +
			"reason kept; a valid index round-trips, and saving writes the entries through an atomic rename)."
	);
});
