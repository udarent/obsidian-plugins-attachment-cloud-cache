import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 站外缓存判定的测试。
 *
 * 需要把 `site-decisions` 一起进 bundle（判定读记忆），
 * 而 `s3/client` 由 `render-target`（`urlPrefixes`）带进来 —— 靠打包解析即可，不必显式列出。
 */
await withLoadedTs(["src/render/external-decide", "src/render/site-decisions"], (mod) => {
	runExternalDecideSuite(mod);
	console.log(
		"External-decide tests passed (every input lands in the right bucket: our own endpoint and public prefix are not " +
			"'external', host matching normalises case, the switch outranks memory, a remembered 'never' stays ignored, " +
			"loopback is refused before any allow, LAN hosts still ask, a host with a port is a different site, " +
			"and an unconfigured plugin never asks)."
	);
});
