import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCloudCleanupSuite } from "./lib/cloud-cleanup-suite.mjs";

/**
 * 云端空间清理（需求 R17 / F15）。
 *
 * 这一套守的是"**什么不该删**"：仍被引用的、站外缓存的、认不出形状的、列举没读全的 ——
 * 以及"删成功才摘索引""一次失败不中断整批"这两条不报错、但很久之后才显形的纪律。
 */
await withLoadedTs(["src/maintenance/cloud-cleanup", "src/cache/index"], async (mod) => {
	await runCloudCleanupSuite(mod);
});

console.log(
	"Cloud-cleanup tests passed (candidates are only the objects this device can see no reference to: " +
		"referenced ones, off-site caches and unrecognisable shapes all stay; sizes are summed honestly; " +
		"URL-to-key mapping uses the very same derivation the renderer uses; pagination stops at the page " +
		"cap and says so instead of pretending the list is complete; deleting removes the index record only " +
		"when the object really went away, one failure never stops the batch, the index is persisted once " +
		"per run, and a failed save is reported)."
);
