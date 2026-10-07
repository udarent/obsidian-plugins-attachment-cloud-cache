import { withLoadedTs } from "./lib/load-ts.mjs";
import { runErrorTextSuite } from "./lib/error-text-suite.mjs";

/**
 * `describeError` 的测试。
 *
 * 它被 27 处调用、跨 8 个模块 —— 原本是 8 份各写一份的本地函数，
 * 抽成一处之后，"用户看到的错误文本长什么样"只有一处定义。
 */
await withLoadedTs(["src/error-text"], async (mod) => {
	runErrorTextSuite(mod);
	console.log(
		"error-text tests passed (an Error yields its message rather than `Error: …`, " +
			"non-Errors fall back to String(), and the last-resort object case is pinned as-is)."
	);
});
