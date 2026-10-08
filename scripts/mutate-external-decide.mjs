import { runMutations } from "./lib/mutate.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 变异验证：站外缓存判定（`src/render/external-decide.ts`）。
 *
 * 这一层的每条分支坏掉都不报错，只是行为变成另一个样子：
 * 功能关了却还在搬、对着自己的存储发问、把内网地址也拿去请求、
 * 或者**默认行为判反**（用户在设置里选了"什么都不做"，插件却在后台下载上传并改他的笔记）。
 *
 * ⚠️ 站点记忆那一套（`allow` / `deny`）已经整条拆掉，所以那两个锚点也随之删除 ——
 * 留着它们只会得到"变异点未找到"。
 */
await runMutations({
	source: "src/render/external-decide.ts",
	entries: ["src/render/external-decide"],
	suite: runExternalDecideSuite,
	mutations: [
		{
			// 后果：用户**关掉了功能却仍在被处理** —— 关不掉的开关比没有开关更糟。
			name: "★ 不看总开关（关掉功能仍会被处理）",
			from: '\tif (!input.settings.externalImageCache) return { action: "ignore", reason: "功能已关闭" };\n',
			to: "\t// 变异：不看开关\n",
			expect: "功能关着",
		},
		{
			// 后果：对着**用户自己的存储端点**列出候选（换过桶、或改过 publicUrlBase 的旧链接
			// 会走到这里），荒谬且会让清单里塞满他自己的地址。
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
			// 后果：没配好存储时也把图算成"可搬" ⇒ 渲染路径上每张图都会试一次，
			// 候选清单里也会出现勾了也做不成的条目。
			name: "★ 不再检查是否已配好（未配置时也当可搬）",
			from: '\tif (!input.configured) return { action: "ignore", reason: "存储未就绪" };\n',
			to: "\t// 变异：不看配置状态\n",
			expect: "未配置时不该动手",
		},
		{
			// 后果：**默认行为判反** —— 用户在设置里选的是「什么都不做」，
			// 插件却在后台把图下载、上传、并改写他的笔记。偏好被无视，而且静默。
			// 这是这一层最严重的一种坏法。
			name: "★ 默认行为判反（选了「什么都不做」却去下载上传并改写笔记）",
			from: '\treturn input.settings.externalImageDefault === "cache"',
			to: '\treturn input.settings.externalImageDefault !== "cache"',
			expect: "局域网地址照常算可搬的候选",
		},
		{
			// 后果：`wait`（默认不动手）被当成"不许碰" ⇒ 命令与「选择要缓存的外链图片」
			// 列不出任何候选 —— 用户把默认设成「什么都不做」之后，那两个显式入口等于不存在。
			name: "★ 把「默认不动手」当成「不许碰」（两个显式入口列不出候选）",
			from: '\treturn decision.action !== "ignore";',
			to: '\treturn decision.action === "cache";',
			expect: "局域网地址要能进候选清单",
		},
	],
});
