import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRemoveSuite } from "./lib/remove-suite.mjs";

/**
 * 「缓存文件怎么删」的测试（`src/maintenance/remove.ts`）。
 *
 * 全库只有这一个文件决定"用哪个宿主 API 把缓存文件拿掉"，而两条调用路径
 * （后台自动淘汰、用户确认后的清理命令）都从这里过 —— 所以这个判断
 * 值得单独钉住，而不是只在验收里顺带看一眼。
 */
await withLoadedTs(["src/maintenance/remove", "src/types"], runRemoveSuite);
