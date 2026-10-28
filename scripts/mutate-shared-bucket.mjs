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
			// 后果：认不出的老 key 也被硬塞进 `adds`（键是 `null`）⇒ 声明里长出一条没人能解释的记录，
			// 而清理端按哈希查表时会以为"有人在引用它"。
			name: "★ 认不出哈希也硬写（声明里长出一条无主记录）",
			from: '		if (hash === null) continue; // 认不出身份 ⇒ 不猜',
			to: '		if (false) continue; // 认不出身份 ⇒ 不猜',
			expect: "认不出身份就不写",
		},
		{
			// 后果：每次对账把**所有条目**都重写一遍 ⇒ 写放大（几百条就多传几十 KB），
			// 而且 `addedAt` 被刷成"现在"，封存切块的排序依据漂移。
			name: "★ 每次对账都重写全部条目（addedAt 也漂）",
			from: '		if (prev.name !== name || prev.ext !== ext) adds[hash] = { name, ext, addedAt: prev.addedAt };',
			to: '		if (true) adds[hash] = { name, ext, addedAt: now };',
			expect: "没变化的条目不该重写",
		},
		{
			// 后果：仍在引用的也照摘 ⇒ 那条对象失去保护，别的设备清理时会被删掉。
			// 这是这一层最贵的一次静默。
			name: "★★ 把仍在引用的也摘掉（真实保护丢失）",
			from: '	for (const hash of declared.keys()) if (!seen.has(hash)) removes.push(hash);',
			to: '	for (const hash of declared.keys()) if (true) removes.push(hash);',
			expect: "仍在引用里的不该被摘",
		},
		{
			// 后果：改名时用"现在"当 `addedAt` ⇒ 这一条在封存顺序里跳到最新，
			// 几百次改名就能把段的切分搅乱（而且没人会报这个错）。
			name: "★★ 改名把 addedAt 刷成现在（封存顺序漂移）",
			from: '	const result = await declareRefs(options, { [key]: { name, ext, addedAt: current.addedAt } }, []);',
			to: '	const result = await declareRefs(options, { [key]: { name, ext, addedAt: new Date().toISOString() } }, []);',
			expect: "不许因为改名而变",
		},
		{
			// 后果：读不到现状时"不写但报成功" ⇒ 调用方照常上传 ⇒ 这一批对象
			// **没有任何保护**，下一次清理会把它们当孤儿删掉（而且没人知道）。
			name: "★★ 读不到现状却报成功（这一批对象没有保护）",
			// ⚠️ 锚点跟着 2026-10-28 的改动走：`declareRefs` 改用 `readDeviceState`，
			// 早退条件从 `!state` 变成 `!read.state`（顺带把失败原因带出去）。
			from: '\tif (!read.state) return { ok: false, reason: "read-failed", detail: read.detail };',
			to: "\tif (!read.state) return { ok: true, steps: 0 };",
			expect: "读不到现状必须拒绝写",
		},
	],
});
