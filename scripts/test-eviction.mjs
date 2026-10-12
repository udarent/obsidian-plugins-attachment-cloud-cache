import { withLoadedTs } from "./lib/load-ts.mjs";
import { runEvictionSuite } from "./lib/eviction-suite.mjs";

/**
 * 缓存上限与自动轮换的纯判定测试。
 *
 * 这一层决定**自动删哪些缓存副本**（进回收站），所以判定必须穷举。
 * 真正碰磁盘的那部分由 `test-rotation.mjs` 与入口验收覆盖。
 */
await withLoadedTs(["src/maintenance/eviction", "src/records"], (mod) => {
	runEvictionSuite(mod);
	console.log(
		"Eviction tests passed (candidates and the size total both come from INDEX ∩ DISK: only copies that really exist " +
			"count towards the total, so a stale row whose file is gone can never inflate the overage and make the limit " +
			"delete real copies; copies living in the attachment folder count just like legacy ones, and a file the index " +
			"does not know is never a candidate (the old 'orphan on disk' category is gone: such a file could be the user's " +
			"own attachment); victims picked by last-use with unreferenced copies first; a freshly used copy is never a " +
			"victim; whole files only — never a partial delete; stable ordering under ties; and the remaining overage " +
			"reported honestly)."
	);
});
