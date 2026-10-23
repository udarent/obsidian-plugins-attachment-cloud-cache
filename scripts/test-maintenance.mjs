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
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/settings",
		"src/types",
		"src/render/external-decide",
	],
	async (mod) => {
		await runMaintenanceSuite(mod);
		console.log(
			"Maintenance planners passed (rewrites preserve aliases and never touch unrelated links, and an " +
				"extensioned rule; a target containing balanced parentheses (`…(1).pdf`) is taken whole, in angle " +
				"form and in link labels too, while an unbalanced one in the title falls back to the first `)`; " +
				"canvas rewriting touches only the two value kinds it owns (file nodes move to " +
				"the new in-vault path, text nodes get the same remote URLs as notes would), leaves indentation and " +
				"key order byte-identical, counts what it had to skip, and refuses to guess on ambiguous short names; " +
				"reference scan only counts our own storage, and an address sitting in a position Obsidian never renders "
			+ "(a code block, inline code, an HTML comment, math, `<code>`, or an escaped link) is not a reference at all, "
			+ "while the same address in ordinary prose still is; " +
				"batch candidates skip note/canvas/database files and empty or already-indexed ones, and they now " +
				"**include** files no note refers to - flagged separately so the list leaves them unchecked and the " +
				"executor never writes a rewrite rule for them (canvas references count the same as Markdown ones); " +
				"off-site candidates cover " +
				"embeds, plain links, img and anchor tags alike (a wiki page with no file-ish tail, a page " +
				"whose extension says text/html or names a server-side page program such as .jsp/.php/.do, and " +
				"an address whose suffix does not look like a file type at all — a repo branch or release " +
				"number such as 5.1-translation_terms or v1.2.3 — are all refused up front and never offered, " +
				"while a text-like extension that may still be a real " +
				"file gets through the candidate stage and is refused later " +
				"by content type), they " +
				"include the ones the default setting leaves alone — otherwise turning that default off would leave " +
				"these explicit actions with an empty list — and they are never produced when the feature is off, the " +
				"host is loopback, or the storage is not ready; and narrowing them to one note keeps the site summary " +
				"honest, because the count is recomputed over that same slice rather than left at the vault-wide figure)."
		);
	}
);
