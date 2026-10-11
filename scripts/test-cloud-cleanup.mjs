import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCloudCleanupSuite } from "./lib/cloud-cleanup-suite.mjs";

/**
 * 云端空间清理（需求 R17 / F15）。
 *
 * 这一套守的是"**什么不该删**"：仍被引用的、站外缓存的、认不出形状的、列举没读全的 ——
 * 以及"删成功才摘索引""一次失败不中断整批""404 = 目标状态已达成（不是失败）"这几条
 * 不报错、但很久之后才显形的纪律。
 *
 * ⚠️ 这里**只覆盖执行链与候选公式**（纯函数）。"什么时候该问用户"那件事在
 * `orphan-watch`（入口在 `maintenance/orphan-watch.ts`，套件是 `test-orphan-watch.mjs`）——
 * 2026-10-11 之前它挂在"用户删掉本地文件"上，默认档下永远不会出现，已按需求改成"孤儿出现时问"。
 */
await withLoadedTs(["src/maintenance/cloud-cleanup", "src/cache/index"], async (mod) => {
	await runCloudCleanupSuite(mod);
});

console.log(
	"Cloud-cleanup tests passed (candidates are only the objects this device can see no reference to: " +
		"referenced ones, off-site caches and unrecognisable shapes all stay; sizes are summed honestly; " +
		"URL-to-key mapping uses the very same derivation the renderer uses; pagination stops at the page " +
		"cap and says so instead of pretending the list is complete; a 404 counts as already done (not a " +
		"failure) and still drops the index record; one failure never stops the batch, the index is persisted " +
		"once per run, and a failed save is reported)."
);
