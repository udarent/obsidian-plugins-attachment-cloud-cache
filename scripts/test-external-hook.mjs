import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalHookSuite } from "./lib/external-hook-suite.mjs";

/**
 * 站外缓存编排的测试。
 *
 * 需要 `site-decisions` 一起进 bundle（编排要读记忆、也要能造记忆）。
 * 询问与执行都是注入的接缝，所以这套完全不需要网络与磁盘。
 */
await withLoadedTs(["src/render/external-hook", "src/render/site-decisions"], async (mod) => {
	await runExternalHookSuite(mod);
	console.log(
		"External-hook tests passed (one question per site and one fetch per URL even when the same image renders " +
			"repeatedly, the decision is stored before it is executed so the next render does not ask again, " +
			"inflight is released on failure so a retry still works, a throwing image never stops the next one, " +
			"and no note path means no caching even when the site was allowed)."
	);
});
