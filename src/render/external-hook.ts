/**
 * 站外缓存的**编排**：走查渲染出来的图片、按 URL 去重、触发执行。
 *
 * ## 这一层存在的唯一理由：**渲染会反复跑**
 *
 * 后处理器不是"每篇笔记跑一次"，而是**每次重新渲染都跑**（滚动、切视图、
 * 编辑后重渲染、打开同一篇笔记……）。而"下载 → 上传 → 改写链接"是一轮**真的网络动作
 * 加一次真的文件写入**，所以必须有张"正在处理中"的表，否则同一张图会被反复搬运。
 *
 * | 表 | 防的是什么 |
 * |---|---|
 * | `inflight` | 同一 URL 正在下载/上传时再次渲染 → 不重复发起（**失败也摘除**，否则重试会被静默忽略） |
 *
 * ## ⚠️ 这里曾经有一整套「按站点询问」—— 已整条拆掉
 *
 * 原先的流程是：遇到站外图 → 按站点弹一个常驻通知 → 用户答"缓存 / 不再询问" →
 * 把答案记进 `.site-decisions.json`。它被换成了**两件用户能预期的事**：
 * 设置里的默认行为（`externalImageDefault`），以及「选择要缓存的外链图片」里逐张勾选。
 * 拆掉的理由有两条，都来自实际使用：
 *
 * - 询问出现在**阅读**路径上，而"要不要把这张图搬进我的存储"并不紧急，
 *   却要求用户当时就答（通知还是常驻的，不点就一直挂着）；
 * - 它记的是**站点**，于是"这个站点别的图都要，就这一张不要"根本表达不出来。
 *
 * ⭐ 那段历史留下的可复用判据仍然有效：**能被用户清掉的状态，必须是唯一的**。
 * 现在"用户想要什么"只有两个来源（设置 + 勾选清单），没有第三条"我记住他说过什么" ——
 * 于是也不存在"清不掉的副本"（当年的症状：设置页点了「清除记忆」却不生效，
 * 因为编排层自己也留了一份，用户只能靠重启 Obsidian）。
 *
 * ## 为什么没有笔记路径就什么都不做
 *
 * 这条链路的产出是"**改写笔记里的链接**"。拿不到笔记路径（`ctx.sourcePath` 缺失）
 * 就改不了，那样"缓存了但链接没改"是彻底的半成品 —— 图进了存储、笔记却仍指着别人的服务器，
 * 而且不会有任何提示。**宁可不做。**
 */

import type { PluginSettings } from "../types";
import { decideExternalCache } from "./external-decide";

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
	/** 存储是否已配好（调用方**同步**算好 —— 判定层是同步的）。 */
	configured: () => boolean;
	/** 执行"下载 → 上传 → 改写"。**不应抛错**（调用方按 fire-and-forget 用）。 */
	cache: (url: string, notePath: string) => Promise<unknown>;
	blockedHost?: (host: string) => boolean;
	/** 出错的记录口（默认静默 —— 渲染路径上抛错会毁掉整篇笔记的渲染）。 */
	onError?: (error: unknown) => void;
}

export interface ExternalHookResult {
	/** 容器里看到的 `<img>` 数。 */
	found: number;
	/** 本次发起的缓存数。 */
	queued: number;
	/** 未处理（不是站外的、默认不动手的、或正在处理中）数。 */
	skipped: number;
}

export interface ExternalHook {
	process: (root: ImageContainerLike | null | undefined, ctx: RenderContextLike | null | undefined) => ExternalHookResult;
}

export function createExternalHook(deps: ExternalHookDeps): ExternalHook {
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

	return {
		process(root, ctx) {
			const empty: ExternalHookResult = { found: 0, queued: 0, skipped: 0 };
			const images = root?.querySelectorAll?.("img");
			if (!images) return empty;

			const list = Array.from(images);
			const result: ExternalHookResult = { found: list.length, queued: 0, skipped: 0 };

			// 没有笔记路径就什么都不做：这条链路的产出是改写笔记，改不了就不该开工
			const notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";
			if (!notePath) {
				result.skipped = list.length;
				return result;
			}

			const settings = deps.settings();
			// 配置状态只算一次：它在一次渲染里不会变，而每个 `<img>` 都算一遍纯属浪费
			const configured = deps.configured();

			for (const image of list) {
				try {
					const src = image?.getAttribute?.("src");
					const decision = decideExternalCache({
						src,
						settings,
						configured,
						blockedHost: deps.blockedHost,
					});

					// `wait`（默认不动手）与 `ignore`（不该处理）在这里是一条路：
					// 渲染路径**只**执行"现在就该搬"这一个决定。
					// 但两者的语义不同（`wait` 会被命令与选择器收作候选），所以判定层分开表达。
					if (decision.action !== "cache") {
						result.skipped += 1;
						continue;
					}

					const url = typeof src === "string" ? src.trim() : "";
					if (enqueue(url, notePath)) result.queued += 1;
					else result.skipped += 1;
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
