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
			// ⚠️ 这条原本守"嵌入写法 `![]()` 不许被漏掉"。实测发现那个 `!?` 是**多余的**：
			// `![a](url)` 里的 `[a](url)` 本来就会被 `\[` 命中（锚点在 `[`，`!` 不属于匹配的一部分），
			// 于是变异改不改都一个样 —— 变异验证如实报"漏过"（实现里那个 `!?` 也已删掉）。
			// 改成守**行内 HTML 那一支**：漏掉 `<a href>` 会让"用一个普通链接指向站外的
			// PDF/音频"永远进不了候选，而这正是 1.1.0 要认真处理的一类（需求 R15）。
			name: "★ 外链候选漏掉行内 <a href>（普通链接指向的文件永远进不了候选）",
			from: "/<(?:img|a)\\b[^>]*?\\b(?:src|href)\\s*=\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)')/gi",
			to: "/<img\\b[^>]*?\\bsrc\\s*=\\s*(?:\"([^\"\\n]*)\"|'([^'\\n]*)')/gi",
			expect: "行内 HTML 的 <a href> 同样要认",
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
			// 后果：同名歧义时"两个都算被引用" ⇒ 命令把 a/dup.png 与 b/dup.png 都搬进缓存，
			// 而改写器在歧义时**拒绝改写**（它分不清 `![[dup.png]]` 指哪个）⇒ 两处链接
			// 全成死链。宁可少处理。
			name: "★ 画布引用的同名歧义被当成「都算引用」（搬走却改不掉 ⇒ 死链）",
			from: "\t\tif (candidates && candidates.length === 1) out.add(candidates[0]);",
			to: "\t\tfor (const hit of candidates ?? []) out.add(hit);",
			expect: "同名歧义一个都不收",
		},
		{
			// 后果：**画布里的引用被丢掉** ⇒ 只被画布引用的附件永远进不了候选
			//（用户把图摆在画布里是最常见的用法之一，而需求 R16 明确要求"同等算数"）。
			// ⚠️ 方向与 1.1.0 之前相反：那时是"画布必须排除"（画布里的引用改不了），
			// 现在改写器会改画布，所以"漏掉画布"才是缺陷。
			name: "★ 画布里的引用被丢掉（只被画布引用的附件永远不被处理）",
			from: "\t\t// \u2b50 来源**不筛**：Markdown 笔记与画布同等算数（需求 R16，2026-10-09 拍板）。\n\t\t// 空的来源路径仍然跳过 —— 那不是宿主会给的形状。\n\t\tif (!sourcePath) continue;",
			to: "\t\tif (!/\\.md$/i.test(sourcePath)) continue;\n\t\tif (!sourcePath) continue;",
			expect: "画布里的引用**算数**",
		},
	],
});
