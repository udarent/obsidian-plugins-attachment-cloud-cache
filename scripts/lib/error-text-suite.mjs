/**
 * `src/error-text.ts` 的断言套件（与变异验证共用）。
 *
 * ## 这里守的是什么
 *
 * `describeError` 把 `unknown` 变成一个能放进**用户可见提示**或日志的字符串。
 * 它原本在 8 个文件里**各写了一份**（同一个语义、两种写法），这才抽出来。
 *
 * 抽出来的真正理由不是"少写几行"，而是**同一个语义只能有一处**：
 * 8 份里任何一份被改坏（比如有人为了调试改成返回 `error.stack`），
 * 那一处的提示就会和别处不一样 —— 而"提示里出现了堆栈"这种事，
 * 只有真的报错时才会被发现。
 *
 * ⚠️ 这是**忠实抽取**，不是行为升级：原来就是 `error.message` / `String(error)`。
 * 特意没有"顺便做成更聪明"（比如从对象里捞 `message` 字段）——
 * 那会改变 27 个调用点的提示文本，而本轮的意图是消除重复、不是改行为。
 */

import assert from "node:assert/strict";

export function runErrorTextSuite(mod) {
	const { describeError } = mod;

	// ── Error：取 message，而不是 String(error) ──
	// ⚠️ 这两者**不一样**：`String(new Error("boom"))` 是 "Error: boom"，
	// 而用户要看到的是 "boom"。这正是必须有一个分支的原因。
	assert.equal(describeError(new Error("boom")), "boom", "★ Error 要取 message，而不是 String(error)");
	assert.equal(
		String(new Error("boom")),
		"Error: boom",
		"（前置条件：两者确实不同 —— 否则上面那条断言守不住任何东西）"
	);

	// 子类同样按 Error 处理（宿主抛的往往是 Error 的子类）
	class Custom extends Error {}
	assert.equal(describeError(new Custom("子类")), "子类", "Error 的子类也要取 message");

	// 空消息要如实给出空串，而不是回落成 "Error"（那会让"没有消息"看起来像有消息）
	assert.equal(describeError(new Error("")), "", "空 message 就是空串，不要回落成类名");

	// ── 非 Error：原样 String() ──
	// 抛字符串、数字、null 在 JS 里都是合法的，而它们同样会进提示。
	assert.equal(describeError("直接抛字符串"), "直接抛字符串", "字符串原样返回");
	assert.equal(describeError(42), "42", "数字");
	assert.equal(describeError(false), "false", "布尔");
	assert.equal(describeError(null), "null", "null");
	assert.equal(describeError(undefined), "undefined", "undefined");

	// 自定义 toString 要走它（有些库抛的就是这种对象）
	assert.equal(describeError({ toString: () => "自定义 toString" }), "自定义 toString", "走 toString");

	// ⚠️ 普通对象会得到 "[object Object]" —— 信息量很低，但这是**刻意的**：
	// 这是最后一道兜底，不该在这里猜结构（猜错会把 "undefined" 之类塞进用户提示）。
	// 把这条钉住是为了让"它就是不好看"变成显式的契约，而不是等有人发现了改名。
	assert.equal(
		describeError({ code: 500 }),
		"[object Object]",
		"普通对象兜底成 [object Object]（刻意保持简单：这里是最后一道，不猜结构）"
	);
}
