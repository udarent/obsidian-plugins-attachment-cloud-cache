import { withLoadedTs } from "./lib/load-ts.mjs";
import { runReleaseSpaceSuite } from "./lib/release-space-suite.mjs";

/**
 * 「清理已上传附件的本地占用」（F18）纯判定层的测试。
 *
 * 这一层决定**删哪些文件**，而且删法是**直接删**（不进回收站）——
 * 所以准入判据必须穷举：每一条都有一条断言守着，另有变异锚点逐条把它改瞎。
 *
 * 断言在 `lib/release-space-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/maintenance/release-space"], (mod) => {
	runReleaseSpaceSuite(mod);
	console.log(
		"Release-space planner passed (a copy is a candidate only when it is in the index, in the upload " +
			"ledger, still linked from a note or canvas through its remote URL, and still on disk; an empty " +
			"reference set yields nothing — the opposite default from eviction, because here \"has a remote " +
			"link\" is the admission rule rather than a sort preference; missing files are counted but never " +
			"offered as reclaimable, the same path is counted once, and the order is size-descending then by " +
			"key so the list is stable across runs)."
	);
});
