import { withLoadedTs } from "./lib/load-ts.mjs";
import { runTransferSuite } from "./lib/transfer-suite.mjs";

/**
 * 粘贴 / 拖拽的测试。
 *
 * 判定部分是纯函数，**必须穷举** —— 因为"接管错了"会让用户的内容凭空消失
 * （我们已经 `preventDefault()` 了，不插回去就没了），而"漏接管"只是没上传。
 * 执行部分用假编辑器 + 真实磁盘 + 真实 HTTP，断言插了什么文本、发了几条请求。
 *
 * 入口把判定与执行打进同一个 bundle：两边共享 `vault-files` 的路径推导，
 * 分成两次 build 会让它们各用一份代码，行为可能与线上不一致。
 *
 * 断言在 `lib/transfer-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(
	[
		"src/editor/editor-hooks",
		"src/core/transfer",
		"src/core/ingest",
		"src/s3/client",
		"src/settings",
		"src/cache/index",
		"src/vault-files",
	],
	async (mod) => {
		const stats = await runTransferSuite(mod);
		console.log(
			`Transfer tests passed (${stats.pasteCases} paste + ${stats.dropCases} drop decision cases + ` +
				`${stats.executionCases} execution scenarios: plain text pastes and in-vault drags are ` +
				"deliberately let through, any unrecognised file makes the whole batch pass through so " +
				"nothing gets swallowed, files are de-duplicated when they appear in both `files` and " +
				"`items`, duplicates are never merged when they cannot be identified, and execution " +
				"inserts remote links (or a local embed on upload failure) at the position captured " +
				"before the network call, once, with nothing lost)."
		);
	}
);
