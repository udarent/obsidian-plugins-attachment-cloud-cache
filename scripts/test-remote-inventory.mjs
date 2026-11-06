import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRemoteInventorySuite } from "./lib/remote-inventory-suite.mjs";

/**
 * 云端盘点（列桶 → 内容哈希集合）的测试。
 *
 * 这是「批量上传预检」从逐 key HEAD 换成一次列桶 + 本地查表的那一步：
 * 断言在 `lib/remote-inventory-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/maintenance/remote-inventory.ts", (mod) => {
	return runRemoteInventorySuite(mod);
});
