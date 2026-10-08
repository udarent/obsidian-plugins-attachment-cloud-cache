import { runMutations } from "./lib/mutate.mjs";
import { runExternalPickerSuite } from "./lib/external-picker-suite.mjs";

/**
 * 变异验证：「选择要缓存的外链图片」的**清单与勾选**（`src/ui/external-picker-logic.ts`）。
 *
 * 这一层的错都表现为"结果不太对"，不报错：
 * - 勾选单位写成**地址** → 同一张图在两篇笔记里合成一条 ⇒ **其中一篇的链接没被改写**
 *   （图进了存储、笔记还指着别人的服务器，而用户以为他勾过了）；
 * - 清单里留着缺字段的幽灵行 → 点不动、也提交不了；
 * - `toggle` 就地改调用方的集合 → 状态有了两个来源，界面显示与实际提交可能不一致；
 * - 全选只勾一部分 → 用户以为全勾上了。
 */
await runMutations({
	source: "src/ui/external-picker-logic.ts",
	entries: ["src/ui/external-picker-logic"],
	suite: runExternalPickerSuite,
	mutations: [
		{
			// 后果：同一张图在两篇笔记里被合成一条 ⇒ 其中一篇不会被处理。
			name: "★ 勾选单位只用地址（同一张图在两篇笔记里被合成一条）",
			from: "\treturn `${notePath}\\u0000${url}`;",
			to: "\treturn url;",
			expect: "必须是两个键",
		},
		{
			// 后果：清单里出现一行点不动、也提交不了的幽灵（缺地址或缺笔记）。
			name: "★ 清单保留缺字段的条目（出现点不动的幽灵行）",
			from: '\t\tif (!url || !notePath) continue;\n',
			to: "\t\t// 变异：不检查字段\n",
			expect: "没有可用条目时应返回空清单",
		},
		{
			// 后果：完全相同的条目出现两次 ⇒ 全选后提交两条一样的（重复下载同一张图）。
			name: "★ 清单不去重（同一行出现两次）",
			from: "\t\tif (seen.has(key)) continue;\n",
			to: "\t\t// 变异：不去重\n",
			expect: "只该出现一次",
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
			// 后果：全选只勾一部分 ⇒ 用户以为全勾上了，实际漏了几张。
			name: "★ 全选只勾第一行（用户以为全勾上了）",
			from: "\tfor (const item of items) next.add(item.key);",
			to: "\tfor (const item of items.slice(0, 1)) next.add(item.key);",
			expect: "全选要勾上清单里每一行",
		},
	],
});
