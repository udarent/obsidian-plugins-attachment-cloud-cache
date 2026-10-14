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
 * 删掉 `setDestructive()` 必须能在界面上看出来（2026-10-12 的真机探针量的是按钮的**实际样式**，不是「有没有写那行代码」）。
 */

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

import { renderFileCards } from "./file-cards";
import type { FileCard } from "./file-cards";

/**
 * 用户的选择。
 *
 * ⚠️ `dismissed` 与 `keep` **不是一回事**（2026-10-14 用户 Android 报告）：
 * 用户报的是"弹窗出现后**点一下边上就不见了**" —— 那是**误关**，不是"我决定保留"。
 * 两者对**动作**的要求相同（都不删，安全），但对**沟通**的要求相反：
 * 误关的人需要知道"什么都没发生、以及想再问一次该去哪"，而主动点保留的人不需要再被告知。
 * ⇒ 关掉时返回 `dismissed`，调用方据此给一条**指路**提示。
 */
export type OrphanCloudChoice = "keep" | "local" | "both" | "dismissed";

export interface OrphanCloudPrompt {
	title: string;
	/** 正文行：先写概况，最后写风险（各档的可恢复性 + 多设备盲区）。 */
	lines: string[];
	/**
	 * 清单里的文件（**缩略图 + 名字**）。
	 *
	 * ⚠️ 这是"要不要删掉这个"这个问题**唯一可核对**的部分：对象 key 是一串
	 * sha256，光看它谁也认不出是哪张图。渲染在 `lines` 之后、按钮之前。
	 */
	cards?: readonly FileCard[];
	/** 保守项（**主按钮**）：什么都不做。 */
	keepCta: string;
	/** 只删本地副本（可恢复：以后会重新下载）。 */
	localCta: string;
	/** 破坏性项：云端对象与本地副本一起删（**不可恢复**）。 */
	bothCta: string;
}

/** 问用户一次；**没做选择就关掉**（点背景 / ESC）⇒ `dismissed`（不动作，但调用方要指路）。 */
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
		// ⚠️ 清单放在正文**之后**、按钮之前：读起来是"背景 → 具体是哪些 → 你要怎么做"。
		if (options.cards && options.cards.length > 0) renderFileCards(modal.contentEl, options.cards);

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

		// ⚠️ 只有"没点任何按钮就关闭"才会走到这里（点按钮时 `finish` 已经先跑过）。
		// 不动作仍然是最安全的那一侧 —— 但**如实回报它是"被关掉"**，见 `OrphanCloudChoice`。
		modal.onClose = () => finish("dismissed");
		modal.open();
	});
}
