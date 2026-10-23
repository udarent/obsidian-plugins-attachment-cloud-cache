import { withLoadedTs } from "./lib/load-ts.mjs";
import { runLocalOrphansSuite } from "./lib/local-orphans-suite.mjs";

/**
 * 「没有任何引用的本地文件」怎么挑（`src/maintenance/local-orphans.ts`）。
 *
 * 这一层的产物是**清理命令的候选**：挑错 = 用户勾上、点删除，删的是他自己的文件。
 * 断言在 `lib/local-orphans-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/maintenance/local-orphans"], async (mod) => {
	const stats = await runLocalOrphansSuite(mod);
	console.log(
		`Local-orphans tests passed (${stats.cases} rows: host-own folders (.obsidian / .trash) are never candidates; ` +
			`a file still used through a **remote** URL counts as used, not as an orphan; off-site cache copies land in ` +
			`their own list (tagged, unticked by default) instead of being dropped, and paths already listed in ` +
			`the cloud-object list are skipped so nothing is offered twice; notes/canvases/` +
			`databases are skipped because deleting one is deleting a note; and what remains is exactly the plain ` +
			`attachments nothing links to).`
	);
});
