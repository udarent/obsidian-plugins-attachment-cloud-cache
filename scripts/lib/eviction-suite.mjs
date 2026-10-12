/**
 * 缓存上限与自动轮换的**纯判定**（`src/maintenance/eviction.ts`）断言套件。
 *
 * ## 这一层判错的代价
 *
 * 它会**自动删文件**（进回收站），而且是在后台、没人看着的时候。
 * 两种错法都不报错：
 * - 挑错了受害者 → 把用户**经常看**的图淘汰掉，留下的却是几个月没碰过的；
 * - 把不该动的算进来 → 动了 `localCopy: "keep"` 时用户在附件目录里的**正常附件**。
 *
 * 所以这里穷举的不是「能不能腾出空间」，而是"**腾的是哪些**"。
 */

import assert from "node:assert/strict";

const MB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-07T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

/** 造一条索引记录。默认「两天前上传、从未被使用」。 */
function entryFor(key, options = {}) {
	return {
		key,
		cachePath: options.cachePath ?? `_attachment-cache/${key}`,
		remoteUrl: `https://img.example.com/${key}`,
		size: options.size ?? 0,
		contentType: "image/png",
		etag: "e",
		// ⚠️ 不能用 `??`：`uploadedAt: ""` 是有意义的输入（"时间戳是坏的"），
		// 而 `"" ?? x` 会保留空串 —— 那样这条用例反而测不到"时间戳坏掉"的情形，
		// 还会让 `new Date("")` 抛 RangeError（这一步就报错了，根本走不到断言）。
		// 传数字 = "那个时刻"，传字符串 = 原样当时间戳（含坏值 ""）。
		uploadedAt:
			options.uploadedAt === undefined
				? iso(NOW - 48 * HOUR)
				: typeof options.uploadedAt === "number"
					? iso(options.uploadedAt)
					: options.uploadedAt,
		sourceName: key,
		lastUsedAt: options.lastUsedAt ?? 0,
	};
}

/** 造一个磁盘文件。 */
function diskFor(path, bytes) {
	return { path, bytes };
}

/** 直接造一个候选（绕过 buildEvictionCandidates，专注测挑受害者的规则）。 */
function candidateFor(key, options = {}) {
	return {
		key,
		cachePath: options.cachePath ?? `_attachment-cache/${key}`,
		bytes: options.bytes ?? 100,
		lastUsedAt: options.lastUsedAt ?? NOW - 48 * HOUR,
		referenced: options.referenced ?? false,
	};
}

export function runEvictionSuite(mod) {
	const { buildEvictionCandidates, planEviction, sumOwnedBytes, megabytesToBytes, DEFAULT_EVICTION_GRACE_MS } = mod;

	// ============================================================
	// 1. 单位换算
	// ============================================================
	assert.equal(megabytesToBytes(1), MB, "1 MB = 1048576 字节");
	assert.equal(megabytesToBytes(0), 0, "0 = 不限制");
	assert.equal(megabytesToBytes(-5), 0, "★ 负数当作不限制（而不是变成负上限，那会让一切都「超限」）");
	assert.equal(megabytesToBytes(Number.NaN), 0, "NaN 当作不限制");
	assert.equal(megabytesToBytes("12"), 0, "★ 非数字当作不限制（绝不能把字符串算成超限）");
	assert.equal(megabytesToBytes(undefined), 0, "undefined 当作不限制");
	assert.equal(DEFAULT_EVICTION_GRACE_MS > 0, true, "宽限期必须有正的默认值（否则刚下载的会被立刻淘汰）");

	// ============================================================
	// 2. ⭐ 候选怎么造（1.2.0 / D-17：一律来自索引）
	//
	// 判错的代价：这是**自动删文件**的路径。挑错了人 = 把用户常看的删掉、
	// 留下的却是几个月没碰过的；多算了人 = 动了不属于我们的文件。
	// ============================================================
	{
		const entries = [
			// 遗留缓存目录里的旧副本
			entryFor("cached.png", { size: 1024 }),
			// ⭐ keep 档的副本就在**附件目录**里 —— 那同样是我们写下的副本，照样计入、照样可淘汰
			entryFor("kept.png", { cachePath: "attachments/kept.png", size: 4096 }),
			// 索引里有、磁盘上却没有：没有可删的东西
			entryFor("gone.png", { size: 999 }),
		];
		// 存在性探针：只有前两条在磁盘上
		const present = (path) => path !== "_attachment-cache/gone.png";

		const selection = buildEvictionCandidates({
			entries,
			present,
			referencedKeys: new Set(["cached.png"]),
		});
		const candidates = selection.candidates;
		const byKey = new Map(candidates.map((c) => [c.key, c]));

		assert.equal(selection.missing, 1, "★ 索引有、磁盘没有的要被数出来（没有可删的文件）");

		// ⭐ 这是本次改造的核心行为变化：**附件目录里的副本也要进来**
		assert.equal(
			byKey.has("kept.png"),
			true,
			"★ keep 档的副本在附件目录里 —— 它同样占用户的磁盘，必须计入上限并可淘汰（P7 关闭的依据）"
		);
		assert.equal(byKey.has("gone.png"), false, "索引有、磁盘没有 → 没有可删的文件，不该进候选");

		// 字节数：索引记的值（文件是我们写下的；不再需要磁盘清单）
		assert.equal(byKey.get("kept.png").bytes, 4096, "字节数取索引记录的值");
		assert.equal(byKey.get("cached.png").referenced, true, "被笔记引用的要标记出来");

		// ⭐ 孤儿这一类**消失了**：磁盘上有的文件若索引不认得，绝不会成为候选
		//（1.2.0 之前它是"最该淘汰"的一类，因为缓存目录里的东西必然是我们的副本；
		//  现在索引外的文件可能是**用户的附件**，一律不能自动删）
		assert.equal(
			candidates.some((c) => c.key === ""),
			false,
			"★ 不该再有「孤儿」候选（索引外的文件一律不碰 —— 那可能是用户的附件）"
		);
		assert.equal(
			candidates.some((c) => c.cachePath === "notes/important.md"),
			false,
			"★ 索引外的路径永远进不来（删文件的路径上不允许存在这种可能）"
		);
	}

	// 候选里的 key 永远非空（旧实现用空串表示孤儿）
	{
		const selection = buildEvictionCandidates({
			entries: [entryFor("a.png")],
			present: () => true,
		});
		assert.equal(selection.candidates.length, 1, "在磁盘上的那份要进候选");
		assert.equal(selection.candidates[0].key, "a.png", "候选的 key 永远非空");
	}

	// 使用时间：优先用 lastUsedAt，没有就退回上传时间，都没有就 0
	{
		const selection = buildEvictionCandidates({
			entries: [
				entryFor("used.png", { lastUsedAt: NOW - 1 * HOUR }),
				entryFor("uploaded.png", { uploadedAt: NOW - 3 * HOUR }),
				entryFor("unknown.png", { uploadedAt: "" }),
			],
			present: () => true,
		});
		const byKey = new Map(selection.candidates.map((c) => [c.key, c]));
		assert.equal(byKey.get("used.png").lastUsedAt, NOW - 1 * HOUR, "有使用时间就用它");
		assert.equal(
			byKey.get("uploaded.png").lastUsedAt,
			NOW - 3 * HOUR,
			"★ 没有使用时间就退回上传时间（把「新上传的」当成「刚用过」，不会被立刻淘汰）"
		);
		assert.equal(byKey.get("unknown.png").lastUsedAt, 0, "两个时间都没有 → 0（按最旧处理）");
	}

	// 没扫引用时一律当「已引用」：保守（宁可按 LRU 排，也不把「未知」当成「没人用」）
	{
		const selection = buildEvictionCandidates({
			entries: [entryFor("a.png")],
			present: () => true,
		});
		assert.equal(
			selection.candidates[0].referenced,
			true,
			"★ 没扫引用时一律当「已引用」（「不知道」不该被当成「没人用」，否则会优先删掉它们）"
		);
	}

	// ============================================================
	// 2b. ⭐ 统计范围：**所有**本地副本（含附件目录里的那些）
	//
	// 这条正是 P7 的关闭依据：从前只算缓存目录内的字节，于是 keep 档
	// "界面上看不见上限、后台却在算另一个数"。现在统计范围与设置文案一致。
	// ============================================================
	{
		const entries = [
			entryFor("in-cache.png", { size: 100 }),
			entryFor("in-attachments.png", { cachePath: "attachments/in-attachments.png", size: 200 }),
			entryFor("bad-size.png", { size: Number.NaN }),
			entryFor("negative.png", { size: -5 }),
		];
		assert.equal(
			sumOwnedBytes(entries),
			300,
			"★ 统计范围 = 索引里的全部本地副本（含附件目录），坏值按 0（绝不把 NaN 带进求和）"
		);
		assert.equal(sumOwnedBytes([]), 0, "空索引 = 0");
	}

	// ============================================================
	// 3. 没超上限 / 没设上限 → 什么都不做
	// ============================================================
	{
		const noLimit = planEviction({ candidates: [candidateFor("a")], totalBytes: 10 * MB, limitBytes: 0, now: NOW });
		assert.deepEqual(noLimit.evict, [], "0 = 不限制 → 一个都不淘汰");
		assert.equal(noLimit.overBy, 0, "不限制时不该报「仍超出」");
		assert.match(noLimit.reason, /上限|限制/, "要说明原因是「没设上限」（供排查）");

		const under = planEviction({ candidates: [candidateFor("a")], totalBytes: 100, limitBytes: 100, now: NOW });
		assert.deepEqual(under.evict, [], "正好等于上限 → 不必淘汰");
		assert.equal(under.overBy, 0, "没有超出");

		const zero = planEviction({ candidates: [], totalBytes: 0, limitBytes: MB, now: NOW });
		assert.deepEqual(zero.evict, [], "空缓存不必淘汰");
	}

	// ============================================================
	// 4. ⭐ 挑谁：未引用优先，其次最久未用
	// ============================================================
	{
		const candidates = [
			candidateFor("recent-but-referenced", { bytes: 100, lastUsedAt: NOW - 1 * HOUR, referenced: true }),
			candidateFor("stale-unreferenced", { bytes: 100, lastUsedAt: NOW - 100 * HOUR, referenced: false }),
			candidateFor("older-referenced", { bytes: 100, lastUsedAt: NOW - 50 * HOUR, referenced: true }),
		];

		// 超出 100 → 只淘汰一个：应当是那个「没人引用」的
		const one = planEviction({ candidates, totalBytes: 300, limitBytes: 200, now: NOW });
		assert.deepEqual(
			one.evict.map((c) => c.key),
			["stale-unreferenced"],
			"★ 优先淘汰「没有任何笔记引用」的（它连显示都不会显示，是纯占地方）"
		);
		assert.equal(one.reclaimable, 100, "回收字节 = 被淘汰文件之和");
		assert.equal(one.projectedBytes, 200, "预计占用 = 原占用 − 回收");
		assert.equal(one.overBy, 0, "已经腾到上限以内");

		// 超出 200 → 淘汰两个：未引用的先走，然后是最久未用的（而不是「最近上传但没人看」那个）
		const two = planEviction({ candidates, totalBytes: 300, limitBytes: 100, now: NOW });
		assert.deepEqual(
			two.evict.map((c) => c.key),
			["stale-unreferenced", "older-referenced"],
			"★ 剩下的按「最久没用过」排 —— 保住经常看的那张，而不是最近上传的那张"
		);
		assert.equal(two.projectedBytes, 100, "刚好到上限");
		assert.equal(two.overBy, 0, "不再超出");
	}

	// ⭐ 「未引用优先」与「最久未用优先」是两条**不同**的规则，这里把时间反过来验一遍：
	// 如果只用 LRU，这条会挑走 referenced-but-stale（它更旧）—— 那是错的答案。
	{
		const candidates = [
			candidateFor("unreferenced-but-recent", { bytes: 100, lastUsedAt: NOW - 2 * HOUR, referenced: false }),
			candidateFor("referenced-but-stale", { bytes: 100, lastUsedAt: NOW - 50 * HOUR, referenced: true }),
		];
		const plan = planEviction({ candidates, totalBytes: 200, limitBytes: 100, now: NOW });
		assert.deepEqual(
			plan.evict.map((c) => c.key),
			["unreferenced-but-recent"],
			"★ 未引用优先压过「更久没用」—— 没有任何笔记引用的副本最该走（它连显示都不会显示）"
		);
	}

	// 同类之间的顺序必须稳定（否则同一份数据每次挑的人可能不同）
	{
		const candidates = [
			candidateFor("zeta", { bytes: 100, lastUsedAt: NOW - 10 * HOUR }),
			candidateFor("alpha", { bytes: 100, lastUsedAt: NOW - 10 * HOUR }),
			candidateFor("mid", { bytes: 100, lastUsedAt: NOW - 10 * HOUR }),
		];
		const plan = planEviction({ candidates, totalBytes: 300, limitBytes: 200, now: NOW });
		assert.deepEqual(plan.evict.map((c) => c.key), ["alpha"], "★ 条件相同时按 key 排序，顺序必须稳定（否则每次淘汰的人都在变）");
	}

	// ============================================================
	// 5. ⭐ 宽限期：刚下载/刚上传的不动（否则等于「刚拉回来又马上删」）
	// ============================================================
	{
		const freshUnreferenced = candidateFor("just-added", {
			bytes: 100,
			lastUsedAt: NOW - 1 * MINUTE,
			referenced: false,
		});
		const old = [
			candidateFor("older-a", { bytes: 100, lastUsedAt: NOW - 50 * HOUR, referenced: true }),
			candidateFor("older-b", { bytes: 100, lastUsedAt: NOW - 40 * HOUR, referenced: true }),
		];

		const plan = planEviction({
			candidates: [freshUnreferenced, ...old],
			totalBytes: 300,
			limitBytes: 100,
			now: NOW,
		});
		assert.deepEqual(
			plan.evict.map((c) => c.key),
			["older-a", "older-b"],
			"★ 刚放进缓存的不参与淘汰 —— 哪怕它是「未引用」的、哪怕它是第一个被挑中的"
		);
		assert.equal(plan.overBy, 0, "靠老的那些也能腾到目标");
	}

	// 腾不到目标时**如实汇报**，而不是假装成功
	{
		const plan = planEviction({
			candidates: [
				candidateFor("fresh-a", { bytes: 100, lastUsedAt: NOW - 1 * MINUTE }),
				candidateFor("fresh-b", { bytes: 100, lastUsedAt: NOW - 2 * MINUTE }),
			],
			totalBytes: 200,
			limitBytes: 50,
			now: NOW,
		});
		assert.deepEqual(plan.evict, [], "全都在宽限期内 → 一个都不动");
		assert.equal(plan.overBy, 150, "★ 必须如实报出「仍然超出多少」（否则界面上会以为上限生效了）");
		assert.match(plan.reason, /刚|宽限/, "原因要说明「这些是刚用过的」");
	}

	// 候选不够（例如索引丢了）时也不能假装腾干净了
	{
		const plan = planEviction({
			candidates: [candidateFor("only", { bytes: 100, lastUsedAt: NOW - 50 * HOUR })],
			totalBytes: 5000,
			limitBytes: 100,
			now: NOW,
		});
		assert.equal(plan.evict.length, 1, "能淘汰的都淘汰");
		assert.equal(plan.overBy, 4800, "★ 剩下的仍超出多少要如实报（候选不够就是不够）");
		assert.notEqual(plan.reason, "", "要给一个原因");
	}

	// ============================================================
	// 6. 只会**整份**淘汰，不做「删一半」
	// ============================================================
	{
		const candidates = [
			candidateFor("a", { bytes: 100, lastUsedAt: NOW - 90 * HOUR }),
			candidateFor("b", { bytes: 100, lastUsedAt: NOW - 80 * HOUR }),
		];
		// 超出 150：只删一个（100）不够，必须删两个
		const plan = planEviction({ candidates, totalBytes: 200, limitBytes: 50, now: NOW });
		assert.equal(plan.evict.length, 2, "★ 一个文件只能整份删 —— 差 150 字节就得删 2 个，不能「删一半」");
		assert.equal(plan.reclaimable, 200, "回收 200");
	}

	// ============================================================
	// 7. 不修改输入
	// ============================================================
	{
		const candidates = [
			candidateFor("b", { lastUsedAt: NOW - 10 * HOUR }),
			candidateFor("a", { lastUsedAt: NOW - 20 * HOUR }),
		];
		const before = candidates.map((c) => c.key);
		planEviction({ candidates, totalBytes: 200, limitBytes: 100, now: NOW });
		assert.deepEqual(candidates.map((c) => c.key), before, "★ 判定不该改动传入的数组顺序（调用方可能还要用它）");
	}
}
