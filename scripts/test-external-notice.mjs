import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalNoticeSuite } from "./lib/external-notice-suite.mjs";

/**
 * 站外缓存询问通知的测试。
 *
 * 用注入的假通知（真替身是空壳，没有 DOM）。真实观感只能真机验证 ——
 * 套件里写明了这条边界。
 */
await withLoadedTs(["src/ui/external-notice"], runExternalNoticeSuite);
