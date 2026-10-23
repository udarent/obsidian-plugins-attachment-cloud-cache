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
	runFileCardsSuite(mod);
	console.log(
		"File-cards tests passed (a row shows the original file name when the " +
			"index still knows it and falls back to the raw key otherwise, never inventing a name; " +
			"the thumbnail comes from the local copy first (so nothing is fetched) and only then from " +
			"the derived storage address; only images get a thumbnail - a PDF or an archive gets a type " +
			"badge instead, because a broken image glyph reads as a fault; when neither source can produce " +
			"an address the row simply has no image rather than an empty one; blank entries are skipped; " +
			"and the address is written through attr rather than img.src, because the render hook patches " +
			"that setter and would download the very object this dialog is asking about - with a failed " +
			"load degrading to the badge instead of leaving a broken icon, and a row may carry *several* " +
			"candidate addresses which are tried one after another before degrading (a file outside the " +
			"vault has no address form we get to choose: the host decides which one actually draws); " +
			"and the subtitle of an off-site " +
			"or local-file row is composed in exactly one place - the host for an off-site row, the absolute " +
			"path when there is no host, and never a vault path (naming the note a link came from reads as if " +
			"a note file had entered the list of files about to be uploaded); each row also shows its full vault path " +
			"as its row text (the way the reference cleanup plugin prints `file.path`) rather than as a separate " +
			"subtitle line, so a root-level file and an object whose local copy is gone both still show where " +
			"they live, and an open target that is a " +
			"vault path for a file in the vault and the storage address otherwise - the link is only drawn when " +
			"a handler was supplied, and never for a row with no target (a link that does nothing when clicked " +
			"reads as a broken plugin); and a row may carry an inline tag right after its name (today only " +
			"\"no note links it\", set on the rows the upload list leaves unticked by default) - kept as its own " +
			"field rather than folded into the subtitle, because one says where the file lives and the other says " +
			"why it is special, and an empty tag is never rendered as an empty span; and a row can be marked " +
			"**not selectable** (a file that is gone — showing it lets the user jump to the note and fix that " +
			"link, while ticking it could only ever end in a wait) and can carry its own link label, so a link " +
			"that opens the note is not labelled \"Open\"."
	);
});
