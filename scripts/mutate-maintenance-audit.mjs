import { runMutations } from "./lib/mutate.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 变异验证：维护功能的纯判定层。
 *
 * 这些判定决定的是**删用户的文件**与**改用户的笔记** —— 本项目里唯二不可逆的操作。
 * 失效的症状还特别安静：多删一份副本没人立刻发现（下次联网会重新下载），
 * 但改坏一条链接会立刻显示成"图没了"。
 *
 * ⚠️ 1.3.0（D-17）：审计的口径换成了**索引 + 存在性**（见 `audit.ts` 文件头）。
 * 与"孤儿 / 缓存目录"有关的两条锚点随代码一起删掉了；新锚点盯的是新口径里那几件
 * 会出错的事：索引外的文件混进统计、字节取错来源、同一路径重复计。
 */
await runMutations({
	source: "src/maintenance/audit.ts",
	entries: [
		"src/maintenance/audit",
		"src/maintenance/references",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/settings",
		"src/types",
		// 套件里有外链候选那一段（它要跑判定层），所以要一起进 bundle ——
		// 少了它，基线会以「找不到模块」失败。
		"src/render/external-decide",
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// 后果：**用户的附件被计成我们的副本** —— 报告里的数字从此包含不属于我们的东西，
			// 而"可回收多少"会被读成"能删多少"。这正是 1.3.0 把口径改成"只认索引"的原因。
			name: "★ 索引外的文件也计进占用（用户的附件被当成我们的副本）",
			from: "\treturn { missingCopies, unused, healthy, bytes: { total, reclaimable } };",
			to: "\tfor (const [p, f] of input.copies) if (!counted.has(p)) total += f.bytes;\n\treturn { missingCopies, unused, healthy, bytes: { total, reclaimable } };",
			expect: "索引外的文件不得计入占用",
		},
		{
			// 后果：报告里的"占了 N MB"变成索引里那个可能过时的值（用户换过文件、同步中断过），
			// 而它要回答的是"磁盘上实际占了多少"。
			name: "★ 字节取索引里记的值而不是磁盘真相（占用报的是过时数字）",
			from: "\t\tconst size = Math.max(0, copy.bytes);",
			to: "\t\tconst size = Math.max(0, entry.size);",
			expect: "总字节按**磁盘**算",
		},
		{
			// 后果：两条记录指着同一份副本时占用被算两遍 —— 报告虚高，用户以为占得比实际多。
			name: "★ 同一路径重复计占用（总数虚高）",
			from: "\t\tif (!counted.has(path)) {\n\t\t\tcounted.add(path);\n\t\t\ttotal += size;\n\t\t}",
			to: "\t\tcounted.add(path);\n\t\ttotal += size;",
			expect: "同一路径只计一次占用",
		},
		{
			// ⚠️ 1.3.0：`planCleanup`（"执行清单也用截断后的"那条锚点）随 `clean-cache` 的退役
			// 一起删掉了 —— 死代码的锚点留着只会让"全都抓住了"这句话不可信。
			// 后果：没扫描引用时把所有副本都报成"未引用"⇒ 用户看到"全部可回收"。
			name: "★ 没扫描引用也判\"未引用\"（把每一份都报成可删）",
			from: "\t\tif (input.referencedKeys && !input.referencedKeys.has(entry.key)) {",
			to: "\t\tif (!input.referencedKeys || !input.referencedKeys.has(entry.key)) {",
			expect: "不该产生",
		},
	],
});
