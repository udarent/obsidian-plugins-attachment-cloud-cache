/**
 * 本地副本的上限与自动淘汰：**纯判定**。
 *
 * ## 为什么需要它
 *
 * 本地副本只会涨：每次上传、回退下载都会留一份。对磁盘有限（或用同步服务）的用户来说，
 * 一份只涨不落的副本集迟早变成问题，而"记得手动清理"这件事没人做得到。
 * 所以要有上限，且要在后台自己淘汰 —— **这一条的含义从 1.0 起没有变过**。
 *
 * ## ⭐ 1.3.0（D-17）：含义不变，实现换了
 *
 * 缓存目录取消之后，本地副本 = **附件目录里那份原文件**（索引记着它在哪）。
 * 于是这一层换了三处实现，每一处都是"物理位置不再提供答案"的直接后果：
 *
 * | | 旧实现 | 新实现 |
 * |---|---|---|
 * | 候选与统计 | 列**缓存目录** + 逐个 stat | **一律来自索引**（一次内存求和） |
 * | 孤儿（目录里有、索引里没有） | 可删（那条目录承诺可整体清理） | **这一类消失** —— 索引里没有的文件一律不碰（那可能是用户的附件，不是我们的副本） |
 * | "云端还有它吗" | 不必问（缓存目录里的东西必然是刚传上去的） | ⭐ **执行层逐个 HEAD 复核**（见下） |
 *
 * ⚠️ 第三条是这次改造里**唯一加强了的安全线**，理由是新的失效形态：
 * 副本现在可能比云端对象**活得久**（别的设备把云端对象清掉了，而本机的台账还记着它）。
 * 那种副本是**最后一份**，删它就是丢数据 —— 所以"我们传过它"不再够用，
 * 必须确认"云端**现在**确实还有它"，而这件事只能问服务端。
 *
 * ## 淘汰谁：三类对象，优先级不同
 *
 * | 类别 | 判据 | 为什么这么排 |
 * |---|---|---|
 * | **未引用副本** | 有索引记录，但没有任何笔记引用 | 先淘汰：引用它的笔记已经删了，纯占地方 |
 * | **被引用的副本** | 有索引记录，且仍有笔记引用 | 后淘汰：删掉它会让那张图**暂时失去离线能力** |
 *
 * ## ⚠️ 淘汰是被允许的，因为"副本"不是唯一的一份
 *
 * 笔记里存的是**远端 URL**（从没被改写），所以被淘汰的副本下次看到那张图时会**自动重新下载**。
 * 代价是"重新拉一遍"，**不是丢数据**。也正因如此，淘汰之后调用方**必须摘掉索引记录** ——
 * 否则渲染层会以为本地还有那份副本，于是每次渲染都白试一次（见 `run.ts` 的 `runEviction`）。
 *
 * ## ⚠️ 两条绝不能越过的界
 *
 * 1. **只碰索引认得的副本**：索引里没有的文件（用户的附件、别的插件放的东西）绝不进候选。
 *    旧实现有一条"孤儿优先淘汰"，它当时是安全的（缓存目录里的东西都是我们的）；
 *    现在**没有任何目录**能提供这种保证，所以那一类被整条删掉了。
 * 2. **只淘汰"不新鲜"的**（`graceMs` 内刚用过的不动）：否则会出现"刚下载完就删掉"，
 *    把刚花掉的流量白扔，还会形成稳定的来回抖动。
 */

import type { CacheEntry } from "../cache/index";
// 路径归一用**共享**的实现（`vault-files.ts` → 宿主的 `normalizePath`）：
// 淘汰要拿索引里的路径与真实路径做比较，两侧必须同源。
import { normalizeVaultPath } from "../vault-files";

/**
 * 刚用过多久之内的副本不参与淘汰。
 *
 * 10 分钟是刻意的：粘贴完一张图后用户多半会立刻看图、改笔记，那段时间里
 * 我们不该去碰它。代价是"上限生效最多晚 10 分钟"，而这不是一件急事。
 */
export const DEFAULT_EVICTION_GRACE_MS = 10 * 60 * 1000;

/** 淘汰候选。 */
export interface EvictionCandidate {
	/** 对象 key。新实现里**永远非空**（候选一律来自索引）。 */
	key: string;
	/** 本地副本的 vault 相对路径（1.3.0 起通常在附件目录里，不再叫"缓存路径"）。 */
	cachePath: string;
	/** 字节数（索引记的值 —— 文件是我们写下的）。 */
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
	/** 被跳过的（宿主索引滞后、云端确认不上等）。 */
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

/** ISO 时间串 → 毫秒；解析不出来返回 0（= 不确知）。 */
function parseTime(value: unknown): number {
	if (typeof value !== "string" || value === "") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 索引里所有**本地副本**占了多少字节（一次内存求和，不碰磁盘）。
 *
 * ⚠️ 1.3.0 起**不再按目录过滤**：缓存目录已经不存在，而 keep 档的副本就在附件目录里 ——
 * 那同样占用户的磁盘，那正是这个上限要管的东西。旧实现只算缓存目录内的字节，
 * 于是在 keep 档"看不见的开关在后台生效/不生效"（P7）：现在统计范围与设置文案一致。
 */
export function sumOwnedBytes(entries: readonly CacheEntry[]): number {
	let total = 0;
	for (const entry of entries) {
		const size = typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
		total += size;
	}
	return total;
}

export interface CandidateInput {
	entries: readonly CacheEntry[];
	/**
	 * "这份副本还在磁盘上吗"。**同步**谓词 —— 由调用方算好（见 `rotation.ts` 的说明）。
	 * 返回假的后果只是"这一轮不淘汰它"，安全。
	 */
	present: (path: string) => boolean;
	/**
	 * 笔记里引用到的对象 key 集合。
	 *
	 * `undefined` 表示"没有扫描引用" —— 此时一律当作**已引用**。
	 * 这个默认值是刻意的：不知道 ≠ 没人用，把"不确知"当成"没人用"会让我们
	 * 优先删掉一批可能还有人要的副本。
	 */
	referencedKeys?: ReadonlySet<string>;
}

export interface CandidateSelection {
	candidates: EvictionCandidate[];
	/** 索引里有记录、但磁盘上找不到那份文件的数量（没有可删的东西）。 */
	missing: number;
}

/**
 * 造出可淘汰的候选。**纯函数**：不改索引、不碰文件。
 *
 * ⚠️ 只有**索引里的**副本会进来。索引里没有的文件（用户自己的附件、别的插件放的东西）
 * 一律不碰 —— 旧实现里那条"目录里有、索引里没有 ⇒ 可删"的规则，
 * 依赖的是"缓存目录里的东西都是我们的"这个物理保证；那份保证随缓存目录一起消失了。
 */
export function buildEvictionCandidates(input: CandidateInput): CandidateSelection {
	const candidates: EvictionCandidate[] = [];
	let missing = 0;

	for (const entry of input.entries) {
		const path = normalizeVaultPath(entry.cachePath);
		if (!path) continue;
		// 磁盘上没有 → 没有可删的东西（这条记录该由自愈去摘，不是淘汰的事）
		if (!input.present(path)) {
			missing += 1;
			continue;
		}

		candidates.push({
			key: entry.key,
			cachePath: path,
			// 索引记的字节：这份文件是我们写下的（用户改过它就不是我们的副本了，
			// 那时真正的修复是自愈/重新下载，不是在这里猜大小）
			bytes: Math.max(0, entry.size),
			// 有使用时间就用它；否则退回上传时间（"刚上传的"约等于"刚用过"）
			lastUsedAt: entry.lastUsedAt > 0 ? entry.lastUsedAt : parseTime(entry.uploadedAt),
			referenced: input.referencedKeys ? input.referencedKeys.has(entry.key) : true,
		});
	}

	return { candidates, missing };
}

export interface EvictionInput {
	candidates: readonly EvictionCandidate[];
	/** 当前占用的总字节。 */
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
	// 刚用过的这一轮不动 —— 否则"刚下载完就删掉"，还会来回抖动。
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
		reason = `仍超出 ${overBy} 字节：有 ${fresh} 份副本在宽限期内（刚用过），本轮不动`;
	} else {
		// 候选不够 —— 常见原因是索引里没有更多副本可淘汰了（例如多数目标都在云端确认不上、
		// 或索引本身不全）。索引不全时上限偏保守，这是安全的那一侧。
		reason = `仍超出 ${overBy} 字节：可淘汰的副本不够（索引里的副本已挑完）`;
	}

	return { evict, reclaimable, totalBytes: total, limitBytes: limit, projectedBytes, overBy, reason };
}
