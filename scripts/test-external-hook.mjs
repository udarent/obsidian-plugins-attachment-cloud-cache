import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalHookSuite } from "./lib/external-hook-suite.mjs";

/**
 * 站外缓存编排的测试。
 *
 * 执行层是注入的接缝，所以这套完全不需要网络与磁盘
 *（站点记忆那一层已经拆掉，不再需要把 `site-decisions` 打进 bundle）。
 */
await withLoadedTs(["src/render/external-hook"], async (mod) => {
	await runExternalHookSuite(mod);
	console.log(
		"External-hook tests passed (one fetch per URL even when the same image renders repeatedly, inflight is released " +
			"on failure so a retry still works, a throwing image never stops the next one, no note path means nothing is " +
			"fetched, and the default setting really decides: 'leave it alone' fetches nothing at all while 'cache " +
			"straight away' does the work)."
	);
});
