import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRevertSuite } from "./lib/revert-suite.mjs";

/**
 * 「把链接改回本地路径」的测试。
 *
 * 这一层不碰网络、不碰磁盘：断言在 `lib/revert-suite.mjs`，
 * 用的是"一个笔记 + 两个附件"的最小 vault 替身。
 */
await withLoadedTs(["src/maintenance/revert", "src/plugin/revert-flow"], async (mod) => {
	await runRevertSuite(mod);
	console.log(
		"Revert tests passed (把链接改回本地路径：四种写法都改、别家地址不动、" +
			"本地副本不在的不进目标、取消/无可改时一次写盘都不发生)."
	);
});
