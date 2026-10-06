import { runMutations } from "./lib/mutate.mjs";
import { runMaintenanceSuite } from "./lib/maintenance-suite.mjs";

/**
 * 变异验证：维护功能的纯判定层。
 *
 * 这些判定决定的是**删用户的文件**与**改用户的笔记** —— 本项目里唯二不可逆的操作。
 * 失效的症状还特别安静：多删一个缓存文件没人立刻发现（下次联网会重新下载），
 * 但改坏一条链接会立刻显示成"图没了"。
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
	],
	suite: runMaintenanceSuite,
	mutations: [
		{
			// 后果：附件目录里的**正常附件**被当成孤儿清理 —— 用户的图片被删。
			name: "★ 只按\"磁盘上没有索引记录\"判孤儿（把附件目录里的文件也当孤儿）",
			from: "\t\tif (!isUnderCacheFolder(file.path, input.cacheFolder)) continue;\n",
			to: "\t\t// 变异：不限定缓存目录\n",
			expect: "算孤儿",
		},
		{
			// 后果：`localCopy: "keep"` 的副本被误判成"失效条目"→ 自愈摘掉它的索引记录
			// → 那些图**失去离线能力**（功能悄悄退化，没有任何报错）。
			name: "★ 不区分缓存目录外的副本（keep 模式的图被误判成「失效条目」，自愈会摘掉它的索引）",
			from: "\t\tif (!isUnderCacheFolder(path, input.cacheFolder)) {\n\t\t\toutsideCache.push(entry);\n\t\t\tcontinue;\n\t\t}\n",
			to: "\t\t// 变异：不分类\n",
			expect: "失效条目",
		},
		{
			// 后果：清理清单被截断 ⇒ 用户以为清干净了，其实还有一堆文件占着空间。
			name: "★ 执行清单也用截断后的（清理静默漏掉后面的对象）",
			from: "\tconst all = [...audit.orphans.map((file) => normalize(file.path)), ...audit.unused.map((entry) => normalize(entry.cachePath))];",
			to: "\tconst all = [...audit.orphans.map((file) => normalize(file.path)), ...audit.unused.map((entry) => normalize(entry.cachePath))].slice(0, limit);",
			expect: "必须**全量**",
		},
		{
			// 后果：没扫描引用时把所有副本都报成"未引用"⇒ 用户看到"全部可清理"。
			name: "★ 没扫描引用也判\"未引用\"（把每一份都报成可删）",
			from: "\t\tif (input.referencedKeys && !input.referencedKeys.has(entry.key)) {",
			to: "\t\tif (!input.referencedKeys || !input.referencedKeys.has(entry.key)) {",
			expect: "不该产生",
		},
	],
});
