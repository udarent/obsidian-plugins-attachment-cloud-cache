import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRenderTargetSuite } from "./lib/render-target-suite.mjs";

/**
 * 渲染目标判定的测试。
 *
 * 需要 `src/s3/client` 一起进 bundle：套件用 `publicUrlFor` 构造"当初写出去的链接"，
 * 再验证判定能把它们反推回来 —— 写与读两侧必须一致。
 */
await withLoadedTs(["src/render/render-target", "src/cache/index", "src/s3/client"], runRenderTargetSuite);
