import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCacheIndexSuite } from "./lib/cache-index-suite.mjs";

/**
 * 缓存索引的测试。
 *
 * 索引记的是「哪个远端 URL 对应哪个本地副本」，所以它错了**不会有任何报错** ——
 * 只会表现为"离线时图不显示"，或"该回退下载时以为本地已有"。
 * 加载时更必须容错：它读失败的时刻恰好是插件启动，在那里抛错用户就直接用不了。
 *
 * 断言在 `lib/cache-index-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/cache/index", (mod) => {
	const stats = runCacheIndexSuite(mod);
	console.log(
		`Cache-index tests passed (${stats.entryCases} entry-validation cases, ${stats.urlCases} URL ` +
			"lookup cases: only 2xx-like complete entries are kept, missing fields get safe defaults, " +
			"'remove' reports whether it removed, iteration is stably key-sorted, lookups normalise " +
			"host case and trailing slashes but never touch percent-encoding, a different host never " +
			"matches, pruneMissing only edits the index, and every malformed input degrades to an " +
			"empty index with a recorded reason instead of throwing)."
	);
});
