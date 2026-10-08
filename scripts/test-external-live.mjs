import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalLiveSuite } from "./lib/external-live-suite.mjs";

/**
 * 实时预览里的站外图（攒批 + 延后解析归属）的测试。
 *
 * 完全不需要 DOM：调度、视图列表、处理动作三样都是注入的接缝。
 */
await withLoadedTs(["src/render/external-live"], async (mod) => {
	await runExternalLiveSuite(mod);
	console.log(
		"External-live tests passed (candidates are batched and handled one microtask later, the note a " +
			"candidate belongs to is resolved from the DOM so split panes cannot rewrite the wrong file, " +
			"one bad view or one bad image never stops the rest, and a disposed queue stays dead)."
	);
});
