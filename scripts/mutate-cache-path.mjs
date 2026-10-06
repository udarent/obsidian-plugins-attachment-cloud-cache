import { runMutations } from "./lib/mutate.mjs";
import { runCachePathSuite } from "./lib/cache-path-suite.mjs";

/**
 * 变异验证：缓存路径模块。
 *
 * 这一版只针对唯一存在的那条语义（`缓存相对路径 === 对象 key`）——
 * 三种布局已被删除，理由见 `src/cache-path.ts` 的头注释。
 * 但**要守的两条安全性质一点没变**：
 *
 * 1. **单射性** —— 不同 key 不得推出同一路径，否则两张图互相覆盖，且是静默的；
 * 2. **`isUnderCacheFolder`** —— 它是「清理未使用缓存」删文件的判据，
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
			name: "空 key 被接受（会推到缓存根目录）",
			from: "\tif (!cleanKey || hasTraversal(cleanKey)) return null;",
			to: "\tif (hasTraversal(cleanKey)) return null;",
			expect: "空 key 应返回 null",
		},
		{
			// 这是本项目里最隐蔽的一类缺陷：缓存与桶不再一一对应，
			// 但**不会报错**，只是"有时命中有时不命中"或取到别人的图。
			name: "★ cachePathFor 不再保持 key 结构（多段 key 塌成 basename）",
			from: "\treturn `${root}/${cleanKey}`;",
			to: '\treturn `${root}/${cleanKey.split("/").pop()}`;',
			// 实际先红的是第 1 节那条"保持结构"的断言 —— 它比单射性更早，
			// 而且正是这条变异最该被拦下的地方（结构都不对了，谈单射没意义）
			expect: "多段 key → 保持结构",
		},
		{
			// 单射性的**独有**用例：恒等映射天然单射，所以只有当有人给路径加一道
			// 归一化（统一小写是最常见的一种）时才会撞名 —— 而撞名是静默覆盖。
			name: "★ key 被统一小写（大小写不同的两个 key 撞同一路径 → 静默互相覆盖）",
			from: "\treturn `${root}/${cleanKey}`;",
			to: "\treturn `${root}/${cleanKey.toLowerCase()}`;",
			expect: "不同 key 不得撞同一路径",
		},
		{
			name: "缓存目录自身不再清洗（前导斜杠会拼出 // 畸形路径）",
			from: "\tconst root = cleanVaultPath(cacheFolder);\n\tif (!root || hasTraversal(root)) return null;",
			to: "\tconst root = String(cacheFolder ?? \"\");\n\tif (!root || hasTraversal(root)) return null;",
			expect: "缓存目录的首尾斜杠要归一",
		},
	],
});
