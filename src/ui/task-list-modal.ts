/**
 * **清单弹窗**：把一个 {@link TaskListOptions} 装进宿主 `Modal`。
 *
 * ⚠️ 这里**只有容器的事**：建 Modal、设标题、开窗、把关窗事件转给壳。
 * 清单本身的装配（列表 / 勾选 / 进度 / 动作区 / 完成态）全在 `task-list-shell.ts` ——
 * 因为同一个壳还要给附件管理视图（R24）用，**两套装配必然分叉**。
 *
 * | 入口 | 列的是什么 | 勾选后干什么 |
 * |---|---|---|
 * | 上传附件 | 被引用的附件 + 没有被引用的附件 + 站外图 + 库外本机文件 | 上传并改写链接 |
 * | 清理附件 | 台账里我们上传过、本库已看不见引用的对象 ＋ 没有任何引用的本地文件 ＋ 站外缓存副本 | 三档：保留 / 只删本地 / 连本地带云端一起删 |
 *
 * ## ⚠️ 关闭语义（唯一一份在壳里）
 *
 * - 用户点「取消」/ ESC / 点背景 ⇒ 交 `null`（调用方据此判断"用户没做"）；
 * - **跑的过程中**关窗 ⇒ 不交结果（那一趟仍在继续，结果会由执行体自己交回）；
 * - **完成态**（D-80，跑完停在界面上）关窗 ⇒ 交**跑完的结果**，不是 `null`。
 *   交 `null` 等于告诉调用方"用户取消了"，而那一趟其实已经做完了。
 *
 * 这三条都实现在 `mountTaskListShell().handleContainerClose()` 里；本文件只负责转调。
 */

import { Modal } from "obsidian";
import type { App } from "obsidian";

import { mountTaskListShell } from "./task-list-shell";
import type { TaskListOptions, TaskListResult } from "./task-list-shell";

export type {
	TaskListAction,
	TaskListFilter,
	TaskListOptions,
	TaskListResult,
} from "./task-list-shell";

/** 开弹窗。**取消 / 直接关掉**（点背景、ESC）返回 `null`。 */
export function askTaskList(app: App, options: TaskListOptions): Promise<TaskListResult | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		modal.titleEl?.setText?.(options.title);

		const shell = mountTaskListShell(modal.contentEl, options, {
			requestClose: () => modal.close(),
			settle: (result) => resolve(result),
		});

		// 直接关掉（ESC / 点外部）也要把结果交回去 —— 否则 `await` 会永远挂着。
		const originalOnClose = modal.onClose?.bind(modal);
		modal.onClose = () => {
			originalOnClose?.();
			shell.handleContainerClose();
		};

		modal.open();
	});
}
