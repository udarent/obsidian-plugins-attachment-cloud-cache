import { runMutations } from "./lib/mutate.mjs";
import { runValueGuardsSuite } from "./lib/value-guards-suite.mjs";

/**
 * 变异验证：`src/records.ts`（`isPlainRecord`）。
 *
 * 它是设置合并、索引校验、错误解析三处的**共同入口**：这里放松一格，
 * 三处会同时把 null / 数组 / 基本类型当成"能按属性读的对象"，
 * 而症状是"读了一堆下标键"或"读 null 的属性直接抛错"。
 */
await runMutations({
	source: "src/records.ts",
	entries: ["src/types.ts", "src/records.ts"],
	suite: runValueGuardsSuite,
	mutations: [
		{
			// 后果：`typeof null === "object"` 通过检查 ⇒ 读 null 的属性直接抛。
			name: "不再挡 null",
			from: "\tif (value === null) return false;",
			to: "\tif (false) return false;",
			expect: "null 不是普通对象",
		},
		{
			// 后果：数组被当成对象 ⇒ 读到一堆下标键（配置里"多了几个键"）。
			name: "不再挡数组",
			from: "\tif (Array.isArray(value)) return false;",
			to: "\tif (false) return false;",
			expect: "数组不是普通对象",
		},
		{
			// 后果：字符串/数字也被当成"能按属性读的对象"（读到 undefined 而不知情）。
			name: "任何值都算普通对象",
			from: '\treturn typeof value === "object";',
			to: "\treturn true;",
			expect: "基本类型不是普通对象",
		},
	],
});
