import { runMutations } from "./lib/mutate.mjs";
import { runS3ErrorsSuite } from "./lib/s3-errors-suite.mjs";

/**
 * 变异验证：S3 错误分类。
 *
 * 这里每一条都对应一个"用户会真的遇到、且很难自己想到"的后果 ——
 * 尤其是**不该重试的重试**（把配置错误变成卡顿）与**脱敏漏掉**（密钥外泄）。
 */
await runMutations({
	source: "src/s3/errors.ts",
	suite: runS3ErrorsSuite,
	mutations: [
		{
			name: "重试判据从白名单松成『4xx 也重试』",
			from: "if (status === 408 || status === 425 || status === 429) return true;",
			to: "if (status >= 400) return true;",
			expect: "4xx",
		},
		{
			name: "401 不再归为鉴权问题（会给出误导性的建议）",
			from: 'if (status === 401 || status === 403) return "auth";',
			to: 'if (status === 403) return "auth";',
			expect: "401",
		},
		{
			name: "5xx 被归成 client（于是不再重试，偶发故障变成硬失败）",
			from: 'if (status >= 500) return "server";',
			to: 'if (status >= 500) return "client";',
			expect: "500",
		},
		{
			name: "3xx 被当成成功（会把重定向目标记成对象地址）",
			from: "return status >= 200 && status < 300;",
			to: "return status >= 200 && status < 400;",
			expect: "不得算成功",
		},
		{
			name: "密钥脱敏变成了空操作",
			from: 'out = out.split(secret).join("«redacted»");',
			to: "out = out;",
			expect: "应被替换成占位符",
		},
		{
			name: "XML 实体不再还原 &amp;（文案里会露出转义序列）",
			from: '.replace(/&amp;/g, "&")',
			to: '.replace(/&amp;/g, "&amp;")',
			expect: "实体",
		},
		{
			name: "SignatureDoesNotMatch 不再给专属建议（退化成泛泛的鉴权提示）",
			from: 'if (code === "SignatureDoesNotMatch") return "s3HintSignature";',
			to: 'if (false) return "s3HintSignature";',
			expect: "针对性的建议键",
		},
		{
			name: "长文案截断后不再标注『已截断』（会被误读成响应体就这么长）",
			from: 'return clean.length <= limit ? clean : `${clean.slice(0, limit)}…（已截断）`;',
			to: "return clean.slice(0, limit);",
			expect: "截断必须明确标出",
		},
		{
			name: "被抛出的非 Error 值退化成 String()（得到 [object Object] 这种噪音）",
			from: "function describeThrown(error: unknown, raw: { message?: unknown } | undefined): string {",
			to:
				"function describeThrown(error: unknown, raw: { message?: unknown } | undefined): string {\n" +
				"\treturn String(error ?? \"\");",
			expect: "不得被兜成 [object Object]",
		},
		{
			name: "无信息的抛出物不再给默认说明（提示里会留下一段空白）",
			from: 'message: text || "请求未能发出或未收到响应",',
			to: "message: text,",
			expect: "应给出明确的默认说明",
		},
		{
			name: "重试次数不再出现在消息里（看不出是网络抖动还是硬失败）",
			from: 'const tries = init.attempts > 1 ? ` (after ${init.attempts} attempts)` : "";',
			to: 'const tries = "";',
			expect: "重试过要在消息里体现",
		},
	],
});
