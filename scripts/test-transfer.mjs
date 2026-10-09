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
				"deliberately let through, every real file type is taken over now that the type gate is " +
				"gone (a mixed batch goes through together rather than leaving anything behind), files are " +
				"de-duplicated when they appear in both `files` and `items`, duplicates are never merged " +
				"when they cannot be identified, and execution " +
				"inserts `![]()` only for types the host can render and plain links otherwise (on upload " +
				"failure it falls back to a host-generated local link) at the position captured " +
				"before the network call, once per distinct image — the clipboard handing the same picture over " +
				"twice (different wrappers, different timestamps) still leaves one link, while two genuinely " +
				"different images both stay — with nothing lost)."
		);
	}
);
