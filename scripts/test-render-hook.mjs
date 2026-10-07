import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRenderHookSuite } from "./lib/render-hook-suite.mjs";

/**
 * 渲染钩子的测试（离线可用的落点）。
 *
 * 需要把 `render-target`、`cache/index`、`s3/client` 一起打进同一个 bundle ——
 * 判定与索引在同一份实例里，跨模块断言才有意义。
 */
await withLoadedTs(
	["src/render/render-hook", "src/render/render-target", "src/cache/index", "src/s3/client"],
	async (mod) => {
		// ⚠️ `await` 不能省：这个套件是 async 的。实测过后果 —— 少了它，套件返回的
		// Promise 被丢弃，里面一条必然失败的断言**完全不影响退出码**（退出码 0，
		// 还照样打印"passed"）。这条失效由 `npm run check:mutate-files` 静态挡住。
		await runRenderHookSuite(mod);
		console.log(
			"Render hook passed (index hit → local src with the remote URL never written; third-party/local/data ignored; " +
				"no usable local path → nothing written; missing copy → download then swap; local file gone → fall back to " +
				"remote exactly once; idempotent; preview `src` setter interception with uninstall)."
		);
	}
);
