/**
 * 用**通知**问用户"这张站外图要不要缓存到你的存储"。
 *
 * ## 为什么是通知而不是弹窗
 *
 * 这条询问出现在**阅读**路径上，而且一篇文章里可能有多个站点。
 * 弹窗（`Modal`）是**独占**的：会打断阅读、必须处理掉才能继续，
 * 而"要不要把这张图搬进我的存储"并不是一件紧急的事。
 * 通知可以放着不管（`duration: 0` = 常驻，直到用户点掉）—— 合适得多。
 *
 * ## `duration: 0` 的两个后果，都写清楚
 *
 * 1. **它不会自己消失**。用户不点就一直挂着 —— 这是刻意的（错过就再也问不到了），
 *    而上限被编排层压住了：**每个站点最多一个**（同站多张图只弹一个）。
 * 2. 因此**必须**在点击后立刻 `hide()`，否则点完还留着一个没有意义的空壳。
 *
 * ## 为什么要注入 `noticeFactory`
 *
 * 测试替身里的 `Notice` 是空壳（没有 DOM），所以"按钮真的能点、点了会怎样"
 * 在 Node 里无法验证。把创建通知这一步做成接缝之后，套件可以塞一个**记账的假通知**，
 * 断言"挂了两颗按钮""点击后关闭并返回对应的选择"。
 * 真实观感（样式、是否真的可点）仍然**只能真机验证**。
 */

import { Notice } from "obsidian";

import type { ExternalAskChoice } from "../render/external-hook";

/** 按钮的最小形状（`HTMLElement` 天然满足）。 */
export interface NoticeButtonLike {
	addEventListener: (event: "click", handler: () => void) => void;
}

/** 通知容器的最小形状（`HTMLElement` 天然满足）。 */
export interface NoticeContainerLike {
	createEl: (tag: string, options?: { text?: string; cls?: string }) => NoticeButtonLike;
}

export interface NoticeLike {
	containerEl: NoticeContainerLike;
	hide: () => void;
}

export interface ExternalNoticeOptions {
	/** 正文（已由调用方 `t()` 好）。 */
	message: string;
	/** 「缓存」按钮的文字。 */
	cacheLabel: string;
	/** 「不再询问」按钮的文字。 */
	neverLabel: string;
}

export interface ExternalNoticeDeps {
	/** 造通知。默认用宿主的 `Notice`；测试注入假实现。 */
	noticeFactory?: (message: string, duration: number) => NoticeLike;
}

/**
 * 问用户。返回用户的选择。
 *
 * 关闭通知（用户没点就自己关掉 / 通知被系统收走）视为 **`never`（不做、但也别记）**？
 * 不 —— 这里返回 `never`，由调用方决定"记不记"。当前调用方会把它记成 deny，
 * 这是刻意的取舍：**不回答就等于不做**，而"不做"被记住之后至少不会反复打扰。
 * （若把它当成"等下次再问"，同一篇文章每次打开都会再弹一次，那更烦。）
 */
export async function askExternalCacheWithNotice(
	options: ExternalNoticeOptions,
	deps: ExternalNoticeDeps = {}
): Promise<ExternalAskChoice> {
	const factory = deps.noticeFactory ?? defaultNoticeFactory;
	// `duration: 0` = 常驻（理由见模块头注释）
	const notice = factory(options.message, 0);

	return new Promise<ExternalAskChoice>((resolve) => {
		let settled = false;
		const finish = (choice: ExternalAskChoice): void => {
			// 只认第一次点击：两颗按钮都在同一个容器上，重复点击不该改变结果，
			// 也不该让 Promise 被 resolve 两次（后者是静默的，但会让状态难以推理）。
			if (settled) return;
			settled = true;
			notice.hide();
			resolve(choice);
		};

		notice.containerEl.createEl("button", { text: options.cacheLabel, cls: "mod-cta" }).addEventListener("click", () =>
			finish("cache")
		);
		notice.containerEl.createEl("button", { text: options.neverLabel }).addEventListener("click", () => finish("never"));
	});
}

/**
 * 默认实现：用宿主的 `Notice`。
 *
 * 这里有一次**有意的断言**：宿主的 `Notice.containerEl` 是 `HTMLElement`，
 * 而 `HTMLElement.createEl` 带泛型标签约束，结构上对不上我们那个最小的
 * `NoticeContainerLike`。硬要描述这层关系只会写出更绕的类型；
 * 而运行时它确实满足（`createEl("button")` 返回的正是能挂 click 的元素）。
 */
function defaultNoticeFactory(message: string, duration: number): NoticeLike {
	return new Notice(message, duration) as unknown as NoticeLike;
}
