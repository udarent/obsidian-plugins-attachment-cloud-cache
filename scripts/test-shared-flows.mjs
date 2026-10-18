import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSharedFlowsSuite } from "./lib/shared-flows-suite.mjs";

/**
 * 跨流程共享动作的测试。
 *
 * 这三件事各自被**两条**流程共用（孤儿询问 / 云端清理 / 上传 / 孤儿监视），
 * 所以一处错就是成对错 —— 而两条流程的套件各测各的，容易都以为另一边测过。
 *
 * 断言在 `lib/shared-flows-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/plugin/shared-flows"], async (mod) => {
	const stats = await runSharedFlowsSuite(mod);
	console.log(
		`Shared-flows tests passed (${stats.cases} cases: object keys are extracted from both markdown bodies ` +
			"and canvas text nodes; the 'still referenced' scan throws when a note or canvas cannot be read " +
			"(skipping would silently turn 'unknown' into 'unreferenced'); the deletion log is written into the " +
			"plugin directory, appends to an existing file but writes a new one, and never lets a write failure " +
			"break the already-completed deletion)."
	);
});
