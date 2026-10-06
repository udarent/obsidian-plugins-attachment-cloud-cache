import { runMutations } from "./lib/mutate.mjs";
import { runDownloadSuite } from "./lib/download-suite.mjs";

/**
 * 变异验证：回退下载（`src/core/download.ts`）。
 *
 * 这一层是**唯一**会把远端字节写进用户 vault 的地方。所以除了"能不下载"，
 * 更要守住三条边界：站外图不下载、并发只下一次、绝不覆盖已有文件。
 */
await runMutations({
	source: "src/core/download.ts",
	entries: ["src/core/download", "src/cache/index", "src/s3/client", "src/render/render-target"],
	suite: runDownloadSuite,
	mutations: [
		{
			// 后果：SCOPE 的红线被越过 —— 站外图会被拉进用户 vault
			//（那正是另一个插件的定位，而且会带来存储与合规问题）。
			name: "★ 不再复核 URL 归属（站外图会被下载进 vault，越过红线）",
			from: "\t\tif (derived !== key) {\n\t\t\treturn { status: \"refused\", key, localPath: \"\" };\n\t\t}\n",
			to: "\t\tvoid derived; // 变异：不复核\n",
			expect: "必须拒绝下载",
		},
		{
			// 后果：一屏里同一张图出现 N 次就发 N 个 GET（移动端流量与等待都很明显）。
			name: "★ 去掉并发去重（同一张图在屏幕上出现几次就下载几次）",
			from: "\t\tconst existing = inflight.get(cleanKey);\n\t\tif (existing) return existing;\n",
			to: "\t\t// 变异：不去重\n",
			expect: "并发只该发 1 次 GET",
		},
		{
			// 后果：一次失败就让这个 key **永远**被判为"正在下载"，
			// 表现是"这张图再也下载不了了"，且不报错。
			name: "★ 去重表在失败时不摘除（一次失败之后这个 key 再也下载不了）",
			from: "\t\tconst task = run(cleanKey, cleanUrl).finally(() => {\n\t\t\tinflight.delete(cleanKey);\n\t\t});",
			to: "\t\tconst task = run(cleanKey, cleanUrl).then((result) => {\n\t\t\tif (result.status === \"downloaded\") inflight.delete(cleanKey);\n\t\t\treturn result;\n\t\t});",
			expect: "失败后必须能重试",
		},
		{
			// 后果：静默抹掉一个同名、且可能没有其它副本的文件 ——
			// 这是本项目里唯一会造成不可逆数据损失的操作。
			name: "★ 直接写到目标路径（覆盖用户同名的文件）",
			from: "\t\t\tconst path = await uniqueVaultPath(target, exists);",
			to: "\t\t\tconst path = target;",
			expect: "不得写到已占用的路径",
		},
		{
			// 后果：用户明确关掉了回退下载，插件还是偷偷联网 —— 这是对设置的违背。
			name: "忽略回退下载开关（用户关掉了仍然联网）",
			from: "\t\tif (!settings.fallbackDownload) {\n\t\t\treturn { status: \"disabled\", key, localPath: \"\" };\n\t\t}\n",
			to: "\t\t// 变异：忽略开关\n",
			expect: "关掉开关",
		},
		{
			// 后果：断网时每张图都弹一条"下载失败" —— 那正是用户此刻的状态，
			// 弹提示既无用又刷屏。
			name: "离线失败也提示（断网时被每张图的提示刷屏）",
			from: "\tif (kind === \"network\") return false;\n",
			to: "\tif (kind === \"network\") return true;\n",
			expect: "应静默",
		},
		{
			// 后果：反向 —— 配置错误被静默掉，用户永远查不出"为什么图一直补不上"。
			name: "★ 配置类失败被静默（用户永远查不出配错了）",
			from: "\tif (!kind) return true; // 不认识的错误：宁可说出来\n",
			to: "\tif (!kind) return false; // 变异：静默\n",
			expect: "不认识的错误应提示",
		},
		{
			// 后果：拿不到客户端时照样往下走 ⇒ 变成"失败并提示"，
			// 于是渲染时每张图都弹一条"未配置"，而这件事在粘贴时与设置页已经说过了。
			name: "拿不到客户端时不再早退（渲染时每张图都弹\"未配置\"）",
			from: "\t\tconst client = deps.client();\n\t\tif (!client) {\n\t\t\treturn { status: \"unavailable\", key, localPath: \"\" };\n\t\t}\n",
			to: "\t\tconst client = deps.client();\n\t\t// 变异：不早退\n",
			expect: "还没配好",
		},
	],
});
