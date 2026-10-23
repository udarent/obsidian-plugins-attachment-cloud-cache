import { runMutations } from "./lib/mutate.mjs";
import { runSelectionSuite } from "./lib/selection-suite.mjs";

/**
 * 变异验证：**清单勾选**（`src/ui/selection-logic.ts`）。
 *
 * 这一层的错都表现为"结果不太对"，不报错：
 * - 勾选单位写成**地址** → 同一个地址在两篇笔记里合成一条 ⇒ **其中一篇的链接没被改写**
 *   （文件进了存储、笔记还指着别人的服务器，而用户以为他勾过了）；
 * - `toggle` 就地改调用方的集合 → 状态有了两个来源，界面显示与实际提交可能不一致；
 * - 全选只勾一部分 → 用户以为全勾上了；
 * - 全选把"见过的都留下" → 切换清单后残留上一批的键，提交时多出几条不存在的条目。
 */
await runMutations({
	source: "src/ui/selection-logic.ts",
	entries: ["src/ui/selection-logic"],
	suite: runSelectionSuite,
	mutations: [
		{
			// 后果：同一个地址在两篇笔记里被合成一条 ⇒ 其中一篇不会被处理。
			name: "★ 勾选单位只用地址（同一个地址在两篇笔记里被合成一条）",
			from: "\treturn `${notePath}\\u0000${url}`;",
			to: "\treturn url;",
			expect: "必须是两个键",
		},
		{
			// 后果：`toggle` 就地改了调用方的集合 ⇒ "当前勾了什么"有两个来源，
			// 界面显示与实际提交可能不一致。
			name: "★ toggle 就地改原集合（状态多出一个来源）",
			from: "\tconst next = new Set(selected);\n\tif (typeof key !== \"string\" || key === \"\") return next;",
			to: '\tconst next = selected;\n\tif (typeof key !== "string" || key === "") return next;',
			expect: "返回新的集合",
		},
		{
			// 后果：全选只勾一部分 ⇒ 用户以为全勾上了，实际漏了几行。
			name: "★ 全选只勾第一行（用户以为全勾上了）",
			from: "\tfor (const item of items) next.add(item.key);",
			to: "\tfor (const item of items.slice(0, 1)) next.add(item.key);",
			expect: "全选要勾上清单里每一行",
		},
	],
});
