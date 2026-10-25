import { withLoadedTs } from "./lib/load-ts.mjs";
import { runValueGuardsSuite } from "./lib/value-guards-suite.mjs";

/**
 * 值形状守卫的测试（`src/types.ts` 的三组模式守卫 + `src/records.ts`）。
 *
 * 两个模块一起打包：它们没有依赖关系，但守的是**同一类事** ——
 * "持久化数据/宿主对象怎么被解释"，所以共用一套断言与两条变异脚本。
 */
await withLoadedTs(["src/types.ts", "src/records.ts"], (mod) => {
	const stats = runValueGuardsSuite(mod);
	console.log(
		`Value-guard tests passed (${stats.guards} guard families: isPlainRecord rejects null and arrays ` +
			"before the typeof check; isCacheDisabled means exactly 'trash' and nothing else; the two " +
			"*_MODES lists are the single source of legal values and are matched case-sensitively)."
	);
});
