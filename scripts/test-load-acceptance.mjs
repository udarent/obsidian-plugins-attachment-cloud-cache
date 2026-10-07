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
		"issued 0 PUT; rendering rewrote the src to the local copy with **zero** requests in both reading view and " +
		"live preview, while a third-party image was left alone; clean-cache moved only the orphan to trash " +
		"(a referenced copy survived, and cancelling touched nothing); batch upload rewrote both link forms and " +
		"kept the originals; an unconfigured paste is left to Obsidian; with the feature switched on, an image from another site was asked about once, downloaded, uploaded and its link rewritten; and with a cache limit set, the background rotation moved the least recently used copies to the trash (the note itself untouched))."
);
