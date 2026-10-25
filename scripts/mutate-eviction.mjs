import { runMutations } from "./lib/mutate.mjs";
import { runEvictionSuite } from "./lib/eviction-suite.mjs";

/**
 * 变异验证：缓存上限与自动轮换的判定（`src/maintenance/eviction.ts`）。
 *
 * 这一层会**直接删除本地副本**，而且没人在旁边看着。每条变异对应的都是
 * "不报错、但删错了"或"该删的不删"：把索引之外的东西也算进来（那是用户的附件）、
 * 把刚下载的立刻删掉、把不限制当成上限 0（于是把副本清空）。
 *
 * ⚠️ 1.2.0（D-17）改造后，这一层的候选**只来自索引** —— 所以"孤儿"那条变异
 * （磁盘上有、索引里没有也照样删）被删掉了：它不是"防线"，而是**唯一在防的事**。
 * 取而代之的是下面两条新变异：索引不认得的路径不能进候选、统计不能漏掉附件目录那份。
 */
await runMutations({
	source: "src/maintenance/eviction.ts",
	entries: ["src/maintenance/eviction", "src/records"],
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
			// 后果：磁盘上已经没有的文件也进候选 ⇒ 执行层拿不到删除凭据、白报一次"跳过"，
			// 而真正的超限量会被算错（把不存在的东西算进"可腾空间"）。
			name: "★ 不检查副本是否还在磁盘上（把不存在的东西算进可腾空间）",
			from: "		if (!input.present(path)) {\n		\tmissing += 1;\n\t\t\tcontinue;\n		}",
			to: "		if (false) {\n		\tmissing += 1;\n\t\t\tcontinue;\n		}",
			expect: "磁盘",
		},
		{
			// 后果：没扫引用时把"不知道"当成"没人用" ⇒ 优先删掉一批可能还有人要的副本。
			name: "★ 没扫引用时把「不知道」当成「没人用」",
			// ⚠️ 2026-10-15：库内路径那一半改成了**硬门槛**（在上面那道 `continue` 里），
			// 于是这里回到"只由 referencedKeys 决定排序"的一行；意图不变：把「没扫引用」的兜底
			// 从「已引用」翻成「没人用」。
			from: "referenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : true,",
			to: "referenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : false,",
			expect: "不知道",
		},
		{
			// 后果：统计口径又退回"只算缓存目录内" ⇒ keep 档的副本不计入上限，
			// 于是界面上看得见的上限管不到实际占空间的那些（P7 的老毛病）。
			name: "★ 统计口径漏掉附件目录里的副本（上限管不到实际占空间的那些）",
			from: "	\tconst size = typeof entry.size === \"number\" && Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;\n\t\ttotal += size;",
			to: "\t\tif (!entry.cachePath.startsWith(\"_attachment-cache/\")) continue;\n\t\ttotal += 0;",
			expect: "统计范围",
		},
		{
			// 后果：非数/负数不再被拦住 ⇒ 字符串会算出 NaN，负上限会让"一切都超限"。
			name: "★ 上限换算不再挡住非数与负数（NaN / 负上限）",
			from: '\tif (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) return 0;\n\treturn Math.floor(mb * 1024 * 1024);',
			to: "\treturn mb * 1024 * 1024;",
			expect: "不限制",
		},
		{
			// 后果：一份**笔记直接指着**的副本（笔记里写的是 `![](../图.png)` 这种库内路径）
			// 进了候选 ⇒ 超上限时被删掉 —— 那条链接指着的是这份文件本身，**没有兜底**
			//（回退下载只认属于本存储的 URL）⇒ 用户打开那篇笔记看到的是**破图**。
			name: "★★ 库内路径指着的副本也进候选（删掉笔记正在显示的那份文件）",
			from: "\t\tif (input.referencedPaths.has(path)) {",
			to: "\t\tif (false) {",
			expect: "库内路径指着的那份",
		},
		{
			// 后果：把「提过云端地址」的也当成不能删 ⇒ 淘汰几乎挑不出人来（副本空间释放白做）。
			// ⚠️ 这条守的是**用户 2026-10-15 的口径**：「笔记里存的是远端地址、只是没在看」，
			// 删了下次看会**回退下载** ⇒ 该删。过度保护会让上限形同虚设。
			name: "★★ 过度保护：把「笔记里提过云端地址」的也当成不能删（淘汰挑不出人）",
			from: "\t\tif (input.referencedPaths.has(path)) {",
			to: "\t\tif (input.referencedPaths.has(path) || (input.referencedKeys ? input.referencedKeys.has(entry.key) : true)) {",
			expect: "照常进候选",
		},
		{
			// 后果：被钉住的那几份**不计入占用** ⇒ 上限判定看起来没超，其实超了
			//（用户看到"上限已生效"，而磁盘上还压着一堆删不掉的副本）。
			name: "★ 被钉住的副本不计入占用（上限判定失真：看着没超，其实超了）",
			from: "\t\tpresentBytes += Math.max(0, entry.size);",
			to: "\t\tpresentBytes += input.referencedPaths.has(path) ? 0 : Math.max(0, entry.size);",
			expect: "占用必须算它",
		},
		{
			// 后果：「腾不到目标」只报一个数字、不说原因 ⇒ 用户以为插件坏了
			//（真相是那几份被笔记直接指着，永远删不掉）。
			name: "★ 腾不到目标时不说「那几份不能删」（只报一个没有解释的数字）",
			from: "\tconst pinned = Math.max(0, input.pinnedCount ?? 0);",
			to: "\tconst pinned = 0;",
			expect: "被笔记直接指着",
		},
		{
			// 后果：索引里两条记录指着同一份文件时，它被算两遍 ⇒ 占用虚高 ⇒ 上限
			// **多删一份真实副本**，而界面上的数字是自洽的。
			// ⚠️ 判据在 `uniqueByPath`（淘汰 / 上限档 / 台账外占用三处共用），
			// 所以这一条同时守住那三处的"按文件算"。
			name: "★★ 同一份文件被两条记录算两遍（占用虚高 ⇒ 上限多删真实副本）",
			from: "\t\tif (!path || seen.has(path)) continue;\n",
			to: "\t\tif (!path) continue;\n",
			expect: "同一份文件只算一次",
		},
	],
});
