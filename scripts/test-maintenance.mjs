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
		"src/render/external-decide",
	],
	(mod) => {
		runMaintenanceSuite(mod);
		console.log(
			"Maintenance planners passed (four audit classes with attachment-folder files never treated as orphans; " +
				"preview truncated but execution list full; link spans for wikilink/alias/subpath/title/angle forms; " +
				"rewrites preserve aliases and never touch unrelated links, and an extension-less link still matches " +
				"an extensioned rule; canvas rewriting touches only the two value kinds it owns (file nodes move to " +
				"the new in-vault path, text nodes get the same remote URLs as notes would), leaves indentation and " +
				"key order byte-identical, counts what it had to skip, and refuses to guess on ambiguous short names; " +
				"reference scan only counts our own storage; " +
				"batch candidates skip note/canvas/database files, empty and already-indexed files and every file no " +
				"note refers to (canvas references count the same as Markdown ones); off-site candidates cover " +
				"embeds, plain links, img and anchor tags alike (web pages are refused later, by content type), they " +
				"include the ones the default setting leaves alone — otherwise turning that default off would leave " +
				"these explicit actions with an empty list — and they are never produced when the feature is off, the " +
				"host is loopback, or the storage is not ready)."
		);
	}
);
