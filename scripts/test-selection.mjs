import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSelectionSuite } from "./lib/selection-suite.mjs";

/**
 * **清单勾选**纯逻辑的测试（`src/ui/selection-logic.ts`）。
 *
 * 只把那一个纯模块进 bundle：它没有任何运行时依赖（全是纯函数）。
 */
await withLoadedTs(["src/ui/selection-logic"], (mod) => {
	const stats = runSelectionSuite(mod);
	console.log(
		`Selection tests passed (${stats.cases} groups: the selection unit is note + url so the same address in two ` +
			"notes stays two entries, toggling returns a new set instead of mutating the caller's, odd keys change " +
			"nothing, and select-all covers exactly the rows handed to it - never keys left over from an earlier list)."
	);
});
