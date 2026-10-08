/**
 * 实时预览（编辑态）下的站外图：**攒批 → 等元素进 DOM → 解析归属 → 交给站外缓存编排**。
 *
 * ## 为什么必须另开一条路径
 *
 * 「缓存外站图片」原先只有**一个**入口，挂在 `registerMarkdownPostProcessor` 上；
 * 而官方 API 文档写明那个钩子只作用于 **reading mode**。真机实测确认了这一点：
 * 同一篇笔记，阅读视图触发 **5 次**、实时预览（编辑态）**0 次**。
 *
 * 后果是"什么都没发生"：编辑态里看到站外图既不询问也不缓存，
 * 插件目录里连 `.site-decisions.json` 都不会出现（因为"同意"从未被问到）。
 * 而编辑态恰恰是用户待得最久的地方 —— 这个缺口比"少支持一种视图"严重得多。
 *
 * ## 为什么候选从 `src` 拦截里来
 *
 * 实时预览的那一层 `<img>` 是编辑器自己造的，公开 API 里没有对应钩子；
 * 而这个项目已经用**拦截 `HTMLImageElement.prototype.src` 的 setter**兜住了它
 * （`render-hook.ts`）。真机实测：实时预览确实走属性赋值（`img.src = …`），
 * 拦截拿到的是**笔记里的原始远端地址**（含站外那张）。所以候选就从那里来。
 *
 * ## ⚠️ 两个实测事实决定了这里的形状
 *
 * 1. **赋值那一刻元素还没进 DOM**（实测 `closest(".cm-editor")` 为 `null`）——
 *    所以**不能当场问**"这张图属于哪篇笔记"。必须延后。
 * 2. 延后多久也是实测的：**微任务时刻** 6/6 张图都已经连上文档、都在编辑器里、
 *    而且都能反查到正确的那篇笔记。所以默认调度器是**一个微任务**。
 *    不用动画帧还有个附带好处：窗口隐藏时动画帧会被节流，微任务不会。
 *
 * ## 为什么归属要按 DOM 反查，而不是取"当前活动笔记"
 *
 * 分屏时正在渲染的可能是**没有焦点**的那一篇，而这条链路的产出就是
 * 「改写笔记里的链接」—— 按活动笔记去猜会**改写另一篇**，那是损坏用户数据。
 * 所以按容器归属判定（`view.containerEl.contains(元素)`），拿不准就**不做**。
 *
 * ## 一批一次
 *
 * 一屏几十张图会让 setter 连着触发几十次。逐次去遍历打开的视图是白烧 CPU，
 * 所以攒成一批、整批只遍历一次；同一个元素在一批里只处理一次。
 */

import type { ImageElementLike } from "./render-hook";

/** 一个"打开着的视图"里我们用得上的两项。 */
export interface OpenViewLike {
	/** 视图的容器根节点（`MarkdownView.containerEl` 满足这个形状）。 */
	root: { contains?: (node: unknown) => unknown } | null | undefined;
	/** 这个视图承载的笔记路径（`MarkdownView.file.path`）。 */
	path: string;
}

export interface ExternalLiveDeps {
	/**
	 * 当前打开着的、可能承载笔记内容的视图。
	 *
	 * ⚠️ **每次 flush 现取**，不缓存：视图随时会开关、笔记随时会换。
	 * 也**不要**在这里过滤"是不是编辑器"—— 归属判定本身就要求"这个元素确实在某个 leaf 里"，
	 * 而阅读视图那条路已经由后处理器负责了（多处理一次也无害：编排层按站点与 URL 去重）。
	 */
	openViews: () => readonly OpenViewLike[];
	/** 解析出归属之后交给站外缓存编排（`externalHook.process`）。 */
	handle: (element: ImageElementLike, notePath: string) => void;
	/** 批次调度。默认**一个微任务**（理由见模块头注释）。注入它是为了测试能同步驱动。 */
	schedule?: (flush: () => void) => void;
	/** 出错记录口（默认静默：这条路径上一次未捕获的异常会毁掉整篇笔记的渲染）。 */
	onError?: (error: unknown) => void;
}

export interface ExternalLiveQueue {
	/** 记下一个候补元素。**同步、绝不抛错**（它跑在全 app 的图片赋值路径上）。 */
	see: (element: ImageElementLike) => void;
	/** 立刻处理攒下的候补（测试与卸载用）。 */
	flush: () => void;
	/** 丢掉攒下的候补、取消已排的调度。插件卸载时调用。 */
	dispose: () => void;
	/** 当前攒了多少（诊断用）。 */
	pending: () => number;
}

/**
 * 找出包含这个元素的那个视图；找不到返回 `null`（= 它不在任何笔记里）。
 *
 * ⚠️ 单个视图形状不对（别的插件造的视图）时**跳过它继续找**，而不是整个放弃：
 * 一个坏视图不该让全库的站外图都处理不了。
 */
export function notePathForElement(views: readonly OpenViewLike[], element: unknown): string | null {
	for (const view of views) {
		if (!view || typeof view.path !== "string" || !view.path) continue;
		const contains = view.root?.contains;
		if (typeof contains !== "function") continue;
		try {
			// ⚠️ `this` 显式绑回 `root`：`contains` 是宿主对象上的方法，
			// 脱离宿主调用在真机上会抛错（lint 的 unbound-method 也拦这个）。
			if (contains.call(view.root, element)) return view.path;
		} catch {
			// 这个视图的 contains 有问题 → 换下一个
		}
	}
	return null;
}

/** 默认调度：一个微任务（为什么不是动画帧见模块头注释）。 */
function defaultSchedule(flush: () => void): void {
	if (typeof queueMicrotask === "function") {
		queueMicrotask(flush);
		return;
	}
	// 极老的宿主才会走到这里 —— 仍然是"延后"，只是粒度粗一点
	window.setTimeout(flush, 0);
}

export function createExternalLiveQueue(deps: ExternalLiveDeps): ExternalLiveQueue {
	/** 待处理的候补。用 Set：同一批里同一个元素重复上报（重渲染会这样）只算一次。 */
	const batch = new Set<ImageElementLike>();
	let scheduled = false;
	let disposed = false;

	const report = (error: unknown): void => {
		try {
			deps.onError?.(error);
		} catch {
			// 连记录都失败就真的没什么可做的了 —— 但绝不能因此让图片赋值失败
		}
	};

	const flush = (): void => {
		scheduled = false;
		if (disposed || batch.size === 0) return;

		const candidates = [...batch];
		batch.clear();

		let views: readonly OpenViewLike[];
		try {
			views = deps.openViews();
		} catch (error) {
			// ⚠️ 这里已经清了 batch、也重置了调度标志，所以**下一条候补照样能排上** ——
			// 一次取视图失败不会把队列永久卡死（卡住的表现是"之后所有站外图都不处理了"）。
			report(error);
			return;
		}

		for (const element of candidates) {
			try {
				const path = notePathForElement(views, element);
				// 拿不到归属就跳过：这条链路会改写笔记，改错了就是损坏用户数据
				if (!path) continue;
				deps.handle(element, path);
			} catch (error) {
				// 单张图出问题不能拖垮这一批（还有别的图要处理）
				report(error);
			}
		}
	};

	const schedule = deps.schedule ?? defaultSchedule;

	return {
		see(element) {
			if (disposed || element === null || element === undefined) return;
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
