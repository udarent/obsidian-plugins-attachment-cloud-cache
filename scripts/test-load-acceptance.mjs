import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 入口验收（加载**真实构建产物**）。
 *
 * ⚠️ 这条测试必须先构建。`package.json` 的 `test` 脚本是
 * `esbuild production && node scripts/run-tests.mjs`，就是为了让这里针对最新产物。
 *
 * 判据：**把 `src/main.ts` 里那两行 `registerEvent` 删掉，这条测试必须变红。**
 */
const result = await runLoadAcceptance();

console.log(
	`Load acceptance passed (built main.js loads and registers ${JSON.stringify(result.registrations)}; ` +
		"a real paste went through: 1 PUT + cached copy byte-identical + link inserted, a second identical paste " +
		"issued 0 PUT, and a clipboard that hands the same image over twice (once in `files`, once in `items`) still " +
		"leaves exactly one link — one paste must not show the same picture twice; rendering rewrote the src to the local copy with **zero** requests in both reading view and " +
		"live preview, while a third-party image was left alone; the usage report counts local copies" +
		"by the index alone — a file it never recorded (possibly the user's own attachment) changes none of" +
		"its numbers and is never touched, an unreferenced copy and a stale record each move exactly one" +
		"number, and the report itself deletes nothing; " +
		"cancelling touched nothing; batch upload rewrote both link forms, left the user's file exactly where it " +
		"was (no cache folder is ever created — that file *is* the local copy) and left both the attachment no note " +
		"refers to and any stray copy alone; " +
		"an unconfigured paste is left to Obsidian; batch upload also picks up the images notes " +
		"link to elsewhere, and its dialog names the sites it will visit (that confirmation is the authorisation) " +
		"while cancelling downloads nothing; with the feature on such an image is downloaded, uploaded and its link " +
		"rewritten, whereas a hostile site list sends no request and leaves the note byte-for-byte identical — and " +
		"letting it through again proves the list filters rather than disables; changing a site setting makes the " +
		"plugin look at the notes " +
		"that are open right now; the \"pick which to cache\" command was driven end to end (its dialog standing in for " +
		"\"see the list, select all, confirm\") — a fresh image lands a local copy *and* a row in the " +
		"index file, an image whose bytes are already cached reuses that copy instead of adding anything, and a " +
		"CDN-style URL whose last path segment carries a token after the dot still produces a local copy whose name ends " +
		"in the " +
		"real type; and with a cache limit set, the background rotation deleted the least recently used " +
		"copies outright (freeing the space now) and removed their index entries, without ever going near the trash, " +
		"and with the note itself untouched; switching the local-copy mode to \"keep nothing\" offered once to also " +
		"clear the copies that were already there — the copy a note still links to was deleted outright (not trashed) " +
		"with its index row removed while the upload ledger kept it, and three copies were left alone: the one no note " +
		"links to, the one whose object could not be confirmed in storage, and the one that was never uploaded; " +
		"running it again deletes nothing and says so, including why))."
);
