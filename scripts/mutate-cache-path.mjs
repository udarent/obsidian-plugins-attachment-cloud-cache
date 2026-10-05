import { runMutations } from "./lib/mutate.mjs";
import { runCachePathSuite } from "./lib/cache-path-suite.mjs";

/**
 * 变异验证：缓存路径模块。
 *
 * 重点校验两处**安全性质**是否真的被守住：
 * 1. 单射性 —— 平铺/按扩展名布局下不同 key 不得撞同一路径；
 * 2. `isUnderCacheFolder` —— 它是「清理未使用缓存」删文件的判据，
 *    判宽了会删掉用户的笔记（不可逆）。
 */
await runMutations({
	source: "src/cache-path.ts",
	suite: runCachePathSuite,
	mutations: [
		{
			// 用字符串前缀代替路径段判断 → `_attachment-cache-other/` 会被误判为缓存
			name: "isUnderCacheFolder 改用字符串前缀（会删到非缓存文件）",
			from: "return clean.startsWith(`${root}/`);",
			to: "return clean.startsWith(root);",
			expect: "前缀相似但不同目录不算在内",
		},
		{
			name: "isUnderCacheFolder 不再拒绝穿越",
			from: "\tif (hasTraversal(raw)) return false;",
			to: "\t// 变异：不检查穿越",
			// 注意该断言用的是 `_attachment-cache/../notes/note.md` 这类
			// "以缓存目录开头但跳出去"的路径 —— 只测 `../outside/...` 测不出来
			expect: "跳出缓存的路径必须被拒绝",
		},
		{
			name: "cachePathFor 不再拒绝穿越（会推出越界路径）",
			from: "\tif (!cleanKey || hasTraversal(cleanKey)) return null;",
			to: "\tif (!cleanKey) return null;",
			expect: "含穿越的 key 必须直接拒绝",
		},
		{
			name: "flattenKey 对多段 key 不再加摘要（静默撞名）",
			from: "\tif (!clean.includes(\"/\")) return baseName(clean);",
			to: "\tif (clean) return baseName(clean);",
			expect: "不得撞同一路径",
		},
		{
			name: "byExt 缺扩展名时不再兜底（产生空目录段）",
			from: '\tconst ext = extensionOf(baseName(cleanKey)) || "misc";',
			to: "\tconst ext = extensionOf(baseName(cleanKey));",
			expect: "不应因缺扩展名产生空段",
		},
		{
			name: "mirror 不再保持 key 结构（缓存与桶不再一一对应）",
			from: '\tif (resolved === "mirror") return `${root}/${cleanKey}`;',
			to: '\tif (resolved === "mirror") return `${root}/${baseName(cleanKey)}`;',
			// 会被更靠前的那条 mirror 断言先拦下（这也是它该被拦下的地方）
			expect: "保持结构",
		},
		{
			name: "空 key 被接受（会推到缓存根目录）",
			from: "\tif (!cleanKey || hasTraversal(cleanKey)) return null;",
			to: "\tif (hasTraversal(cleanKey)) return null;",
			expect: "空 key 应返回 null",
		},
		{
			name: "未知布局不再回落（返回 null 而非 mirror）",
			from: '\tconst resolved: CacheLayout = isCacheLayout(layout) ? layout : "mirror";',
			to: "\tconst resolved: CacheLayout = isCacheLayout(layout) ? layout : (\"bogus\" as CacheLayout);",
			expect: "未知布局应回落到 mirror",
		},
	],
});
