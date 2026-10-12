import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSelfHealSuite } from "./lib/self-heal-suite.mjs";

/**
 * 索引自愈的测试。
 *
 * 索引是**派生数据**，而它指向的本地副本随时可能消失（用户自己删了那份副本、同步漏了文件、
 * `keep` 档下用户自己整理了附件）。留着一条指向不存在文件的记录，会让占用统计偏高，
 * 并让下次看到那张图时白下载一次。
 *
 * ⭐ 这一套守的是**误摘的方向**（代价不对称）：多留一条只是统计偏高；
 * 误摘一条会让那张图**下次被看到时白下载一次**（且期间离线不可用）。
 * 所以"查询抛错时不许摘"、"上一轮也不在才摘"是这里最要紧的两条，
 * 而且这一层**连删文件的入口都没有**（依赖面被断言钉住）。
 *
 * 断言在 `lib/self-heal-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/maintenance/self-heal", async (mod) => {
	const stats = await runSelfHealSuite(mod);
	console.log(
		`Self-heal tests passed (${stats.cases} cases: one path is checked once but every record ` +
			"pointing at it is dropped together, and blank paths are never handed to the host; " +
			"a missing file drops its records while everything else is left alone, and the change is " +
			"persisted once and announced with an honest count; two rounds are needed before anything is " +
			"dropped - a file that is merely still on its way (a new device mid-sync) is never mistaken for " +
			"a gone one, and a round that saw it come back wipes the suspicion; an existence check that " +
			"THROWS drops nothing, is counted separately, and does not consume the round already earned - " +
			"keeping a stale record only skews a number, while dropping a live one costs a pointless " +
			"re-download, so the judgement leans toward keeping; a failed save reports the failure instead " +
			"of claiming a repair; large indexes yield to the host in batches rather than stopping early - " +
			"a half-done repair would be worse than a slow one; and the dependency surface has no way to " +
			"delete a file at all)."
	);
});
