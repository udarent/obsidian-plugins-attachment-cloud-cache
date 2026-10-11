/**
 * 「这些附件已经没人引用了，要清掉吗？」——**三选一**弹窗（需求 R17 的主场景）。
 *
 * ## 它会**自动**出现（这才是重点）
 *
 * 与维护命令里那种"用户主动发起"的确认框不同：这个弹窗是**孤儿出现时自己弹的**
 * （用户刚把笔记里最后一条引用删掉，见 `maintenance/orphan-watch.ts`）。
 * 因为是自动出现，措辞与按钮顺序都要按"用户可能没在期待它"来设计。
 *
 * ## ⭐ 一个孤儿占两份资源 ⇒ 三档风险，不是一个"删 / 不删"
 *
 * | 档 | 删掉什么 | 能不能回来 |
 * |---|---|---|
 * | **保留**（主按钮） | 什么都不动 | —— |
 * | 只删本地副本 | 库里的那份副本（腾出空间） | 能：笔记里再出现那条链接时会**自动重新下载** |
 * | 云端与本地一起删（破坏性） | 云端对象 + 本地副本 | **不能**：对象从存储里没了 |
 *
 * 把这两层揉成一个"删"字，用户就没法"只做他能接受的那一半"：
 * 想要"库小一点但别丢源文件"的人，会因为这个弹窗只有"全删/不删"而只能选择什么都不做。
 *
 * ## ⭐ 主按钮是"保留"，与"确定/取消"的惯例相反
 *
 * 把**不动作**的那一侧标成 `setCta()`（主按钮）：顺手按回车的代价在两个方向上**不对等** ——
 * 误删云端是**不可恢复**的（而"保留"最多只是少回收一点空间，下次还能再清）。
 *
 * 三个按钮的视觉等级与风险等级**一一对应**：主按钮（紫）＝不动作、
 * 普通按钮＝可恢复的删除、`setDestructive()`（红）＝不可恢复的删除。
 *
 * ## 为什么必须如实写风险
 *
 * 插件**只看得到本设备此刻的引用**（多设备盲区）：别的设备、别的 vault 可能仍在用同一个对象。
 * 这条边界写在正文里（由调用方传入），而不是含糊成"已确认无人使用"——
 * 需求 R17 把"如实告知"写成硬要求。
 *
 * ## 破坏性按钮的样式：这一处有真机判据
 *
 * `setDestructive()` 在本项目历史上曾经是个**死选项**（另一处弹窗传了这个意图
 * 却从没调用过宿主的方法，真机上两个按钮逐项相同 —— 用户按下唯一不可恢复的按钮前
 * 唯一的安全信号失效）。所以这里的样式不是"写了就算"：真机判据要求
 * 删掉 `setDestructive()` 必须能在界面上看出来（见 `dev-notes/_archive/` 的孤儿探针）。
 */

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

/** 用户的选择。**关掉弹窗与 `keep` 同义**（不动作永远是最安全的那一侧）。 */
export type OrphanCloudChoice = "keep" | "local" | "both";

export interface OrphanCloudPrompt {
	title: string;
	/** 正文行：先列对象，再写风险（各档的可恢复性 + 多设备盲区）。 */
	lines: string[];
	/** 保守项（**主按钮**）：什么都不做。 */
	keepCta: string;
	/** 只删本地副本（可恢复：以后会重新下载）。 */
	localCta: string;
	/** 破坏性项：云端对象与本地副本一起删（**不可恢复**）。 */
	bothCta: string;
}

/** 问用户一次；关掉弹窗等同 `keep`。 */
export function askOrphanCloudDelete(app: App, options: OrphanCloudPrompt): Promise<OrphanCloudChoice> {
	return new Promise((resolve) => {
		let answered = false;
		const finish = (choice: OrphanCloudChoice) => {
			// 防重入：`close()` 也会触发 onClose，别让"关闭"覆盖掉刚做的选择
			if (answered) return;
			answered = true;
			resolve(choice);
		};

		const modal = new Modal(app);
		modal.titleEl?.setText?.(options.title);

		for (const line of options.lines) {
			modal.contentEl?.createDiv?.({ text: line });
		}

		new Setting(modal.contentEl)
			// ⭐ 主按钮是**保守**那一档（理由见文件头注释）
			.addButton((button) =>
				button.setButtonText(options.keepCta).setCta().onClick(() => {
					finish("keep");
					modal.close();
				})
			)
			// 中间这档会删文件，但**能回来**（重新下载）⇒ 普通按钮，不染红
			.addButton((button) =>
				button.setButtonText(options.localCta).onClick(() => {
					finish("local");
					modal.close();
				})
			)
			.addButton((button) =>
				button.setButtonText(options.bothCta).setDestructive().onClick(() => {
					finish("both");
					modal.close();
				})
			);

		modal.onClose = () => finish("keep");
		modal.open();
	});
}
