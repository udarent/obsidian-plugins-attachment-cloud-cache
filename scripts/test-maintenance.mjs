import { withLoadedTs } from "./lib/load-ts.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 维护功能的纯判定层测试（P1 #8/#9/#10）。
 *
 * 涉及**删用户文件**与**改用户笔记**，所以判定要穷举；
 * 真正碰磁盘/网络的部分由 `test-maintenance-run.mjs` 覆盖。
 */
await withLoadedTs(
	[
		"src/maintenance/audit",
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/settings",
		"src/types",
	],
	runMaintenanceSuite
);
