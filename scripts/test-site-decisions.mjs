import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSiteDecisionsSuite } from "./lib/site-decisions-suite.mjs";

/**
 * 站点决定记忆的测试。
 *
 * 这个模块不依赖宿主（纯数据 + 纯函数），走一次打包只是为了与其它套件同一条路。
 */
await withLoadedTs(["src/render/site-decisions"], runSiteDecisionsSuite);
