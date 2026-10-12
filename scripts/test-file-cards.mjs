import { withLoadedTs } from "./lib/load-ts.mjs";
import { runFileCardsSuite } from "./lib/file-cards-suite.mjs";

/**
 * 确认框里那张「文件清单」的测试（`src/ui/file-cards.ts`）。
 *
 * 起因（用户口径）：**"确认文件时应当以缩略图方式展示，以便用户确认是哪个文件"** ——
 * 两处确认框（孤儿询问、清理云端未使用对象）原先列的是对象 key / 缓存路径，
 * 末段都是一串 sha256，用户认不出那是哪张图，而清单是他按下按钮前唯一能核对的东西。
 *
 * 断言在 `lib/file-cards-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/ui/file-cards", (mod) => {
	const stats = runFileCardsSuite(mod);
	console.log(
		`File-cards tests passed (${stats.cases} cases: a row shows the original file name when the ` +
			"index still knows it and falls back to the raw key otherwise, never inventing a name; " +
			"the thumbnail comes from the local copy first (so nothing is fetched) and only then from " +
			"the derived storage address; only images get a thumbnail - a PDF or an archive gets a type " +
			"badge instead, because a broken image glyph reads as a fault; when neither source can produce " +
			"an address the row simply has no image rather than an empty one; blank entries are skipped; " +
			"and the address is written through attr rather than img.src, because the render hook patches " +
			"that setter and would download the very object this dialog is asking about - with a failed " +
			"load degrading to the badge instead of leaving a broken icon)."
	);
});
