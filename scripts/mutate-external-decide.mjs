import { runMutations } from "./lib/mutate.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 变异验证：站外缓存判定（`src/render/external-decide.ts`）。
 *
 * 这一层的每条分支坏掉都不报错，只是行为变成另一个样子：
 * 功能关了却还在问、记过"不再询问"却还问、对着自己的存储发问、
 * 或者把内网地址也拿去请求。所以六条分支逐条打坏。
 */
await runMutations({
	source: "src/render/external-decide.ts",
	entries: ["src/render/external-decide", "src/render/site-decisions"],
	suite: runExternalDecideSuite,
	mutations: [
		{
			// 后果：用户**关掉了功能却仍在被问** —— 关不掉的开关比没有开关更糟。
			name: "★ 不看总开关（关掉功能仍会被询问）",
			from: '\tif (!input.settings.externalImageCache) return { action: "ignore", reason: "功能已关闭" };\n',
			to: "\t// 变异：不看开关\n",
			expect: "功能关着",
		},
		{
			// 后果：用户选过"此站点不再询问"，却每次都还被问 —— 记忆存了等于没存。
			name: "★ 忽略「不再询问」的记忆（用户答过也照问）",
			from: '\tif (remembered === "deny") return { action: "ignore", reason: "该站点已标记不再询问" };\n',
			to: "\t// 变异：忽略 deny\n",
			expect: "不再询问",
		},
		{
			// 后果：用户选过"缓存并记住"，却每次都还要再点一次 —— 站点记忆形同虚设。
			name: "★ 忽略「已记住」的记忆（每次都重新问一遍）",
			from: '\tif (remembered === "allow") return { action: "cache", host };\n',
			to: "\t// 变异：忽略 allow\n",
			expect: "已记住",
		},
		{
			// 后果：对着**用户自己的存储端点**弹"要不要缓存这张站外图"
			// （换过桶、或改过 publicUrlBase 的旧链接会走到这里），荒谬且会引导用户误操作。
			name: "★ 不再按主机识别本存储（对着自己的端点发问）",
			from: '\tif (ownHosts(input.settings.s3).has(host)) {\n\t\treturn { action: "ignore", reason: "属于本存储（主机匹配）" };\n\t}\n',
			to: "\t// 变异：不看主机\n",
			expect: "主机匹配",
		},
		{
			// 后果：把回环/链路本地地址也纳入处理 ⇒ 笔记里一张图就能让插件去请求
			// `127.0.0.1` 或云元数据端点（那是别人机器上的探测原语）。
			name: "★ 不再拦回环与链路本地地址（把内网探测发出去）",
			from: '\tif (isBlocked(host)) return { action: "ignore", reason: "本地/链路本地地址（安全）" };\n',
			to: "\t// 变异：不拦本地地址\n",
			expect: "回环",
		},
		{
			// 后果：没配好存储时逐张图弹"未配置" ⇒ 打开一篇含站外图的笔记就刷一屏通知。
			name: "★ 不再检查是否已配好（未配置时刷屏询问）",
			from: '\tif (!input.configured) return { action: "ignore", reason: "存储未就绪（不打扰）" };\n',
			to: "\t// 变异：不看配置状态\n",
			expect: "未配置",
		},
	],
});
