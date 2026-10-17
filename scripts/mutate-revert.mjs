import { runMutations } from "./lib/mutate.mjs";
import { runRevertSuite } from "./lib/revert-suite.mjs";

/**
 * 变异验证：把链接改回本地路径。
 *
 * ⚠️ 每条 `expect` 都是实测下来**最先红**的那条断言。
 */
await runMutations({
	source: "src/maintenance/revert.ts",
	entries: ["src/maintenance/revert", "src/plugin/revert-flow"],
	suite: runRevertSuite,
	mutations: [
		{
			// 后果：**本地副本已经被删了，链接还被改回去** —— 用户得到一条打不开的链接，
			// 而且从此再没有任何东西能把那份文件取回来（云端地址被覆盖掉了）。
			name: "★★ 本地副本不在也改回本地路径（造一条打不开的链接）",
			from: "if (!input.present(path)) {",
			to: "if (false) {",
			expect: "本地副本不在的那份不许进改写目标",
		},
		{
			// 后果：**有目标却一处都不改** —— 用户点了按钮、提示说成功，笔记一个字没变。
			name: "★★ 有可改目标却静默空转（点了按钮，笔记没变）",
			from: "if (targets.length === 0) return { text, count: 0 };",
			to: "if (targets.length >= 0) return { text, count: 0 };",
			expect: "四种写法都要改",
		},
	],
});
