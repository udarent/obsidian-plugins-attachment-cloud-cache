import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSelfHealSuite } from "./lib/self-heal-suite.mjs";

/**
 * 索引自愈的测试。
 *
 * 索引是**派生数据**，而它指向的本地副本随时可能消失（用户删了缓存目录、同步漏了文件、
 * `keep` 档下用户自己整理了附件）。留着一条指向不存在文件的记录，会让占用统计虚高，
 * 并让渲染误判「本地已有」——于是既不显示、也不去取。
 *
 * ⭐ 这一套守的是**误摘的方向**（代价不对称）：多留一条只是统计不准；
 * 误摘一条会把那张图的**离线可用性悄悄拿掉**。所以"查询抛错时不许摘"是这里最要紧的一条，
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
			"persisted once and announced with an honest count; an existence check that THROWS drops " +
			"nothing and is counted separately - keeping a stale record only skews a number, while " +
			"dropping a live one silently takes that file's offline availability away, so the judgement " +
			"leans toward keeping; a failed save reports the failure instead of claiming a repair; large " +
			"indexes yield to the host in batches rather than stopping early - a half-done repair would be " +
			"worse than a slow one; and the dependency surface has no way to delete a file at all)."
	);
});
