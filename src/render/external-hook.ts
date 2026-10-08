/**
 * 站外缓存的**编排**：走查渲染出来的图片、按站点去重、调询问、触发执行。
 *
 * ## ⚠️ 这一层存在的唯一理由：**渲染会反复跑**
 *
 * 后处理器不是"每篇笔记跑一次"，而是**每次重新渲染都跑**（滚动、切视图、
 * 编辑后重渲染、打开同一篇笔记……）。于是"问用户一次"这件事如果放在这里不加记忆，
 * 用户会被同一个站点反复打扰，而且每次都是同一个问题。
 *
 * 所以这里挂**两张表**，去重范围 = 一个插件实例（与 `createLocalCopyEnsurer`
 * 的 `inflight` 同一条纪律）：
 *
 * | 表 | 防的是什么 |
 * |---|---|
 * | `asking` | 同一站点**正在问**（还没答复）时再次渲染 → 直接跳过（**同站多张图只弹一个**） |
 * | `inflight` | 同一 URL 正在下载/上传时再次渲染 → 不重复发起（失败也摘除） |
 *
 * ## ⚠️ 这里曾经还有第三张表 `asked`（"问过就记住"）—— 它多余而且有害
 *
 * - **多余**：答复之后抑制重复询问的依据是**记忆本身**
 *   （deny → `ignore`、allow → `cache`），而"还没答复"那段窗口由 `asking` 挡着。
 *   那张表能覆盖的两段，都已经被覆盖了。
 * - **有害**：它是**永久**的。于是用户在设置页点「清除站点记忆」之后**不会重新询问**
 *   —— 被清掉的记忆不再是唯一的真相来源，用户唯一的办法是重启 Obsidian。
 *   实测踩到：用户报"清除站点记忆以后，也没有再次询问图片是否上传"。
 *
 * ⇒ 可复用判据：**能被用户清掉的状态，必须是唯一的**。
 * 多存一份清不掉的副本，就等于让那个"清除"按钮只在重启后才生效。
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
	/**
	 * 正在问的站点 → 那个还没落地的 Promise。
	 *
	 * ⚠️ 它只覆盖"**还没答复**"这段窗口，答复一落地就摘除。
	 * 答复之后的抑制全靠记忆（用户可以清空它）—— 见模块头注释里
	 * 关于那张被删掉的 `asked` 表的说明。
	 */
	const asking = new Map<string, Promise<ExternalAskChoice>>();
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
		const pending = deps
			.ask({ host, url })
			.then((choice): ExternalAskChoice => choice)
			.catch((error): ExternalAskChoice => {
				// 询问本身失败（UI 出问题）→ 当作"别问了"，绝不当成"同意"
				report(error);
				return "never";
			});

		// ⚠️ 同步入表（在返回之前）：`process` 同一次调用里的**后续图片**就靠它跳过。
		// 这一步不能挪到 then 里 —— 那会在同一次渲染里对同一站点弹出多个询问。
		asking.set(host, pending);
		void pending
			.then((choice) => {
				// 先记住决定（同步写内存），再按决定执行 —— 顺序反过来的话，
				// 紧接着的一次渲染会读到一个还没写下的记忆，于是**再问一遍**。
				deps.remember(host, choice === "cache" ? "allow" : "deny");
				if (choice === "cache") enqueue(url, notePath);
			})
			.catch(report)
			// ⚠️ 必须摘除：留着它就等于"问过就永久记住"，清空记忆也不会再问（见模块头注释）
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

					// ask：同站只问一次（**正在问**的才算，答复之后由记忆决定不再问）
					if (asking.has(decision.host)) {
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
