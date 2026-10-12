/**
 * 一个最小的确认弹窗。
 *
 * ## 为什么破坏性命令必须有它
 *
 * `cleanup-cloud` 与孤儿询问这类命令会**删云端对象 / 把本地副本送进回收站**。
 * 让它"点了就执行"意味着用户只有一次机会 ——
 * 而用户在命令面板里点错命令是很常见的。确认框把"会不会删"变成一个明确的动作。
 *
 * ## 为什么单独成模块、并把结果收敛成 `Promise<boolean>`
 *
 * 宿主的真弹窗点不了，测试就覆盖不到"确认后执行 / 取消后什么都不做"这两条路径。
 * 把弹窗封在一个返回布尔的函数后面，调用方（命令处理器）就能被替换成
 * 一个"总是确认"或"总是取消"的假实现 —— 那两条路径才验得动。
 *
 * ⚠️ 文案上刻意说清**要删多少个、占多少空间**，而不是只写"确定要清理吗"：
 * 后者让用户无法判断代价，只能凭运气点。
 */

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

import { renderFileCards } from "./file-cards";
import type { FileCard } from "./file-cards";

export interface ConfirmOptions {
	title: string;
	/** 正文行（逐行列出会做什么）。 */
	lines: string[];
	/**
	 * 清单里的文件（**缩略图 + 名字**）。给了就渲染在 `lines` 之后。
	 *
	 * ⚠️ 只在"要动的东西能画出来"时给：列的多半是**对象 key**
	 * （一串 sha256 —— 用户认不出那是哪张图），而清单是他按下不可逆按钮前
	 * 唯一能核对的东西。
	 */
	cards?: readonly FileCard[];
	/** 确认按钮文字。 */
	cta: string;
	/** 是否把确认按钮标成破坏性（宿主会把它染成警示色）。 */
	destructive?: boolean;
}

/** 问用户一次。取消/关闭都算"否"。 */
export function confirmWithModal(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const finish = (value: boolean) => {
			// 防重入：关闭弹窗也会触发 onClose，别让"取消"覆盖掉"确认"
			if (answered) return;
			answered = true;
			resolve(value);
		};

		const modal = new Modal(app);
		modal.titleEl?.setText?.(options.title);

		for (const line of options.lines) {
			modal.contentEl?.createDiv?.({ text: line });
		}
		// 清单放在正文之后、按钮之前：读起来是"背景 → 具体是哪些 → 你要怎么做"
		if (options.cards && options.cards.length > 0) renderFileCards(modal.contentEl, options.cards);

		new Setting(modal.contentEl)
			.addButton((button) => {
				const cta = button.setButtonText(options.cta);
				// ⭐ 破坏性动作必须**看得出来** —— 宿主会把它染成警示色。
				//
				// ⚠️ 这个选项以前是**死的**：它传进来了、注释也写着"宿主会把它染成警示色"，
				// 但从来没有人调用过宿主那个方法。2026-10-10 在真机上量到：「彻底删除」与
				// 「Cancel」的 class、背景色、字色、描边**四项逐项相同** —— 而这是用户按下
				// 不可逆按钮前**唯一**读到的安全信号。
				//
				// 为什么一直没人发现：这一层刻意不在单元测试网里（见文件头），
				// 所以只有"在真机上量效果"能发现它。现在的判据在真机验证链条里：
				// 把鼠标挪开、焦点清掉之后比两个按钮的样式，两者必须看得出不同。
				if (options.destructive) cta.setDestructive();
				cta.onClick(() => {
					finish(true);
					modal.close();
				});
			})
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					finish(false);
					modal.close();
				})
			);

		// 直接关掉（Esc / 点外部）也要给答案，否则 await 会永远挂着
		const originalOnClose = modal.onClose?.bind(modal);
		modal.onClose = () => {
			originalOnClose?.();
			finish(false);
		};

		modal.open();
	});
}
