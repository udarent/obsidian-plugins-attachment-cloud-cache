import { runMutations } from "./lib/mutate.mjs";
import { runSharedBucketSuite } from "./lib/shared-bucket-suite.mjs";

/**
 * 变异验证：共享桶的跨库判据（`src/maintenance/shared-bucket.ts`）。
 *
 * 这一层决定"能不能删桶里的对象"，而删错了**不可恢复**。所以五条各自对应一种真实失效：
 * 少排除自己（永远删不掉自己的对象）、少「没有声明」分支（删掉别的库还在用的）、
 * 检查点失效（跑一半别人新增了引用照删）、读不到现状却硬写（覆盖已有引用 ⇒ 那些对象失去保护）。
 */
await runMutations({
	source: "src/maintenance/shared-bucket.ts",
	suite: runSharedBucketSuite,
	mutations: [
		{
			// 后果：同一台设备的 head 与段里都有同一个 hash 时算成两个占用者 ⇒
			// 汇报里写"2 台设备在用"，而删除判定本身没错 —— 症状看起来像"统计不对"，
			// 真正的问题是它掩盖了"到底谁在用"。
			name: "★ 占用表不去重（同一台设备算成两个）",
			from: "\t\t\tif (seen.has(slot)) continue;",
			to: "\t\t\tif (false) continue;",
			expect: "只算一个占用者",
		},
		{
			// 后果：**自己那份也算占用** ⇒ 本设备引用过的对象永远删不掉。
			// 症状是"我明明没在用了，它一直躺在待清理里"，用户只能手工去桶里删。
			name: "★★ 判据没排除自己（自己引用着也算占用）",
			from:
				"\treturn list.filter((occupant) => !(occupant.vault === self.vault && occupant.device === self.device));",
			to: "\treturn list.slice();",
			expect: "自己引用着不算占用",
		},
		{
			// 后果：一份声明都没有时返回"可以判" ⇒ 空占用表 ⇒ 所有候选都"没人引用"。
			// 这正是首次使用 / 别的设备都是旧版时的情形 —— 会删掉别的库还在用的对象。
			name: "★★ 没有声明时照判（把「没读到」当成「没人引用」）",
			from: '\t\t\tif (load.entries.length === 0) {',
			to: "\t\t\tif (false) {",
			expect: "没有声明就不出候选",
		},
		{
			// 后果：别人在批量删除期间写了新引用，检查点照样返回 same ⇒ 后半批照删。
			name: "★★ 检查点永远说「没变」",
			from: '\t\t\treturn scan.fingerprint === baseline ? "same" : "changed";',
			to: '\t\t\treturn "same";',
			expect: "声明集合变了",
		},
		{
			// 后果：读不到现状时"不写但报成功" ⇒ 调用方照常上传 ⇒ 这一批对象
			// **没有任何保护**，下一次清理会把它们当孤儿删掉（而且没人知道）。
			name: "★★ 读不到现状却报成功（这一批对象没有保护）",
			from: '\tif (!state) return { ok: false, reason: "read-failed", detail: "" };',
			to: "\tif (!state) return { ok: true, steps: 0 };",
			expect: "读不到现状必须拒绝写",
		},
	],
});
