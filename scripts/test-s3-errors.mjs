import assert from "node:assert/strict";

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
 *
 * ⭐ 另有一条**跨层断言**（只有在本文件才能做）：`hintKey` 是"用户接下来看到的那句话"，
 * 所以每一个键都必须在 i18n 的两张表里有文案。这条以前没人守 —— 套件只断言键名，
 * `check:i18n-keys` 只认 `t("字面量")`，于是 9 个键一个都没写、生产路径也不读 `hintKey`，
 * 用户在上传失败时看到的是原始 XML（2026-10-18 修）。
 */
await withLoadedTs(["src/s3/errors.ts", "src/i18n.ts"], (mod) => {
	const stats = runS3ErrorsSuite(mod);

	for (const key of mod.HINT_KEYS) {
		for (const locale of ["en", "zh"]) {
			const text = mod.I18N[locale]?.[key];
			assert.equal(typeof text, "string", `${locale} 缺 hint 文案：${key}（用户会看到裸键名）`);
			assert.ok(text.length > 0, `${locale} 的 hint 文案不能为空：${key}`);
			// 文案本身也不许把协议细节摊给用户（与设计 §8.1 的用词规则同源）。
			assert.doesNotMatch(
				text,
				/HTTP\s*\d|X-Amz|<|SignatureDoesNotMatch|AccessDenied|NoSuchBucket/,
				`${key}（${locale}）的文案暴露了协议细节：${text}`
			);
		}
	}

	console.log(
		`S3 error tests passed (only 2xx counts as success incl. 3xx rejected; ` +
			`whitelist retry policy — all 4xx and 501 not retried over ${stats.retryableCases} cases; ` +
			"XML/HTML error bodies parsed; credentials unconditionally redacted from message and body; " +
			`all ${mod.HINT_KEYS.length} hint keys have user-facing copy in both languages).`
	);
});
