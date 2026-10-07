import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalHookSuite } from "./lib/external-hook-suite.mjs";

/**
 * 站外缓存编排的测试。
 *
 * 需要 `site-decisions` 一起进 bundle（编排要读记忆、也要能造记忆）。
 * 询问与执行都是注入的接缝，所以这套完全不需要网络与磁盘。
 */
await withLoadedTs(["src/render/external-hook", "src/render/site-decisions"], runExternalHookSuite);
