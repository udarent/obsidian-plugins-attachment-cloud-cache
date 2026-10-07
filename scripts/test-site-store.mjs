import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSiteStoreSuite } from "./lib/site-store-suite.mjs";

/**
 * 站点决定记忆持久化的测试。
 *
 * 需要 `src/render/site-decisions` 一起进 bundle：套件同时断言"load 出来的确实是
 * 一份可用的 SiteDecisions"。宿主替身通过 `mock-obsidian.mjs` 提供（真实磁盘）。
 */
await withLoadedTs(["src/host/site-store", "src/render/site-decisions"], async (mod) => {
	await runSiteStoreSuite(mod);
	console.log(
		"Site-store tests passed (write to a temp file then rename within the same directory so a crash never leaves " +
			"half a JSON, parent folders created first so a deleted plugin folder heals, no temp file left behind, " +
			"and unreadable or malformed data degrades to empty memory instead of keeping the plugin from starting)."
	);
});
