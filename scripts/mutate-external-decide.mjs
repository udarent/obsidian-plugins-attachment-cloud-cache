import { runMutations } from "./lib/mutate.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 变异验证：站外文件判定（`src/render/external-decide.ts`）。
 *
 * 这一层的每条分支坏掉都不报错，只是行为变成另一个样子：功能关了却还在搬、
 * 对着自己的存储发问、把内网地址也拿去请求、或者**名单形同虚设**
 *（用户在设置里把某个站点拉黑，插件照旧自动去搬它的文件并改写笔记）。
 *
 * ⚠️ 1.2.0 把旧的三态（`ignore` / `wait` / `cache`）收敛成了两态，判定多了
 * `purpose` 这一维，所以这里锚定的东西也换了：
 * - 从前守的是"默认行为别判反"，现在守的是"**别把开关 / 名单也套到显式工具上**" ——
 *   那会让「挑选要缓存的文件」随开关一起消失（入口消失比行为错更难发现）。
 *
 * ⚠️ 站点记忆那一套（`allow` / `deny`）已经整条拆掉，所以相关的锚点也随之删除 ——
 * 留着它们只会得到"变异点未找到"。
 */
await runMutations({
	source: "src/render/external-decide.ts",
	entries: ["src/render/external-decide"],
	suite: runExternalDecideSuite,
	mutations: [
		{
			// 后果：用户**关掉了功能却仍在被自动处理** —— 关不掉的开关比没有开关更糟。
			name: "★ 不看总开关（关掉功能仍会被自动处理）",
			from: '\tif (input.purpose === "auto" && !input.settings.externalImageCache) {\n',
			to: '\tif (input.purpose === "auto" && false) {\n',
			expect: "功能关着",
		},
		{
			// 后果：**把总开关也套到显式工具上** ⇒ 关掉自动处理的人连
			// 「挑选要缓存的文件」都列不出候选。入口悄无声息地消失，用户只会以为"功能没了"。
			name: "★ 把总开关套到显式工具上（关掉开关后挑不出候选）",
			from: '\tif (input.purpose === "auto" && !input.settings.externalImageCache) {\n',
			to: '\tif (!input.settings.externalImageCache) {\n',
			expect: "显式工具不受开关约束",
		},
		{
			// 后果：**名单也套到了显式工具上** ⇒ 用户手动勾中的文件搬不动，
			// 而界面上没有任何提示（勾选本身就是同意，不该被一份"自动搬的准入"否掉）。
			name: "★ 把名单也套到显式工具上（手动勾选的被名单挡住）",
			from: '\t\tinput.purpose === "auto" &&\n\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n',
			to: '\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n',
			expect: "显式工具不受名单约束",
		},
		{
			// 后果：**名单形同虚设** —— 用户把站点拉黑（或只留白名单），插件照旧自动去搬。
			// 这是"设置改了、没有任何效果"的典型：用户查不出为什么名单不起作用。
			name: "★ 名单形同虚设（自动处理无视黑/白名单）",
			from: "\t\t!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)\n",
			to: "\t\tfalse\n",
			expect: "黑名单",
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
			// 后果：没配好存储时也把文件算成"可搬" ⇒ 渲染路径上每张图都会试一次，
			// 候选清单里也会出现勾了也做不成的条目。
			name: "★ 不再检查是否已配好（未配置时也当可搬）",
			from: '\tif (!input.configured) return { action: "ignore", reason: "存储未就绪" };\n',
			to: "\t// 变异：不看配置状态\n",
			expect: "未配置时不该动手",
		},
	],
});
