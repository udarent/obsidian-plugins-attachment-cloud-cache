/**
 * **清单壳（容器无关）**：一个列表 + 勾选 + 逐项进度 + 底部动作区。
 *
 * 两个容器共用这一份装配：
 * | 容器 | 谁在用 | 怎么收起 |
 * |---|---|---|
 * | `Modal`（弹窗） | 「上传附件」「清理附件」两条命令 | `modal.close()` |
 * | `ItemView`（附件管理视图，R24） | 视图里的「待上传 / 待清理」 | 视图自己的收起动作 |
 *
 * ## ⚠️ 为什么必须是**同一个函数**，不是两套装配
 *
 * 那套东西有四条链在用、有 200 行分块的性能纪律、有勾选 O(1) 与完成态（D-76 / D-80）——
 * 在视图里重写一遍 = 重写已经在真机上验过的东西，换来的只是"看起来更整合"。
 * **判据：出现第二份"装配 + 接线 + 完成态"就是走错了路。**
 *
 * ## ⚠️⚠️ 性能：几千个条目也不能卡（用户 2026-10-15 提醒）
 *
 * 1. **分块画**（{@link ROW_DRAW_CHUNK}）：一次最多画 200 行，其余靠"再显示 N 行"接着画。
 *    ⚠️ 它**只管画** —— 勾选范围、要处理的范围、进度的分母全按**整个清单**算。
 * 2. **勾选与进度都只改该改的地方**：勾一行只更新按钮文案（O(1)），
 *    一项跑完只改**那一行**的状态文字（O(1)）。全量重画只在"换范围 / 开跑 / 再显示"时发生。
 * 3. **缩略图不许用原生懒加载**：`renderThumb` 刻意**没有** `loading="lazy"`
 *    —— 它在宿主的弹窗容器里会"永远不加载"（`transform`/`opacity` 动画搅乱滚动根判定），
 *    而"分块画"已经把"一次建多少 `<img>`"限住了。理由与代价写在 `file-cards.ts::renderThumb`。
 *
 * ## ⚠️ 这一层"点不了"，所以写法刻意保守
 *
 * 宿主的 `Modal` 在测试里没有可编程的 DOM（替身的 `Setting.addButton` 是**空操作**），
 * 所以这里的每一行都只能靠**真机验证**。因此：
 * - 所有宿主 DOM 调用都带 `?.`（宿主版本差异时宁可少画一个控件，也不要整条链路崩）；
 * - **能不能穷举的部分一律不在这一层**：行怎么算（`planFileCards`）、勾选怎么算
 *   （`selection-logic.ts`）、进度怎么折叠（`task-list.ts`）都在纯模块里，有套件与锚点钉着；
 * - 状态**只有一份**（`selected` / `statuses`），界面由它派生 —— 不把状态藏在 DOM 里。
 */

import { Setting, setIcon } from "obsidian";

import { selectEverything, toggleSelection } from "./selection-logic";
import { renderThumb } from "./file-cards";
import type { FileCard, FileCardOpenTarget } from "./file-cards";
import { foldTaskProgress, selectionInOrder, setTaskStatus } from "./task-list";
import type { TaskListLabels, TaskReporter, TaskStatus } from "./task-list";

export type { TaskListLabels, TaskProgress, TaskReporter, TaskStatus } from "./task-list";

/** 一次最多画多少行（见文件头的性能纪律）。 */
const ROW_DRAW_CHUNK = 200;

/**
 * 清单行的键 = `FileCard.id`；而勾选那两个函数按 `{ key }` 收口。
 * 一行适配，比让"哪些行算勾中"多出一份判据要好。
 */
function keysOf(rows: readonly FileCard[]): { key: string }[] {
	return rows.map((row) => ({ key: row.id }));
}

/**
 * 只有**能勾**的行（`selectable === false` 的那些不参与勾选，D-70）。
 *
 * ⚠️ 全选、默认勾选、`initiallySelected` **三处都必须先过这一道**：
 * 少一处的症状是"用户点了全选，界面上那几个勾上了，执行时却被忽略"
 *（或者更糟：我们替用户处理了他以为没勾的东西）。
 */
function selectableRows(rows: readonly FileCard[]): FileCard[] {
	return rows.filter((row) => row.selectable !== false);
}

/**
 * 清单上方的**范围过滤**（一个勾选框）。现在只有一处用途：「只看当前笔记」。
 *
 * ## ⚠️ 它**重新算**清单与正文，不是把行藏起来
 *
 * 只藏行就不知道"看到的是不是全部"—— 摘要说 12 个而清单只有 3 行，用户会按一份
 * 自相矛盾的清单点确认。所以 `apply` 交出**新的清单与新的正文**。
 *
 * ⚠️ 切换范围会**重置勾选**（按新范围的默认值重算）—— 不清的话，上一批看不见的行
 * 仍然勾着、仍会被处理（显示 A、提交 B）。
 */
export interface TaskListFilter {
	/** 稳定键：`onFiltersChange` 收到的状态按它索引。 */
	key: string;
	/** 勾选框的文案。 */
	name: string;
	/** 打开时是否勾上。 */
	value: boolean;
}

/**
 * 一档**动作**（按钮）。给"同一个清单、几种处理方式"的场景用。
 *
 * ⚠️ 各档的风险等级必须与视觉等级**一一对应**：不可恢复的那一档才 `destructive`，
 * 而**保守**（什么都不做）的那一档才 `primary`。
 */
export interface TaskListAction {
	key: string;
	/** 按钮文字（随勾选数变化）。 */
	label: (count: number) => string;
	/** 主按钮（宿主染成强调色）。⚠️ 只有保守那一档该用它。 */
	primary?: boolean;
	/** 破坏性（宿主染成警示色）。⚠️ 只有不可恢复的那一档该用它。 */
	destructive?: boolean;
	/** 这一档**什么都不做**（如"保留"）：直接带着勾选结果收口，不跑 `run`。 */
	idle?: boolean;
	/**
	 * 按钮数字的来源（默认 = 勾选数）。
	 *
	 * ⭐ 附件管理用它实现「**数字 = 能作用的件数**」：勾 10 个里 3 个已在云端 ⇒ 上传显示 3。
	 * 判定逻辑属于调用方（它才有行状态），壳只负责把它算出来的数字画上去。
	 */
	countFor?: (selected: readonly string[]) => number;
}

export interface TaskListOptions {
	title: string;
	/** 正文行（背景、风险、代价）—— 逐行画在清单上方。给了 `filter` 时它是**初始**那批。 */
	lines?: readonly string[];
	cards: readonly FileCard[];
	/** 范围 / 类别过滤开关（可多个，各自一个勾选框）。⚠️ 多个开关**只调一次**重算回调。 */
	filters?: readonly TaskListFilter[];
	/** 任一开关变化时重算清单与正文。不给 = 只改状态、清单不动。 */
	onFiltersChange?: (
		state: Readonly<Record<string, boolean>>
	) => Promise<{ cards: readonly FileCard[]; lines?: readonly string[] }>;
	labels: TaskListLabels;
	/** 多档动作（按钮）。缺省 = 单一主按钮 + 取消。 */
	actions?: readonly TaskListAction[];
	/** 默认勾选：`all`（默认）或 `none`。 */
	defaultSelected?: "all" | "none";
	/**
	 * 只勾**这些**（D-68）：不给 = 全勾；与 `defaultSelected: "none"` 同时给时后者优先。
	 * ⚠️ 传进来的键**不在当前清单里**时静默忽略。
	 */
	initiallySelected?: readonly string[];
	/**
	 * 主按钮是不是**不可撤销**的动作（删除类）。仅在没给 `actions` 时生效。
	 * ⚠️ 它是用户按下那个按钮前**唯一**读到的安全信号。
	 */
	destructive?: boolean;
	/** 点按钮之后跑的事。不传 = **只做选择**。 */
	run?: (selected: readonly string[], report: TaskReporter, action?: string) => Promise<void>;
	/** 点行尾「打开」时去哪（D-66）。**不传就不画链接**。 */
	onOpen?: (target: FileCardOpenTarget) => void;
}

export interface TaskListResult {
	/** 勾中的键，**按清单顺序**。 */
	selected: string[];
	/** 有没有真的跑过（false = 只选择，或点的是"什么都不做"那一档）。 */
	ran: boolean;
	/** 用户点的那一档（没给 `actions` 时为 `undefined`）。 */
	action?: string;
}

/**
 * 容器与壳之间的契约。
 *
 * ⚠️ 这两个回调**分开**：`settle` 只交结果，`requestClose` 只管收起容器。
 * 合成一个会让"跑完了但容器不该关"（视图里就是这样）无法表达。
 */
export interface TaskListShellHost {
	/** 收起承载它的容器（弹窗 close / 视图收起）。 */
	requestClose: () => void;
	/** 交回结果（只交一次；重复调用忽略）。 */
	settle: (result: TaskListResult | null) => void;
}

/** 壳交出去的句柄（容器在卸载 / 外部换清单时用）。 */
export interface TaskListShell {
	/**
	 * 外部换一份清单（视图切筛选时用；弹窗里由 {@link TaskListOptions.filters} 驱动）。
	 * 与过滤开关走**同一套**重置逻辑（勾选、状态、分块位置都按新清单重算）。
	 */
	replaceCards: (cards: readonly FileCard[], lines?: readonly string[]) => void;
	/** 当前勾选（按清单顺序）。 */
	selection: () => string[];
	/**
	 * 容器被外部关掉时调用（ESC / 点背景 / 视图卸载）。
	 *
	 * ⚠️ 它封装了**唯一**一份关闭判据：跑的过程中不交结果（那一趟仍在继续），
	 * 完成态交的是**跑完的结果**而不是 `null`（D-80）。
	 */
	handleContainerClose: () => void;
}

/** 复选框与状态文字的句柄（`setText`/`setAttribute` 都当可选的：宿主版本差异时少改一处，不要崩）。 */
interface RowRef {
	box: { checked?: boolean; disabled?: boolean } | null;
	statusEl: { setText?: (text: string) => unknown; setAttribute?: (name: string, value: string) => unknown } | null;
}

/**
 * 把清单壳挂到一个已存在的容器上。
 *
 * 容器只负责"有地方画"，不参与任何判定 —— 这样 `Modal` 与 `ItemView` 才能共用同一份装配。
 */
export function mountTaskListShell(
	container: HTMLElement,
	options: TaskListOptions,
	host: TaskListShellHost
): TaskListShell {
	let answered = false;
	const settle = (value: TaskListResult | null): void => {
		if (answered) return;
		answered = true;
		host.settle(value);
	};
	const close = (): void => host.requestClose();

	/** 正文行整块重画（换范围时数字必须与清单对得上）。 */
	const linesEl = container.createDiv?.({ cls: "acc-task-lines" });
	const paintLines = (lines: readonly string[]): void => {
		linesEl?.empty?.();
		for (const line of lines ?? []) linesEl?.createDiv?.({ text: line });
	};
	paintLines(options.lines ?? []);

	let cards: FileCard[] = [...(options.cards ?? [])];
	/** 过滤开关的当前状态（`key` → 勾没勾）。⚠️ 只有这一份。 */
	const filterState: Record<string, boolean> = {};
	for (const item of options.filters ?? []) filterState[item.key] = item.value;

	/** 默认勾选（首次打开与换范围共用**一份**判据）。⚠️ 只从**能勾的**行里取。 */
	const initialSelection = (rows: readonly FileCard[]): Set<string> => {
		if (options.defaultSelected === "none") return new Set<string>();
		const pickable = keysOf(selectableRows(rows));
		if (!options.initiallySelected) return selectEverything(pickable);
		const allowed = new Set(options.initiallySelected);
		return new Set(pickable.map((row) => row.key).filter((key) => allowed.has(key)));
	};

	/** ⚠️ 勾选状态**只有这一份**。 */
	let selected: Set<string> = initialSelection(cards);
	/** 逐项状态（只放**勾中的**那些）。 */
	let statuses: ReadonlyMap<string, TaskStatus> = new Map<string, TaskStatus>();
	let phase: "pick" | "run" = "pick";
	/** 进度分母 = **交给这一趟**的件数。 */
	let runningTotal = 0;
	/**
	 * 这一趟**跑完了没有**。
	 * ⚠️ 不能拿 `finished >= total` 代替：逐项循环跑完时改写/收尾还在继续。
	 */
	let runFinished = false;
	/**
	 * 跑完了、界面停在**完成态**（D-80）。
	 * ⇒ 清单留着（失败行带状态文字）、顶部变成计数、按钮区只剩「关闭」。
	 */
	let settled = false;
	/** 完成态要交回去的结果（点「关闭」或按 ESC 时交它，而不是交 `null`）。 */
	let settledResult: TaskListResult | null = null;
	/** 已经画出来的行数。 */
	let drawn = 0;
	/** 行句柄（进度上报只改那一行）。 */
	const rowRefs = new Map<string, RowRef>();

	const progressEl = container.createDiv?.({ cls: "acc-task-progress" });
	const listEl = container.createDiv?.({ cls: "acc-task-list" });
	const emptyEl = container.createDiv?.({ cls: "acc-task-empty" });
	/**
	 * 按钮区单独一个容器 —— **完成态要整块换掉**（D-80）。
	 * 不这么做的话跑完之后 `取消` 与 `关闭` 会并排出现，而那时它们做的是同一件事。
	 */
	const footerEl = container.createDiv?.({ cls: "acc-task-actions" });
	let ctaButton: { setButtonText?: (text: string) => unknown; setDisabled?: (value: boolean) => unknown } | null = null;
	let cancelButton: { setDisabled?: (value: boolean) => unknown } | null = null;
	const actionButtons: {
		action: TaskListAction;
		button: { setButtonText?: (text: string) => unknown; setDisabled?: (value: boolean) => unknown };
	}[] = [];

	const statusText = (status: TaskStatus): string => {
		if (status === "done") return options.labels.statusDone;
		if (status === "failed") return options.labels.statusFailed;
		if (status === "skipped") return options.labels.statusSkipped;
		return status === "running" ? "…" : "";
	};

	/** 更新"跟勾选数/进度有关"的那些东西（**清单本身不动**）。 */
	const updateControls = (): void => {
		emptyEl?.setText?.(cards.length === 0 ? options.labels.empty : "");

		if (phase === "run") {
			const progress = foldTaskProgress(statuses, runningTotal);
			progressEl?.setText?.(runFinished ? options.labels.finished(progress) : options.labels.running(progress));
		} else {
			progressEl?.setText?.("");
		}

		// ⚠️ 完成态的按钮由 `showSettledFooter()` 独占：这里再改一次会把「关闭」改回主按钮并启用它。
		if (settled) return;

		if (selectableRows(cards).length === 0) {
			ctaButton?.setButtonText?.(options.labels.close);
			ctaButton?.setDisabled?.(phase === "run");
		} else {
			ctaButton?.setButtonText?.(options.labels.cta(selected.size));
			ctaButton?.setDisabled?.(phase === "run" || selected.size === 0);
		}
		cancelButton?.setDisabled?.(phase === "run");
		const chosenKeys = selectionInOrder(cards, selected);
		for (const item of actionButtons) {
			const count = item.action.countFor ? item.action.countFor(chosenKeys) : selected.size;
			item.button.setButtonText?.(item.action.label(count));
			item.button.setDisabled?.(phase === "run" || (count === 0 && !item.action.idle));
		}
	};

	/** 只改**一行**的状态（进度上报走这里 ⇒ O(1)）。 */
	const updateStatus = (key: string): void => {
		const statusEl = rowRefs.get(key)?.statusEl;
		if (!statusEl) return;
		const status = statuses.get(key) ?? "pending";
		statusEl.setText?.(statusText(status));
		statusEl.setAttribute?.("class", `acc-task-status acc-task-status-${status}`);
	};

	/** 把勾选状态同步到**已画出来的**行上（全选/全不选用它）。 */
	const syncChecks = (): void => {
		for (const [key, ref] of rowRefs) {
			if (ref.box) ref.box.checked = selected.has(key);
		}
	};

	/** 画清单 —— **只在**换范围 / 开跑 / 点"再显示"时调用。 */
	const paintRows = (): void => {
		if (!listEl) return;
		listEl.empty?.();
		rowRefs.clear();

		for (const card of cards.slice(0, drawn)) {
			const row = listEl.createDiv?.({ cls: "acc-task-row" });
			if (!row) continue;
			const status = statuses.get(card.id) ?? "pending";

			const box = row.createEl?.("input", {
				cls: "acc-task-check",
				// ⭐ 读屏（D-80）：裸 checkbox 只会被读成「复选框」，用行名当标签。
				// ⚠️ 用 `aria-label` 而不是 `<label for>`：后者需要 id，会和多实例撞车。
				attr: { type: "checkbox", "aria-label": card.label },
			}) as
				| {
						checked?: boolean;
						disabled?: boolean;
						addEventListener?: (type: string, handler: () => void) => void;
				  }
				| undefined;
			if (box) {
				box.checked = selected.has(card.id);
				if (phase === "run" || card.selectable === false) box.disabled = true;
				box.addEventListener?.("change", () => {
					if (phase === "run") return;
					selected = toggleSelection(selected, card.id);
					updateControls();
				});
			}

			renderThumb(row, card);
			const text = row.createSpan?.({ cls: "acc-task-text" });
			const head = text?.createSpan?.({ cls: "acc-task-head" }) ?? text;
			head?.createSpan?.({ cls: "acc-task-name", text: card.label });
			// ⭐ 行内小标签（D-68 / D-71）：有 `hintIcon` 就**只画图标**，`hint` 当悬停说明。
			if (card.hintIcon) {
				const mark = head?.createSpan?.({
					cls: "acc-task-hint-icon",
					attr: { title: card.hint, "aria-label": card.hint },
				});
				if (mark) setIcon(mark, card.hintIcon);
			} else if (card.hint) {
				head?.createSpan?.({ cls: "acc-task-hint", text: card.hint });
			}
			if (card.meta) text?.createSpan?.({ cls: "acc-task-meta", text: card.meta });
			// ⭐ 行尾「打开」（D-66）：位置固定在**状态文字之前**。
			if (options.onOpen && card.open) {
				const target = card.open;
				const link = row.createEl?.("a", {
					cls: "acc-task-open",
					text: card.openLabel?.trim() || options.labels.open?.trim() || "↗",
					attr: { href: "#", title: target.value },
				}) as unknown as { onclick?: (event?: { preventDefault?: () => void }) => void } | undefined;
				if (link) {
					link.onclick = (event) => {
						event?.preventDefault?.();
						options.onOpen?.(target);
					};
				}
			}
			const statusEl = row.createSpan?.({
				cls: `acc-task-status acc-task-status-${status}`,
				text: statusText(status),
			});
			rowRefs.set(card.id, { box: box ?? null, statusEl: statusEl ?? null });
		}

		// 还没画完 ⇒ 给一个"再显示 N 行"（分块画，而不是把剩下的丢掉）
		if (cards.length > drawn) {
			const more = listEl.createDiv?.({ cls: "acc-task-more" });
			const moreButton = more?.createEl?.("button", {
				text: options.labels.showMore(cards.length - drawn),
			}) as { addEventListener?: (type: string, handler: () => void) => void } | undefined;
			moreButton?.addEventListener?.("click", () => {
				drawn = Math.min(cards.length, drawn + ROW_DRAW_CHUNK);
				paintRows();
				updateControls();
			});
		}
	};

	/** 重置到"刚打开"的样子（首次与换清单共用）。 */
	const resetRows = (): void => {
		drawn = Math.min(cards.length, ROW_DRAW_CHUNK);
		paintRows();
		updateControls();
	};

	/** 换一份清单（外部换 / 过滤开关触发）：勾选与状态都按新清单重算。 */
	const replaceCards = (nextCards: readonly FileCard[], lines?: readonly string[]): void => {
		if (phase === "run") return;
		if (lines) paintLines(lines);
		cards = [...nextCards];
		statuses = new Map<string, TaskStatus>();
		selected = initialSelection(cards);
		resetRows();
	};

	/**
	 * 任一过滤开关变化：**清掉勾选与状态**（上一批的键不属于这一批）。
	 * ⚠️ 多个开关共用这一个入口 —— 每个开关各调一次重算会互相覆盖。
	 */
	const applyFilters = async (): Promise<void> => {
		if (phase === "run") return;
		const handler = options.onFiltersChange;
		if (!handler) return;
		let next: { cards: readonly FileCard[]; lines?: readonly string[] } = { cards: [] };
		try {
			next = await handler({ ...filterState });
		} catch {
			// 取数失败（笔记读不到 / 目录读不了）→ 当作空清单。
			// 绝不能抛出：那会让界面停在没有结果的中间态，点了确认也没反应。
			next = { cards: [] };
		}
		replaceCards(next.cards, next.lines);
	};

	/** 点按钮：先确认勾选，再（如果给了 `run`）就地开跑。 */
	const confirm = async (action?: string, idle?: boolean): Promise<void> => {
		if (phase === "run") return;
		const chosen = selectionInOrder(cards, selected);
		// ⚠️ 「一件都没勾」只能挡住**真要做事**的档：`idle` 在 0 勾选时仍是合法出口。
		if (chosen.length === 0 && !idle) return;
		if (idle || !options.run) {
			settle({ selected: chosen, ran: false, action });
			close();
			return;
		}

		phase = "run";
		runningTotal = chosen.length;
		statuses = new Map<string, TaskStatus>(chosen.map((key) => [key, "pending"] as const));
		paintRows();
		updateControls();
		try {
			await options.run(
				chosen,
				(key, status) => {
					statuses = setTaskStatus(statuses, key, status);
					updateStatus(key);
					updateControls();
				},
				action
			);
		} catch (error) {
			// 执行体意外失败 ⇒ 仍要把结果交回去，否则调用方会以为"用户取消了"。
			void error;
		} finally {
			runFinished = true;
			settled = true;
			settledResult = { selected: chosen, ran: true, action };
			paintRows();
			updateControls();
			// ⭐⭐ D-80（评审 3-1）：**不自动收起**。失败行留在清单里，用户看完自己关。
			showSettledFooter();
		}
	};

	/** 画按钮区（打开时调一次；完成态整块换掉）。 */
	const renderFooter = (): void => {
		if (!footerEl) return;
		if (options.actions && options.actions.length > 0) {
			const row = new Setting(footerEl);
			for (const action of options.actions) {
				row.addButton((button) => {
					actionButtons.push({ action, button });
					if (action.destructive) button.setDestructive?.();
					else if (action.primary) button.setCta?.();
					button.setButtonText(action.label(selected.size));
					button.onClick(() => {
						void confirm(action.key, action.idle);
					});
				});
			}
			// ⭐⭐ D-76：**多档动作也要有「取消」**，否则想退出只能 ESC / 点背景。
			new Setting(footerEl).addButton((button) => {
				cancelButton = button;
				button.setButtonText(options.labels.cancel).onClick(() => {
					if (phase === "run") return;
					settle(null);
					close();
				});
			});
		} else {
			// ⭐ 一件能勾的都没有（只有失效行）⇒ **只画一个「关闭」**（D-70）。
			// ⚠️ 必须**根本不创建**那颗按钮 —— `addButton(() => {})` 会留下一个空白按钮。
			const nothingToPick = selectableRows(cards).length === 0;
			const buttons = new Setting(footerEl);
			buttons.addButton((button) => {
				ctaButton = button;
				if (options.destructive) button.setDestructive?.();
				else button.setCta?.();
				button.onClick(() => {
					if (selectableRows(cards).length === 0) {
						settle({ selected: [], ran: false });
						close();
						return;
					}
					void confirm();
				});
			});
			if (!nothingToPick) {
				buttons.addButton((button) => {
					cancelButton = button;
					button.setButtonText(options.labels.cancel).onClick(() => {
						if (phase === "run") return;
						settle(null);
						close();
					});
				});
			}
		}
	};

	/**
	 * 完成态：按钮区**整块换成一颗「关闭」**（D-80）。
	 * ⚠️ 必须清空旧句柄：`updateControls()` 还活着，留着会往已销毁的按钮上写字。
	 */
	const showSettledFooter = (): void => {
		footerEl?.empty?.();
		ctaButton = null;
		cancelButton = null;
		actionButtons.length = 0;
		if (!footerEl) return;
		new Setting(footerEl).addButton((button) => {
			button.setCta?.();
			button.setButtonText(options.labels.close);
			button.onClick(() => {
				settle(settledResult);
				close();
			});
		});
	};

	// ⭐ 范围过滤（勾选项）：勾上 = 只看当前笔记。
	// ⚠️ 用 `addToggle` 而不是下拉：只有两个范围，勾选框一眼看得懂"我在看哪一份"。
	for (const item of options.filters ?? []) {
		new Setting(container)
			.setName(item.name)
			.addToggle((toggle) =>
				toggle.setValue(item.value).onChange((on) => {
					filterState[item.key] = on;
					void applyFilters();
				})
			);
	}

	new Setting(container)
		.addButton((button) =>
			button.setButtonText(options.labels.selectAll).onClick(() => {
				if (phase === "run") return;
				// ⚠️ 只选**能勾的**（D-70）：把不可选的行塞进 `selected`，症状是"界面灰着、提交里却有它"。
				selected = selectEverything(keysOf(selectableRows(cards)));
				syncChecks();
				updateControls();
			})
		)
		.addButton((button) =>
			button.setButtonText(options.labels.selectNone).onClick(() => {
				if (phase === "run") return;
				selected = new Set<string>();
				syncChecks();
				updateControls();
			})
		);

	renderFooter();
	resetRows();

	return {
		replaceCards,
		selection: () => selectionInOrder(cards, selected),
		/**
		 * 容器被外部关掉（ESC / 点背景 / 视图卸载）。
		 * ⚠️ 跑的过程中不交结果；完成态交**跑完的结果**（D-80），不是 `null`。
		 */
		handleContainerClose: (): void => {
			if (phase === "run") return;
			settle(settled ? settledResult : null);
		},
	};
}
