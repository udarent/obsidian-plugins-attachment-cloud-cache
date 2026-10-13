import { withLoadedTs } from "./lib/load-ts.mjs";
import { runLocalCopyTruthSuite } from "./lib/local-copy-truth-suite.mjs";

/**
 * **"一个事实只有一个持有者"**的跨模块一致性测试（计划里的 A2）。
 *
 * 与其它套件的分工：那些各自测"某个模块算得对不对"，这一条测**两个模块对同一个事实
 * 的回答必须自洽** —— 因为历史上真的出过事的三次（N11 的归属、幽灵记录抬高超出量、
 * 索引指着旧路径）全都不是"某个模块错了"，而是"同一个事实有两个回答，且答案不一致"。
 *
 * 断言在 `lib/local-copy-truth-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(
	["src/cache/index", "src/maintenance/eviction", "src/object-key"],
	(mod) => {
		const stats = runLocalCopyTruthSuite(mod);
		console.log(
			`Local-copy truth passed (${stats.cases} cases across three seams: "did we upload it" is ` +
				"answered by the ledger and not by whether an entry exists - the ledger remembers an object whose " +
				"copy was never kept, an entry without a ledger row is not ours, and removing an entry is not the " +
				"same as forgetting the ledger; a copy's path has one answer, so moving it makes the old path " +
				"stop resolving (descendants included) while the key still resolves to the new one; the cap's two " +
				"byte figures only have to keep one inequality - the cheap index sum is never smaller than the " +
				"bytes actually on disk, because under-counting would silently skip rotation rounds; and the hash " +
				"comes from the key's hash segment, never from the key as a whole.)"
		);
	}
);
