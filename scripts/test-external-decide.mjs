import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 站外缓存判定的测试。
 *
 * 需要把 `site-decisions` 一起进 bundle（判定读记忆），
 * 而 `s3/client` 由 `render-target`（`urlPrefixes`）带进来 —— 靠打包解析即可，不必显式列出。
 */
await withLoadedTs(["src/render/external-decide", "src/render/site-decisions"], runExternalDecideSuite);
