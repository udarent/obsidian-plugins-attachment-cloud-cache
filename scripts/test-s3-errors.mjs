import { withLoadedTs } from "./lib/load-ts.mjs";
import { runS3ErrorsSuite } from "./lib/s3-errors-suite.mjs";

/**
 * S3 错误分类与脱敏的测试。
 *
 * 为什么这两件事值得单独一个测试文件：它们决定了"出错时用户看到什么"。
 * 分类错了会让重试行为莫名其妙；脱敏漏了会把密钥送到别人的聊天窗口里。
 * 两者都是**纯逻辑**，可以穷举，所以没有理由不穷举。
 *
 * 断言在 `lib/s3-errors-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/s3/errors.ts", (mod) => {
	const stats = runS3ErrorsSuite(mod);
	console.log(
		`S3 error tests passed (only 2xx counts as success incl. 3xx rejected; ` +
			`whitelist retry policy — all 4xx and 501 not retried over ${stats.retryableCases} cases; ` +
			"XML/HTML error bodies parsed; credentials unconditionally redacted from message and body)."
	);
});
