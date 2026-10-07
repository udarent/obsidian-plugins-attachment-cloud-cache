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
 * ## ⭐ 两道门槛：把"读全库笔记"挡住
 *
 * 这条链上最贵的一步是**扫全库笔记**（判断哪些副本还被引用，见 `scanReferences`）。
 * 而"缓存有没有超上限"这件事可以先用两个便宜的信号判断：
 *
 * | 门槛 | 代价 | 挡掉的情形 |
 * |---|---|---|
 * | ① 索引里的字节之和 | 一次内存求和 | 绝大多数时候（没超） |
 * | ② 磁盘上的真实总量 | 列目录 + 逐个 stat | 索引记的比上限小、但磁盘上其实还多 |
 *
 * 只有两道都过了，才去扫笔记、才去动文件。
 *
 * ## 触发（由接线层决定，这一层只管"该不该跑"）
 *
 * | 触发 | 时机 | 为什么需要它 |
 * |---|---|---|
 * | `startup` | 加载后延迟一次 | 缓存可能在插件没运行时长大了；**这一轮不看索引**（见下） |
 * | `growth` | 每次上传/下载完成后 | 缓存长大的**真正原因**都在这里，反应最快 |
 * | `settings` | 保存设置后 | 用户刚把上限调小，想立刻看到效果 |
 * | `interval` | 周期性兜底 | 覆盖"非上传引起"的增长（回退下载、同步带来的新图） |
 *
 * ## ⚠️ `startup` 那一轮刻意不看索引
 *
 * 索引文件是**可能坏掉或丢掉**的（`loadCacheIndex` 遇到坏 JSON 就降级成空索引）。
 * 那时缓存目录里全是"孤儿"（磁盘上有、索引里没有），它们一样占着用户的磁盘 ——
 * 上限不能因为索引坏了就形同虚设。所以启动这一轮**直接量磁盘**。
 * 其余触发用索引做便宜门槛（它们发生得更频繁，值得省这一次列目录）。
 *
 * ## 安静是默认值
 *
 * 没超上限、没得可淘汰、刚淘汰过 —— 都不提示。这是一个后台保洁任务，
 * 它不该在用户读笔记的时候插嘴。只有**真的淘汰了东西**才说一句。
 */

import type { CacheIndex } from "../cache/index";
import type { PluginSettings } from "../types";
import type { DiskFile } from "./audit";
import {
	buildEvictionCandidates,
	formatMegabytes,
	megabytesToBytes,
	planEviction,
	sumIndexedBytes,
} from "./eviction";
import type { EvictionOutcome, EvictionPlan } from "./eviction";
import { deleteModeSuffix } from "./remove";

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
	/** 列缓存目录下的文件（接线层复用 `collectCacheFiles`）。 */
	collectFiles: () => Promise<DiskFile[]>;
	/** 扫全库笔记，收集仍被引用的 key（接线层复用 `scanReferences`）。 */
	scanReferencedKeys: () => Promise<Set<string>>;
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
	/** 量到的缓存占用。 */
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
	const announce = (outcome: EvictionOutcome, overBy: number, settings: PluginSettings): void => {
		try {
			const mb = formatMegabytes(outcome.freed);
			// ⚠️ 文案按"删除方式"二选一（后缀与"实际用了哪个 API"同源，不会分叉）：
			// 说"移入了回收站"而其实已删除 ⇒ 用户会去回收站里找一个不在那儿的文件。
			const suffix = deleteModeSuffix(settings.deleteMode);
			if (overBy > 0) {
				deps.notify(
					deps.t(`cacheEvictedPartial_${suffix}`, {
						mb,
						count: outcome.evicted,
						overMb: formatMegabytes(overBy),
					})
				);
			} else {
				deps.notify(deps.t(`cacheEvicted_${suffix}`, { mb, count: outcome.evicted }));
			}
		} catch (error) {
			report(error);
		}
	};

	async function rotate(
		reason: RotationReason,
		settings: PluginSettings,
		limitBytes: number,
		at: number
	): Promise<RotationSummary> {
		const files = await deps.collectFiles();
		const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.bytes), 0);
		// 磁盘上其实没超 → 连笔记都不用扫（那是这条链上最贵的一步）
		if (totalBytes <= limitBytes) {
			return { reason, totalBytes, limitBytes, evicted: 0, freed: 0, skipped: 0, overBy: 0 };
		}

		const referencedKeys = await deps.scanReferencedKeys();
		const candidates = buildEvictionCandidates({
			entries: deps.index().toArray(),
			files,
			referencedKeys,
			cacheFolder: settings.cacheFolder,
		});
		const plan = planEviction({ candidates, totalBytes, limitBytes, now: at, graceMs: deps.graceMs });

		// 一份都挑不出来（例如全在宽限期内）→ 不动手，也不打扰
		const outcome: EvictionOutcome =
			plan.evict.length > 0 ? await deps.evict(plan) : { evicted: 0, freed: 0, skipped: [] };

		// ⚠️ "还超多少"要用**实际**回收量算，而不是计划里的数字：
		// 执行时可能有文件被跳过（宿主索引滞后），那时真实的超出量更大。
		// 报小了会让用户以为上限已经生效。
		const overBy = Math.max(0, totalBytes - outcome.freed - limitBytes);
		if (outcome.evicted > 0) announce(outcome, overBy, settings);

		return {
			reason,
			totalBytes,
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

				// 门槛 ①（**便宜**）：索引里记的字节。启动那一轮跳过它，理由见模块头注释。
				if (
					reason !== "startup" &&
					sumIndexedBytes(deps.index().toArray(), settings.cacheFolder) <= limitBytes
				) {
					return null;
				}

				const at = now();
				if (!isRotationDue({ now: at, lastRunAt, minIntervalMs })) return null;

				running = true;
				lastRunAt = at;
				try {
					return await rotate(reason, settings, limitBytes, at);
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
