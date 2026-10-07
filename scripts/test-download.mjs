import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDownloadSuite } from "./lib/download-suite.mjs";

/**
 * 回退下载的测试（P0 #6）。
 *
 * 用真实 HTTP 服务 + 真实磁盘：这一层是唯一会把远端字节写进用户 vault 的地方，
 * 所以"恰好 1 次 GET""绝不覆盖""失败不留半个文件"这些必须真的数、真的读。
 */
await withLoadedTs(
	["src/core/download", "src/cache/index", "src/s3/client", "src/render/render-target"],
	async (mod) => {
		const stats = await runDownloadSuite(mod);
		console.log(
			`Download passed (byte-identical to disk, index registered and persisted, concurrent requests for one key ` +
				`collapse to a single GET, failures stay retryable, third-party URLs refused, setting off = no request, ` +
				`never clobbers an occupied path, offline failures stay silent while auth failures speak up, ` +
				`sha256 of the round-tripped bytes matches ${stats.sha256Prefix}…).`
		);
	}
);
