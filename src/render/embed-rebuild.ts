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
import type { AccessProbe } from "../link-access";
import { usesSignedUrls } from "../link-access";
import { decideRenderTarget } from "./render-target";
import type { RenderTarget } from "./render-target";

/** 重建出来的节点上的标记：值是类型（`audio`/`video`/`pdf`），也是**防递归**的凭据。 */
export const EMBED_MARK = "data-acc-embed";
/** 库内副本路径（重建时的输入）。 */
export const EMBED_PATH_ATTR = "data-acc-embed-path";
/** 归属笔记（阅读视图那条路直接给；实时预览那条路靠 DOM 反查）。 */
export const EMBED_SOURCE_ATTR = "data-acc-embed-source";
/**
 * 这一格要走**预签名地址**（而不是库内副本）。
 *
 * 值是 `"1"`；要签的 **key** 放在 {@link EMBED_PATH_ATTR} 里（复用同一个属性，
 * 因为它本来就是"重建用的那个地址/身份"）。
 *
 * 为什么需要它：私有存储 + 不留副本时，音频/视频**没有本地文件**可用，
 * 但我们仍然能造出 `<video>`/`<audio>` 并指向一条临时可用的地址 —— **真机量过能播**
 *（`loadeddata` 64 ms、640×360、`play()` 后 `currentTime` 正常前进）：宿主的 webview 认这条地址，
 * 它只是**不肯**把远端 `![]()` 渲染成 `<video>` 而已。
 */
export const EMBED_SIGNED_ATTR = "data-acc-embed-signed";
/**
 * 这一格走**直连**（公开读取 + 不留副本）：不签名、不落盘，`src` 就是笔记里那条远端地址。
 *
 * 与 {@link EMBED_SIGNED_ATTR} 是**互斥的两种来路**：私有桶要签名（否则 403），
 * 公开桶不用（签了只是多一个过期窗口）。地址存在 {@link EMBED_URL_ATTR} 里。
 */
export const EMBED_DIRECT_ATTR = "data-acc-embed-direct";
/** 直连时要用的那条地址（只有 {@link EMBED_DIRECT_ATTR} 为 `"1"` 时才有意义）。 */
export const EMBED_URL_ATTR = "data-acc-embed-url";

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
	/**
	 * 当前的**匿名可达性探测结果** —— 只用来判"缺副本的这一格要不要改走预签名"。
	 * 判据在 `link-access.ts`，这里只消费。
	 */
	accessProbe?: () => AccessProbe;
	/**
	 * 私有存储 + 不留副本时，一条**预签名地址**（失败返回 `null`）。
	 *
	 * ⚠️ 与 `render-hook` 的 `signedUrlFor` 是**同一个实现**（`main.ts` 里注入同一份），
	 * 缓存也在那一层 —— 这里再签一次会让同一张图拿到两条不同的地址。
	 */
	signedUrlFor?: (key: string) => Promise<string | null>;
	/**
	 * 造一个媒体节点（`<video>`/`<audio>`）—— DOM 构造留在接线层。
	 *
	 * 为什么不让这一层自己 `document.createElement`：这一层是**纯逻辑**（可用假元素穷举），
	 * 而"宿主窗口里的元素怎么造"属于接线知识（设置界面还是独立窗口）。
	 */
	createMediaNode?: (kind: "audio" | "video", url: string) => EmbedNode | null;
	/** 实时预览那条路靠它反查归属（与站外图共用同一份实现）。 */
	notePathFor?: (element: unknown) => string | null;
	/** 批次调度。默认**一个微任务**（理由见模块头注释）。注入是为了测试能同步驱动。 */
	schedule?: (flush: () => void) => void;
	onError?: (error: unknown) => void;
}

export interface EmbedRebuildQueue {
	/** 记下一个待重建的元素（**同步、绝不抛错**：它跑在图片赋值路径上）。 */
	see: (element: EmbedElementLike, localPath: string, sourcePath?: string | null) => void;
	/**
	 * 同上，但这一格要换成**预签名地址**（私有存储 + 不留副本：没有本地文件可用）。
	 *
	 * 只接受音频/视频（`signedMediaKindFor`）；PDF 不在其列 —— 它要靠 pdf.js +
	 * 一个**库内路径**（签名地址喂不进去），所以"不留副本"时 PDF 仍显示不出来。
	 */
	seeSigned: (element: EmbedElementLike, key: string, sourcePath?: string | null) => void;
	/**
	 * 同上，但**不签名**：公开读取 + 不留副本时，直接用笔记里那条远端地址造节点。
	 *
	 * ⚠️ 这条来路是「公开桶 + 图床式」的**唯一**显示方式：公开桶的字节谁都取得到，
	 * 但宿主的 `<img>` 播不了视频 —— 不自己造节点，那一格一帧都放不出来。
	 */
	seeDirect: (element: EmbedElementLike, key: string, url: string, sourcePath?: string | null) => void;
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

	/**
	 * 把"下一帧跑一次 flush"这件事**只写一遍**。
	 *
	 * 三条入队来路（库内副本 / 预签名 / 直连）共用它：排不上调度时不能把 `scheduled`
	 * 留在"已排"状态 —— 那会让之后所有候补都进不来，而现象只是"有的图不刷新"。
	 */
	const enqueueFlush = (): void => {
		if (scheduled) return;
		scheduled = true;
		try {
			schedule(flush);
		} catch (error) {
			scheduled = false;
			report(error);
		}
	};

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
			enqueueFlush();
		},
		seeSigned(element, key, sourcePath) {
			if (disposed || !element) return;
			// 只认音频/视频（PDF 救不了，见 `signedMediaKindFor`）——
			// 在这里再判一次是刻意的：`seeSigned` 的调用点将来可能不止一个。
			if (!signedMediaKindFor(key)) return;
			try {
				element.setAttribute(EMBED_MARK, signedMediaKindFor(key) ?? "media");
				element.setAttribute(EMBED_PATH_ATTR, key);
				element.setAttribute(EMBED_SIGNED_ATTR, "1");
				if (typeof sourcePath === "string" && sourcePath !== "") {
					element.setAttribute(EMBED_SOURCE_ATTR, sourcePath);
				}
			} catch (error) {
				report(error);
				return;
			}
			batch.add(element);
			enqueueFlush();
		},
		seeDirect(element, key, url, sourcePath) {
			if (disposed || !element) return;
			// 与 `seeSigned` 同一条纪律：只认音频/视频；PDF 救不了（它要 pdf.js + 库内路径）。
			const kind = signedMediaKindFor(key);
			if (!kind || !url) return;
			try {
				element.setAttribute(EMBED_MARK, kind);
				element.setAttribute(EMBED_PATH_ATTR, key);
				element.setAttribute(EMBED_DIRECT_ATTR, "1");
				element.setAttribute(EMBED_URL_ATTR, url);
				if (typeof sourcePath === "string" && sourcePath !== "") {
					element.setAttribute(EMBED_SOURCE_ATTR, sourcePath);
				}
			} catch (error) {
				report(error);
				return;
			}
			batch.add(element);
			enqueueFlush();
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
 * "这一格能不能用**预签名地址**救"—— 音频/视频可以，PDF 不行。
 *
 * PDF 要靠 pdf.js 打开、而 pdf.js 只吃**库内路径**（`revealFile` / 应用内查看器）；
 * 给它一条远端签名地址在宿主里没有对应实现（远端 `![]()` 本来就只是一张 `<img>`）。
 * ⇒ 私有 + 不留副本时 PDF 仍然显示不出来，要它可用就得保留本地副本（这是那条边界本身，
 * 不是缺陷：不造一个播不了的东西，比造了再坏更好）。
 */
export function signedMediaKindFor(key: unknown): "audio" | "video" | null {
	const kind = rebuildKindFor(key);
	return kind === "audio" || kind === "video" ? kind : null;
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

	const signed = element.getAttribute?.(EMBED_SIGNED_ATTR) === "1";
	const direct = element.getAttribute?.(EMBED_DIRECT_ATTR) === "1";
	let node: EmbedNode | null = null;
	try {
		if (direct) {
			// 公开读 + 不留副本：地址就是笔记里那条（不签名）。类型只认音频/视频，
			// PDF 与其它类型**保留原元素**（与 `seeDirect` 的判据同源）。
			const kind = signedMediaKindFor(path);
			const url = element.getAttribute?.(EMBED_URL_ATTR) ?? "";
			if (!kind || !url || !deps.createMediaNode) return;
			node = deps.createMediaNode(kind, url);
		} else if (signed) {
			// 预签名那条路：`path` 里装的是 **key**（没有本地文件）
			const kind = signedMediaKindFor(path);
			if (!kind || !deps.signedUrlFor || !deps.createMediaNode) return;
			const url = await deps.signedUrlFor(path);
			// 签不出来就**保留原元素**（宁可显示得差一点，也不要空一格）——
			// 与"渲染不出来"同一个处置，也与 `deferSignedUrl` 在图片那条路上的处置一致。
			if (!url) return;
			node = deps.createMediaNode(kind, url);
		} else {
			node = await deps.renderEmbed(path, sourcePath);
		}
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

		const settings = deps.settings();
		const decision = decideRenderTarget({
			src: element.getAttribute("src"),
			settings,
			index: deps.index(),
			// 判据只在 `link-access.ts` 一处（与图片那条路共用同一个函数）
			useSignedUrls: usesSignedUrls(settings, deps.accessProbe?.()),
		});
		if (decision.action === "ignore") continue;

		// ⭐ 私有存储 + 不留副本：音频/视频改走**预签名地址**（自建节点），PDF 跳过。
		// 这条路不取字节、不落盘 —— 与图片那条路是同一条访问方式判定的产物。
		if (decision.action === "signed") {
			if (!signedMediaKindFor(decision.key)) continue; // 图片由 `render-hook` 改 `src`
			if (!deps.signedUrlFor || !deps.createMediaNode) continue;
			queue.seeSigned(element, decision.key, sourcePath);
			taken += 1;
			continue;
		}

		// ⭐ 公开读 + 不留副本：不签名，直接用远端地址造节点（同样只认音频/视频）。
		if (decision.action === "direct") {
			if (!signedMediaKindFor(decision.key)) continue;
			if (!deps.createMediaNode) continue;
			queue.seeDirect(element, decision.key, decision.remoteUrl, sourcePath);
			taken += 1;
			continue;
		}

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
