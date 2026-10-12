import { withLoadedTs } from "./lib/load-ts.mjs";
import { runOrphanRemovalSuite } from "./lib/orphan-removal-suite.mjs";

/**
 * 删掉孤儿副本（需求 R17 的"连本地一起清"那一档）。
 *
 * 这一套守的是**唯一一种删法**：这条路删掉的那份副本，**可能同时是用户自己的附件原件**
 * （`keep` 档下副本就是附件本身），所以一律走**回收站**。
 * 把回收站换成直接删，就是绕过回收站**永久删掉用户的图**。
 *
 * 另外两条纪律也在这里钉住：拿不到删除凭据时文件与记录都不动；
 * 删失败不算成功、也不摘记录，整个运行最多落盘一次。
 */
await withLoadedTs(["src/maintenance/orphan-removal"], async (mod) => {
	const result = await runOrphanRemovalSuite(mod);
	console.log(
		`Orphan-removal tests passed (${result.cases} cases: every copy goes to the trash and Vault.delete is ` +
			"never called (the copy may be the user's own attachment, and this path is one the user explicitly " +
			"confirmed); a file the host index does not know " +
			"is skipped entirely, leaving both the file and its record alone; a delete that fails is not counted " +
			"and does not drop the record; one failure never stops the batch; the index is written at most once " +
			"per run and only when something really changed; and a save that fails is reported)."
	);
});
