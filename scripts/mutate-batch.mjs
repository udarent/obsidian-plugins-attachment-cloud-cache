import { runMutations } from "./lib/mutate.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 变异验证：批量上传的**候选挑选**（`src/maintenance/batch.ts`）。
 *
 * 这一层决定"哪些文件/哪些外链图会被真的下载、上传、并改写笔记"。
 * 它坏掉的两类症状都不报错：
 * - **选出太多**（把网页当图片、把用户明确拒绝过的站点也照抓）——
 *   用户的机器会去访问他从未同意过的地方；
 * - **选出太少**（同一篇文章里的图被漏掉一半）——
 *   表现为"迁移完了，可有些图还指着原来的地方"。
 *
 * ⚠️ 库内文件那部分的判定由 `mutate-maintenance-audit.mjs` 覆盖（它用同一套套件）。
 * 这里只加**外链**这一类 —— `runMutations` 一个文件只能调一次，
 * 所以新的一类判定就该有新的一份变异文件。
 */
await runMutations({
	source: "src/maintenance/batch.ts",
	entries: [
		"src/maintenance/audit",
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/settings",
		"src/types",
		"src/render/site-decisions",
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// 后果：普通链接（指向网页而不是图片）也被当成外链图去下载 ——
			// 命令会去抓一堆 HTML，然后报一串"不是图片"的失败。
			name: "★ 外链候选把普通链接也收进来（把网页当图片去下载）",
			from: "text.matchAll(/!\\[[^\\]\\n]*\\]\\(\\s*(<[^>)\\n]*>|[^)\\s\\n]+)/g)",
			to: "text.matchAll(/!?\\[[^\\]\\n]*\\]\\(\\s*(<[^>)\\n]*>|[^)\\s\\n]+)/g)",
			expect: "普通链接",
		},
		{
			// 后果：判定层被绕过 ⇒ **用户自己的存储地址、他明确标过「不再询问」的站点、
			// 以及回环/链路本地地址全都会变成候选**。这是这条命令最严重的一种坏法：
			// 它会去访问用户从未同意过的地方，甚至去请求本机与云元数据端点。
			name: "★ 外链候选不再经过判定层（自己的存储与「不再询问」的站点都会被下载）",
			from: '\t\t\tif (decision.action === "ignore") {\n',
			to: "\t\t\tif (false) {\n",
			expect: "候选要带上",
		},
		{
			// 后果：`needsConsent` 是**授权信号** —— 确认框靠它决定"要不要说明
			// 点确认就等于授权"，调用方也靠它决定"要不要把站点记成「缓存」"。
			// 报成 false 的话，用户会在没有任何提示的情况下授权一次下载。
			name: "★ 不再标出「这个站点还没答过」（用户会在毫无提示的情况下授权下载）",
			from: 'needsConsent: decision.action === "ask"',
			to: "needsConsent: false",
			expect: "标出哪些还没答过",
		},
	],
});
