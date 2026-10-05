import { withLoadedTs } from "./lib/load-ts.mjs";
import { runHashSuite } from "./lib/hash-suite.mjs";

/**
 * SHA-256 / HMAC-SHA256 的测试。
 *
 * 这两个原语是**自己写的**（移动端没有 `node:crypto`；iOS 上 `crypto.subtle` 又可能不存在），
 * 所以必须拿 `node:crypto` 当独立 oracle 逐字节比对，而不是"看起来对就行"。
 *
 * 断言在 `lib/hash-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/s3/hash.ts", async (mod) => {
	const stats = await runHashSuite(mod);
	console.log(
		`Hash tests passed (SHA-256 over ${stats.sizes} sizes incl. padding boundaries, ` +
			`${stats.hmacCases} HMAC cases incl. 64/65-byte key boundary, RFC 4231 vector, ` +
			`WebCrypto-path equivalence; node:crypto used as an independent oracle, ` +
			`subtle available here: ${stats.subtleAvailable}).`
	);
});
