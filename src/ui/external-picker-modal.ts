/**
 * 「选择要缓存的外链图片」弹窗。
 *
 * ## 它补的是"逐张控制"这件事
 *
 * 早先按**站点**询问（记在 `.site-decisions.json` 里），于是"这个站点别的图都要、
 * 就这一张不要"根本表达不出来。现在改成：设置里定**默认**怎么做，
 * 想逐张挑时就用这个弹窗 —— **勾选本身就是同意**，与默认那一档无关。
 *
 * ## 为什么要做成"注入一个 loader"
 *
 * 清单来自哪里是 I/O（读当前笔记 / 扫全库），而这一层不该知道 vault 的事：
 * 它只拿到"某个范围下有哪些候选"，画出来，然后把用户勾的结果交回去。
 * 于是"要不要扫全库"这种决定留在接线层（`main.ts`），而这里可以在测试之外被替换掉
 * —— 这正是入口验收能端到端驱动这条链路的原因。
 *
 * ## ⚠️ 这一层"点不了"，所以写法刻意保守
 *
 * 宿主的 `Modal` 在测试里没有可编程的 DOM，所以这里的每一行都只能靠**真机验证**
 * （`dev-notes/.probe-external-picker.mjs` 会在真实 Obsidian 里把它开出来、点它、
 * 读回结果）。因此代码里：
 * - 所有宿主 DOM 调用都带 `?.`（宿主版本差异时宁可少画一个控件，也不要整条链路崩）；
 * - 勾选状态**只有一份**（`selected` 这个 Set），界面每次都由它重画 ——
 *   不把状态藏在 DOM 里，避免"显示 A、提交 B"。
 */

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

import type { ExternalCandidate } from "../maintenance/batch";
import { EXTERNAL_PICK_SCOPES, buildPickItems, selectEverything, toggleSelection } from "./external-picker-logic";
import type { ExternalPickItem, ExternalPickScope } from "./external-picker-logic";

/**
 * 载入某个范围下的候选。**I/O 由调用方负责**（这一层不碰 vault）。
 *
 * 交回来的就是命令那条链的 `ExternalCandidate`（已经去过重、已经过滤掉
 * 本存储/回环地址/未就绪），清单行由 {@link buildPickItems} 从这里构造。
 */
export type ExternalCandidateLoader = (scope: ExternalPickScope) => Promise<ExternalCandidate[]>;

export interface ExternalPickLabels {
	title: string;
	/** 「范围」这个设置项的名字。 */
	scopeName: string;
	scopeNote: string;
	scopeVault: string;
	/** 空清单时的说明（要顺带说清"为什么可能是空的"）。 */
	empty: string;
	selectAll: string;
	selectNone: string;
	/** 确认按钮文字，含 `{count}`（随勾选数实时变化）。 */
	cta: string;
	cancel: string;
}

/** 用 `{count}` 填一次文案（自己实现，免得为一个参数把 i18n 整个引进来）。 */
function withCount(template: string, count: number): string {
	return String(template ?? "").replace(/\{count\}/g, String(count));
}

/**
 * 开弹窗让用户勾选。返回勾中的条目；**取消 / 直接关掉返回 `null`**
 * （与"打开了但一张也没勾"区分开：前者是"别问我"，后者是"我看了，没有要的"）。
 */
export function pickExternalImagesWithModal(
	app: App,
	load: ExternalCandidateLoader,
	labels: ExternalPickLabels
): Promise<ExternalPickItem[] | null> {
	return new Promise((resolve) => {
		let answered = false;
		const finish = (value: ExternalPickItem[] | null): void => {
			if (answered) return;
			answered = true;
			resolve(value);
		};

		const modal = new Modal(app);
		modal.titleEl?.setText?.(labels.title);
		const content = modal.contentEl;

		/** 当前范围。默认"当前笔记"—— 它最贴近"我正在看这篇、随手挑几张"。 */
		let scope: ExternalPickScope = "note";
		let items: ExternalPickItem[] = [];
		/** ⚠️ 勾选状态**只有这一份**（界面每次由它重画，不把状态藏在 DOM 里）。 */
		let selected: Set<string> = new Set();
		/** 取数期间不许提交（否则会提交一份还没加载完的空清单）。 */
		let loading = false;

		const listEl = content?.createDiv?.({ cls: "acc-external-pick-list" });
		const emptyEl = content?.createDiv?.({ cls: "acc-external-pick-empty" });
		let ctaButton: { setButtonText?: (text: string) => unknown; setDisabled?: (value: boolean) => unknown } | null = null;

		const paint = (): void => {
			// 一句话说明清单为什么可能是空的（不说清的话，用户会以为按钮坏了）
			emptyEl?.setText?.(items.length === 0 ? labels.empty : "");

			if (listEl) {
				listEl.empty?.();
				for (const item of items) {
					const row = listEl.createDiv?.({ cls: "acc-external-pick-row" });
					if (!row) continue;
					const box = row.createEl?.("input", { attr: { type: "checkbox" } }) as
						| { checked?: boolean; addEventListener?: (type: string, handler: () => void) => void }
						| undefined;
					if (box) {
						box.checked = selected.has(item.key);
						box.addEventListener?.("change", () => {
							selected = toggleSelection(selected, item.key);
							paint();
						});
					}
					// 全库范围下把笔记路径也带上：同一个地址出现在多篇里时，
					// 只显示地址会让用户分不清自己勾的是哪一篇的那张。
					row.createSpan?.({
						text: scope === "vault" ? `${item.url} — ${item.notePath}` : item.url,
					});
				}
			}

			ctaButton?.setButtonText?.(withCount(labels.cta, selected.size));
			ctaButton?.setDisabled?.(loading || selected.size === 0);
		};

		const reload = async (next: ExternalPickScope): Promise<void> => {
			scope = next;
			loading = true;
			// ⚠️ 换范围时**清掉勾选**：上一批的键不该残留（`selected` 里的键属于别的清单，
			// 留着会让提交多出几条当前清单里根本没有的条目）
			selected = new Set();
			paint();
			try {
				items = buildPickItems(await load(next));
			} catch {
				// 取数失败（笔记读不到、目录读不了）→ 当作空清单。
				// 绝不能抛出：那会让弹窗停在一个没有结果的中间态，用户点了确认也没反应。
				items = [];
			}
			loading = false;
			paint();
		};

		if (content) {
			new Setting(content)
				.setName(labels.scopeName)
				.addDropdown((dropdown) => {
					for (const value of EXTERNAL_PICK_SCOPES) {
						dropdown.addOption(value, value === "note" ? labels.scopeNote : labels.scopeVault);
					}
					dropdown.setValue(scope).onChange((value) => {
						void reload(value === "vault" ? "vault" : "note");
					});
				});

			new Setting(content)
				.addButton((button) =>
					button.setButtonText(labels.selectAll).onClick(() => {
						selected = selectEverything(items);
						paint();
					})
				)
				.addButton((button) =>
					button.setButtonText(labels.selectNone).onClick(() => {
						selected = new Set();
						paint();
					})
				);

			new Setting(content)
				.addButton((button) => {
					ctaButton = button;
					button.setCta?.();
					button.onClick(() => {
						if (loading) return;
						// 勾中的条目按**清单顺序**交回去（稳定，便于断言与复现）
						finish(items.filter((item) => selected.has(item.key)));
						modal.close();
					});
				})
				.addButton((button) =>
					button.setButtonText(labels.cancel).onClick(() => {
						finish(null);
						modal.close();
					})
				);
		}

		// 直接关掉（Esc / 点外部）也算取消 —— 否则 await 会永远挂着
		const originalOnClose = modal.onClose?.bind(modal);
		modal.onClose = () => {
			originalOnClose?.();
			finish(null);
		};

		paint();
		modal.open();
		// 先画空态再取数：弹窗**立刻**出现（读全库可能要好几百毫秒），
		// 而"点了按钮什么都没发生"是最容易让人以为插件坏了的表现。
		void reload(scope);
	});
}
