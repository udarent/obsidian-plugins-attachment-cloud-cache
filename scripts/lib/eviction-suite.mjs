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
	const { buildEvictionCandidates, planEviction, sumOwnedBytes, megabytesToBytes, DEFAULT_EVICTION_GRACE_MS, uniqueByPath } = mod;

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
			referencedPaths: new Set(),
			referencedKeys: new Set(["cached.png"]),
		});
		const candidates = selection.candidates;
		const byKey = new Map(candidates.map((c) => [c.key, c]));

		assert.equal(selection.missing, 1, "★ 索引有、磁盘没有的要被数出来（没有可删的文件）");
		assert.equal(
			selection.presentBytes,
			1024 + 4096,
			"★ 存在着的字节和 = 只算磁盘上确实还在的那几份（幽灵记录不计入总量）"
		);

		// ⭐ 这是本次改造的核心行为变化：**附件目录里的副本也要进来**
		assert.equal(
			byKey.has("kept.png"),
			true,
			"★ keep 档的副本在附件目录里 —— 它同样占用户的磁盘，必须计入上限并可淘汰（P7 关闭的依据）"
		);
		assert.equal(byKey.has("gone.png"), false, "索引有、磁盘没有 → 没有可删的文件，不该进候选");

		// 字节数：索引记的值（文件是我们写下的；不再需要磁盘清单）
		assert.equal(byKey.get("kept.png").bytes, 4096, "字节数取索引记录的值");
		// ⚠️ 先验"它在候选里"再验标记：`referencedKeys` 命中的那份**照常进候选**
		//（只有被**库内路径**直接指着的才不能删，见下面那一节）——
		// 少了这句，"把云端地址引用的也排除掉"这类过度保护会以 TypeError 的形式报出来，
		// 读起来像测试坏了而不是判据错了。
		assert.equal(byKey.has("cached.png"), true, "★ 被笔记提过**云端地址**的那份照常进候选（只是排在最后）");
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
			referencedPaths: new Set(),
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
			referencedPaths: new Set(),
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
			referencedPaths: new Set(),
		});
		assert.equal(
			selection.candidates[0].referenced,
			true,
			"★ 没扫引用时一律当「已引用」（「不知道」不该被当成「没人用」，否则会优先删掉它们）"
		);
	}

	// ============================================================
	// ⭐⭐「还有人在用吗」= 两个问题，而且**后果不同**（2026-10-15）
	//
	// - `referencedKeys`：笔记里还写着**云端那个地址**吗 ⇒ 只影响**排序**
	//   （提过的排后面）；删掉它只是"那张图暂时失去离线能力"，下次看会**回退下载**。
	// - `referencedPaths`：笔记用**库内路径**（`![](../企业微信截图_….png)`）**直接指着**
	//   这份文件吗 ⇒ **硬门槛，进不了候选**。那种链接指着的是文件本身，删了**没有任何兜底**
	//   （回退下载只认属于本存储的 URL）⇒ 用户打开那篇笔记看到的是**破图**。
	//
	// ⚠️⚠️ 判据方向是"多认一句只是少删一份"，而**漏认会删错** ⇒ 两个方向都往保守落。
	// 用户 2026-10-15 的口径：「笔记里存的始终是远端地址」这句**不是恒真**的
	// —— 他说"（副本）该删呀，不然腾空间就没什么用了"，那是对**已经被改写成远端地址**
	// 的那一类说的；写着库内路径的那一类不在此列。
	// ============================================================
	{
		const selection = buildEvictionCandidates({
			entries: [
				entryFor("url.png", { cachePath: "attachments/url.png", size: 100 }),
				entryFor("path.png", { cachePath: "attachments/path.png", size: 200 }),
			],
			present: () => true,
			// 只有 url.png 的**云端地址**出现在笔记里
			referencedKeys: new Set(["url.png"]),
			// 而 path.png 被笔记用**库内路径**直接指着
			referencedPaths: new Set(["attachments/path.png"]),
		});
		const byKey = new Map(selection.candidates.map((c) => [c.key, c]));

		assert.equal(byKey.has("path.png"), false, "★★ 库内路径指着的那份**不进候选**（删了那张图没有任何兜底）");
		assert.equal(selection.pinned, 1, "★ 「被钉住」要计数 —— 腾不到目标时靠它把原因说出来");
		assert.equal(selection.presentBytes, 300, "★★ 但钉住的那份**照样占磁盘** ⇒ 占用必须算它（否则上限判定失真）");
		assert.equal(byKey.has("url.png"), true, "★ 提了云端地址的那份**照常进候选**（删了能回退下载 ⇒ 只是排后面，不是不能删）");
		assert.equal(byKey.get("url.png").referenced, true, "★ 而且它标成「有人提过」⇒ 排在候选最后（软偏好，不是硬门槛）");
	}

	// 同一份**既被云端地址提过、又被库内路径指着** ⇒ 仍然不能删（库内那一路更硬）
	{
		const selection = buildEvictionCandidates({
			entries: [entryFor("both.png", { cachePath: "attachments/both.png" })],
			present: () => true,
			referencedKeys: new Set(["both.png"]),
			referencedPaths: new Set(["attachments/both.png"]),
		});
		assert.equal(selection.candidates.length, 0, "★★ 两条都命中 ⇒ 以「不能删」为准（笔记里那条库内链接指着它）");
	}

	// 腾不到目标时**原因要说得准**：不是"没找到可删的"，是"那几份不能删"
	{
		// 占用 300（其中 200 被笔记直接指着 ⇒ 不能删），上限 50 ⇒ 就算把能删的（100）全删了也还超 150
		const plan = planEviction({
			candidates: [candidateFor("only", { bytes: 100, lastUsedAt: NOW - 50 * HOUR })],
			totalBytes: 300,
			limitBytes: 50,
			now: NOW,
			pinnedCount: 200,
		});
		assert.equal(plan.overBy, 150, "★ 连「不能删」的部分一起算 ⇒ 这个超出量是**腾不掉**的，必须如实报");
		assert.match(
			plan.reason,
			/被笔记直接指着|不能删/,
			"★★ 原因要说清是「被笔记直接指着」—— 只报一个数字会让用户以为插件坏了"
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
	// 2c. ⭐⭐ 幽灵记录**不得**抬高超出量（否则上限会多删真实副本）
	//
	// 索引里可能留着"文件已经不在了"的记录（用户删了、同步还没到、换设备）。
	// 若总量用**索引原始和**、而候选只含磁盘上还在的那几份，两者就错位：
	// 幽灵记录抬高超出量 ⇒ 淘汰多删，极端情况一份不剩 —— 而真实占用根本没超上限。
	// ⇒ 判据：总量必须与候选**同源**（`presentBytes`）。
	// ============================================================
	{
		const entries = [];
		for (let i = 0; i < 10; i += 1) entries.push(entryFor(`p${i}.png`, { size: 10 * MB }));
		// 只有前 4 份真的在磁盘上；后 6 份的文件已被用户删掉（索引还记着 = 幽灵记录）
		const presentPaths = new Set(entries.slice(0, 4).map((e) => e.cachePath));
		const present = (path) => presentPaths.has(path);

		const selection = buildEvictionCandidates({ entries, present, referencedKeys: null, referencedPaths: new Set() });
		assert.equal(selection.missing, 6, "6 份是幽灵记录（索引记着、磁盘上没有）");
		assert.equal(selection.presentBytes, 40 * MB, "★★ 总量 = 磁盘上确实还在的那 4 份");
		assert.equal(sumOwnedBytes(entries), 100 * MB, "（索引原始和是 100MB —— 它把幽灵记录也算进去了）");

		const limit = 50 * MB;
		const fixed = planEviction({
			candidates: selection.candidates,
			totalBytes: selection.presentBytes,
			limitBytes: limit,
			now: NOW,
		});
		assert.equal(
			fixed.evict.length,
			0,
			"★★ 真实占用 40MB 没超 50MB ⇒ **一份都不该删**（幽灵记录不得抬高超出量）"
		);

		// 反例：把索引原始和当总量 —— 那正是修复前"4 份真副本被全删光"的成因。
		// 这条断言钉住的是**调用方必须传 presentBytes**，不是 planEviction 自己的行为。
		const broken = planEviction({
			candidates: selection.candidates,
			totalBytes: sumOwnedBytes(entries),
			limitBytes: limit,
			now: NOW,
		});
		assert.equal(
			broken.evict.length,
			4,
			"★★ 总量若传索引原始和 ⇒ 4 份真副本全被删光（本次修掉的缺陷；调用方必须传 presentBytes）"
		);
	}

	// ============================================================
	// 2d. ⭐⭐ 索引自相矛盾（两条记录指着**同一份文件**）时，只能算一份
	//
	// 成因真实存在：搬运 / 改名中断、两台设备的台账合并、自愈只摘了一半。
	// 按**记录**累加字节会把同一份文件算两遍 ⇒ 占用虚高 ⇒ 上限判定**多删真实副本**，
	// 而界面上的数字是自洽的（只有用户事后发现图没了才知道）。
	// ⇒ 判据：先按路径折成"磁盘上的文件"（`uniqueByPath`），再做任何计数。
	// ============================================================
	{
		const samePath = "_attachment-cache/a.png";
		const entries = [
			entryFor("a.png", { cachePath: samePath, size: 10 * MB }),
			// 同一个 cachePath，另一个 key（"两份台账指向同一份文件"）
			entryFor("a-from-other-device.png", { cachePath: samePath, size: 10 * MB }),
			entryFor("b.png", { size: 10 * MB }),
		];
		const present = () => true;
		const selection = buildEvictionCandidates({ entries, present, referencedKeys: null, referencedPaths: new Set() });

		assert.equal(
			selection.presentBytes,
			20 * MB,
			"★★ 同一份文件只算一次（按记录累加会把 20MB 报成 30MB ⇒ 超出量虚高 ⇒ 多删）"
		);
		assert.equal(selection.candidates.length, 2, "★ 候选也按**文件**算，不按记录算（同一份别删两次）");
		assert.deepEqual(
			selection.candidates.map((c) => c.cachePath),
			[samePath, "_attachment-cache/b.png"],
			"保留**第一条**记录（顺序来自索引本身：稳定、可复现）"
		);

		// ⭐ 真正要紧的后果：虚高的占用会让上限多删一份真实副本
		const limit = 15 * MB;
		const fixed = planEviction({
			candidates: selection.candidates,
			totalBytes: selection.presentBytes,
			limitBytes: limit,
			now: NOW,
		});
		assert.equal(fixed.evict.length, 1, "★★ 真实占用 20MB 超 15MB ⇒ 只该删一份（腾到 10MB）");

		// 反例：把索引原始和当总量 —— 那就是修复前的样子（30MB 超 15MB ⇒ 连删两份）
		const broken = planEviction({
			candidates: selection.candidates,
			totalBytes: sumOwnedBytes(entries),
			limitBytes: limit,
			now: NOW,
		});
		assert.equal(broken.evict.length, 2, "★★ 总占用虚高时会连删两份真实副本（本次修掉的缺陷）");

		// 幽灵记录也不能被数两次（先折叠、再计数）
		const ghost = "_attachment-cache/gone.png";
		const ghosts = [
			entryFor("gone-a.png", { cachePath: ghost, size: 1024 }),
			entryFor("gone-b.png", { cachePath: ghost, size: 1024 }),
		];
		const ghosted = buildEvictionCandidates({
			entries: ghosts,
			present: () => false,
			referencedKeys: null,
			referencedPaths: new Set(),
		});
		assert.equal(ghosted.missing, 1, "★ 同一份不存在的文件也只有一个「失效记录」");
		assert.equal(ghosted.presentBytes, 0, "不存在的文件不占磁盘");

		// 归一后为空的记录既不算候选也不算占用（坏数据不得污染上限判定）
		// ⚠️ 用真正的空串：宿主的 `normalizePath` **不 trim**，纯空格会被当成一个路径名
		//（那不是我们要判的事，别在这里顺手改口径）。
		const blank = buildEvictionCandidates({
			entries: [entryFor("blank.png", { cachePath: "", size: 5 * MB })],
			present: () => true,
			referencedKeys: null,
			referencedPaths: new Set(),
		});
		assert.equal(blank.candidates.length, 0, "指不到库内路径的记录不进候选");
		assert.equal(blank.presentBytes, 0, "★ 也不算占用（否则它会白白抬高超出量）");
	}

	// 2e. `uniqueByPath` 的形状（它是 2d 那个判据的唯一实现，单独钉一下）
	{
		const before = [
			{ cachePath: "a/b.png" },
			{ cachePath: "./a/b.png" },
			{ cachePath: "/a/b.png" },
			{ cachePath: "" },
			{ cachePath: "c.png" },
		];
		const folded = uniqueByPath(before);
		assert.deepEqual(
			folded.map((item) => item.path),
			["a/b.png", "c.png"],
			"★ 归一后相同的路径只留一条（`./`、开头的 `/` 都归一到同一个），空路径直接丢"
		);
		assert.equal(folded[0].entry, before[0], "保留**第一条**记录本身（不是造一个副本）");
		assert.deepEqual(uniqueByPath([]), [], "空输入 = 空输出");
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
