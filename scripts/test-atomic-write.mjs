import { withLoadedTs } from "./lib/load-ts.mjs";
import { runAtomicWriteSuite } from "./lib/atomic-write-suite.mjs";

/**
 * `writeJsonAtomically` 的测试。
 *
 * 它原本在 `cache/store.ts` 与 `host/site-store.ts` 里各有一份**逐字相同**的实现。
 * 抽到一处之后，"两个 store 的落盘语义一致"就不再依赖"记得同步改两处"。
 */
await withLoadedTs(["src/atomic-write"], async (mod) => {
	await runAtomicWriteSuite(mod);
	console.log(
		"atomic-write tests passed (writes .tmp then renames, creates the parent folder when missing, " +
			"falls back to a direct write when rename is unsupported, cleans the temp file even then, " +
			"and never lets cleanup failure break the save)."
	);
});
