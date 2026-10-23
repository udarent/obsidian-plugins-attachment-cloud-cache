/**
 * 后台自动轮换的**编排**：什么时候去看、看之前先看什么、看完之后说什么。
 *
 * ## 为什么要单独一层
 *
 * 它是**自动**运行的（没有用户在旁边按确认），所以三件事必须写清楚、也必须有测试：
 * ① 什么时候跑（触发与节流）；② 跑之前先看什么（两道**由便宜到贵**的门槛）；
 * ③ 结果怎么报（什么时候提示、什么时候保持安静）。
 * 这些都塞进 `main.ts` 的接线里就没法测了。
 *
 * ## ⭐ 一道门槛：索引里的字节之和（它是"当前占用"的**上界**）
 *
 * 这条链上最贵的一步是**扫全库笔记**（判断哪些副本还被引用，见 `scanReferences`），
 * 所以先用一次内存求和挡住绝大多数轮次：没超上限就直接返回。
 * ⚠️ 它是上界（索引 ⊇ 磁盘上还在的）⇒"上界都不超就一定不超"⇒ 在这里跳过是**安全**的；
 * 但它**不是**"当前占用"本身 —— 真正的总量在 `rotate()` 里用 `presentBytes` 算。
 *
 * ⚠️ 从前还有第二道门槛（"列缓存目录 + 逐个 stat"），用来发现"索引记的比上限小、
 * 但磁盘上其实还多"。它随缓存目录一起**取消**了：那条目录的清单本身也来自索引，
 * 列不出索引之外的东西；而索引之外的文件现在**绝不能删**（那可能是用户的附件）。
 * 代价如实记：**索引不全时上限偏保守**（宁可少删），这是安全的那一侧。
 * ⚠️ 反过来的那一侧（索引记着、文件已经不在的**幽灵记录**）不由这里兜 —— 它由
 * **总量改用"存在着的字节和"**兜住（见 `eviction.ts` 的模块头注释）：两道关都靠它就同时成立。
 *
 * ## 触发（由接线层决定，这一层只管"该不该跑"）
 *
 * | 触发 | 时机 | 为什么需要它 |
 * |---|---|---|
 * | `startup` | 加载后延迟一次 | 副本可能在插件没运行时长大了（回退下载、同步带来的新图） |
 * | `growth` | 每次上传/下载完成后 | 副本长大的**真正原因**都在这里，反应最快 |
 * | `settings` | 保存设置后 | 用户刚把上限调小，想立刻看到效果 |
 * | `interval` | 周期性兜底 | 覆盖上面几种之外的缓慢增长 |
 *
 * ⚠️ `startup` 那一轮**不再特殊**（从前它绕过索引、直接量磁盘）：
 * 那时"磁盘上有、索引里没有"的东西都在缓存目录里，删掉是安全的；
 * 现在索引外的文件可能是**用户的附件**，一律不能自动删 ⇒ 索引不全时上限偏保守，
 * 而不是"凭磁盘清单猜"。
 *
 * ## 安静是默认值
 *
 * 没超上限、没得可淘汰、刚淘汰过 —— 都不提示。这是一个后台保洁任务，
 * 它不该在用户读笔记的时候插嘴。只有**真的淘汰了东西**才说一句。
 */

import type { CacheIndex } from "../cache/index";
import type { PluginSettings } from "../types";
import {
	buildEvictionCandidates,
	formatMegabytes,
	megabytesToBytes,
	planEviction,
	sumOwnedBytes,
} from "./eviction";
import type { EvictionOutcome, EvictionPlan } from "./eviction";

/** 为什么触发一次检查。 */
export type RotationReason = "startup" | "growth" | "settings" | "interval";

/**
 * 两次**实际执行**之间的最短间隔。
 *
 * 它与"多久检查一次"是两件事：检查可以很频繁（有便宜的门槛挡着，代价接近零），
 * 而"量磁盘 + 扫笔记 + 删文件"不该被一串事件连着触发好几次。
 * 一分钟的粒度足够 —— 连粘 20 张图也只会在最后做一轮。
 */
export const DEFAULT_ROTATION_MIN_INTERVAL_MS = 60 * 1000;

/**
 * 现在该不该真的跑一轮。**纯函数**。
 *
 * `lastRunAt` 的初值是 `-Infinity`，所以第一次永远该跑（不需要特判"首次"）。
 */
export function isRotationDue(input: { now: number; lastRunAt: number; minIntervalMs: number }): boolean {
	return !(input.now - input.lastRunAt < input.minIntervalMs);
}

export interface CacheRotationDeps {
	settings: () => PluginSettings;
	index: () => CacheIndex;
	/**
	 * "这份副本还在磁盘上吗"（**同步**）。
	 *
	 * 接线层用宿主的文件索引回答：它**可能滞后**于磁盘，而滞后只会让这一轮
	 * 少淘汰几个（执行层拿不到删除凭据时会跳过），方向是安全的。
	 */
	isPresent: (path: string) => boolean;
	/** 扫全库笔记，收集仍被引用的 key（接线层复用 `scanReferences`）。 */
	scanReferencedKeys: () => Promise<Set<string>>;
	/**
	 * 笔记 / 画布**直接指着**的库内路径（接线层复用 `referencedVaultPaths`）。
	 *
	 * ⚠️ "还有人用吗"的另一半，而且是**硬门槛**而不是排序偏好（见 `eviction.ts` 模块头）：
	 * 少了它，一份"笔记里还写着本地路径"的副本会被淘汰掉 ⇒ 用户打开那篇笔记看到**破图**，
	 * 且没有任何自动恢复的路径（回退下载只认属于本存储的 URL）。
	 * 两个问题为什么都要问，见 `eviction.ts` 的 `referencedPaths`。
	 */
	referencedPaths: () => Promise<ReadonlySet<string>>;
	/** 执行淘汰（接线层复用 `runEviction`）。 */
	evict: (plan: EvictionPlan) => Promise<EvictionOutcome>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
	now?: () => number;
	/** 两次实际执行之间的最短间隔。 */
	minIntervalMs?: number;
	/** 刚放进缓存多久之内的副本不参与淘汰。 */
	graceMs?: number;
	/** 出错时的记录口（**不能**用来打扰用户：这是后台任务）。 */
	onError?: (error: unknown) => void;
}

/** 一轮**实际执行**的结果（没跑时 `maybeRotate` 返回 `null`）。 */
export interface RotationSummary {
	reason: RotationReason;
	/** 量到的缓存占用。⚠️ **只含磁盘上确实还在的副本**（与候选同源，见 `eviction.ts`）。 */
	totalBytes: number;
	limitBytes: number;
	evicted: number;
	freed: number;
	/** 被跳过的数量（宿主的文件索引滞后于磁盘等）。 */
	skipped: number;
	/** 执行之后**仍然**超出的字节（> 0 表示这轮没腾到目标）。 */
	overBy: number;
}

export interface CacheRotator {
	/**
	 * 有需要就跑一轮。返回 `null` 表示"没跑" ——
	 * 没设上限 / 没超门槛 / 被节流 / 已经有一轮在跑 / 真去量了但发现没超 / 出错了。
	 */
	maybeRotate: (reason: RotationReason) => Promise<RotationSummary | null>;
}

export function createCacheRotator(deps: CacheRotationDeps): CacheRotator {
	const now = deps.now ?? Date.now;
	const minIntervalMs = deps.minIntervalMs ?? DEFAULT_ROTATION_MIN_INTERVAL_MS;
	let lastRunAt = Number.NEGATIVE_INFINITY;
	let running = false;

	const report = (error: unknown): void => {
		try {
			deps.onError?.(error);
		} catch {
			// 连记录都失败就真没什么可做的了 —— 但绝不能因此影响别的东西
		}
	};

	/**
	 * 提示一句。**自己的 try**：提示失败（例如宿主界面出问题）
	 * 不该把已经完成的淘汰结果吞掉（那会让调用方以为"什么都没发生"）。
	 */
	const announce = (outcome: EvictionOutcome, overBy: number): void => {
		try {
			const mb = formatMegabytes(outcome.freed);
			if (overBy > 0) {
				deps.notify(
					deps.t("cacheEvictedPartial", {
						mb,
						count: outcome.evicted,
						overMb: formatMegabytes(overBy),
					})
				);
			} else {
				deps.notify(deps.t("cacheEvicted", { mb, count: outcome.evicted }));
			}
		} catch (error) {
			report(error);
		}
	};

	async function rotate(reason: RotationReason, limitBytes: number, at: number): Promise<RotationSummary> {
		const entries = deps.index().toArray();

		const referencedKeys = await deps.scanReferencedKeys();
		// ⭐ 另一半：笔记**直接指着**的库内路径。判据是"**不能删**"（不是排序偏好）——
		// 那些副本删了笔记里那张图就没了（回退下载只认属于本存储的 URL），见 `eviction.ts` 模块头。
		const referencedPaths = await deps.referencedPaths();
		const { candidates, presentBytes, pinned } = buildEvictionCandidates({
			entries,
			present: deps.isPresent,
			referencedKeys,
			referencedPaths,
		});
		// ⭐ 总量用 `presentBytes`（**磁盘上确实还在**的那些）—— 与候选同源。
		// 用索引的原始和会让**幽灵记录**（索引记着、文件已经不在了）抬高超出量 ⇒ 多删真实副本。
		// 详见 `eviction.ts` 的模块头注释（含那条反例）。
		// ⚠️ `presentBytes` 里**包含**被钉住的那几份（它们确实占着磁盘）—— 所以"仍超出"必须
		// 把它们的存在说出来，否则用户看到的是一个没有解释的数字（`pinnedCount`）。
		const plan = planEviction({
			candidates,
			totalBytes: presentBytes,
			limitBytes,
			now: at,
			graceMs: deps.graceMs,
			pinnedCount: pinned,
		});

		// 一份都挑不出来（例如全在宽限期内）→ 不动手，也不打扰
		const outcome: EvictionOutcome =
			plan.evict.length > 0 ? await deps.evict(plan) : { evicted: 0, freed: 0, skipped: [] };

		// ⚠️ "还超多少"要用**实际**回收量算，而不是计划里的数字：
		// 执行时可能有文件被跳过（宿主索引滞后），那时真实的超出量更大。
		// 报小了会让用户以为上限已经生效。
		const overBy = Math.max(0, presentBytes - outcome.freed - limitBytes);
		if (outcome.evicted > 0) announce(outcome, overBy);

		return {
			reason,
			totalBytes: presentBytes,
			limitBytes,
			evicted: outcome.evicted,
			freed: outcome.freed,
			skipped: outcome.skipped.length,
			overBy,
		};
	}

	return {
		async maybeRotate(reason) {
			// 已经有一轮在跑：直接让路。两次同时量磁盘、同时删同一批文件
			// 只会产生"到底删了没有"这种解释不清的状态。
			if (running) return null;

			try {
				const settings = deps.settings();
				const limitBytes = megabytesToBytes(settings.cacheLimitMb);
				// 没设上限 → 什么都不做（连索引都不读）—— 默认就是这个状态
				if (limitBytes <= 0) return null;

				// 门槛（**便宜**）：索引里记的字节之和。⚠️ 它是"存在着的字节和"的**上界**
				// （索引 ⊇ 磁盘上还在的），所以"上界都不超 ⇒ 一定不超"⇒ 在这里跳过是安全的。
				// 它只回答"要不要进去看"，**真正的总量**在 `rotate()` 里用 `presentBytes` 算
				// —— 两者不能混：用原始和当总量会让幽灵记录造成多删。
				if (sumOwnedBytes(deps.index().toArray()) <= limitBytes) return null;

				const at = now();
				if (!isRotationDue({ now: at, lastRunAt, minIntervalMs })) return null;

				running = true;
				lastRunAt = at;
				try {
					return await rotate(reason, limitBytes, at);
				} finally {
					// ⚠️ 只有**真的跑过**的那一次才清这个标志。
					// 若把 `finally` 挂在更外层，上面任何一个提前 return 都会把
					// 正在跑的那一轮的标志清掉，于是第三轮会与第一轮**并发**执行。
					running = false;
				}
			} catch (error) {
				// 后台任务绝不能把异常抛给调用方（它跑在插件的生命周期里）
				report(error);
				return null;
			}
		},
	};
}
