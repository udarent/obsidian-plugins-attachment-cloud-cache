import { runMutations } from "./lib/mutate.mjs";
import { runSiteDecisionsSuite } from "./lib/site-decisions-suite.mjs";

/**
 * 变异验证：站点决定记忆（`src/render/site-decisions.ts`）。
 *
 * 这一层存的是**用户表达过的意图**，所以它坏掉的方式都很安静：
 * 记忆还在、插件也照跑，只是用户的选择**不生效**了（仍然被问，或"不再询问"被绕开）。
 * 所以归一化、删除的返回值、落盘顺序、以及读坏数据的降级，每条都要能被单独打坏。
 */
await runMutations({
	source: "src/render/site-decisions.ts",
	entries: ["src/render/site-decisions"],
	suite: runSiteDecisionsSuite,
	mutations: [
		{
			// 后果：`Example.com` 与 `example.com` 变成两条 ⇒ 用户在一个拼写下选了「不再询问」，
			// 换个拼写（或换个来源写入的 URL）就又被问 —— 而用户以为自己已经答过了。
			name: "★ 主机不再归一化大小写（同一站点记成两条，「不再询问」失效）",
			from: '\treturn host.trim().toLowerCase().replace(/\\.+$/, "");',
			to: "\treturn host.trim();",
			expect: "大小写",
		},
		{
			// 后果：调用方会照着返回值汇报，于是"清除了 0 个"变成"已清除" —— 用户以为清掉了，
			// 而列表其实没变。这条设置页会直接显示给用户看。
			name: "删除不再返回是否真的删掉（调用方无法如实汇报）",
			from: "\t\treturn key ? this.byHost.delete(key) : false;",
			to: "\t\tif (key) this.byHost.delete(key);\n\t\treturn true;",
			expect: "删不存在",
		},
		{
			// 后果：落盘顺序取决于访问历史 ⇒ 每次写入的 diff 都在变，
			// 用户把 `.obsidian/` 放进 git 就会看到莫名其妙的改动。
			name: "落盘顺序不稳定（每次 diff 都在变）",
			from: '\t\treturn [...this.byHost.entries()]\n\t\t\t.map(([host, decision]) => ({ host, decision }))\n\t\t\t.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));',
			to: "\t\treturn [...this.byHost.entries()].map(([host, decision]) => ({ host, decision }));",
			expect: "顺序",
		},
		{
			// 后果：记忆文件是用户可以手改的。改坏一个字符 → 插件在**启动时**抛错 →
			// 用户看到的是"插件加载失败"，而不是"某条记忆读不出来"。
			name: "★ 读坏数据直接抛错（一个手改坏的文件让插件起不来）",
			from: '\t\tif (!value || typeof value !== "object") return new SiteDecisions();',
			to: '\t\tif (!value || typeof value !== "object") throw new Error("变异：坏数据没有降级");',
			expect: "读坏数据不该抛错",
		},
		{
			// 后果：非法值被写进记忆（`decision: "maybe"`）→ 之后所有判断都不认识它 →
			// 表现为"记忆里有这个站点，但行为像没记过"，极难归因。
			name: "写入不再校验决定值（非法值进记忆，之后谁都不认识它）",
			from: "\t\tif (!key || !isSiteDecision(decision)) return false;",
			to: "\t\tif (!key) return false;",
			expect: "非法的决定值",
		},
	],
});
