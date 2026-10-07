import { withLoadedTs } from "./lib/load-ts.mjs";
import { runEvictionSuite } from "./lib/eviction-suite.mjs";

/**
 * 缓存上限与自动轮换的纯判定测试。
 *
 * 这一层决定**自动删哪些缓存副本**（进回收站），所以判定必须穷举。
 * 真正碰磁盘的那部分由 `test-rotation.mjs` 与入口验收覆盖。
 */
await withLoadedTs(["src/maintenance/eviction", "src/cache-path", "src/records"], (mod) => {
	runEvictionSuite(mod);
	console.log(
		"Eviction tests passed (victims picked by last-use with unreferenced copies first, a freshly cached copy is never " +
			"a victim, 'keep' copies living in the attachment folder are never candidates, orphans on disk become candidates " +
			"with an empty key, whole files only — never a partial delete, byte counts read from disk rather than the index, " +
			"stable ordering under ties, and the remaining overage reported honestly)."
	);
});
