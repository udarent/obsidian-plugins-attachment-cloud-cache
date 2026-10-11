import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDownloadTargetSuite } from "./lib/download-target-suite.mjs";

/**
 * 回退下载落点（`src/download-target.ts`）的测试。
 *
 * 它决定副本**叫什么名字**与**会不会碰到已有的文件** —— 后者是不可逆的，
 * 所以这里穷举的是"出错时倒向哪一侧"而不是功能本身。
 *
 * 断言在 `lib/download-target-suite.mjs`（与变异验证共用，避免两套断言漂移）。
 */
await withLoadedTs(["src/download-target", "src/object-key"], async (mod) => {
	const cases = await runDownloadTargetSuite(mod);
	console.log(
		`Download-target tests passed (${cases.naming} naming cases + ${cases.placement} placement cases + ` +
			`${cases.safety} safety cases: the local name comes from the entry's original name, else parsed back ` +
			"out of a C2 key, else the key itself — never invented; an occupied path is reused when the bytes " +
			"match and otherwise gets the next `name N.ext` (same convention as pasting); a probe that throws " +
			"counts as occupied, an unreadable hash counts as different content, a key without a hash never " +
			"guesses, and the suffix loop always terminates)."
	);
});
