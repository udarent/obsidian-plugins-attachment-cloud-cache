import { withLoadedTs } from "./lib/load-ts.mjs";
import { runInterceptSuite } from "./lib/intercept-suite.mjs";

/**
 * 接线判定层的测试。
 *
 * 判定错了就是"preventDefault 之后不管了" —— 图会消失且不报错。
 * 真事件路径由 `test-load-acceptance.mjs` 覆盖，这里穷举判定本身。
 */
await withLoadedTs("src/host/intercept.ts", (mod) => runInterceptSuite(mod));
