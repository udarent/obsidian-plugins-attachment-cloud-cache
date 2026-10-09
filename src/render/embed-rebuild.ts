/**
 * **非图片**可预览附件（音频 / 视频 / PDF）的节点重建。
 *
 * ## 要解决的缺陷：宿主把远端嵌入渲染成了 `<img>`
 *
 * 笔记里写 `![doc.pdf](https://…)` 时，宿主的渲染结果是
 * **`<img src="https://…/doc.pdf">`** —— 元素类型本身就是错的（0-A 真机取证）。
 * 于是无论我们怎么改 `src`，用户都只会看到一个坏图：
 * 浏览器不会在 `<img>` 里播放音频、也不会用 pdf.js 打开 PDF。
 *
 * ⇒ 救不了 src，只能**重建节点**：用库内副本生成一条**库内**嵌入（`![[<副本>]]`），
 * 经宿主自己的 `MarkdownRenderer` 渲染成它本来该有的 `internal-embed` 节点，替换原节点。
 *
 * ## 为什么把"重建"而不是"改写 src"作为形态
 *
 * 图片只需要换地址（`<img>` 是对的）；音频/视频/PDF 需要换**元素**。
 * 判据落在**可嵌入类型表**上（`vault-files.ts`，与链接生成共用同一张表）：
 * - 表内且是图片 → 走原有的改 `src` 路径（零重建、最快）；
 * - 表内且非图片 → 走这里；
 * - 表外/未知 → 不重建（它本来就该是一条普通链接，宿主不会给它造 `<img>`）。
 *
 * ## 三条不能破的性质
 *
 * 1. **远端地址绝不写进元素**（离线零请求的来源）：实时预览那条路在赋值那一刻
 *    就发现"这该重建"，于是**根本不写 `src`**，元素保持空 src —— 一个字节的远端
 *    地址都不会进 DOM。阅读视图那条路把 `src` 写成 **`app://` 本地地址**，
 *    同样不是远端。
 * 2. **防递归**：重建出来的节点带着标记（{@link EMBED_MARK}），再扫一遍时直接跳过，
 *    否则 `MarkdownRenderer` 渲染出的 embed 会被我们当成"待重建"无限替换。
 * 3. **单点失败不能拖垮整批**：一个元素渲染失败就**保留原样**并记下来，
 *    其余照常处理（与站外图那条队列同一条纪律）。
 *
 * ## 为什么用"攒批 + 一个微任务"而不是 MutationObserver（实时预览）
 *
 * 与 `external-live.ts` 同一个理由：赋值那一刻元素常常还没连上文档，
 * 而**替换节点需要父节点**。实测（那边已经量过）一个微任务之后元素就已经在文档里、
 * 也能反查到所属笔记。所以这里沿用同一套调度，不引入观察器（少一个生命周期要管）。
 */

import type { CacheIndex } from "../cache/index";
import type { PluginSettings } from "../types";
import { embedKindFor, extensionOfName } from "../vault-files";
import type { EmbedKind } from "../vault-files";
import { decideRenderTarget } from "./render-target";
import type { RenderTarget } from "./render-target";

/** 重建出来的节点上的标记：值是类型（`audio`/`video`/`pdf`），也是**防递归**的凭据。 */
export const EMBED_MARK = "data-acc-embed";
/** 库内副本路径（重建时的输入）。 */
export const EMBED_PATH_ATTR = "data-acc-embed-path";
/** 归属笔记（阅读视图那条路直接给；实时预览那条路靠 DOM 反查）。 */
export const EMBED_SOURCE_ATTR = "data-acc-embed-source";

/**
 * 宿主渲染出来的节点。
 *
 * 形状收得极窄（只要是个对象）是刻意的：我们**只**把它交给 `replaceChild`，
 * 不读它的任何属性 —— 于是"宿主给的 DOM 长什么样"不会渗进这一层，
 * 假节点也就能像真节点一样拿来测。
 */
export type EmbedNode = object;

/** 重建时用得上的元素形状（结构化类型，便于用假元素穷举）。 */
export interface EmbedElementLike {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	/** 替换节点要用父节点 —— 元素还没进文档时它是 `null`（那时**不做**替换）。 */
	parentNode?: { replaceChild(newNode: unknown, oldNode: unknown): unknown } | null;
	addEventListener?(type: string, callback: () => void): void;
}

/** 容器的形状：只需要能查出元素。 */
export interface EmbedContainerLike {
	querySelectorAll?(selector: string): ArrayLike<EmbedElementLike>;
}

export interface EmbedRebuildDeps {
	settings: () => PluginSettings;
	index: () => CacheIndex;
	/** 库内路径 → 能放进 `src` 的地址（拿不到时返回 `null`）。 */
	resourceUrlFor: (vaultPath: string) => string | null;
	/**
	 * 把库内文件渲染成**嵌入节点**（宿主 API：`generateMarkdownLink` + `MarkdownRenderer`）。
	 * 拿不到节点时返回 `null`（那时**保留原元素**，绝不产出一个坏节点）。
	 */
	renderEmbed: (localPath: string, sourcePath: string | null) => Promise<EmbedNode | null>;
	/** 索引里没有副本时补齐（下载）。返回本地路径或 `null`。 */
	ensureLocalCopy?: (key: string, remoteUrl: string) => Promise<string | null>;
	/** 实时预览那条路靠它反查归属（与站外图共用同一份实现）。 */
	notePathFor?: (element: unknown) => string | null;
	/** 批次调度。默认**一个微任务**（理由见模块头注释）。注入是为了测试能同步驱动。 */
	schedule?: (flush: () => void) => void;
	onError?: (error: unknown) => void;
}

export interface EmbedRebuildQueue {
	/** 记下一个待重建的元素（**同步、绝不抛错**：它跑在图片赋值路径上）。 */
	see: (element: EmbedElementLike, localPath: string, sourcePath?: string | null) => void;
	/** 立刻处理攒下的（测试与卸载用）。 */
	flush: () => void;
	dispose: () => void;
	pending: () => number;
}

/**
 * 这个库内副本**需不需要重建节点**？返回要重建的类型，或 `null`（不需要）。
 *
 * 纯函数：判据只有"扩展名"一项，而它来自**同一张可嵌入类型表**（与链接生成共用）——
 * 于是"笔记里写 `![]()` 还是 `[]()`"与"渲染时换 src 还是换节点"**不可能分叉**，
 * 两者都是"宿主能不能预览它"的同一个事实。
 */
export function rebuildKindFor(localPath: unknown): EmbedKind | null {
	const kind = embedKindFor(extensionOfName(localPath));
	return kind && kind !== "image" ? kind : null;
}

/** 给元素打上"待重建"的标记（同步）。 */
export function markEmbedForRebuild(
	element: EmbedElementLike,
	localPath: string,
	sourcePath?: string | null
): void {
	const kind = rebuildKindFor(localPath);
	if (!kind) return;
	element.setAttribute(EMBED_MARK, kind);
	element.setAttribute(EMBED_PATH_ATTR, localPath);
	if (typeof sourcePath === "string" && sourcePath !== "") {
		element.setAttribute(EMBED_SOURCE_ATTR, sourcePath);
	}
}

/** 默认调度：一个微任务（为什么不是动画帧见模块头注释）。 */
function defaultSchedule(flush: () => void): void {
	if (typeof queueMicrotask === "function") {
		queueMicrotask(flush);
		return;
	}
	window.setTimeout(flush, 0);
}

export function createEmbedRebuildQueue(deps: EmbedRebuildDeps): EmbedRebuildQueue {
	const batch = new Set<EmbedElementLike>();
	let scheduled = false;
	let disposed = false;

	const report = (error: unknown): void => {
		try {
			deps.onError?.(error);
		} catch {
			// 连记录都失败就真的没什么可做的了 —— 但绝不能因此让渲染失败
		}
	};

	const flush = (): void => {
		scheduled = false;
		if (disposed || batch.size === 0) return;

		const candidates = [...batch];
		batch.clear();

		for (const element of candidates) {
			try {
				void rebuildOne(element, deps, report);
			} catch (error) {
				// 单个元素出问题不能拖垮这一批（还有别的元素等着）
				report(error);
			}
		}
	};

	const schedule = deps.schedule ?? defaultSchedule;

	return {
		see(element, localPath, sourcePath) {
			if (disposed || !element) return;
			try {
				markEmbedForRebuild(element, localPath, sourcePath);
			} catch (error) {
				report(error);
				return;
			}
			batch.add(element);
			if (scheduled) return;
			scheduled = true;
			try {
				schedule(flush);
			} catch (error) {
				// 排不上调度不能把标志留在"已排"状态 —— 那会让之后所有候补都进不来
				scheduled = false;
				report(error);
			}
		},
		flush,
		dispose() {
			disposed = true;
			batch.clear();
			scheduled = false;
		},
		pending: () => batch.size,
	};
}

/**
 * 重建一个元素（异步）：渲染嵌入节点 → 替换。
 *
 * ⚠️ 拿不到父节点就**不做任何事**（元素还没进文档）：保留标记，等下一轮
 * （编辑器重渲染会再走一遍赋值，或者下一次 flush 会带上它）。
 * 绝不"先把原元素删掉再插入"——那会出现"内容消失"的中间态。
 */
async function rebuildOne(element: EmbedElementLike, deps: EmbedRebuildDeps, report: (e: unknown) => void): Promise<void> {
	const path = element.getAttribute?.(EMBED_PATH_ATTR) ?? "";
	const sourcePath = element.getAttribute?.(EMBED_SOURCE_ATTR) ?? deps.notePathFor?.(element) ?? null;
	if (!path) return;

	let node: EmbedNode | null = null;
	try {
		node = await deps.renderEmbed(path, sourcePath);
	} catch (error) {
		report(error);
	}
	if (!node) return; // 渲染不出来就保留原元素（宁可显示得差一点，也不要空一格）

	const parent = element.parentNode;
	if (!parent || typeof parent.replaceChild !== "function") return;
	try {
		parent.replaceChild(node, element);
	} catch (error) {
		report(error);
	}
}

/**
 * 阅读视图（后处理器）那一趟：把属于本存储、且需要重建的元素标记好并交给队列。
 *
 * **同步** —— 与 `processImages` 同一个纪律：一旦 `await`，元素可能已经连上 DOM
 * 并开始加载远端地址。这里把它换成 `app://` 本地地址（**不是**远端），
 * 真正的节点替换在微任务里做（那时元素才有父节点）。
 */
export function processEmbeds(
	root: EmbedContainerLike | null | undefined,
	deps: EmbedRebuildDeps,
	sourcePath: string | null,
	queue: EmbedRebuildQueue
): number {
	const elements = root?.querySelectorAll?.("img");
	if (!elements) return 0;

	let taken = 0;
	for (let i = 0; i < elements.length; i += 1) {
		const element = elements[i];
		if (!element || typeof element.getAttribute !== "function") continue;
		// 已经是我们重建出来的节点 ⇒ 跳过（防递归）
		if (element.getAttribute(EMBED_MARK)) continue;

		const decision = decideRenderTarget({
			src: element.getAttribute("src"),
			settings: deps.settings(),
			index: deps.index(),
		});
		if (decision.action === "ignore") continue;

		if (decision.action === "local") {
			const kind = rebuildKindFor(decision.localPath);
			if (!kind) continue; // 图片走原有的改 src 路径
			const resourceUrl = deps.resourceUrlFor(decision.localPath);
			if (resourceUrl) element.setAttribute("src", resourceUrl);
			queue.see(element, decision.localPath, sourcePath);
			taken += 1;
			continue;
		}

		// 属于本存储但本地没有副本 → 先补齐，补上了再重建。
		// ⚠️ 这条**不**改 `src`：远端地址不写进元素，用户看到的是等待而不是一张坏图。
		if (deps.ensureLocalCopy) {
			void deps
				.ensureLocalCopy(decision.key, decision.remoteUrl)
				.then((local) => {
					if (!local || !rebuildKindFor(local)) return;
					queue.see(element, local, sourcePath);
				})
				.catch((error) => {
					// 补齐失败不是错误路径：那个位置本来就没有可显示的东西
					deps.onError?.(error);
				});
			taken += 1;
		}
	}

	return taken;
}

/** 判定结果里"要不要重建"的判据（导出给测试用；实现就是上面两条的组合）。 */
export function shouldRebuild(decision: RenderTarget): boolean {
	if (decision.action !== "local") return false;
	return rebuildKindFor(decision.localPath) !== null;
}
