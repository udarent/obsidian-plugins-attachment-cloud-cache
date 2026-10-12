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
			name: "★ 不查上传台账（没传成功过的本地文件也会被删）",
			from: "\t\tif (!input.uploaded.has(entry.key)) continue;",
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
	],
});
