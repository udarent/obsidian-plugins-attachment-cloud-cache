/**
 * 清单类界面的**纯逻辑**：逐项状态与进度。
 *
 * ## 为什么需要一个共用模块
 *
 * 插件里有三条"列出一批东西、用户勾一批、然后逐个处理"的链：
 * **上传附件**（`plugin/upload-existing-flow.ts`）、**检查未被引用的云端附件**
 * （`plugin/orphan-flow.ts` 的命令那条路）、**挑选要缓存的文件**（`main.ts` + `ui/external-picker-modal.ts`）。
 * 它们要展示的东西是同一件事（缩略图 + 名字 + 勾选框 + 每项的状态 + 总体进度），
 * 而**判定**（哪些行、勾了什么、还剩几件没做完）与**画出来**必须分开：
 * 弹窗那一层进不了单测（宿主的 `Modal` 没有可编程的 DOM，只能真机驱动），
 * 所以能穷举的部分一律搬进这里。
 *
 * ## 三件容易错且不报错的事
 *
 * 1. **进度的分母**：必须取"**交给这一趟**的条目数"，不是清单的行数 ——
 *    清单里可能有没勾中的行；用行数当分母会让进度永远到不了 100%（用户以为卡住了）。
 * 2. **终态才算走完**：`failed` / `skipped` 也是终态。只把 `done` 当"完成"的话，
 *    失败的那一项会让进度条停在 99%。
 * 3. **勾选按清单顺序交出去**：按 `Set` 的插入顺序会得到"用户点击的顺序"，
 *    那既不稳定也不可复现（同一勾选状态两次运行可能产生两种提交顺序）。
 *
 * ## 与 `external-picker-logic.ts` 的分工
 *
 * 勾选的**状态操作**（`toggleSelection` / `selectEverything`）住在那边 ——
 * 它先服务于挑图那条链，现在三条链共用同一份实现（**同一条规则只许有一处**）。
 * 这里是"清单运行起来之后"的那一半：状态机 + 进度折叠。
 */

/**
 * 一项的状态。
 *
 * ⚠️ `skipped` 与 `failed` **不是一回事**，界面文案也必须分开：
 * - `skipped` ＝ 我们按规则**没做**（例如"已经在你自己的存储里了"、"手机端拿不到这条本机路径"）——
 *   它不是故障，用户不需要重试；
 * - `failed` ＝ 做了但**没成**（网络、权限、文件读不到）—— 用户可以重试。
 * 把两者合成"没成功"会让用户去修一件本来就不需要修的事，也会掩盖真正的失败。
 */
export type TaskStatus = "pending" | "running" | "done" | "skipped" | "failed";

/** 运行结束时那一行进度要报的东西。 */
export interface TaskProgress {
	/** 交给这一趟的条目数（**不是清单行数**，见文件头）。 */
	total: number;
	/** 已经走到终态（`done` / `skipped` / `failed`）的件数。 */
	finished: number;
	/** 其中成功完成的。 */
	done: number;
	/** 其中被跳过的（不是故障）。 */
	skipped: number;
	/** 其中失败的。 */
	failed: number;
	/** 还在跑的那一项（没有则 `null`）—— 界面据此让那一行转起来。 */
	running: string | null;
}

/** 上报一项的状态。跑的过程中可以报任意多次（最后落在哪个状态就算哪个）。 */
export type TaskReporter = (key: string, status: TaskStatus) => void;

/**
 * 界面文字。**全部由调用方给**（各自走 `t()`）——
 * 理由：三条链的措辞不同（"上传"/"删除"/"缓存"），而模板参数要走真正的翻译器。
 */
export interface TaskListLabels {
	/** 清单为空时的说明（要说清"为什么可能是空的"）。 */
	empty: string;
	/**
	 * 标题栏那颗**全选复选框**的可读名（`aria-label`，以及未勾满时的悬停说明）。
	 *
	 * ⚠️ 2026-10-23 起「全选 / 全不选」不再是两颗按钮，而是标题栏里的**一个三态复选框**
	 *（主流表格的做法：全勾 / 半选 / 全不勾都在同一个控件上）。两句文案都还用着：
	 * 没全勾时提示"全选"、已全勾时提示"全不选"（点它会清空）。
	 */
	selectAll: string;
	selectNone: string;
	/** 标题栏右侧的「已选 N / 共 M」。⚠️ 与动作按钮上的数字**不是一回事**（那是"能作用的件数"）。 */
	selectedCount?: (selected: number, total: number) => string;
	cancel: string;
	/**
	 * 清单里**一件能勾的都没有**时，主按钮的文案（D-70）。
	 *
	 * ⭐ 那种清单（只有"已经失效、只能打开笔记去修"的行）没有可执行的动作 ——
	 * 主按钮退回成"关闭"，否则它会一直灰着，用户找不到出口（而 ESC / 点背景不是
	 * 每个人都知道的出口）。
	 */
	close: string;
	/** 主按钮文字，随勾选数变化。 */
	cta: (count: number) => string;
	/** 跑的时候那一行（还没跑完）。 */
	running: (progress: TaskProgress) => string;
	/** 跑完之后那一行。 */
	finished: (progress: TaskProgress) => string;
	statusDone: string;
	statusFailed: string;
	statusSkipped: string;
	/** "再显示 N 行"那颗按钮（清单一次只画前若干行，见 `task-list-modal.ts` 的性能纪律）。 */
	showMore: (count: number) => string;
	/**
	 * 行尾那颗「打开」的文案（D-66）。
	 *
	 * ⚠️ 可选：没给就不画链接 —— 而**生产上三条链都经 `buildTaskLabels` 给齐**
	 * （与 `file-cards.ts::FileCardHandlers` 同一个口径：点不动的链接比没有更糟）。
	 */
	open?: string;
}

/**
 * 由 `t()` 造一套界面文字（三条链共用；只有**主按钮**那句按链传进来）。
 *
 * ⚠️ "全选 / 全不选 / 取消"三句直接沿用 `externalPick*` 那三条 —— 它们本来就是
 * 通用的三个词，而**同一句话只维护一处**（本项目的老纪律）。将来若给它们改名，
 * 三处一起改，别只改一半。
 */
export function buildTaskLabels(
	t: (key: string, params?: Record<string, unknown>) => string,
	ctaKey: string
): TaskListLabels {
	return {
		empty: t("taskListEmpty"),
		selectAll: t("externalPickAll"),
		selectNone: t("externalPickNone"),
		selectedCount: (selected, total) => t("taskListSelected", { selected, total }),
		cancel: t("externalPickCancel"),
		close: t("taskListClose"),
		cta: (count) => t(ctaKey, { count }),
		running: (progress) => t("taskProgressRunning", { finished: progress.finished, total: progress.total }),
		finished: (progress) =>
			t("taskProgressFinished", { done: progress.done, skipped: progress.skipped, failed: progress.failed }),
		statusDone: t("taskStatusDone"),
		statusFailed: t("taskStatusFailed"),
		statusSkipped: t("taskStatusSkipped"),
		showMore: (count) => t("taskShowMore", { count }),
		open: t("fileCardOpen"),
	};
}

/**
 * 改一项的状态。返回**新的 Map**（不改原来的）。
 *
 * 用不可变对象而不是就地改，与勾选那边同一条纪律：状态的来源只有一份，
 * 界面每次由它重画 —— 不会出现"界面显示 A、实际是 B"。
 */
export function setTaskStatus(
	statuses: ReadonlyMap<string, TaskStatus>,
	key: unknown,
	status: TaskStatus
): Map<string, TaskStatus> {
	const next = new Map(statuses);
	if (typeof key !== "string" || key === "") return next;
	next.set(key, status);
	return next;
}

/**
 * 折叠出进度。`total` 是**交给这一趟**的条目数（见文件头第 1 条）。
 *
 * ⚠️ 只统计**出现在 `statuses` 里的终态**：没被上报过的键按"还没做"算
 * （`pending` 本来也不进 `statuses`）—— 这样"上报漏了一件事"表现为进度不到 100%，
 * 而不是被悄悄补成完成。
 */
export function foldTaskProgress(statuses: ReadonlyMap<string, TaskStatus>, total: number): TaskProgress {
	const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
	let done = 0;
	let skipped = 0;
	let failed = 0;
	let running: string | null = null;

	for (const [key, status] of statuses ?? []) {
		if (status === "done") done += 1;
		else if (status === "skipped") skipped += 1;
		else if (status === "failed") failed += 1;
		else if (status === "running" && running === null) running = key;
	}

	return { total: safeTotal, finished: done + skipped + failed, done, skipped, failed, running };
}

/**
 * 勾中的键，**按清单顺序**交出去。
 *
 * 两条纪律：
 * - 顺序取清单（稳定、可复现），不是用户点击的顺序；
 * - 只交**清单里现在有的**行 —— `selected` 里可能残留上一批范围的键
 *   （挑图那条换范围时会清，但清不干净也不该泄进提交）。
 */
export function selectionInOrder(rows: readonly { id: string }[], selected: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const row of rows ?? []) {
		const id = typeof row?.id === "string" ? row.id : "";
		if (id !== "" && selected.has(id)) out.push(id);
	}
	return out;
}
