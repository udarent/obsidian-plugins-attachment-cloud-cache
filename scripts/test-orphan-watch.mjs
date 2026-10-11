import { withLoadedTs } from "./lib/load-ts.mjs";
import { runOrphanWatchSuite } from "./lib/orphan-watch-suite.mjs";

/**
 * 孤儿监视（需求 R17 的主场景：**孤儿出现时问**）。
 *
 * 这一套守两件事：
 * ① "什么时候该弹那个框"—— 冷启动不弹、别的笔记还在用时不弹、不是我们上传的不弹、
 *    问过一次不追着问；而"最后一个引用真的没了"时必须弹。两个方向的钉子都在。
 * ② "答了之后删什么"—— 一个孤儿占**两份**资源（云端对象 + 本地副本），
 *    本地那份落在缓存目录内还是外，决定它是被直接删（可再生副本）还是进回收站
 *    （`localCopy: "keep"` 时那是**用户自己的附件**）。分类错了就是永久删用户文件。
 */
await withLoadedTs(["src/maintenance/orphan-watch"], async (mod) => {
	const result = await runOrphanWatchSuite(mod);
	console.log(
		`Orphan-watch tests passed (${result.cases} cases: warm-up only registers and never fires, so loading a ` +
			"vault does not ask about everything at once; a key that loses its last reference is reported, " +
			"and one that another note still links is not - the false-positive direction is pinned as hard as " +
			"the missed one; deleting a note orphans what it linked while renaming keeps the count; reads that " +
			"fail are recorded instead of being treated as 'no references'; the ask filter keeps only " +
			"objects this plugin uploaded that have not been asked about yet; and the local-removal plan " +
			"sorts copies into 'cache file, deleted outright' versus 'the user's own attachment, sent to the " +
			"trash', by path segment rather than by prefix, skipping anything the index does not vouch for)."
	);
});
