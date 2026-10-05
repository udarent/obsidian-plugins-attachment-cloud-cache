import { withLoadedTs } from "./lib/load-ts.mjs";
import { runS3ClientSuite } from "./lib/s3-client-suite.mjs";

/**
 * S3 客户端的测试。
 *
 * 对着**本地真实 HTTP 服务**跑，服务端用**独立重算**的签名验证请求 ——
 * 而不是拿被测代码自己的实现自我比对（那样等于什么都没证明）。
 *
 * 断言的重点全部落在"网络上真的发生了什么"：
 * 上传字节逐字节一致、凭据错时恰好 1 条请求、5xx 时重试且不超上限、
 * 上传过程 PUT=1 且 GET=0。这些用 mock 掉客户端是测不出来的。
 *
 * 断言在 `lib/s3-client-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/s3/client.ts", async (mod) => {
	const stats = await runS3ClientSuite(mod);
	console.log(
		`S3 client tests passed (${stats.scenarios} scenarios against a real local HTTP server that ` +
			"independently recomputes SigV4: byte-identical upload, signed path includes the bucket, " +
			"no hand-set Host, credential errors cost exactly 1 request, 5xx retries with exponential " +
			"backoff up to the cap, config errors never reach the network, public URLs encoded once)."
	);
});
