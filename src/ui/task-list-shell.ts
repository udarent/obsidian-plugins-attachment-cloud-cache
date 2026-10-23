/**
 * **清单壳（容器无关）**：一个列表 + 勾选 + 逐项进度 + 底部动作区。
 *
 * 两个容器共用这一份装配：
 * | 容器 | 谁在用 | 怎么收起 |
 * |---|---|---|
 * | `Modal`（弹窗） | 「上传附件」「清理附件」两条链 | `modal.close()` |
 * | `Modal`（附件管理，R24） | 五列清单 ＋ 五个动作 | `modal.close()`，且**跑完自己收起** |
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
import type { TaskListLabels, TaskProgress, TaskReporter, TaskStatus } from "./task-list";

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
	/**
	 * 清单**自己**那一行标题（画在清单正上方，与「全选 / 全不选」同一行）。
	 *
	 * ⚠️ 弹窗**不要**传：宿主 `Modal` 已经把 `title` 画在窗口顶上了，再来一行就是重复。
	 * 常驻视图没有这一层（标签页标题在别处、而且是固定不变的）⇒ 由它传。
	 */
	listHeading?: string;
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
	/**
	 * 跑完**立刻收起容器**，不进入完成态（D-80 的例外，2026-10-23）。
	 *
	 * ## 为什么允许有例外
	 *
	 * D-80（评审 3-1）定的是"跑完不关窗，失败行留在原地让人看"—— 这条对**一次性的短任务弹窗**
	 * （上传附件、清理附件）成立：用户本来就要关掉它才能继续。
	 *
	 * ⭐ 但**附件管理**是长任务工作台（几分钟、几十项），当它装在**弹窗**里时，"停留"就变成
	 * "一个挡着笔记、必须手动关掉的窗口"。⇒ 这种容器自己声明 `autoCloseOnFinish: true`，
	 * 由它负责把结果说出来（成 / 跳 / 败 ＋ 失败项点名），本壳只负责把
	 * {@link TaskListResult.progress} 与 {@link TaskListResult.failed} 交回去。
	 *
	 * ⚠️ **默认 false**：不给这一项就还是 D-80 的老行为。别把这条当成"更先进"顺手打开 ——
	 * 短任务弹窗关掉之后就只剩一条通知，而失败原因本来就在失败行上。
	 */
	autoCloseOnFinish?: boolean;
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
	/**
	 * 跑完的计数（成 / 跳 / 败）。只在这一趟真的跑过时给。
	 *
	 * ⭐ 给"跑完就把窗口收起来"的容器用（见 {@link TaskListOptions.autoCloseOnFinish}）：
	 * 窗口没了之后，调用方**只剩这份数字**能拿来说话。
	 */
	progress?: TaskProgress;
	/** 跑完**失败**的那些键（按清单顺序）。窗口收起后用来点名。 */
	failed?: string[];
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
 * 容器只负责"有地方画"，不参与任何判定 —— 所以三条链各开一个弹窗、共用同一份装配。
 *
 * ⭐ **版面顺序由创建顺序决定**（`container` 的子节点就是视觉顺序）：
 *
 * ```
 * 固定说明段        .acc-task-lines
 * 过滤开关（可选）  .acc-task-filters     ← 只在给了 `filters` 时存在
 * 进度              .acc-task-progress
 * ┌ 清单 .acc-task-list ────────────────────────────┐
 * │ ☑ 附件清单                      已选 3 / 18     │  .acc-task-headrow（粘在顶部）
 * │ ☐ 行…                                           │  .acc-task-row
 * └─────────────────────────────────────────────────┘
 * 空清单说明        .acc-task-empty
 * 动作区            .acc-task-actions
 * ```
 *
 * ⚠️⚠️ 标题栏在**清单里面**（滚动区的第一个子节点、`position: sticky`）：
 * 它原先建在容器最末（`new Setting(container)`）⇒ 被排到动作按钮**下面**，想全选得先滚过整个清单。
 * 搬出来之后又发现"在清单外面"仍会随页面滚走 ⇒ 现在是清单自己的表头，滚动时粘住。
 * **位置是结构，不是样式** —— 不要用 CSS `order` 去挪（DOM 顺序仍在说谎，读屏与 Tab 跟着错）。
 *
 * ⚠️ 全选是**一个三态复选框**（2026-10-23 用户要求），不是两颗按钮：
 * 全勾 / 半选（`indeterminate`）/ 全不勾都落在同一个控件上，与行的勾选框同一列、同一个读法。
 */
export function mountTaskListShell(
	container: HTMLElement,
	options: TaskListOptions,
	host: TaskListShellHost
): TaskListShell {
	let answered = false;
	/**
	 * 容器**已经被收起来了**（用户点的关闭 / 取消 / ESC / 点背景 / 视图卸载）。
	 *
	 * ⚠️ 跑的过程中也要置位：那时 `handleContainerClose()` 刻意**不交结果**（那一趟还在跑），
	 * 于是跑完必须由 `finally` 补交 —— 否则调用方的 `Promise` 永远悬着，也没人知道跑成了没有。
	 */
	let containerClosed = false;
	const settle = (value: TaskListResult | null): void => {
		if (answered) return;
		answered = true;
		host.settle(value);
	};
	const close = (): void => {
		containerClosed = true;
		host.requestClose();
	};

	/** 正文行整块重画（换范围时数字必须与清单对得上）。 */
	const linesEl = container.createDiv?.({ cls: "acc-task-lines" });
	const paintLines = (lines: readonly string[]): void => {
		linesEl?.empty?.();
		for (const line of lines ?? []) linesEl?.createDiv?.({ text: line });
	};
	paintLines(options.lines ?? []);

	/**
	 * 过滤开关（`Setting` 行）的容器。**建在这里是为了版面顺序**（在清单上方）；
	 * 里面那几行在函数末尾统一挂（它们要用 `filterState` 与 `applyFilters`）。
	 * 没有开关时**不建**这个容器 —— 否则会留一个空 div 撑出一点间距。
	 */
	const filtersEl = (options.filters?.length ?? 0) > 0 ? container.createDiv?.({ cls: "acc-task-filters" }) : null;

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
	/**
	 * 表头那颗**全选复选框**（三态）与右侧的「已选 N / 共 M」。
	 *
	 * ⚠️ 它们是**每次 `paintRows` 重建**的（`listEl.empty()` 会把表头一起清掉）⇒
	 * 每次重建都要重新赋值；`updateControls` 靠这两个句柄把状态刷回去。
	 * 这也是为什么它们**不能**像 `ctaButton` 那样只建一次。
	 */
	let headCheck:
		| {
				checked?: boolean;
				indeterminate?: boolean;
				disabled?: boolean;
				title?: string;
		  }
		| null = null;
	let headCount: { setText?: (text: string) => unknown } | null = null;
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
		/** 能勾的行（下面几处都要用它 —— ⚠️ 只算一次，别在几个分支里各算一遍）。 */
		const pickable = selectableRows(cards);
		emptyEl?.setText?.(cards.length === 0 ? options.labels.empty : "");

		if (phase === "run") {
			const progress = foldTaskProgress(statuses, runningTotal);
			progressEl?.setText?.(runFinished ? options.labels.finished(progress) : options.labels.running(progress));
		} else {
			progressEl?.setText?.("");
		}

		/**
		 * ⭐ 表头那颗复选框的**三态**：全勾 / 半选（`indeterminate`）/ 全不勾。
		 *
		 * ⚠️ 判据只此一份 —— 它是"选了多少"这件事的唯一算术，按钮与行都从它派生。
		 * ⚠️ 放在 `settled` 那道闸**之前**：完成态里 `phase` 仍是 `run` ⇒ 它保持灰着。
		 */
		if (headCheck) {
			let chosen = 0;
			for (const row of pickable) if (selected.has(row.id)) chosen += 1;
			headCheck.checked = pickable.length > 0 && chosen >= pickable.length;
			headCheck.indeterminate = chosen > 0 && chosen < pickable.length;
			headCheck.disabled = phase === "run" || pickable.length === 0;
			// 悬停说明说清"点它会发生什么"：已全勾 ⇒ 全不选；否则 ⇒ 全选。
			headCheck.title = headCheck.checked ? options.labels.selectNone : options.labels.selectAll;
		}
		headCount?.setText?.(options.labels.selectedCount?.(selected.size, cards.length) ?? "");

		// ⚠️ 完成态的按钮由 `showSettledFooter()` 独占：这里再改一次会把「关闭」改回主按钮并启用它。
		if (settled) return;

		if (pickable.length === 0) {
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

	/** 把勾选状态同步到**已画出来的**行上（表头那颗全选复选框改完用它）。 */
	const syncChecks = (): void => {
		for (const [key, ref] of rowRefs) {
			if (ref.box) ref.box.checked = selected.has(key);
		}
	};

	/**
	 * 画**表头**（清单的第一个子节点，`position: sticky` ⇒ 滚到哪儿都在）。
	 *
	 * ⚠️ 每次 `paintRows` 都要重画（`listEl.empty()` 把它一起清掉），句柄在这里重新赋值。
	 *
	 * ⚠️⚠️ 复选框**放在标题左边**、与每一行的勾选框同一列：这是主流表格的读法 ——
	 * "全选"不是一个动作按钮，而是**同一列的最上面那一格**。它有三态：
	 * 全勾 / 半选 / 全不勾，状态由 `updateControls` 统一算（判据只此一份）。
	 */
	const paintHead = (): void => {
		headCheck = null;
		headCount = null;
		if (!listEl) return;
		const head = listEl.createDiv?.({ cls: "acc-task-headrow" });
		if (!head) return;

		const box = head.createEl?.("input", {
			// ⚠️ **不复用** `acc-task-check`：`.acc-task-check` 在界面与脚本里的意思是
			// "**行**的勾选框"（"勾了几行""全选能勾的"都按它数）。表头这颗也算进去的话，
			// 任何一处 `querySelectorAll(".acc-task-check")` 都会把"全选"当成第一行 ——
			// 实测就撞过：脚本点 `boxes[0]` 想勾一行，结果点的是全选，断言因别的原因变红。
			cls: "acc-task-check-all",
			attr: {
				type: "checkbox",
				// 读屏念"全选"；三态里的半选由 `indeterminate` 自己表达（aria 会念成 mixed）
				"aria-label": options.labels.selectAll,
			},
		}) as
			| {
					checked?: boolean;
					indeterminate?: boolean;
					disabled?: boolean;
					title?: string;
					addEventListener?: (type: string, handler: () => void) => void;
			  }
			| undefined;
		if (box) {
			box.addEventListener?.("change", () => {
				if (phase === "run") return;
				// ⚠️ 读 `checked`（浏览器已经把 indeterminate 清掉并翻成 true/false）：
				// 勾上 ⇒ 全选**能勾的**（D-70：不可选的行不进 `selected`）；取消 ⇒ 清空。
				selected = box.checked ? selectEverything(keysOf(selectableRows(cards))) : new Set<string>();
				syncChecks();
				updateControls();
			});
			headCheck = box;
		}

		if (options.listHeading) head.createDiv?.({ cls: "acc-task-heading", text: options.listHeading });
		headCount = head.createDiv?.({ cls: "acc-task-count" }) ?? null;
	};

	/** 画清单 —— **只在**换范围 / 开跑 / 点"再显示"时调用。 */
	const paintRows = (): void => {
		if (!listEl) return;
		listEl.empty?.();
		rowRefs.clear();
		paintHead();

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
			/**
			 * ⚠️ 整趟抛了：**没上报的那些必须有个结论**。
			 *
			 * 不标的话它们停在 `pending` ⇒ 进度停在 `0/N`；而容器一旦"跑完就收起"
			 * （{@link TaskListOptions.autoCloseOnFinish}），用户看到的通知会是
			 * 「完成 0、跳过 0、失败 0」—— **一次都没做成，却报了个全零**。
			 * 标成 `failed` 是诚实的：这些确实没做成，而且可以重试。
			 * 已经上报过的（done / skipped / failed）**不动**：那些是执行体自己说的话。
			 */
			for (const key of chosen) {
				const current = statuses.get(key);
				if (current === undefined || current === "pending" || current === "running") {
					statuses = setTaskStatus(statuses, key, "failed");
				}
			}
		} finally {
			runFinished = true;
			const progress = foldTaskProgress(statuses, runningTotal);
			const failed = chosen.filter((key) => statuses.get(key) === "failed");
			settledResult = { selected: chosen, ran: true, action, progress, failed };

			/**
			 * ⚠️⚠️ **容器在跑的过程中被关掉了**（手机返回键 / ESC / 点背景）。
			 *
			 * 原来这种情况下 `handleContainerClose()` 什么都不交（那一趟还在跑），于是
			 * 跑完之后**没有人**交结果 ⇒ 容器的 `Promise` 永远悬着、也没人告诉用户跑成了没有。
			 * 现在是：跑完补交一次结果（调用方据此发通知），界面不再回来。
			 */
			settled = true;
			if (options.autoCloseOnFinish || containerClosed) {
				// 先交结果再收容器：调用方要在窗口消失**之前**拿到数字（它只剩这些能说话）。
				settle(settledResult);
				if (!containerClosed) close();
			} else {
				paintRows();
				updateControls();
				// ⭐⭐ D-80（评审 3-1）：**不自动收起**。失败行留在清单里，用户看完自己关。
				showSettledFooter();
			}
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
	// ⚠️ 挂在 `filtersEl`（清单**上方**那个容器）上，不是 `container` —— 见函数头那张版面表。
	for (const item of options.filters ?? []) {
		if (!filtersEl) break;
		new Setting(filtersEl)
			.setName(item.name)
			.addToggle((toggle) =>
				toggle.setValue(item.value).onChange((on) => {
					filterState[item.key] = on;
					void applyFilters();
				})
			);
	}

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
			// ⚠️ 这里也要置位：ESC / 点背景 / 视图卸载都不经过 `close()`。
			containerClosed = true;
			if (phase === "run") return;
			settle(settled ? settledResult : null);
		},
	};
}
