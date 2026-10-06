import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRenderHookSuite } from "./lib/render-hook-suite.mjs";

/**
 * 渲染钩子的测试（离线可用的落点）。
 *
 * 需要把 `render-target`、`cache/index`、`s3/client` 一起打进同一个 bundle ——
 * 判定与索引在同一份实例里，跨模块断言才有意义。
 */
await withLoadedTs(
	["src/render/render-hook", "src/render/render-target", "src/cache/index", "src/s3/client"],
	runRenderHookSuite
);
