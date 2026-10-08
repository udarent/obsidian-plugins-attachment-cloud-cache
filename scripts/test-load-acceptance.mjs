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
		"live preview, while a third-party image was left alone; clean-cache deleted only the orphan through " +
		"Vault.delete (never the trash), said so in the confirmation text, left the referenced copy alone, and " +
		"cancelling touched nothing; batch upload rewrote both link forms, kept the originals and left " +
		"no stray copy behind; an unconfigured paste is left to Obsidian; batch upload also picks up the images notes " +
		"link to elsewhere, and its dialog names the sites it will visit (that confirmation is the authorisation) " +
		"while cancelling downloads nothing; with the feature on and the default set to \"cache straight away\" such " +
		"an image is downloaded, uploaded and its link rewritten, whereas the default \"leave it alone\" sends no " +
		"request and leaves the note byte-for-byte identical; changing that setting makes the plugin look at the notes " +
		"that are open right now; the \"pick which to cache\" command was driven end to end (its dialog standing in for " +
		"\"see the list, select all, confirm\") — a fresh image leaves a file in the cache folder *and* a row in the " +
		"index file, an image whose bytes are already cached reuses that copy instead of adding anything, and a " +
		"CDN-style URL whose last path segment carries a token after the dot still produces a cache file ending in the " +
		"real type; and with a cache limit set, the background rotation deleted the least recently used " +
		"copies outright (freeing the space now) and removed their index entries, without ever going near the trash, " +
		"and with the note itself untouched))."
);
