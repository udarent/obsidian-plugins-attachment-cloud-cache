import { runMutations } from "./lib/mutate.mjs";
import { runExternalHookSuite } from "./lib/external-hook-suite.mjs";

/**
 * 变异验证：站外缓存编排（`src/render/external-hook.ts`）。
 *
 * 这一层跑在**每次重新渲染**上（滚动、切视图、编辑都会触发），
 * 所以它坏掉的两类症状都不报错：要么"同一个站点被反复问"（烦到不能用），
 * 要么"缓存了但笔记没改"（彻底的半成品，而站点记忆已经记成 allow，不会再问）。
 */
await runMutations({
	source: "src/render/external-hook.ts",
	entries: ["src/render/external-hook", "src/render/site-decisions"],
	suite: runExternalHookSuite,
	mutations: [
		{
			// 后果：同一篇文章里同站的每张图都弹一个通知；切一下视图就再来一轮。
			// 渲染会反复跑，所以这是"一开笔记就被通知刷屏"。
			name: "★ 不再按站点去重（同站每张图、每次重新渲染都弹一次）",
			from: "\t\t\t\t\tif (asked.has(decision.host) || asking.has(decision.host)) {\n\t\t\t\t\t\tresult.skipped += 1;\n\t\t\t\t\t\tcontinue;\n\t\t\t\t\t}\n",
			to: "\t\t\t\t\t// 变异：不去重\n",
			expect: "只该问一次",
		},
		{
			// 后果：用户答了却什么都没记下 ⇒ 下次渲染又问一遍，答案永远不生效。
			name: "★ 答复后不写记忆（用户答过也白答）",
			from: '\t\t\t\tdeps.remember(host, choice === "cache" ? "allow" : "deny");\n',
			to: "\t\t\t\t// 变异：不写记忆\n",
			expect: "必须记住",
		},
		{
			// 后果：先入队后写记忆 ⇒ 紧接着的一次渲染读到"还没写下的记忆" ⇒ 再问一遍。
			// 这条顺序错了不会报错，只是偶尔多问一次 —— 最难发现的一类。
			name: "★ 先执行后写记忆（紧接着的渲染会再问一次）",
			from: '\t\t\t\tdeps.remember(host, choice === "cache" ? "allow" : "deny");\n\t\t\t\tif (choice === "cache") enqueue(url, notePath);',
			to: '\t\t\t\tif (choice === "cache") enqueue(url, notePath);\n\t\t\t\tdeps.remember(host, choice === "cache" ? "allow" : "deny");',
			expect: "已经记住",
		},
		{
			// 后果：失败之后那个 URL 被永久卡在 inflight 里 ⇒ 用户重试也没反应，
			// 而界面上什么都没发生（与"下载失败"看起来一样，但永远好不了）。
			name: "★ inflight 只在成功时摘除（失败后那个 URL 被永久卡住）",
			from: "\t\tvoid Promise.resolve(deps.cache(url, notePath))\n\t\t\t.catch(report)\n\t\t\t.finally(() => inflight.delete(url));\n",
			to: "\t\tvoid Promise.resolve(deps.cache(url, notePath)).then(() => inflight.delete(url), report);\n",
			expect: "必须能重试",
		},
		{
			// 后果：拿不到笔记路径也照样缓存 ⇒ 图进了存储、笔记没变（改不了），
			// 而站点记忆已 allow ⇒ 下次不会再问。半成品且不可自愈。
			name: "★ 没有笔记路径也不早退（缓存了却改不了笔记）",
			from: '\t\t\tconst notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";\n\t\t\tif (!notePath) {\n\t\t\t\tresult.skipped = list.length;\n\t\t\t\treturn result;\n\t\t\t}\n',
			to: '\t\t\tconst notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";\n',
			expect: "不该询问",
		},
		{
			// 后果：UI 出问题时把"没回答"当成"同意" ⇒ 悄悄下载并上传用户没同意的图。
			// 这是最不该有的默认值：没回答就是没同意。
			name: "★ 询问失败被当成「同意」（悄悄下载上传用户没答应的图）",
			from: '\t\t\t\treport(error);\n\t\t\t\treturn "never";',
			to: '\t\t\t\treport(error);\n\t\t\t\treturn "cache";',
			expect: "默认同意",
		},
	],
});
