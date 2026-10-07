/**
 * 渲染钩子的 DOM 部分：把判定结果**落到元素上**。
 *
 * ## 两条路径，一个判定
 *
 * | 路径 | 手段 | 覆盖 |
 * |---|---|---|
 * | 阅读视图（阅读模式、导出、任何走 markdown 渲染的地方） | `registerMarkdownPostProcessor` | 确定性：在处理函数里改完，元素才进 DOM |
 * | **实时预览**（Live Preview，编辑态） | 拦截 `HTMLImageElement.prototype.src` 的 setter | 兜底：那一层的 `<img>` 是编辑器自己造的，公开 API 里没有对应钩子 |
 *
 * 为什么必须两条都做：**阅读视图是离线阅读的主路径，而编辑态是用户待得最久的地方**。
 * 只做前者，用户在离线时编辑笔记会看到一堆破图；只做后者，导出的 HTML 与阅读模式不受益。
 *
 * ## ⚠️ 为什么是"拦 prototype 的 setter"而不是 MutationObserver
 *
 * 观察 DOM 变更的问题在**时机**：`<img src="https://…">` 一旦插入文档，
 * 浏览器就可能已经开始加载；等你收到变更通知再改 `src`，请求已经发出 ——
 * "断网零请求"就守不住了（而且是否抢在加载前，取决于浏览器内部调度，**没有保证**）。
 *
 * 而 setter 拦截是**确定性**的：远端地址根本没被赋进去，请求不可能发出。
 * `this` 就是那个元素，所以要做兜底（本地文件失效时退回远端）也有地方挂监听器。
 *
 * ## 为什么不需要判断"这个元素在编辑器里"
 *
 * 一开始想按 `.cm-editor` 限定范围，但那**不可靠**：编辑器的小部件常常先离屏创建、
 * 设置好 `src` 再插入，那一刻 `closest(".cm-editor")` 是 `null`，拦截就失效了 ——
 * 恰好在最常见的路径上失效。
 *
 * 而真实的限定条件本来就不需要 DOM 位置：**只有"属于本存储、且本地确实有副本"的
 * URL 才会被改写**。任一张满足这个条件的图，用本地副本都是对的 —— 无论它出现在
 * 阅读视图、实时预览还是别的地方。判定（`decideRenderTarget`）本身已经足够窄。
 *
 * ## 失败要能退回
 *
 * 索引可能指向一个已被删掉的缓存文件（SCOPE 承诺"缓存目录可随时删除"）。
 * 那时 `<img>` 会加载失败 —— 所以两条路径都要挂一个 **error 兜底**：
 * 先尝试补齐本地副本（下载），补不上就把远端地址**放回去**，
 * 让在线用户仍然看得到图。否则删除缓存目录就等于"所有图片都坏了"。
 */

import type { PluginSettings } from "../types";
import type { CacheIndex } from "../cache/index";
import { decideRenderTarget } from "./render-target";

/** `<img>` 的最小形状（结构化类型，便于用假元素穷举）。 */
export interface ImageElementLike {
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	addEventListener?(type: string, callback: () => void): void;
}

/** 容器的形状：只需要能查出里面的图片。 */
export interface ImageContainerLike {
	querySelectorAll?(selector: string): ArrayLike<ImageElementLike>;
}

export interface RenderHookDeps {
	settings: () => PluginSettings;
	index: () => CacheIndex;
	/**
	 * vault 相对路径 → 能直接放进 `src` 的地址。
	 * 拿不到时返回 `null`（此时**不改**这个元素，而不是改成一个坏地址）。
	 */
	resourceUrlFor: (vaultPath: string) => string | null;
	/**
	 * 属于本存储但本地没有副本 → 补齐（下载）。返回本地路径或 `null`。
	 * 不提供时"缺副本"的图保持远端地址（在线可用，离线不可用）。
	 */
	ensureLocalCopy?: (key: string, remoteUrl: string) => Promise<string | null>;
	/** 发现索引指向的本地副本其实不存在 —— 交给调用方自愈。 */
	onLocalCopyMissing?: (key: string) => void;
	/**
	 * 这份本地副本**刚被真的用上**（`src` 已经指向它）。
	 *
	 * 存在的唯一目的是给**缓存上限的轮换**排序：淘汰时按"最久没用过"先走，
	 * 而不是按"最早上传"（见 `maintenance/eviction.ts`）。
	 *
	 * ⚠️ 它会被**高频**调用（一屏几十张图、滚动一次再来一轮），
	 * 所以实现里绝不能有 I/O —— 接线层只改内存，落盘是防抖的
	 * （见 `host/runtime.ts` 的 `IndexStore.touch`）。
	 */
	onLocalCopyUsed?: (key: string) => void;
	/** 用户可见提示（可选）。 */
	notify?: (message: string) => void;
}

export interface ProcessImagesResult {
	/** 改成用本地副本的数量。 */
	local: number;
	/** 属于本存储但本地没有、已交给补齐流程的数量。 */
	deferred: number;
}

/** 记录每个元素上我们挂过的兜底信息，避免重复挂监听器。 */
interface Fallback {
	remoteUrl: string;
	localPath: string;
	key: string;
	/** 是否已经挂过 error 兜底（实时预览路径用）。 */
	wired?: boolean;
}

/**
 * 走查一个已渲染的元素，把属于本存储的图片换成本地副本。
 *
 * **同步**：不 `await` 任何东西 —— 理由见模块头注释（异步开一个口子，
 * 元素就可能已经连上 DOM 并开始加载远端图片）。
 */
export function processImages(
	root: ImageContainerLike | null | undefined,
	deps: RenderHookDeps,
	fallbacks: WeakMap<ImageElementLike, Fallback> = new WeakMap()
): ProcessImagesResult {
	const result: ProcessImagesResult = { local: 0, deferred: 0 };
	const images = root?.querySelectorAll?.("img");
	if (!images) return result;

	for (let i = 0; i < images.length; i += 1) {
		const img = images[i];
		if (!img || typeof img.getAttribute !== "function") continue;

		const decision = decideRenderTarget({
			src: img.getAttribute("src"),
			settings: deps.settings(),
			index: deps.index(),
		});

		if (decision.action === "ignore") continue;

		if (decision.action === "local") {
			const resourceUrl = deps.resourceUrlFor(decision.localPath);
			if (!resourceUrl) continue; // 拿不到可用地址 → 保持原样，别改成坏链接
			wireFallback(img, deps, fallbacks, {
				remoteUrl: decision.remoteUrl,
				localPath: decision.localPath,
				key: decision.key,
			});
			img.setAttribute("src", resourceUrl);
			result.local += 1;
			// 记下"这张图刚被看到" —— 缓存轮换靠它区分"常看"与"早就没人看"
			deps.onLocalCopyUsed?.(decision.key);
			continue;
		}

		// 属于本存储但本地没有副本 → 异步补齐，补上了再换
		if (deps.ensureLocalCopy) {
			result.deferred += 1;
			void deps
				.ensureLocalCopy(decision.key, decision.remoteUrl)
				.then((localPath) => {
					if (!localPath) return;
					const resourceUrl = deps.resourceUrlFor(localPath);
					if (!resourceUrl) return;
					img.setAttribute("src", resourceUrl);
				})
				.catch(() => {
					// 补齐失败不是错误路径：图仍然按远端地址显示着（在线可见）。
				});
		}
	}

	return result;
}

/**
 * 给元素挂"本地副本失效时退回远端"的兜底。
 *
 * ⚠️ **这里没有"是否已挂过"的守卫**，而且不需要 —— 幂等性来自别处：
 * 第一次处理后元素的 `src` 已经是 `app://…`，于是再走一遍 `processImages` 时
 * 判定直接是 `ignore`，根本不会走到这里。
 *
 * 我原本在这里加过 `if (fallbacks.has(img)) return;`，变异验证证明它**永远走不到**
 * （去掉之后没有任何断言变红 ⇒ 它是死代码）。与其留一段看起来在防什么、
 * 实际防不住的代码，不如删掉并把"幂等来自哪里"写清楚。
 * （实时预览那条路径**确实**需要这类守卫：编辑器重渲染会对**同一个元素**
 * 再赋一次同样的远端地址，那时 src 不是本地地址，判定仍会命中 —— 见
 * `wireImageFallback` 的 `wired` 标记。）
 */
function wireFallback(
	img: ImageElementLike,
	deps: RenderHookDeps,
	fallbacks: WeakMap<ImageElementLike, Fallback>,
	info: Fallback
): void {
	if (typeof img.addEventListener !== "function") return;
	fallbacks.set(img, info);

	img.addEventListener("error", () => {
		const pending = fallbacks.get(img);
		if (!pending) return;
		// 只兜一次：拿掉记录，避免"退回远端又失败"再触发一轮
		fallbacks.delete(img);
		deps.onLocalCopyMissing?.(pending.key);

		const recover = () => {
			// 退回远端：在线用户仍然看得到图（离线时它也只是失败，与原来一样）
			img.setAttribute("src", pending.remoteUrl);
		};

		if (!deps.ensureLocalCopy) {
			recover();
			return;
		}
		void deps
			.ensureLocalCopy(pending.key, pending.remoteUrl)
			.then((localPath) => {
				const resourceUrl = localPath ? deps.resourceUrlFor(localPath) : null;
				if (resourceUrl) img.setAttribute("src", resourceUrl);
				else recover();
			})
			.catch(recover);
	});
}

// ─────────────────────────── 实时预览的兜底 ───────────────────────────

/** 拦截 `src` setter 需要的最小环境（抽出来才能在假 document 上测）。 */
export interface SrcPatchEnvironment {
	/** 拥有 `HTMLImageElement` 的那个对象（浏览器里就是 `window`）。 */
	view: { HTMLImageElement?: { prototype: object } } | null | undefined;
	log?: (error: unknown) => void;
}

/** 上一次赋值时的原始远端地址，供失败时退回。 */
const pendingRemote = new WeakMap<ImageElementLike, Fallback>();

/**
 * 拦截图片 `src` 的 setter，让"属于本存储且有本地副本"的地址在赋值那一刻就被换掉。
 *
 * 返回**卸载函数**（把原 setter 放回去）—— 插件卸载后还在改全局 prototype
 * 是最典型的"卸载不干净"缺陷。
 */
export function installImageSrcPatch(deps: RenderHookDeps, env: SrcPatchEnvironment): () => void {
	const prototype = env.view?.HTMLImageElement?.prototype;
	if (!prototype) return () => {};

	const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
	// 没有 setter（元素不存在 / 已经被别的东西换成访问器）→ 什么都不做，而不是硬来
	if (!descriptor || typeof descriptor.set !== "function") return () => {};

	/**
	 * 用**原 setter** 写值。
	 *
	 * ⚠️ 不把 `descriptor.set` 抽成一个变量再用（`const originalSet = descriptor.set`）：
	 * 那属于"把方法与其宿主分开"，`this` 有被指向意外对象的余地
	 * （lint 的 `unbound-method` 正是拦这个）。这里每次从 `descriptor` 上**直接调用**，
	 * `this` 显式传成目标元素，不存在歧义。
	 */
	const applySrc = (target: unknown, value: unknown): void => {
		descriptor.set?.call(target, value);
	};
	
	const log = env.log ?? (() => {});

	try {
		Object.defineProperty(prototype, "src", {
			...descriptor,
			set(value: unknown) {
				const element = this as unknown as ImageElementLike;
				let next = value;
				try {
					const decision = decideRenderTarget({
						src: value,
						settings: deps.settings(),
						index: deps.index(),
					});

					if (decision.action === "local") {
						const resourceUrl = deps.resourceUrlFor(decision.localPath);
						if (resourceUrl) {
							// ⚠️ **就地更新**而不是每次 `set` 一个新对象：
							// 兜底记录上带着 `wired` 标记（"监听器已挂过"），
							// 每写一个新对象就把那个标记冲掉了 —— 于是编辑器重渲染
							// （对同一元素再赋一次同样的远端地址）会不断堆积 error 监听器，
							// 一次加载失败触发 N 次自愈。
							//
							// 这是**实测发现的**：一条断言（"重复赋同一个远端地址只该挂一个兜底"）
							// 在未变异的代码上就红了，才发现那个守卫形同虚设。
							const pending = pendingRemote.get(element);
							if (pending) {
								pending.remoteUrl = decision.remoteUrl;
								pending.localPath = decision.localPath;
								pending.key = decision.key;
							} else {
								pendingRemote.set(element, {
									remoteUrl: decision.remoteUrl,
									localPath: decision.localPath,
									key: decision.key,
								});
							}
							wireImageFallback(element, deps, applySrc);
							next = resourceUrl;
							// 同上：这一份副本刚被用到（实时预览这条路径也一样要记）
							deps.onLocalCopyUsed?.(decision.key);
						}
					} else if (decision.action === "fetch" && deps.ensureLocalCopy) {
						// 不属于"已有本地副本"，但属于本存储 → 后台补齐，补上后换成本地。
						// 这里**不改**当前赋值：线上用户应当立刻看到图（远端加载），
						// 而不是等我们下载完 —— 那会让整篇笔记的图片都空一拍。
						void deps
							.ensureLocalCopy(decision.key, decision.remoteUrl)
							.then((localPath) => {
								const resourceUrl = localPath ? deps.resourceUrlFor(localPath) : null;
								if (resourceUrl) applySrc(element, resourceUrl);
							})
							.catch(() => {});
					}
				} catch (error) {
					// 任何意外都不能让图片赋值失败 —— 那会让整篇笔记渲染不出来
					log(error);
					next = value;
				}
				applySrc(element, next);
			},
		});
	} catch (error) {
		log(error);
		return () => {};
	}

	return () => {
		try {
			Object.defineProperty(prototype, "src", descriptor);
		} catch (error) {
			log(error);
		}
	};
}

/**
 * 给被改写的元素挂 error 兜底（实时预览路径专用）。
 *
 * 与 `wireFallback` 的区别只在于"退回远端"要用**原始 setter** 写回去 ——
 * 否则会再次进我们的 setter，形成自我循环。
 */
function wireImageFallback(
	img: ImageElementLike,
	deps: RenderHookDeps,
	applySrc: (target: unknown, value: unknown) => void
): void {
	if (typeof img.addEventListener !== "function") return;
	if (pendingRemote.get(img)?.wired) return;
	const info = pendingRemote.get(img);
	if (info) info.wired = true;

	img.addEventListener("error", () => {
		const pending = pendingRemote.get(img);
		if (!pending) return;
		pendingRemote.delete(img);
		deps.onLocalCopyMissing?.(pending.key);
		applySrc(img, pending.remoteUrl);
	});
}
