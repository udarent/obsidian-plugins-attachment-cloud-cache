import { withLoadedTs } from "./lib/load-ts.mjs";
import { runOrphanWatchSuite } from "./lib/orphan-watch-suite.mjs";

/**
 * 孤儿监视（需求 R17 的主场景：**孤儿出现时问**）。
 *
 * 这一套守两件事：
 * ① "什么时候该弹那个框"—— 冷启动不弹、别的笔记还在用时不弹、不是我们经手过的不弹、
 *    问过一次不追着问；而"最后一个引用真的没了"时必须弹。两个方向的钉子都在。
 *    ⚠️ 判据是**上传台账**（`isOurs`）而不是"索引里有没有条目"：条目只管"本地副本在哪"，
 *    而「不留副本」那一档没有副本 ⇒ 没有条目 ⇒ 拿条目当判据会让该档**永不弹框**
 *    （2026-10-11 的 N11，与 P8 同一形状）。套件里有一格专门钉它。
 * ② "答了之后删什么"—— 一个孤儿占**两份**资源（云端对象 + 本地副本），而本地那份
 *    **可能就是用户的附件原件** ⇒ 删法只有一种：**回收站**。
 *    ⚠️ 2026-10-12（D-17）：从前还有一条"副本在缓存目录里 ⇒ 直接删"的支路，
 *    它随缓存目录一起消失了 —— 判据错了就是永久删用户文件，所以那条边界值得记住。
 */
await withLoadedTs(["src/maintenance/orphan-watch"], async (mod) => {
	const result = await runOrphanWatchSuite(mod);
	console.log(
		`Orphan-watch tests passed (${result.cases} cases: warm-up only registers and never fires, so loading a ` +
			"vault does not ask about everything at once; a key that loses its last reference is reported, " +
			"and one that another note still links is not - the false-positive direction is pinned as hard as " +
			"the missed one; deleting a note orphans what it linked while renaming keeps the count; reads that " +
			"fail are recorded instead of being treated as 'no references'; the ask filter keeps only " +
			"objects we have handled (from the upload ledger, NOT from the local-copy index - so the " +
			"'no local copy' setting still gets asked) that have not been asked about yet; and the local-removal " +
			"plan produces targets only for copies the index vouches for (disposal is now fixed to the trash — " +
			"there is only one kind of copy left, and it may well be the user's own attachment))."
	);
});
