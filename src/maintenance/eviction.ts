/**
 * 缓存上限与自动轮换：**纯判定**。
 *
 * ## 为什么需要它
 *
 * 缓存目录只会涨：每次粘贴/拖拽/回退下载都会留一份副本。对磁盘有限（或用同步服务）
 * 的用户来说，一个只涨不落的目录迟早变成问题，而"记得手动去清理"这件事没人做得到。
 * 所以要有上限，且要在后台自己轮换。
 *
 * ## 淘汰谁：三类对象，优先级不同
 *
 * | 类别 | 判据 | 为什么这么排 |
 * |---|---|---|
 * | **孤儿** | 磁盘上有、索引里没有 | 最先淘汰：它连"是哪张图"都无从查起，渲染钩子也不可能用到它 |
 * | **未引用副本** | 有索引记录，但没有任何笔记引用 | 次先淘汰：引用它的笔记已经删了，纯占地方 |
 * | **被引用的副本** | 有索引记录，且仍有笔记引用 | 最后淘汰：删掉它会让那张图**暂时失去离线能力** |
 *
 * ## ⚠️ 淘汰是被允许的，因为"副本"不是唯一的一份
 *
 * 被淘汰的副本可以从用户自己的存储**重新下载**（笔记里存的是远端 URL，从没被改动）。
 * 所以这里的代价是"那张图下次看到它时会重新拉一遍"，**不是丢数据**。
 * 也正因如此，淘汰之后调用方**必须摘掉索引记录** —— 否则渲染层会以为本地还有那份副本，
 * 于是走 error 兜底、每次渲染都白试一次（见 `run.ts` 的 `runEviction`）。
 *
 * ## ⚠️ 两条绝不能越过的界
 *
 * 1. `localCopy: "keep"` 时副本在**用户的附件目录**里 —— 那是正常附件，绝不进候选
 *    （判据是 `isUnderCacheFolder`，与维护功能同一套）。
 * 2. 只淘汰"**不新鲜**"的（`graceMs` 内刚用过/刚放进缓存的不动）：否则会出现
 *    "刚下载完就删掉"，把刚花掉的流量白扔，而且会形成稳定的来回抖动。
 */

import type { CacheEntry } from "../cache/index";
import { isUnderCacheFolder } from "../cache-path";
import type { DiskFile } from "./audit";

/**
 * 刚放进缓存多久之内的副本不参与淘汰。
 *
 * 10 分钟是刻意的：粘贴完一张图后用户多半会立刻看图、改笔记，那段时间里
 * 我们不该去碰它。代价是"上限生效最多晚 10 分钟"，而这不是一件急事。
 */
export const DEFAULT_EVICTION_GRACE_MS = 10 * 60 * 1000;

/** 淘汰候选。 */
export interface EvictionCandidate {
	/** 对象 key。**空串表示孤儿**（磁盘上有、索引里没有）—— 索引里的 key 永远非空，所以不歧义。 */
	key: string;
	/** 缓存目录内的 vault 相对路径。 */
	cachePath: string;
	/** 字节数（**磁盘上的真实值**优先）。 */
	bytes: number;
	/** 最近一次使用（epoch ms）。**0 = 不确知**，按"最旧"处理。 */
	lastUsedAt: number;
	/** 是否仍被某篇笔记引用。 */
	referenced: boolean;
}

/**
 * 一次淘汰的结果（由执行层填）。
 *
 * 定义在这里而不是执行层：判定层与执行层都要用它，放在纯模块里可以让
 * 编排层不必反向依赖 `run.ts`（那会绕出一个没意义的依赖环）。
 */
export interface EvictionOutcome {
	/** 真的被淘汰的文件数。 */
	evicted: number;
	/** 真的回收的字节数。 */
	freed: number;
	/** 被跳过的（宿主的文件索引滞后于磁盘等）。 */
	skipped: { path: string; reason: string }[];
}

/** 上限（MB）→ 字节。**非数、负数、NaN 一律当作"不限制"（0）**。 */
export function megabytesToBytes(mb: unknown): number {
	if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) return 0;
	return Math.floor(mb * 1024 * 1024);
}

/** 字节 → 给人看的 MB（一位小数）。 */
export function formatMegabytes(bytes: unknown): string {
	const value = typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	return (value / (1024 * 1024)).toFixed(1);
}

/** 路径归一化，只用于**比较**（与索引里的写法可能有前导斜杠/反斜杠差异）。 */
function normalize(path: unknown): string {
	if (typeof path !== "string") return "";
	return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** ISO 时间串 → 毫秒；解析不出来返回 0（= 不确知）。 */
function parseTime(value: unknown): number {
	if (typeof value !== "string" || value === "") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 索引里**缓存目录内**的副本占了多少字节（一次内存求和，不碰磁盘）。
 *
 * 编排层拿它做"要不要去量磁盘"的**便宜门槛**：缓存是慢慢涨的，
 * 而"量一次磁盘"要列目录 + 逐个 stat —— 不该在每次上传、每个周期都做。
 *
 * ⚠️ 只算缓存目录内的：`localCopy: "keep"` 的副本在附件目录里，
 * 那是用户的附件，不该计入缓存上限。
 */
export function sumIndexedBytes(entries: readonly CacheEntry[], cacheFolder: string): number {
	let total = 0;
	for (const entry of entries) {
		if (!isUnderCacheFolder(entry.cachePath, cacheFolder)) continue;
		const size = typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
		total += size;
	}
	return total;
}

export interface CandidateInput {
	entries: readonly CacheEntry[];
	/** 缓存目录下的文件（调用方负责只列这个目录）。 */
	files: readonly DiskFile[];
	/**
	 * 笔记里引用到的对象 key 集合。
	 *
	 * `undefined` 表示"没有扫描引用" —— 此时一律当作**已引用**。
	 * 这个默认值是刻意的：不知道 ≠ 没人用，把"不确知"当成"没人用"会让我们
	 * 优先删掉一批可能还有人要的副本。
	 */
	referencedKeys?: ReadonlySet<string>;
	cacheFolder: string;
}

/**
 * 造出可淘汰的候选。**纯函数**：不改索引、不碰文件。
 *
 * 三类东西绝不会进来：缓存目录**外**的副本（用户的附件）、磁盘上**不存在**的记录
 * （没有可删的文件）、以及缓存目录外的任何文件。
 */
export function buildEvictionCandidates(input: CandidateInput): EvictionCandidate[] {
	const disk = new Map<string, DiskFile>();
	for (const file of input.files) {
		if (!isUnderCacheFolder(file.path, input.cacheFolder)) continue;
		disk.set(normalize(file.path), file);
	}

	const out: EvictionCandidate[] = [];
	const indexedPaths = new Set<string>();

	for (const entry of input.entries) {
		const path = normalize(entry.cachePath);
		// ⚠️ 只管缓存目录里的副本：附件目录里的那份是用户的正常附件。
		//
		// 这一道与上面（构造磁盘映射时）的过滤是**刻意的双保险**，与 `runCleanup` 同一条纪律：
		// 这是"自动删文件"的路径，多一道校验的代价是零，而少一道的代价不可逆。
		// 也因此**只拆这一道不会漏东西**（另一道已经把那些路径挡在外面了）——
		// 变异验证打的是上面那一道，别把这里的冗余当成"没人管的死代码"。
		if (!isUnderCacheFolder(path, input.cacheFolder)) continue;

		const file = disk.get(path);
		// 磁盘上没有 → 没有可删的东西（这条记录该由自愈去摘，不是淘汰的事）
		if (!file) continue;
		indexedPaths.add(path);

		out.push({
			key: entry.key,
			cachePath: path,
			// 磁盘大小优先（那才是能腾出的空间）；stat 拿不到时退回索引记录的数字
			bytes: file.bytes > 0 ? file.bytes : Math.max(0, entry.size),
			// 有使用时间就用它；否则退回上传时间（"刚上传的"约等于"刚用过"）
			lastUsedAt: entry.lastUsedAt > 0 ? entry.lastUsedAt : parseTime(entry.uploadedAt),
			referenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : true,
		});
	}

	// 孤儿：磁盘上有、索引里没有。它们不可能被渲染钩子用到，是最该淘汰的一类。
	for (const [path, file] of disk) {
		if (indexedPaths.has(path)) continue;
		out.push({
			key: "",
			cachePath: path,
			bytes: Math.max(0, file.bytes),
			lastUsedAt: 0,
			referenced: false,
		});
	}

	return out;
}

export interface EvictionInput {
	candidates: readonly EvictionCandidate[];
	/** 缓存目录当前的总字节（磁盘上的真实值）。 */
	totalBytes: number;
	/** 上限（字节）。0 = 不限制。 */
	limitBytes: number;
	/** 当前时间（epoch ms），注入是为了可穷举。 */
	now: number;
	graceMs?: number;
}

export interface EvictionPlan {
	/** 要淘汰的文件，**按该删的顺序**排好（第一个最该走）。 */
	evict: EvictionCandidate[];
	/** 计划回收的字节。 */
	reclaimable: number;
	/** 执行前的占用。 */
	totalBytes: number;
	/** 目标。 */
	limitBytes: number;
	/** 执行后的预计占用。 */
	projectedBytes: number;
	/** 执行后**仍然超出**的字节（> 0 表示这轮腾不到目标，必须如实报出去）。 */
	overBy: number;
	/** 为什么是这个结果（日志与排查用，不进界面）。 */
	reason: string;
}

/**
 * 挑出这一轮该淘汰哪些文件。**纯函数**。
 *
 * 顺序是「未引用优先 → 最久未用优先 → key」，三段都必要：
 * 前两段决定"谁的代价最小"，最后一段保证**同一份数据每次挑的人一样**
 * （否则用户会看到"每次轮换删的都不一样"，没法解释也没法复现）。
 */
export function planEviction(input: EvictionInput): EvictionPlan {
	const total = Math.max(0, input.totalBytes);
	const limit = Math.max(0, input.limitBytes);

	const done = (reason: string): EvictionPlan => ({
		evict: [],
		reclaimable: 0,
		totalBytes: total,
		limitBytes: limit,
		projectedBytes: total,
		overBy: 0,
		reason,
	});

	// 0 = 不限制。这不是"上限为 0 字节"，而是"不要管我"。
	if (limit <= 0) return done("未设上限（0 = 不限制）");
	const over = total - limit;
	if (over <= 0) return done("没超上限");

	const graceMs = input.graceMs ?? DEFAULT_EVICTION_GRACE_MS;
	// 刚用过 / 刚放进缓存的这一轮不动 —— 否则"刚下载完就删掉"，还会来回抖动。
	const eligible = input.candidates.filter((candidate) => input.now - candidate.lastUsedAt >= graceMs);

	const ordered = [...eligible].sort((a, b) => {
		// ① 没被引用的先走（它连显示都不会显示）
		const byRef = Number(a.referenced) - Number(b.referenced);
		if (byRef !== 0) return byRef;
		// ② 再按"多久没用过"
		if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt;
		// ③ 最后按 key —— 只为了让顺序**稳定**
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});

	const evict: EvictionCandidate[] = [];
	let reclaimable = 0;
	for (const candidate of ordered) {
		if (reclaimable >= over) break;
		evict.push(candidate);
		reclaimable += Math.max(0, candidate.bytes);
	}

	const projectedBytes = total - reclaimable;
	const overBy = Math.max(0, projectedBytes - limit);
	const fresh = input.candidates.length - eligible.length;

	let reason: string;
	if (overBy <= 0) {
		reason = "已腾到上限以内";
	} else if (fresh > 0) {
		reason = `仍超出 ${overBy} 字节：有 ${fresh} 份副本在宽限期内（刚用过或刚放进缓存），本轮不动`;
	} else {
		// 候选不够 —— 常见原因是缓存目录里还有没被索引收录的文件（孤儿之外的，
		// 例如索引损坏后重建中）。那种情况要靠"清理缓存"命令处理。
		reason = `仍超出 ${overBy} 字节：可淘汰的对象不够（缓存目录里可能还有未被索引收录的文件）`;
	}

	return { evict, reclaimable, totalBytes: total, limitBytes: limit, projectedBytes, overBy, reason };
}
