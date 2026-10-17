import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCloudCleanupSuite } from "./lib/cloud-cleanup-suite.mjs";

/**
 * 云端空间清理（需求 R17 / F15）。
 *
 * ⚠️ 2026-10-16：「清理云端未使用对象…」命令退役 ⇒ **候选公式**（`selectCleanupCandidates`）与
 * **分页列举**（`listAllObjects`）下线，本套件不再覆盖它们。
 * ⭐ 那条「**站外缓存整体排除**」的判据**没有消失** —— 它搬进了
 * `maintenance/orphan-watch.ts::selectOrphanAsks`（两条路共用），断言在 `test-orphan-watch.mjs`。
 *
 * 这一套现在守的是两件不报错、但很久之后才显形的事：
 * - 两个 key 工具：URL→key 的换算（与渲染层**同一套规则**）、站外缓存的 key 集合；
 * - 执行链：**删成功才摘索引**、**一次失败不中断整批**、**台账变了也要落盘**，
 *   以及"404 = 目标状态已达成（不是失败）"。
 */
await withLoadedTs(["src/maintenance/cloud-cleanup", "src/cache/index"], async (mod) => {
	await runCloudCleanupSuite(mod);
});

console.log(
	"Cloud-cleanup tests passed (the two key helpers: URL-to-key mapping uses the very same derivation " +
		"the renderer uses, and the off-site-cache set only takes entries explicitly marked external; and the " +
		"executor: a 404 counts as already done (not a failure) and still drops the index record, one failure " +
		"never stops the batch, both the index record and the upload-ledger entry are dropped only when the " +
		"object is really gone, the change is persisted even when the ledger was the only thing that moved - " +
		"which is exactly the 'no local copy' setting - and a failed save is reported. " +
		"NOTE: the candidate formula and the bucket listing are no longer covered here: the command that used " +
		"them was retired on 2026-10-16, and the off-site-cache exclusion moved to the orphan ask filter.)"
);
