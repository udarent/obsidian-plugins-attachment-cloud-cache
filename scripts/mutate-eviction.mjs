import { runMutations } from "./lib/mutate.mjs";
import { runEvictionSuite } from "./lib/eviction-suite.mjs";

/**
 * 变异验证：缓存上限与自动轮换的判定（`src/maintenance/eviction.ts`）。
 *
 * 这一层会**自动把文件送进回收站**，而且没人在旁边看着。每条变异对应的都是
 * "不报错、但删错了"或"该删的不删"：把用户的正常附件也算进来、把刚下载的立刻删掉、
 * 把不限制当成上限 0（于是把整个缓存清空）。
 */
await runMutations({
	source: "src/maintenance/eviction.ts",
	entries: ["src/maintenance/eviction", "src/cache-path", "src/records"],
	suite: runEvictionSuite,
	mutations: [
		{
			// 后果：用户没设上限（0）时把"0 字节"当成目标 ⇒ **整个缓存被淘汰**。
			// 这是最严重的一种：设置里的"0 = 不限制"被理解成"上限为零"。
			name: "★ 把「不限制」当成「上限为 0」（不设上限反而清空整个缓存）",
			from: '\tif (limit <= 0) return done("未设上限（0 = 不限制）");\n',
			to: "\t// 变异：不区分「不限制」\n",
			expect: "不限制",
		},
		{
			// 后果：任何笔记都没有引用的副本（纯占地方）不再被优先淘汰 ⇒
			// 被淘汰的可能是用户天天在看的图，而没人要的那份留下来。
			name: "★ 不再优先淘汰「没有任何笔记引用」的副本（该走的没走，天天在看的反被删）",
			from: "\t\tconst byRef = Number(a.referenced) - Number(b.referenced);\n\t\tif (byRef !== 0) return byRef;\n",
			to: "\t\t// 变异：不看引用情况\n",
			expect: "未引用优先",
		},
		{
			// 后果：刚下载 / 刚粘贴的副本立刻被淘汰 ⇒ 刚花掉的流量白扔，而且会来回抖动
			//（淘汰 → 下次看图又下载 → 再淘汰）。
			name: "★ 不再有宽限期（刚下载完就删掉，来回抖动）",
			from: "\tconst eligible = input.candidates.filter((candidate) => input.now - candidate.lastUsedAt >= graceMs);\n",
			to: "\tconst eligible = input.candidates.filter(() => true);\n",
			expect: "不参与淘汰",
		},
		{
			// 后果：`localCopy: "keep"` 时副本在用户的**附件目录**里 —— 那是正常附件。
			// 它们一旦进了候选，就会被自动送进回收站，而且没人在旁边看着。
			//
			// ⚠️ 这里打的是**文件侧**那道过滤（`files` → 磁盘映射）。附件目录有**两道**保护：
			// 文件侧（不把缓存目录外的文件收进映射）与条目侧（`entry.cachePath` 不在缓存目录内就跳过）。
			// 只拆条目侧那一道**不会**漏东西 —— 文件侧已经把那些路径挡在外面了，
			// 所以那个方向上是刻意的双保险（与 `runCleanup` 的"双保险"同一条纪律），
			// 不追求"每道都能被单独杀掉"。
			name: "★ 磁盘文件不再限定在缓存目录内（开始自动删用户的正常附件）",
			from: "\t\tif (!isUnderCacheFolder(file.path, input.cacheFolder)) continue;\n\t\tdisk.set(normalize(file.path), file);",
			to: "\t\tdisk.set(normalize(file.path), file);",
			expect: "附件",
		},
		{
			// 后果：没扫引用时把"不知道"当成"没人用" ⇒ 优先删掉一批可能还有人要的副本。
			name: "★ 没扫引用时把「不知道」当成「没人用」",
			from: "\t\t\treferenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : true,",
			to: "\t\t\treferenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : false,",
			expect: "不知道",
		},
		{
			// 后果：孤儿（磁盘上有、索引里没有）不再进候选 ⇒ 索引一旦损坏/被删，
			// 缓存目录里那堆文件永远腾不掉，上限形同虚设。
			name: "★ 孤儿不再进候选（索引损坏后上限永久失效）",
			from: "\tfor (const [path, file] of disk) {\n\t\tif (indexedPaths.has(path)) continue;",
			to: "\tfor (const [path, file] of []) {\n\t\tif (indexedPaths.has(path)) continue;",
			expect: "孤儿",
		},
		{
			// 后果：磁盘大小拿不到时按 0 算 ⇒ "能腾出多少空间"报成 0，
			// 于是轮换以为腾够了，实际上超出的全是这些被算成 0 的文件。
			name: "★ 磁盘大小拿不到时不退回索引记录的数字（把「能腾多少」算成 0）",
			from: "\t\t\tbytes: file.bytes > 0 ? file.bytes : Math.max(0, entry.size),",
			to: "\t\t\tbytes: file.bytes,",
			expect: "退回索引",
		},
		{
			// 后果：非数/负数不再被拦住 ⇒ 字符串会算出 NaN，负上限会让"一切都超限"。
			name: "★ 上限换算不再挡住非数与负数（NaN / 负上限）",
			from: '\tif (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) return 0;\n\treturn Math.floor(mb * 1024 * 1024);',
			to: "\treturn mb * 1024 * 1024;",
			expect: "不限制",
		},
	],
});
