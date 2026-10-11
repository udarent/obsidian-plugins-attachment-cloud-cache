import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCacheIndexSuite } from "./lib/cache-index-suite.mjs";

/**
 * 缓存索引的测试。
 *
 * 索引记的是「哪个远端 URL 对应哪个本地副本」，所以它错了**不会有任何报错** ——
 * 只会表现为"离线时图不显示"，或"该回退下载时以为本地已有"。
 * 加载时更必须容错：它读失败的时刻恰好是插件启动，在那里抛错用户就直接用不了。
 *
 * ⚠️ 它还带一份**上传台账**（"这个 key 是我们经手过的吗"）。那份数据与本地副本无关：
 * 云端清理的自动入口靠它认领对象，而「不留副本」那一档**没有副本 ⇒ 没有条目** ——
 * 判据若接在条目上，那个入口在该档永不出现（2026-10-11 的 N11）。
 *
 * 断言在 `lib/cache-index-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/cache/index", (mod) => {
	const stats = runCacheIndexSuite(mod);
	console.log(
		`Cache-index tests passed (${stats.entryCases} entry-validation cases, ${stats.urlCases} URL ` +
			`lookup cases, ${stats.ledgerCases} upload-ledger cases: only 2xx-like complete entries are kept, ` +
			"missing fields get safe defaults, 'remove' reports whether it removed, iteration is stably key-sorted, " +
			"lookups normalise host case and trailing slashes but never touch percent-encoding, a different host " +
			"never matches, and every malformed input degrades to an " +
			"empty index with a recorded reason instead of throwing; the ledger remembers what we uploaded " +
			"independently of whether a local copy exists - dropping a copy never drops the ledger, only a real " +
			"cloud delete does, a legacy file with no ledger is backfilled from the entries, and the invariant " +
			"'every entry's key is in the ledger' always holds)."
	);
});
