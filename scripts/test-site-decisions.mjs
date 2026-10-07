import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSiteDecisionsSuite } from "./lib/site-decisions-suite.mjs";

/**
 * 站点决定记忆的测试。
 *
 * 这个模块不依赖宿主（纯数据 + 纯函数），走一次打包只是为了与其它套件同一条路。
 */
await withLoadedTs(["src/render/site-decisions"], (mod) => {
	runSiteDecisionsSuite(mod);
	console.log(
		"Site-decisions tests passed (hosts normalise for case and a trailing dot so one site is one row, toArray is " +
			"stably sorted so diffs stay quiet, removing a site reports whether it existed, reading and deleting agree " +
			"on normalisation, and corrupt input degrades to an empty memory with only the bad entries skipped)."
	);
});
