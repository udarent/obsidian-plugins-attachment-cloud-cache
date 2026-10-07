import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSigv4Suite } from "./lib/sigv4-suite.mjs";

/**
 * SigV4 签名的测试。
 *
 * 不依赖任何 SDK（本项目明确"不依赖 PicGo / 单一提供商"，也要避免为了签名
 * 拖进一个几百 KB 的 AWS SDK），所以正确性必须由**规范本身**保证。
 * 办法是把 AWS 公开发布过的三个向量钉在这里：签名对上 ⇔ 规范化请求逐字节正确。
 *
 * 断言在 `lib/sigv4-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/s3/sigv4.ts", async (mod) => {
	const stats = await runSigv4Suite(mod);
	console.log(
		`SigV4 tests passed (${stats.officialVectors} published AWS vectors: get-vanilla, ` +
			`query-order-key-case, S3 GET-object; ${stats.asciiBytes} ASCII bytes checked against the ` +
			"RFC 3986 unreserved rule; query sorted after encoding; double-encoding regression guarded)."
	);
});
