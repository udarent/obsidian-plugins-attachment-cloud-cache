/**
 * **清单式弹窗**：两条"列出一批、勾一批、逐个处理"的链共用这一个壳。
 *
 * | 入口 | 列的是什么 | 勾选后干什么 |
 * |---|---|---|
 * | 上传附件 | 库内被引用的附件 + 库内没有被引用的附件 + 笔记里的站外图 + 库外本机文件 | 上传并改写链接 |
 * | 清理附件 | 台账里我们上传过、而本库已看不见引用的对象（**台账口径**，不列桶）＋ **没有任何引用的本地文件**（D-74）＋ **站外缓存下来的本地副本**（D-77） | 三档：保留 / 只删本地文件 / 连本地带云端一起删 |
 *
 * ⚠️ 曾经还有两行，现在都没了：
 * - 「挑选要缓存的文件」—— 2026-10-22 并入「上传附件」（D-68），于是"当前笔记 / 全库"的
 *   范围切换也跟着搬了过来（现在是清单上方的勾选项，见 {@link TaskListFilter}）；
 * - 「清理云端未使用对象…」（列**整个桶**）—— 2026-10-16 退役：候选并入「检查未被引用的
 *   云端附件」，站外缓存那条排除也随之一并搬过去（见 `maintenance/orphan-watch.ts`）。
 *
 * ## 为什么统一（2026-10-15 用户提的）
 *
 * 四处（当时）在此之前是**四种样子**：一个只有勾选框、一个只有缩略图、一个连缩略图都没有
 * （只有一行行路径文字）、还有一个是三选一弹窗。用户逐项核对、控制范围、看进展
 * 这三件事**每一处都该有**，所以壳只有这一个：**缩略图 + 勾选（含全选/全不选）+ 进度**。
 *
 * ## ⚠️⚠️ 性能：几千个条目也不能卡（用户 2026-10-15 提醒）
 *
 * 三条纪律，改动这一层时别破坏：
 *
 * 1. **分块画**（{@link ROW_DRAW_CHUNK}）：一次最多画 200 行，其余靠"再显示 N 行"接着画。
 *    ⚠️ 它**只管画** —— 勾选范围、要处理的范围、进度的分母全按**整个清单**算，
 *    "没画出来的行"照样会被处理（这是"分块画"，不是"截断候选"）。
 * 2. **勾选与进度都只改该改的地方**：勾一行只更新按钮文案（O(1)），
 *    一项跑完只改**那一行**的状态文字（O(1)）。全量重画只在"换范围 / 开跑 / 再显示"时发生。
 * 3. **缩略图不许用原生懒加载**：`renderThumb` 刻意**没有** `loading="lazy"`
 *    —— 它在宿主的弹窗容器里会"永远不加载"（`transform`/`opacity` 动画搅乱滚动根判定），
 *    而"分块画"已经把"一次建多少 `<img>`"限住了。理由与代价写在 `file-cards.ts::renderThumb`。
 *
 * ## ⚠️ 这一层"点不了"，所以写法刻意保守
 *
 * 宿主的 `Modal` 在测试里没有可编程的 DOM（替身的 `Setting.addButton` 是**空操作**，
 * 回调都不会被调用），所以这里的每一行都只能靠**真机验证**。因此：
 * - 所有宿主 DOM 调用都带 `?.`（宿主版本差异时宁可少画一个控件，也不要整条链路崩）；
 * - **能不能穷举的部分一律不在这一层**：行怎么算（`planFileCards`）、勾选怎么算
 *   （`external-picker-logic.ts`）、进度怎么折叠（`task-list.ts`）都在纯模块里，有套件与锚点钉着；
 * - 状态**只有一份**（`selected` / `statuses`），界面由它派生 —— 不把状态藏在 DOM 里，避免"显示 A、提交 B"。
 */

import { Modal, Setting, setIcon } from "obsidian";
import type { App } from "obsidian";

import { selectEverything, toggleSelection } from "./selection-logic";
import type { FileCardOpenTarget } from "./file-cards";
import { renderThumb } from "./file-cards";
import type { FileCard } from "./file-cards";
import { type TaskListLabels, type TaskReporter, foldTaskProgress, selectionInOrder, setTaskStatus } from "./task-list";
import type { TaskStatus } from "./task-list";

/** 一次最多画多少行（见文件头的性能纪律）。 */
const ROW_DRAW_CHUNK = 200;

/**
 * 清单行的键 = `FileCard.id`；而勾选那两个函数按 `{ key }` 收口
 * （它们是挑图那条链先长出来的，键的语义在那边是 `pickKey`）。
 * 一行适配，比让"哪些行算勾中"多出一份判据要好。
 */
function keysOf(rows: readonly FileCard[]): { key: string }[] {
	return rows.map((row) => ({ key: row.id }));
}

/**
 * 只有**能勾**的行（`selectable === false` 的那些不参与勾选，D-70）。
 *
 * ⚠️ 全选、默认勾选、`initialSelection` **三处都必须先过这一道**：
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
 * 只藏行就不知道"看到的是不是全部"（且另一些调用方的正文确实带数字）——
 * 摘要说 12 个而清单只有 3 行，用户会按一份自相矛盾的清单点确认
 *（本项目最忌"一处硬一处软"）。所以 `apply` 交出**新的清单与新的正文**。
 *
 * ⚠️ 切换范围会**重置勾选**（按新范围的默认值重算，与"换范围"的语义一致）——
 * 不清的话，切到当前笔记之后上一批看不见的行仍然勾着、仍会被处理（显示 A、提交 B）。
 *
 * ⚠️ 曾经是个**下拉**（`TaskListScope`，挑图那条链用它切三档）。2026-10-22 用户要求
 * 改成勾选项（只有两个范围，勾上 = 只看当前笔记）。
 */
export interface TaskListFilter {
	/** 稳定键：`onFiltersChange` 收到的状态按它索引（多个开关时唯一标识一个）。 */
	key: string;
	/** 勾选框的文案（`Setting.setName`）。 */
	name: string;
	/** 打开时是否勾上。 */
	value: boolean;
}

/**
 * 一档**动作**（按钮）。给"同一个清单、几种处理方式"的场景用 —— 典型是孤儿那条命令：
 * 保留 / 只删本地副本 / 云端与本地一起删。
 *
 * ⚠️ 各档的风险等级必须与视觉等级**一一对应**（见 `cloud-delete-modal.ts` 的设计理由）：
 * 不可恢复的那一档才 `destructive`，而**保守**（什么都不做）的那一档才 `primary`。
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
}

export interface TaskListOptions {
	title: string;
	/** 正文行（背景、风险、代价）—— 逐行画在清单上方。给了 `filter` 时它是**初始**那批。 */
	lines?: readonly string[];
	cards: readonly FileCard[];
	/**
	 * 范围 / 类别过滤开关（可多个，各自一个勾选框）。
	 *
	 * ⚠️ 多个开关**只调一次**重算回调（`onFiltersChange`）—— 每个开关各返回一份行
	 * 会互相覆盖（一行只能有一份清单）。`onFiltersChange` 收到的是**全部开关的当前状态**。
	 */
	filters?: readonly TaskListFilter[];
	/**
	 * 任一开关变化时重算清单与正文。不给 = 只改状态、清单不动（那多半是写错了）。
	 *
	 * `lines` 不给 = 正文保持不变。抛错当作空清单
	 *（不能把弹窗卡在没有结果的中间态，用户点确认会没反应）。
	 */
	onFiltersChange?: (
		state: Readonly<Record<string, boolean>>
	) => Promise<{ cards: readonly FileCard[]; lines?: readonly string[] }>;
	labels: TaskListLabels;
	/**
	 * 多档动作（按钮）。给了就不画"主按钮 + 取消"那一对，改成一档一个按钮。
	 * 缺省 = 单一主按钮（三条"勾完就干一件事"的链用这个）。
	 */
	actions?: readonly TaskListAction[];
	/** 默认勾选：`all`（默认）或 `none`。 */
	defaultSelected?: "all" | "none";
	/**
	 * 只勾**这些**（D-68）：不给 = 全勾；与 `defaultSelected: "none"` 同时给时后者优先。
	 *
	 * ⭐ 用途是「大而全的上传」：清单里同时有"被引用"与"没有被任何笔记引用"的文件，
	 * 后者默认**不勾**（传上去不会出现在任何笔记里，得用户自己决定）。
	 * ⚠️ 传进来的键**不在当前清单里**时静默忽略（换范围 / 清单变短时不该报错）。
	 */
	initiallySelected?: readonly string[];
	/**
	 * 主按钮是不是**不可撤销**的动作（删除类）。仅在没给 `actions` 时生效。
	 *
	 * ⚠️ 这不是样式偏好：它是用户按下那个按钮前**唯一**读到的安全信号
	 * （宿主的 `setDestructive()` 会把它染成警示色）。本项目在真机上量过一次
	 * "破坏性按钮与普通按钮逐项相同"，所以这条判据有真机验证链条盯着。
	 */
	destructive?: boolean;
	/**
	 * 点按钮之后跑的事。不传 = **只做选择**（返回值就是结果）。
	 * 跑的过程中用 `report` 上报逐项状态；抛错也算跑完（调用方负责报告失败）。
	 * `action` 是用户点的那一档（没给 `actions` 时是 `undefined`）。
	 */
	run?: (selected: readonly string[], report: TaskReporter, action?: string) => Promise<void>;
	/**
	 * 点行尾「打开」时去哪（D-66）。**不传就不画链接**。
	 *
	 * ⚠️ 由装配点注入（`main.ts::pickTasks` 转调 `openCardTarget`）：弹窗层不进单测，
	 * 而"库内文件 / 站外地址"的打开方式差别在那边一处说清。
	 */
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

/** 复选框与状态文字的句柄（`setText`/`setAttribute` 都当可选的：宿主版本差异时少改一处，不要崩）。 */
interface RowRef {
	box: { checked?: boolean; disabled?: boolean } | null;
	statusEl: { setText?: (text: string) => unknown; setAttribute?: (name: string, value: string) => unknown } | null;
}

/** 开弹窗。**取消 / 直接关掉**（点背景、ESC）返回 `null`。 */
export function askTaskList(app: App, options: TaskListOptions): Promise<TaskListResult | null> {
	return new Promise((resolve) => {
		let answered = false;
		const finish = (value: TaskListResult | null): void => {
			if (answered) return;
			answered = true;
			resolve(value);
		};

		const modal = new Modal(app);
		modal.titleEl?.setText?.(options.title);
		const content = modal.contentEl;

		/**
		 * 正文行装在一个容器里（而不是逐个 append 到 `content`）：换范围时**整块重画**，
		 * 于是清单上方的数字永远与清单本身对得上（见 {@link TaskListFilter}）。
		 */
		const linesEl = content?.createDiv?.({ cls: "acc-task-lines" });
		const paintLines = (lines: readonly string[]): void => {
			linesEl?.empty?.();
			for (const line of lines ?? []) linesEl?.createDiv?.({ text: line });
		};
		paintLines(options.lines ?? []);

		let cards: FileCard[] = [...(options.cards ?? [])];
		/** 过滤开关的当前状态（`key` → 勾没勾）。⚠️ 只有这一份，界面由它派生。 */
		const filterState: Record<string, boolean> = {};
		for (const item of options.filters ?? []) filterState[item.key] = item.value;
		/**
		 * 默认勾选（首次打开与换范围共用**一份**判据）：
		 * `none` ⇒ 空；给了 `initiallySelected` ⇒ 只勾交集；都没给 ⇒ 全勾。
		 *
		 * ⚠️ 一律只从**能勾的**行里取（`selectable === false` 的行不参与，见 `selectableRows`）。
		 */
		const initialSelection = (rows: readonly FileCard[]): Set<string> => {
			if (options.defaultSelected === "none") return new Set<string>();
			const pickable = keysOf(selectableRows(rows));
			if (!options.initiallySelected) return selectEverything(pickable);
			const allowed = new Set(options.initiallySelected);
			return new Set(pickable.map((row) => row.key).filter((key) => allowed.has(key)));
		};
		/** ⚠️ 勾选状态**只有这一份**。 */
		let selected: Set<string> = initialSelection(cards);
		/** 逐项状态（只放**勾中的**那些：没勾的不属于这一趟）。 */
		let statuses: ReadonlyMap<string, TaskStatus> = new Map<string, TaskStatus>();
		let phase: "pick" | "run" = "pick";
		/** 进度分母 = **交给这一趟**的件数（不是清单行数，见 `task-list.ts` 文件头）。 */
		let runningTotal = 0;
		/**
		 * 这一趟**跑完了没有**。
		 *
		 * ⚠️ 不能拿 `finished >= total` 代替：逐项循环跑完时改写/收尾还在继续
		 * （上传那条链就是"先逐个上传、再统一改写、最后删重复副本"）——
		 * 那时报"已结束"是在替用户描述一件还没发生的事。
		 */
		let runFinished = false;
		/**
		 * 跑完了、界面停在**完成态**（D-80，评审 3-1）。
		 *
		 * ## 为什么不再自动关窗
		 *
		 * 原来 `finally` 里 `modal.close()`：**哪几项失败、为什么失败，用户再也看不到** ——
		 * 结果只剩一条计数通知（而通知会自己消失）。而「失败的那几行」正是他接下来要处理的
		 * 东西（重试 / 去改链接 / 换一篇笔记）。
		 * ⇒ 现在停在完成态：清单留着（失败行带状态文字）、顶部那行变成成/跳/败的计数、
		 * 按钮区只剩一颗「关闭」。用户看完自己关。
		 */
		let settled = false;
		/** 完成态要交回去的结果（点「关闭」或按 ESC 时交它，而不是交 `null`）。 */
		let settledResult: TaskListResult | null = null;
		/** 已经画出来的行数（"再显示 N 行"每点一次加一块）。 */
		let drawn = 0;
		/** 行句柄（进度上报只改那一行，见文件头的性能纪律）。 */
		const rowRefs = new Map<string, RowRef>();

		const progressEl = content?.createDiv?.({ cls: "acc-task-progress" });
		const listEl = content?.createDiv?.({ cls: "acc-task-list" });
		const emptyEl = content?.createDiv?.({ cls: "acc-task-empty" });
		/**
		 * 按钮区单独一个容器 —— **完成态要整块换掉**（D-80）。
		 *
		 * 不这么做的话跑完之后只能改按钮文字：`取消` 与 `关闭` 会并排出现，而那时它们
		 * 做的是同一件事（用户会以为自己点错了）。整块重画是唯一能保证「完成态只有一颗按钮」
		 * 的写法。
		 */
		const footerEl = content?.createDiv?.({ cls: "acc-task-actions" });
		let ctaButton: { setButtonText?: (text: string) => unknown; setDisabled?: (value: boolean) => unknown } | null = null;
		let cancelButton: { setDisabled?: (value: boolean) => unknown } | null = null;
		/** 多档动作的按钮句柄（每档的文案都跟着勾选数走）。 */
		const actionButtons: {
			action: TaskListAction;
			button: { setButtonText?: (text: string) => unknown; setDisabled?: (value: boolean) => unknown };
		}[] = [];

		const statusText = (status: TaskStatus): string => {
			if (status === "done") return options.labels.statusDone;
			if (status === "failed") return options.labels.statusFailed;
			if (status === "skipped") return options.labels.statusSkipped;
			// `running` 用省略号：它不是一个"状态词"，是一次正在发生的事
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

			// ⚠️ 完成态的按钮由 `showSettledFooter()` 独占：这里再改一次，会把
			// 「关闭」改成「上传并改写链接 (3)」并**启用**它 ⇒ 用户以为还能再传一遍。
			if (settled) return;

			// ⭐ 一件能勾的都没有 ⇒ 主按钮退回成「关闭」（D-70）：那种清单只有"失效、只能
			// 打开笔记去修"的行，按钮一直灰着会让用户找不到出口。
			if (selectableRows(cards).length === 0) {
				ctaButton?.setButtonText?.(options.labels.close);
				ctaButton?.setDisabled?.(phase === "run");
			} else {
				ctaButton?.setButtonText?.(options.labels.cta(selected.size));
				ctaButton?.setDisabled?.(phase === "run" || selected.size === 0);
			}
			cancelButton?.setDisabled?.(phase === "run");
			// 多档动作：每一档的文案都跟着勾选数；"保留"那一档没有东西可做但仍然有意义 ⇒ 不禁用
			for (const item of actionButtons) {
				item.button.setButtonText?.(item.action.label(selected.size));
				item.button.setDisabled?.(phase === "run" || (selected.size === 0 && !item.action.idle));
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

		/** 把勾选状态同步到**已画出来的**行上（全选/全不选用它，O(已画行数)）。 */
		const syncChecks = (): void => {
			for (const [key, ref] of rowRefs) {
				if (ref.box) ref.box.checked = selected.has(key);
			}
		};

		/**
		 * 画清单 —— **只在**换范围 / 开跑 / 点"再显示"时调用（别在勾选或进度上报里调，见文件头）。
		 */
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
					// ⭐ 读屏（D-80，评审 3-3）：裸 checkbox 只会被读成「复选框」，用户不知道
					// 这一行是什么。用行名当标签 —— ⚠️ 用 `aria-label` 而不是 `<label for>`：
					// 后者需要 id，而这一层不生成 id（生造 id 会和多实例的弹窗撞车）。
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
					// 开跑之后不许再改勾选 —— 界面与"正在处理的那一批"必须一致；
					// **不能勾的行**（`selectable === false`，D-70）从头就禁用。
					if (phase === "run" || card.selectable === false) box.disabled = true;
					box.addEventListener?.("change", () => {
						if (phase === "run") return;
						selected = toggleSelection(selected, card.id);
						// ⚠️ 只更新按钮/进度那句，不重画清单（勾一行是 O(1) 的事）
						updateControls();
					});
				}

				renderThumb(row, card);
				// 名字与副标题各占一行（这一层点不了、没有断言钉 DOM 形状，所以可以包一层排版）
				const text = row.createSpan?.({ cls: "acc-task-text" });
				// ⚠️ 名字与行内标签要在**同一行**（`acc-task-text` 是纵向 flex）⇒ 外面再包一行。
				// 包里 `?? text`：替身没有 `createSpan` 时退化成直接挂在 `text` 上（少一层排版，不少内容）。
				const head = text?.createSpan?.({ cls: "acc-task-head" }) ?? text;
				head?.createSpan?.({ cls: "acc-task-name", text: card.label });
				// ⭐ 行内小标签（D-68 / D-71）：有 `hintIcon` 就**只画图标**，`hint` 当悬停说明。
				// ⚠️ 这一层以前**根本没画 `hint`** —— D-68 的「没有笔记引用」只在只读清单里出现，
				// 而上传清单走的是这里 ⇒ 用户看到的只有"默认没勾"，看不出为什么。
				if (card.hintIcon) {
					const mark = head?.createSpan?.({
						cls: "acc-task-hint-icon",
						attr: { title: card.hint, "aria-label": card.hint },
					});
					// ⚠️ `setIcon` 只在真机（有 DOM）上有意义 —— 这一层本来就不进单测；
					// 拿不到它时那一行只是少个图标，不会崩（`?.` 兜着）。
					if (mark) setIcon(mark, card.hintIcon);
				} else if (card.hint) {
					head?.createSpan?.({ cls: "acc-task-hint", text: card.hint });
				}
				if (card.meta) text?.createSpan?.({ cls: "acc-task-meta", text: card.meta });
				// ⭐ 行尾「打开」（D-66）：位置固定在**状态文字之前**，名字/副标题那一块
				// 仍是 `acc-task-text` —— 勾选与进度都是按行句柄更新的，这里只多一个静态节点。
				// ⚠️ 行自己的文案优先（失效附件那一行去的是**笔记**，D-70）。
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

		/** 重置到"刚打开"的样子（首次与换范围共用）。 */
		const resetRows = (): void => {
			drawn = Math.min(cards.length, ROW_DRAW_CHUNK);
			paintRows();
			updateControls();
		};

		/**
		 * 任一过滤开关变化：**清掉勾选与状态**（上一批的键不属于这一批）。
		 *
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
				// 绝不能抛出：那会让弹窗停在没有结果的中间态，点了确认也没反应。
				next = { cards: [] };
			}
			// 正文与清单**同一批**（摘要里的数字必须与下面几行对得上）
			if (next.lines) paintLines(next.lines);
			cards = [...next.cards];
			statuses = new Map<string, TaskStatus>();
			// 换范围后与首次打开**同一份**默认（全勾 / 只勾指定 / 全不勾）——
			// 两处各写一遍就会"第一次打开勾了 3 个、换个范围全勾上了"
			selected = initialSelection(cards);
			resetRows();
		};

		/** 点按钮：先确认勾选，再（如果给了 `run`）就地开跑。`action` 是多档动作里用户点的那一档。 */
		const confirm = async (action?: string, idle?: boolean): Promise<void> => {
			if (phase === "run") return;
			const chosen = selectionInOrder(cards, selected);
			// ⚠️ 「一件都没勾」只能挡住**真要做事**的档：`idle`（如“保留”）在 0 勾选时
			// 仍然是一个合法的出口（“我看完了”）—— 否则那个按钮点下去**一点反应都没有**
			//（D-76：用户把勾选全部取消之后，这就是唯一剩下的出口）。
			if (chosen.length === 0 && !idle) return;
			// 「什么都不做」那一档（如"保留"）：不跑 `run`，把勾选结果交回调用方
			if (idle || !options.run) {
				finish({ selected: chosen, ran: false, action });
				modal.close();
				return;
			}

			phase = "run";
			runningTotal = chosen.length;
			// 只把**勾中的**那些放进状态表：没勾中的行不属于这一趟
			statuses = new Map<string, TaskStatus>(chosen.map((key) => [key, "pending"] as const));
			// 开跑时重画一次（要把勾选框禁掉、把状态列初始化）
			paintRows();
			updateControls();
			try {
				await options.run(
					chosen,
					(key, status) => {
						statuses = setTaskStatus(statuses, key, status);
						// ⚠️ 只改那一行 + 进度那句（一次上报 O(1)，几千个条目也不卡）
						updateStatus(key);
						updateControls();
					},
					action
				);
			} catch (error) {
				// 跑的过程抛出（调用方自己的执行体意外失败）⇒ 仍然要把结果交回去并关窗，
				// 否则调用方会以为"用户取消了"而丢掉已经做掉的那些。
				void error;
			} finally {
				runFinished = true;
				settled = true;
				settledResult = { selected: chosen, ran: true, action };
				paintRows();
				updateControls();
				// ⭐⭐ 2026-10-22（D-80，评审 3-1）：**不关窗**。
				// 失败的那几行留在清单里（带状态文字），顶部那行是成/跳/败的计数 ——
				// 用户要处理的就是它们，而关掉窗之后只剩一条会自己消失的通知。
				showSettledFooter();
			}
		};

		/** 画按钮区（打开时调一次；完成态整块换掉，见 `showSettledFooter`）。 */
		const renderFooter = (): void => {
			if (!footerEl) return;
			// 多档动作：一档一个按钮（顺序即调用方给的顺序）
			if (options.actions && options.actions.length > 0) {
				const row = new Setting(footerEl);
				for (const action of options.actions) {
					row.addButton((button) => {
						actionButtons.push({ action, button });
						// ⚠️ 风险等级与视觉等级一一对应（见 `TaskListAction`）
						if (action.destructive) button.setDestructive?.();
						else if (action.primary) button.setCta?.();
						button.setButtonText(action.label(selected.size));
						button.onClick(() => {
							void confirm(action.key, action.idle);
						});
					});
				}
				// ⭐⭐ 2026-10-22（D-76）：**多档动作也要有「取消」**。
				// 原来这一支只画那几个动作按钮，想退出只能 ESC / 点背景 ——
				// 而另一条命令（「上传附件」）有一颗明确的「取消」 ⇒ 两屏不是一个产品。
				new Setting(footerEl).addButton((button) => {
					cancelButton = button;
					button.setButtonText(options.labels.cancel).onClick(() => {
						if (phase === "run") return;
						finish(null);
						modal.close();
					});
				});
			} else {
				// ⭐ 一件能勾的都没有（只有失效行）⇒ **只画一个「关闭」**：那种清单没有可执行的动作，
				// 再画一个「取消」就是两个一模一样的出口（D-70）。
				// ⚠️ 必须**根本不创建**那颗按钮 —— `addButton(() => {})` 会留下一个空白按钮。
				const nothingToPick = selectableRows(cards).length === 0;
				const buttons = new Setting(footerEl);
				buttons.addButton((button) => {
					ctaButton = button;
					// ⭐ 不可撤销的动作必须**看得出来**（理由见 `TaskListOptions.destructive`）
					if (options.destructive) button.setDestructive?.();
					else button.setCta?.();
					button.onClick(() => {
						// 没有可勾的行 ⇒ 这一下就是"我看完了"（不跑 `run`）
						if (selectableRows(cards).length === 0) {
							finish({ selected: [], ran: false });
							modal.close();
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
							finish(null);
							modal.close();
						});
					});
				}
			}
		};

		/**
		 * 完成态：按钮区**整块换成一颗「关闭」**（D-80）。
		 *
		 * ⚠️ 必须清空 `ctaButton` / `cancelButton` / `actionButtons`：`updateControls()`
		 * 还活着（窗没关），留着旧句柄就会往**已经销毁**的按钮上写字。
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
					finish(settledResult);
					modal.close();
				});
			});
		};
		if (content) {
			// ⭐ 范围过滤（勾选项，2026-10-22）：勾上 = 只看当前笔记。
			// ⚠️ 用 `addToggle` 而不是下拉：只有两个范围，勾选框一眼看得懂"我在看哪一份"，
			// 也不会让用户以为这是第三个处理档位。
			for (const item of options.filters ?? []) {
				new Setting(content)
					.setName(item.name)
					.addToggle((toggle) =>
						toggle.setValue(item.value).onChange((on) => {
							filterState[item.key] = on;
							void applyFilters();
						})
					);
			}

			new Setting(content)
				.addButton((button) =>
					button.setButtonText(options.labels.selectAll).onClick(() => {
						if (phase === "run") return;
						// ⚠️ 只选**能勾的**（D-70）：把不可选的行也塞进 `selected`，
						// 症状是"界面灰着、提交里却有它"。
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
		}

		// 直接关掉（ESC / 点外部）也算取消 —— 否则 `await` 会永远挂着。
		// ⚠️ **跑的过程中不算**：那一趟已经开始了，关窗只是把界面收起来，
		// 结果仍会由 `confirm` 交回去（否则调用方会以为"用户取消了"而丢掉刚上传的东西）。
		const originalOnClose = modal.onClose?.bind(modal);
		modal.onClose = () => {
			originalOnClose?.();
			if (phase === "run") return;
			// ⭐ 完成态下按 ESC / 点背景关窗，要交**跑完的结果**（D-80）：
			// 交 `null` 等于告诉调用方「用户取消了」，而那一趟其实已经做完了 ——
			// 调用方会因此把刚做完的事当成没发生（比如不再报那句完成）。
			finish(settled ? settledResult : null);
		};

		renderFooter();
		resetRows();
		modal.open();
	});
}
