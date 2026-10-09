/**
 * 「这个附件的云端副本要不要一起删？」——**三选一**弹窗（需求 R17 的主场景）。
 *
 * ## 为什么必须是三选一，而不是"确定/取消"
 *
 * 用户删掉一个本地文件时，我们的问题不是"你确定吗"，而是
 * **"云端那一份要不要一起删"** —— 那是一个他才知道答案的问题，
 * 而且**两个方向的代价都不小**：
 *
 * - 删了云端：其他设备上没缓存过的引用会失效，且**不可恢复**；
 * - 不删云端：空间不会被回收（这正是他可能想要的）。
 *
 * 所以两个选项都摆在明面上，而**默认/主按钮是保守的那个**（仅删本地）。
 *
 * ## 为什么"云端"这一档可能被禁用
 *
 * 本库**还有别的引用**时禁用（`cloudAllowed: false`）：那条引用会变成死链，
 * 而用户此刻正在删的是**另一个文件**。禁用比"让他自己负责"更合适 ——
 * 需求 R17 把这条写成硬要求（仍被引用时不给删）。
 *
 * ⚠️ 禁用的**原因**必须写在界面上（`cloudDisabledReason`），
 * 而不是只留一个灰按钮 —— 否则用户只会觉得"插件坏了"。
 */

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

/** 用户的选择。`cancel` 包含"直接关掉弹窗"。 */
export type CloudDeleteChoice = "local" | "cloud" | "cancel";

export interface CloudDeleteOptions {
	title: string;
	/** 正文行（逐行列出会发生什么，含无法撤销与多设备共享的提示）。 */
	lines: string[];
	/** 云端那一档是否可选。 */
	cloudAllowed: boolean;
	/** 不可选时的原因（显示在正文末尾）。 */
	cloudDisabledReason?: string;
	/** 保守选项（主按钮）。 */
	localCta: string;
	/** 云端选项。 */
	cloudCta: string;
	cancelCta: string;
}

/** 问用户一次；关掉弹窗与"取消"同义。 */
export function askCloudDelete(app: App, options: CloudDeleteOptions): Promise<CloudDeleteChoice> {
	return new Promise((resolve) => {
		let answered = false;
		const finish = (choice: CloudDeleteChoice) => {
			// 防重入：`close()` 也会触发 onClose，别让"取消"覆盖掉刚做的选择
			if (answered) return;
			answered = true;
			resolve(choice);
		};

		const modal = new Modal(app);
		modal.titleEl?.setText?.(options.title);

		for (const line of options.lines) {
			modal.contentEl?.createDiv?.({ text: line });
		}
		if (!options.cloudAllowed && options.cloudDisabledReason) {
			modal.contentEl?.createDiv?.({ text: options.cloudDisabledReason });
		}

		new Setting(modal.contentEl)
			// ⭐ 主按钮是**保守**那一档：用户按回车/顺手确认时得到的是"不动云端"。
			.addButton((button) =>
				button.setButtonText(options.localCta).setCta().onClick(() => {
					finish("local");
					modal.close();
				})
			)
			.addButton((button) => {
				// `setDestructive` 是宿主当前推荐的破坏性样式（`setWarning` 已废弃）
				button.setButtonText(options.cloudCta).setDestructive();
				if (!options.cloudAllowed) {
					button.setDisabled(true);
				} else {
					button.onClick(() => {
						finish("cloud");
						modal.close();
					});
				}
				return button;
			})
			.addButton((button) =>
				button.setButtonText(options.cancelCta).onClick(() => {
					finish("cancel");
					modal.close();
				})
			);

		modal.onClose = () => finish("cancel");
		modal.open();
	});
}
