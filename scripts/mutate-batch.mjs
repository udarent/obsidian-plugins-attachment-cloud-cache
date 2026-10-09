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
		"src/render/external-decide",
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
			name: "★ 外链候选不再经过判定层（自己的存储、回环地址、未就绪的存储都会被下载）",
			from: '\t\t\tif (!isCacheableExternal(decision)) {\n',
			to: "\t\t\tif (false) {\n",
			expect: "候选要带上",
		},
		{
			// 后果：**没有任何笔记引用**的文件也被当成候选 ⇒ 命令会把它们
			// 上传、移进缓存目录并改名。而它们没有任何链接会把用户引到新位置，
			// 用户看到的只是"我放在附件目录里的东西被搬走了"。
			name: "★ 未引用的文件也进候选（把用户放在附件目录里的东西搬走）",
			from: '\t\tif (!options.referencedPaths.has(file.path)) {\n',
			to: "\t\tif (false) {\n",
			expect: "只有被笔记引用的才处理",
		},
		{
			// 后果：连**画布**里的引用也算"被笔记引用" ⇒ 只被画布引用的附件被搬走，
			// 而画布里的那条引用我们不改写（`planLinkRewrites` 只认 Markdown）⇒ 画布上的图没了。
			name: "★ 不按来源筛（画布里的引用也算笔记引用，搬走之后画布上的图变死链）",
			from: "\t\tif (!/\\.md$/i.test(sourcePath)) continue;\n",
			to: "\t\t// 变异：不筛来源\n",
			expect: "画布里的引用不算",
		},
	],
});
