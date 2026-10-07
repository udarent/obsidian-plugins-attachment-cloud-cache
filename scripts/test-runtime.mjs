import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRuntimeSuite } from "./lib/runtime-suite.mjs";

/**
 * 运行时装配的测试（`createIndexStore` 的防抖落盘、`makeSerializer` 的串行）。
 *
 * 用真实磁盘（宿主替身指向临时目录）：这套的性质里有"真的写进去了没有"，
 * 而那个只能在磁盘上看。
 */
await withLoadedTs(["src/host/runtime", "src/cache/index", "src/cache/store"], runRuntimeSuite);
