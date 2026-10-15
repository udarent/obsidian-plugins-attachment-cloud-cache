/**
 * **清单式弹窗**：四条"列出一批、勾一批、逐个处理"的链共用这一个壳。
 *
 * | 入口 | 列的是什么 | 勾选后干什么 |
 * |---|---|---|
 * | 上传已有附件 | 库内被引用的附件 + 笔记里的站外图 + 库外本机文件 | 上传并改写链接 |
 * | 清理云端空间 | 桶里没人引用的对象 | 删掉云端对象 |
 * | 检查未引用的云端附件 | 我们传过、而本库已看不见引用的对象 | 三档：保留 / 只删本地副本 / 一起删 |
 * | 挑选要缓存的文件 | 某个范围里的站外图 / 本机文件（可切范围） | 缓存勾中的那些 |
 *
 * ## 为什么统一（2026-10-15 用户提的）
 *
 * 四处在此之前是**四种样子**：一个只有勾选框、一个只有缩略图、一个连缩略图都没有
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

import { Modal, Setting } from "obsidian";
import type { App } from "obsidian";

import { selectEverything, toggleSelection } from "./external-picker-logic";
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

/** 可选的"范围"下拉（挑图那条用它切换当前笔记 / 全库）。 */
export interface TaskListScope {
	name: string;
	options: readonly { value: string; label: string }[];
	value: string;
	/** 切换后交出**新的**行；失败（读不到）当作空清单。 */
	onChange: (value: string) => Promise<readonly FileCard[]>;
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
	/** 正文行（背景、风险、代价）—— 逐行画在清单上方。 */
	lines?: readonly string[];
	cards: readonly FileCard[];
	scope?: TaskListScope;
	labels: TaskListLabels;
	/**
	 * 多档动作（按钮）。给了就不画"主按钮 + 取消"那一对，改成一档一个按钮。
	 * 缺省 = 单一主按钮（三条"勾完就干一件事"的链用这个）。
	 */
	actions?: readonly TaskListAction[];
	/** 默认勾选：`all`（默认）或 `none`。 */
	defaultSelected?: "all" | "none";
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

		for (const line of options.lines ?? []) content?.createDiv?.({ text: line });

		let cards: FileCard[] = [...(options.cards ?? [])];
		/** ⚠️ 勾选状态**只有这一份**。 */
		let selected: Set<string> =
			options.defaultSelected === "none" ? new Set<string>() : selectEverything(keysOf(cards));
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
		/** 已经画出来的行数（"再显示 N 行"每点一次加一块）。 */
		let drawn = 0;
		/** 行句柄（进度上报只改那一行，见文件头的性能纪律）。 */
		const rowRefs = new Map<string, RowRef>();

		const progressEl = content?.createDiv?.({ cls: "acc-task-progress" });
		const listEl = content?.createDiv?.({ cls: "acc-task-list" });
		const emptyEl = content?.createDiv?.({ cls: "acc-task-empty" });
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

			ctaButton?.setButtonText?.(options.labels.cta(selected.size));
			ctaButton?.setDisabled?.(phase === "run" || selected.size === 0);
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
					attr: { type: "checkbox" },
				}) as
					| {
							checked?: boolean;
							disabled?: boolean;
							addEventListener?: (type: string, handler: () => void) => void;
					  }
					| undefined;
				if (box) {
					box.checked = selected.has(card.id);
					// 开跑之后不许再改勾选 —— 界面与"正在处理的那一批"必须一致
					if (phase === "run") box.disabled = true;
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
				text?.createSpan?.({ cls: "acc-task-name", text: card.label });
				if (card.meta) text?.createSpan?.({ cls: "acc-task-meta", text: card.meta });
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

		/** 切范围：**清掉勾选与状态**（上一批的键不属于这一批）。 */
		const reload = async (value: string): Promise<void> => {
			if (phase === "run") return;
			selected = new Set<string>();
			statuses = new Map<string, TaskStatus>();
			try {
				cards = [...((await options.scope?.onChange(value)) ?? [])];
			} catch {
				// 取数失败（笔记读不到 / 目录读不了）→ 当作空清单。
				// 绝不能抛出：那会让弹窗停在没有结果的中间态，点了确认也没反应。
				cards = [];
			}
			// 换范围后默认**全选**（与首次打开一致）：勾选是"取舍"，默认不做取舍
			if (options.defaultSelected !== "none") selected = selectEverything(keysOf(cards));
			resetRows();
		};

		/** 点按钮：先确认勾选，再（如果给了 `run`）就地开跑。`action` 是多档动作里用户点的那一档。 */
		const confirm = async (action?: string, idle?: boolean): Promise<void> => {
			if (phase === "run") return;
			const chosen = selectionInOrder(cards, selected);
			if (chosen.length === 0) return;
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
				paintRows();
				updateControls();
				finish({ selected: chosen, ran: true, action });
				modal.close();
			}
		};

		if (content) {
			if (options.scope) {
				const scope = options.scope;
				new Setting(content)
					.setName(scope.name)
					.addDropdown((dropdown) => {
						for (const option of scope.options) dropdown.addOption(option.value, option.label);
						dropdown.setValue(scope.value).onChange((value) => {
							void reload(value);
						});
					});
			}

			new Setting(content)
				.addButton((button) =>
					button.setButtonText(options.labels.selectAll).onClick(() => {
						if (phase === "run") return;
						selected = selectEverything(keysOf(cards));
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

			// 多档动作：一档一个按钮（顺序即调用方给的顺序）
			if (options.actions && options.actions.length > 0) {
				const row = new Setting(content);
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
			} else {
				new Setting(content)
					.addButton((button) => {
						ctaButton = button;
						// ⭐ 不可撤销的动作必须**看得出来**（理由见 `TaskListOptions.destructive`）
						if (options.destructive) button.setDestructive?.();
						else button.setCta?.();
						button.onClick(() => {
							void confirm();
						});
					})
					.addButton((button) => {
						cancelButton = button;
						button.setButtonText(options.labels.cancel).onClick(() => {
							if (phase === "run") return;
							finish(null);
							modal.close();
						});
					});
			}
		}

		// 直接关掉（ESC / 点外部）也算取消 —— 否则 `await` 会永远挂着。
		// ⚠️ **跑的过程中不算**：那一趟已经开始了，关窗只是把界面收起来，
		// 结果仍会由 `confirm` 交回去（否则调用方会以为"用户取消了"而丢掉刚上传的东西）。
		const originalOnClose = modal.onClose?.bind(modal);
		modal.onClose = () => {
			originalOnClose?.();
			if (phase === "run") return;
			finish(null);
		};

		resetRows();
		modal.open();
		if (options.scope) {
			// 先画空态再取数：弹窗**立刻**出现（读全库可能要好几百毫秒），
			// 而"点了按钮什么都没发生"是最容易让人以为插件坏了的表现。
			void reload(options.scope.value);
		}
	});
}
