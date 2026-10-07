import { runMutations } from "./lib/mutate.mjs";
import { runErrorTextSuite } from "./lib/error-text-suite.mjs";

/**
 * 变异验证：`describeError`（`src/error-text.ts`）。
 *
 * 这个语义原本在 8 个文件里各写一份，被 27 处调用。它决定**用户看到的错误文本**，
 * 而失效方式是静默的：提示变成 "Error: boom" 或 "[object Object]"，
 * 界面照常工作，只是把本该有用的信息弄丢了。
 */
await runMutations({
	source: "src/error-text.ts",
	entries: ["src/error-text"],
	suite: runErrorTextSuite,
	mutations: [
		{
			// 后果：提示里全部带上 "Error: " 前缀（用户看到的是类名，不是原因），
			// 而后备分支本来就不该走 —— 于是这一处的错误文本与别处不一致。
			name: "★ 去掉 Error 分支（提示变成 Error: …，而不是原因本身）",
			from: "\tif (error instanceof Error) return error.message;\n\treturn String(error);",
			to: "\treturn String(error);",
			expect: "要取 message",
		},
		{
			// 后果：取的是类名而不是消息 —— 同上，用户看不到真正的原因。
			name: "★ 取 name 而不是 message（用户看到「Error」两个字）",
			from: "\tif (error instanceof Error) return error.message;",
			to: "\tif (error instanceof Error) return error.name;",
			expect: "要取 message",
		},
		{
			// 后果：非 Error 的值（抛字符串/数字/null 都合法）被吞成空串 ——
			// 于是提示里那一段什么也没有，而"什么都没有"比"有个难看的值"更难查。
			name: "非 Error 的值被吞成空串",
			from: "\treturn String(error);",
			to: '\treturn "";',
			expect: "字符串原样返回",
		},
		{
			// 后果：空 message 被回落成类名 —— "没有消息"看起来像"有消息"。
			name: "空 message 被回落成类名（没有消息看起来像有消息）",
			from: "\tif (error instanceof Error) return error.message;",
			to: '\tif (error instanceof Error) return error.message || "Error";',
			expect: "空 message 就是空串",
		},
	],
});
