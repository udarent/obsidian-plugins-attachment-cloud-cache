import { withLoadedTs } from "./lib/load-ts.mjs";
import { runNotifyUserSuite } from "./lib/notify-user-suite.mjs";

/**
 * 「用户可见提示」统一出口的测试。
 *
 * 这一层只有几行，但它守的是**一条跨三个模块的约定**：文案键在核心层选、
 * 文字由接线层给（见 `src/notify-user.ts` 的文件头）。写反了不报错 ——
 * 只让英文用户在唯一一次提示里看到中文，或者让所有人看到一串键名。
 *
 * 断言在 `lib/notify-user-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/notify-user", (mod) => {
	const stats = runNotifyUserSuite(mod);
	console.log(
		`Notify-user tests passed (${stats.cases} cases: the sentence is resolved by the caller's ` +
			"translator, spoken exactly once, and gets the caller's parameters untouched; with no sink " +
			"nothing is spoken at all and nothing is thrown - this runs on the render and delete paths; " +
			"and with a sink but no translator the key itself is spoken, never a hard-coded sentence in " +
			"one language - which is what made an English user see Chinese back when two of these layers " +
			"carried their own Chinese fallbacks)."
	);
});
