/**
 * 站外缓存的**编排**：走查渲染出来的图片、按站点去重、调询问、触发执行。
 *
 * ## ⚠️ 这一层存在的唯一理由：**渲染会反复跑**
 *
 * 后处理器不是"每篇笔记跑一次"，而是**每次重新渲染都跑**（滚动、切视图、
 * 编辑后重渲染、打开同一篇笔记……）。于是"问用户一次"这件事如果放在这里不加记忆，
 * 用户会被同一个站点反复打扰，而且每次都是同一个问题。
 *
 * 所以这里挂**三张表**，去重范围 = 一个插件实例（与 `createLocalCopyEnsurer`
 * 的 `inflight` 同一条纪律）：
 *
 * | 表 | 防的是什么 |
 * |---|---|
 * | `asking` | 同一站点**正在问**时再次渲染 → 复用同一个 Promise，不再弹 |
 * | `asked` | 问过但还没答复期间再次渲染 → 直接跳过（**同站多张图只弹一个**） |
 * | `inflight` | 同一 URL 正在下载/上传时再次渲染 → 不重复发起（失败也摘除） |
 *
 * ## 为什么没有笔记路径就什么都不做
 *
 * 这条链路的产出是"**改写笔记里的链接**"。拿不到笔记路径（`ctx.sourcePath` 缺失）
 * 就改不了，那样"缓存了但链接没改"是彻底的半成品 —— 图进了存储、笔记没变、
 * 而站点记忆已经记成 allow，下次不会再问。**宁可不做。**
 *
 * 这也是 `ask` 与 `cache` 都被这条前置检查挡住的理由：两者都需要改写。
 */

import type { PluginSettings } from "../types";
import { decideExternalCache } from "./external-decide";
import type { SiteDecision, SiteDecisions } from "./site-decisions";

/** 用户在询问里的选择。 */
export type ExternalAskChoice =
	/** 缓存这张图，并记住这个站点。 */
	| "cache"
	/** 这个站点以后都不要问。 */
	| "never";

export interface ExternalAskInfo {
	host: string;
	url: string;
}

/** 只用到 `getAttribute` —— 抽出来是为了让编排能在假 DOM 上穷举。 */
export interface ImageElementLike {
	getAttribute?: (name: string) => string | null;
}

/** 只用到 `querySelectorAll`。 */
export interface ImageContainerLike {
	querySelectorAll?: (selector: string) => ArrayLike<ImageElementLike> | null;
}

/** 渲染上下文里我们用得上的那一项。 */
export interface RenderContextLike {
	sourcePath?: string;
}

export interface ExternalHookDeps {
	settings: () => PluginSettings;
	/** 现取记忆（`load()` 之后对象会换，不能抓快照）。 */
	decisions: () => SiteDecisions;
	/** 存储是否已配好（调用方同步算好）。 */
	configured: () => boolean;
	/** 询问接缝 —— UI 注入；测试可替换（否则这条路径测不到）。 */
	ask: (info: ExternalAskInfo) => Promise<ExternalAskChoice>;
	/** 记下这个站点的决定（写内存 + 落盘）。 */
	remember: (host: string, decision: SiteDecision) => void;
	/** 执行"下载 → 上传 → 改写"。**不应抛错**（调用方按 fire-and-forget 用）。 */
	cache: (url: string, notePath: string) => Promise<unknown>;
	blockedHost?: (host: string) => boolean;
	/** 出错的记录口（默认静默 —— 渲染路径上抛错会毁掉整篇笔记的渲染）。 */
	onError?: (error: unknown) => void;
}

export interface ExternalHookResult {
	/** 容器里看到的 `<img>` 数。 */
	found: number;
	/** 本次新发起的询问数。 */
	asked: number;
	/** 本次发起的缓存数。 */
	queued: number;
	/** 未处理（不是站外的、已有记忆、或正在处理中）数。 */
	skipped: number;
}

export interface ExternalHook {
	process: (root: ImageContainerLike | null | undefined, ctx: RenderContextLike | null | undefined) => ExternalHookResult;
}

export function createExternalHook(deps: ExternalHookDeps): ExternalHook {
	/** 正在问的站点 → Promise（再次渲染时复用它，而不是再弹一个）。 */
	const asking = new Map<string, Promise<ExternalAskChoice>>();
	/** 已经问过（还没答复）的站点 —— 同站多张图只弹一个。 */
	const asked = new Set<string>();
	/** 正在下载/上传的 URL。 */
	const inflight = new Set<string>();

	const report = (error: unknown): void => {
		try {
			deps.onError?.(error);
		} catch {
			// 连记录都失败就真的没什么可做的了 —— 但绝不能因此让渲染失败
		}
	};

	const enqueue = (url: string, notePath: string): boolean => {
		if (inflight.has(url)) return false;
		inflight.add(url);
		// ⚠️ `finally` 而不是 `then`：**失败也必须摘除**，否则那个 URL 会被永久卡住
		// （用户重试也会被静默忽略）。与 `download.ts` 的 `inflight` 同一条纪律。
		void Promise.resolve(deps.cache(url, notePath))
			.catch(report)
			.finally(() => inflight.delete(url));
		return true;
	};

	const startAsking = (host: string, url: string, notePath: string): void => {
		asked.add(host);
		const pending = deps
			.ask({ host, url })
			.then((choice): ExternalAskChoice => choice)
			.catch((error): ExternalAskChoice => {
				// 询问本身失败（UI 出问题）→ 当作"别问了"，绝不当成"同意"
				report(error);
				return "never";
			});

		asking.set(host, pending);
		void pending
			.then((choice) => {
				// 先记住决定（同步写内存），再按决定执行 —— 顺序反过来的话，
				// 紧接着的一次渲染会读到一个还没写下的记忆，于是**再问一遍**。
				deps.remember(host, choice === "cache" ? "allow" : "deny");
				if (choice === "cache") enqueue(url, notePath);
			})
			.catch(report)
			.finally(() => asking.delete(host));
	};

	return {
		process(root, ctx) {
			const empty: ExternalHookResult = { found: 0, asked: 0, queued: 0, skipped: 0 };
			const images = root?.querySelectorAll?.("img");
			if (!images) return empty;

			const list = Array.from(images);
			const result: ExternalHookResult = { found: list.length, asked: 0, queued: 0, skipped: 0 };

			// 没有笔记路径就什么都不做：这条链路的产出是改写笔记，改不了就不该开工
			const notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";
			if (!notePath) {
				result.skipped = list.length;
				return result;
			}

			const settings = deps.settings();
			const decisions = deps.decisions();
			// 配置状态只算一次：它在一次渲染里不会变，而每个 `<img>` 都算一遍纯属浪费
			const configured = deps.configured();

			for (const image of list) {
				try {
					const src = image?.getAttribute?.("src");
					const decision = decideExternalCache({
						src,
						settings,
						decisions,
						configured,
						blockedHost: deps.blockedHost,
					});

					if (decision.action === "ignore") {
						result.skipped += 1;
						continue;
					}

					const url = String(src).trim();

					if (decision.action === "cache") {
						if (enqueue(url, notePath)) result.queued += 1;
						else result.skipped += 1;
						continue;
					}

					// ask：同站只问一次（正在问的也复用，不再弹第二个）
					if (asked.has(decision.host) || asking.has(decision.host)) {
						result.skipped += 1;
						continue;
					}
					startAsking(decision.host, url, notePath);
					result.asked += 1;
				} catch (error) {
					// 单张图出问题不能拖垮整次渲染（还有别的图要处理）
					report(error);
					result.skipped += 1;
				}
			}

			return result;
		},
	};
}
