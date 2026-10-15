/**
 * **"一个事实只有一个持有者"**的跨模块一致性套件（计划里的 A2）。
 *
 * ## 为什么是"跨模块"而不是"再写一遍各模块的套件"
 *
 * 这个仓库里每个模块都已经有自己的套件（`cache-index-suite` / `eviction-suite` /
 * `object-key-suite`…），它们各自都对。**但历史上真的出过事的那些缺陷，全都不是"某个模块错了"，
 * 而是"同一个事实，两个模块各自回答，且答案不一致"**：
 *
 * | 事实 | 曾经的两套口径 | 症状 |
 * |---|---|---|
 * | 是不是我们上传的 | 索引条目 vs **上传台账** | 「不留副本」档没有条目 ⇒ 询问**永不出现**（N11） |
 * | 上限该统计多少字节 | 索引原始和 vs **磁盘上还在的** | 幽灵记录抬高超出量 ⇒ **多删** |
 * | 副本在哪儿 | 索引里的路径 vs 磁盘 | 移动后索引指旧路 ⇒ 白下载一份重复文件 |
 *
 * 所以这套断言专门盯**两个回答之间必须成立的关系**，而不是某个回答本身。
 * 它跑在 `CacheIndex` / `buildEvictionCandidates` / `object-key` 三个模块的**接缝**上。
 *
 * ## 断言取向
 *
 * 每一条都写成"**如果这两处哪天分叉了，哪个方向是危险的**"：
 * 危险的默认值、单向的不等式、摘条目与忘台账的区别 —— 这些都不是"实现细节"，
 * 而是当初那三个缺陷的判据。
 *
 * 断言在这里（与变异验证共用），入口在 `scripts/test-local-copy-truth.mjs`。
 */

import assert from "node:assert/strict";

const MB = 1024 * 1024;

/** 一条索引记录（只写这套断言关心的字段）。 */
function entry(key, cachePath, size = MB, origin = "own") {
	return { key, cachePath, size, origin, remoteUrl: `https://s3.example.com/notes/${key}` };
}

export function runLocalCopyTruthSuite(mod) {
	const { CacheIndex, buildEvictionCandidates, sumOwnedBytes, hashFromKey, displayNameForKey, objectKeyFor } = mod;

	// ============================================================
	// ① 事实：**这个对象是不是我们传上去的**
	//
	// ⭐ 唯一回答者 = 上传台账（`wasUploaded`），**不是**"索引里有没有条目"。
	// 这不是风格问题：条目记的是"本地副本在哪"，而「不留副本」那一档按纪律不写条目 ——
	// 用条目回答，就会在那一档对所有对象答"不是我们的"（N11，询问永不出现）。
	// ============================================================
	{
		// 台账里有、条目里没有（= 「不留副本」档）
		const ledgerOnly = new CacheIndex([], ["keep-none.png"]);
		assert.equal(
			ledgerOnly.wasUploaded("keep-none.png"),
			true,
			"★ 台账记得它 ⇒ 就该认它是我们的（这条正是 N11 的判据）"
		);
		assert.equal(ledgerOnly.get("keep-none.png"), undefined, "……而它在索引里确实没有条目（没有副本）");
	}
	{
		// ⭐ 不变量 `条目 ⊆ 台账`：构造时就成立（有本地副本 ⇒ 必然是我们经手过的）。
		// 这条不变量是**在构造函数里**建立的，理由是历史性的：用条目构造出来的索引
		// 若带着一个空台账，它的行为就与"从文件读回来的同一份内容"不一致 ——
		// 也就是"重启之后行为变了"，本项目反复消除的一类问题。
		const entryOnly = new CacheIndex([entry("has-copy.png", "attachments/has-copy.png")]);
		assert.equal(entryOnly.wasUploaded("has-copy.png"), true, "★ 有副本 ⇒ 台账里必然有它（构造函数就补上）");
	}
	{
		// ⭐ 真正的危险方向：两个"回答者"对同一个 key 给出**相反**答案。
		// 「不留副本」那一档没有条目 —— 谁要是拿"索引里有没有条目"来回答
		// "是不是我们上传的"，它就会对**所有**对象答"不是我们的"，
		// 于是那条自动询问**永不出现**（N11）。所以这里把两个回答并排钉住。
		const noCopy = new CacheIndex([], ["kept-none.png"]);
		assert.equal(noCopy.get("kept-none.png") !== undefined, false, "这一档确实没有条目（没有本地副本）");
		assert.equal(noCopy.wasUploaded("kept-none.png"), true, "★★ 而台账答得出 —— 归属问题只能问台账");
	}
	{
		// ⭐ 摘条目 ≠ 忘台账：删除留痕之后、对象已不在云端时，两者会分头变化
		const index = new CacheIndex([entry("a.png", "attachments/a.png")], ["a.png"]);
		index.remove("a.png");
		assert.equal(index.wasUploaded("a.png"), true, "摘掉条目只是'本地没副本了'，台账还在");
		assert.equal(index.forgetUploaded("a.png"), true, "忘台账是另一件事（对象确实不在云端了）");
		assert.equal(index.wasUploaded("a.png"), false);
		assert.deepEqual(index.uploadedKeys(), [], "两个账本各自独立，谁也不会顺手清掉另一个");
	}

	// ============================================================
	// ② 事实：**副本在库里的哪个路径**
	//
	// ⭐ 唯一回答者 = 索引（`findByCachePath` 与 `moveCachePath` 成对）。
	// 分叉的后果是"索引指着旧路径 ⇒ 渲染以为本地没副本 ⇒ 白下载一份重复文件"。
	// ============================================================
	{
		const index = new CacheIndex([entry("a.png", "attachments/old.png")]);
		assert.equal(index.findByCachePath("attachments/old.png")?.key, "a.png", "按路径能找回记录");
		index.moveCachePath("attachments/old.png", "attachments/new.png");
		assert.equal(index.findByCachePath("attachments/old.png"), undefined, "★ 搬完之后旧路径**不该**还能查到");
		assert.equal(index.findByCachePath("attachments/new.png")?.key, "a.png", "新路径查到的是同一条记录（key 不变）");
		assert.equal(index.get("a.png")?.cachePath, "attachments/new.png", "两个方向都必须一致（按 key 查也是新路径）");
	}
	{
		// 目录改名：子文件的路径要跟着搬，否则整棵子树的记录都指向旧路径
		const index = new CacheIndex([
			entry("a.png", "attachments/talks/a.png"),
			entry("b.png", "attachments/talks/deep/b.png"),
		]);
		index.moveCachePath("attachments/talks", "attachments/2026", { includeDescendants: true });
		assert.equal(index.findByCachePath("attachments/2026/a.png")?.key, "a.png", "一级子文件跟着搬");
		assert.equal(index.findByCachePath("attachments/2026/deep/b.png")?.key, "b.png", "深层子文件也跟着搬");
		assert.equal(index.findByCachePath("attachments/talks/a.png"), undefined, "旧目录下不该还查得到");
	}

	// ============================================================
	// ③ 事实：**上限该统计哪些字节**
	//
	// 这里有两个数，而它们**唯一的正确关系是一条单向不等式**：
	//
	// - `sumOwnedBytes(索引)`：便宜的门槛（纯内存求和），可能**偏大**（幽灵记录还没被自愈摘）
	// - `presentBytes`（`buildEvictionCandidates` 给的）：真正该拿去比上限的占用
	//
	// ⭐ 不等式方向就是这个功能的命门：门槛偏大只会"多进去看一眼"（安全），
	// 偏小则会让轮换**跳过**本该跑的一轮 ⇒ 上限静默失效（P7 / P8 同形）。
	// ============================================================
	{
		const entries = [
			entry("present-a.png", "attachments/a.png", 2 * MB),
			entry("ghost.png", "attachments/gone.png", 8 * MB), // 索引有、磁盘没有（幽灵）
			entry("present-b.png", "attachments/b.png", 1 * MB),
		];
		const onDisk = new Set(["attachments/a.png", "attachments/b.png"]);
		const { presentBytes, missing } = buildEvictionCandidates({
			entries,
			present: (path) => onDisk.has(path),
			referencedPaths: new Set(),
		});

		assert.equal(presentBytes, 3 * MB, "★★ 上限用的占用只算**磁盘上还在的**那些（幽灵不抬高超出量 ⇒ 不会多删）");
		assert.equal(missing, 1, "幽灵记录如实计数（该由自愈去摘，不是淘汰的事）");
		assert.ok(
			sumOwnedBytes(entries) >= presentBytes,
			"★★ 便宜的门槛必须**不小于**真实占用 —— 反过来就会跳过本该跑的轮换（上限静默失效）"
		);
		assert.equal(sumOwnedBytes(entries), 11 * MB, "门槛按索引原始和（这里含那 8MB 幽灵）");
	}
	{
		// 坏字节数不能把别的量抹掉（负值在"求和"里会做减法）
		const { presentBytes } = buildEvictionCandidates({
			entries: [entry("a.png", "attachments/a.png", 5 * MB), entry("bad.png", "attachments/bad.png", -3 * MB)],
			present: () => true,
			referencedPaths: new Set(),
		});
		assert.equal(presentBytes, 5 * MB, "坏字节数收敛到 0，而不是把别的副本的字节减掉");
	}
	{
		// 没有引用的候选是**可回收**，而有引用的不是 —— 两个函数对"不知道有没有引用"的默认值相反，
		// 这是刻意的：淘汰侧"不确知 ⇒ 当作已引用"（宁可少删）。
		const entries = [entry("used.png", "attachments/used.png", MB), entry("orphan.png", "attachments/orphan.png", MB)];
		const blind = buildEvictionCandidates({ entries, present: () => true, referencedPaths: new Set() });
		assert.equal(blind.candidates.length, 2, "没扫引用时一律当作已引用 ⇒ 都进候选（这是候选，不是「该删」）");
	}

	// ============================================================
	// ④ 事实：**对象 key 里的名字与哈希**
	//
	// ⭐ 唯一回答者 = `object-key.ts`（`hashFromKey` / `displayNameForKey`）。
	// 分叉的后果是具体的：拿**整个文件名**去比哈希永远不相等（同步到达的副本认不出来）；
	// 或者把 URL 末段的令牌当成扩展名（副本名没人认得出）。
	// ============================================================
	{
		const fullHash = "abcdef0123456789".repeat(4);
		const key = objectKeyFor({ hash: fullHash, ext: "pdf", filename: "报告 v2.pdf" });
		assert.equal(hashFromKey(key), fullHash, "从 key 里取回来的就是生成时那一段（**完整**哈希，不是它的前缀）");
		assert.notEqual(
			hashFromKey(key),
			key,
			"★ 哈希**不是**整个 key —— 拿整个 key 去比内容哈希永远不相等（同步到达的副本于是认不出）"
		);
		assert.ok(
			displayNameForKey(key).includes("报告"),
			`名字段还得能看出是哪个文件（用户要照着它核对不可恢复的删除），实际：${displayNameForKey(key)}`
		);
		// 老形状（1.2.0 之前：纯内容寻址）也要能解析回来 —— 否则"换设备后认不出自家副本"
		assert.equal(hashFromKey(`${fullHash}.pdf`), fullHash, "★ 两代 key 形状都要认（老对象还在桶里）");
		assert.equal(hashFromKey("not-a-key"), null, "认不出来就返回 null（绝不猜）");
	}

	return { cases: 10 };
}
