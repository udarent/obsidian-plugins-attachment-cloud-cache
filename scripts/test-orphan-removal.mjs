import { withLoadedTs } from "./lib/load-ts.mjs";
import { runOrphanRemovalSuite } from "./lib/orphan-removal-suite.mjs";

/**
 * 删掉孤儿副本（需求 R17 的"连本地一起清"那一档）。
 *
 * 这一套守的是**两种副本的分工**：缓存目录里的可再生副本直接删（空间立刻释放），
 * 而 `localCopy: "keep"` 时附件目录里那份是**用户自己的文件**，必须走回收站。
 * 把后者当成前者，就是绕过回收站**永久删掉用户的图**。
 *
 * 另外两条纪律也在这里钉住：拿不到删除凭据时文件与记录都不动；
 * 删失败不算成功、也不摘记录，整个运行最多落盘一次。
 */
await withLoadedTs(["src/maintenance/orphan-removal"], async (mod) => {
	const result = await runOrphanRemovalSuite(mod);
	console.log(
		`Orphan-removal tests passed (${result.cases} cases: a cached copy is deleted outright and never sent to ` +
			"the trash, while the user's own attachment in the attachments folder goes to the trash and is never " +
			"deleted outright - the two flips are pinned in both directions; a file the host index does not know " +
			"is skipped entirely, leaving both the file and its record alone; a delete that fails is not counted " +
			"and does not drop the record; one failure never stops the batch; the index is written at most once " +
			"per run and only when something really changed; and a save that fails is reported)."
	);
});
