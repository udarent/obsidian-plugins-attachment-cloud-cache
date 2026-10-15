import { runMutations } from "./lib/mutate.mjs";
import { runReleaseSpaceSuite } from "./lib/release-space-suite.mjs";

/**
 * 变异验证：存量清理的纯判定（`src/maintenance/release-space.ts`）。
 *
 * 这一层的每条判据守着**不可逆**的后果：候选错了 → 直接删（不进回收站）。
 * 所以四条准入判据**逐条**各配一个锚点，另有排序、去重与字节合计三个。
 *
 * ⚠️ 目标是"**会红**"而不是"会挂"：每条都是"不报错、只是行为不对"的改动。
 */
await runMutations({
	source: "src/maintenance/release-space.ts",
	suite: runReleaseSpaceSuite,
	mutations: [
		{
			// 后果：把"本地有这么一份文件"当成"这个对象我们传上去过" ——
			// 于是一个**从没上传成功**的本地附件也会进候选，而它云端可能根本没有，
			// 删掉就是真正丢数据（这是四条判据里唯一那条"删了回不来"的）。
			//
			// ⚠️ 锚点必须带上**上一行的注释**：不加的话这句在文件里出现两次
			//（另一处在比较字节的帮手 `unlinkedPresentBytes` 里，逐字相同），
			// 而 `replace` 只改第一处 ⇒ 变异改到帮手、主路径毫发无损 ⇒ 报"漏过（测试无牙）"，
			// 把人引向"补断言"，而真相是锚点不唯一（2026-10-15 实际踩到；
			// 现在运行器会直接报"锚点不唯一"，见 `lib/mutate.mjs`）。
			name: "★ 不查上传台账（没传成功过的本地文件也会被删）",
			from: "\t\t// ① 是不是我们上传的（台账口径 —— 别借\"索引里有没有条目\"，见 `n11`）\n\t\tif (!input.uploaded.has(entry.key)) continue;",
			to: "\t\t// 变异：不查台账",
			expect: "台账里没有的对象不得进候选",
		},
		{
			// 后果：连**孤儿**一起清 —— 而孤儿正是"用户可能还想留着"的那一类
			//（笔记删了、图还在）。它同时越过了与 R17 的分工线：那条线是**逐次询问**。
			name: "★ 不看有没有远端链接（孤儿也被一起清掉，越过了 R17 的分工线）",
			from: "\t\tif (!input.referencedKeys.has(entry.key)) continue;",
			to: "\t\t// 变异：不检查远端链接",
			expect: "孤儿不归这条命令管",
		},
		{
			// 后果：把已经不存在的副本当成"可释放的字节"报给用户 ——
			// 用户按一个达不到的数字去期待，跑完发现一个都没删（而且不报错）。
			name: "★ 不检查磁盘（已失效的记录也算进可释放字节）",
			from: "\t\tif (!input.present(path)) {",
			to: "\t\tif (false) {",
			// 实际先红的是"个数"那条（未变异的代码里它先说话）：已失效的那份也进了候选
			expect: "不存在的副本没有可删的东西",
		},
		{
			// 后果：同一份文件被算两次 ⇒ 报给用户的"可释放 N MB"是虚的。
			name: "★ 同一路径不去重（字节被重复计入，清单也多一项）",
			from: "\t\tif (!path || seen.has(path)) continue;",
			to: "\t\tif (!path) continue;",
			// 同上：先说话的是"个数"那条（清单里同一份文件出现了两次）
			expect: "同一路径只能出现一次",
		},
		{
			// 后果：清单从小到大排 —— 用户先看到的是一堆零碎文件，
			// 而"能腾多少"这个最关键的信息被推到最下面（列表还会被截断 → 干脆看不见）。
			name: "排序反了（先给小文件，大文件被截断在清单之外）",
			from: "\t\tif (a.bytes !== b.bytes) return b.bytes - a.bytes;",
			to: "\t\tif (a.bytes !== b.bytes) return a.bytes - b.bytes;",
			expect: "按字节降序",
		},
		{
			// 后果：合计恒为 0 ⇒ 确认框里"可释放 0.0 MB"，而这**正是用户按下按钮的依据**
			//（他据此判断值不值得清）。不报错、只是让他以为这事没意义。
			name: "★ 合计字节不累加（确认框显示可释放 0 MB）",
			from: "\tfor (const candidate of candidates) bytes += candidate.bytes;",
			to: "\tfor (const candidate of candidates) bytes += 0;",
			expect: "合计要算出来",
		},

		// ── ⭐⭐ 上限档（2026-10-15 用户报告：设了上限 500，清理却把本地副本全清了）──
		{
			// 后果：**上限档退化成全清** —— 用户设了 500 MB、按下清理，结果本地副本一份不剩。
			// ⭐ 这正是用户 2026-10-15 报的那个行为（原话："应该要留下 500，而不是全清"）。
			name: "★★ 上限档退化成全清（设了上限却把所有副本都清掉）",
			from: "\tconst planned = keepBytes > 0 ? planToLimit(input, keepBytes) : planWholeStock(input);",
			to: "\tconst planned = planWholeStock(input);",
			expect: "只清超出的那部分",
		},
		{
			// 相反的错向：目标 = 0 的输入被送进上限那条路 ⇒ `planEviction` 把 0 读成"未设上限"
			// ⇒ 「不留副本」档**一份都不删**。表现是按钮点了没动静 ——
			// 而那与"功能坏了"看起来完全一样。
			name: "★ 存量档被送进上限那条路（一份都不删：按钮点了没动静）",
			from: "\tconst planned = keepBytes > 0 ? planToLimit(input, keepBytes) : planWholeStock(input);",
			to: "\tconst planned = planToLimit(input, keepBytes);",
			expect: "四条判据都过就该进候选",
		},
		{
			// 后果：目标没传下去（0 = 未设上限）⇒ 上限档一份都不清。同上，这条盯的是"接线"。
			name: "★ 目标没传给挑选函数（上限档一份都不清）",
			from: "\t\tlimitBytes: keepBytes,",
			to: "\t\tlimitBytes: 0,",
			expect: "只清超出的那部分",
		},
		{
			// ⭐⭐ 后果：上限档**把没人引用的副本也一起清掉** —— 用户 2026-10-15 特意排除过：
			// 没人引用的副本可能还要**连云端对象一起**删（R17 三档询问会问用户），
			// 那是另一个决定；而这里只是腾空间。两类互不重叠。
			name: "★★ 上限档把「没人引用的副本」也算进池子（越过了 R17 那条分工线）",
			from: "\t\t(entry) => input.uploaded.has(entry.key) && input.referencedKeys.has(entry.key)\n",
			to: "\t\t(entry) => true\n",
			expect: "上限档只清",
		},
		{
			// 后果：时间没传对 ⇒ 每份副本都被当成"刚用过"（宽限期拦下全部）⇒ 上限档一份都不清。
			name: "★ 时间没传对（每份都被当成刚用过 ⇒ 一份都不清）",
			from: "\t\tnow: input.now,",
			to: "\t\tnow: 0,",
			expect: "只清超出的那部分",
		},
		{
			// 后果：读不出目标时落到"一份不留"（全清）——那是三种解释里**最具破坏性**的一种，
			// 而"读不出来的值"没有任何理由触发它（安全的方向只能是"这次什么都别删"）。
			name: "★★ 坏目标被解释成「全清」（读不出目标时最具破坏性的那一种）",
			from: "\tif (!Number.isFinite(input.keepBytes) || input.keepBytes < 0) {",
			to: "\tif (false) {",
			expect: "目标读不出来",
		},
		{
			// 后果同上，只是走「一份不留」那一档（目标 = 0）。
			name: "★★ 一份不留那一档把「被库内链接指着」的也删掉",
			from: "\t\tif (input.referencedPaths.has(path)) continue;\n",
			to: "",
			expect: "一份不留那一档也不许删",
		},
	],
});
