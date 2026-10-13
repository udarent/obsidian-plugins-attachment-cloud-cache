/**
 * **所有定时器的唯一出处**（设计里的"后台任务"一节，A3）。
 *
 * ## 为什么单独一个模块
 *
 * 这些定时器散在 `onload` 里时，每一个都要**自己记得**在卸载时取消 —— 而漏掉一个的后果
 * 是具体的：插件卸载后（热重载、切库）它还会跑，去改用户的笔记、弹一个"要不要删云端"。
 * 项目里为此在 `onunload` 写过一段注释解释"为什么必须显式取消"。
 *
 * ⇒ 收成一张**表**：每个任务在自己的条目里声明 `id` / 种类 / 间隔 / **为什么是这个触发点**，
 * 启动与取消都由这里统一做。于是"漏了一条线"变成**可数**的（表里有几条就是几条），
 * 而不是"靠人读 `onload` 三遍"。
 *
 * ## ⚠️ 一律用 `window.setTimeout` / `window.setInterval`
 *
 * 弹出窗口里裸 `setTimeout` 不是同一个定时器（与 `core/external-cache.ts`、
 * `host/runtime.ts`、`plugin/orphan-flow.ts` 同一条理由）—— 这里统一走 `window`。
 *
 * ## 自证
 *
 * 套件 `test-background-tasks.mjs` 用假的 `window` 定时器驱动：断言**表里每条都真的被排上**、
 * `dispose` 把**每一条**都取消（漏一条就红），以及各自的间隔与文档一致。
 */

import type { RotationReason } from "../maintenance/rotation";

/**
 * 启动后延迟多久做第一次缓存上限检查。
 *
 * 延迟是刻意的：超限时那一轮要列目录、还要扫全库笔记（判断哪些副本还被人引用），
 * 直接放在 `onload` 里会让"打开 Obsidian"变慢。3 秒足够让界面先出来。
 */
export const ROTATION_STARTUP_DELAY_MS = 3 * 1000;

/**
 * 周期性兜底检查的间隔。
 *
 * ⚠️ 间隔短不会造成持续 I/O：每一轮先走**便宜的门槛**（索引里的字节求和，
 * 纯内存），没超就立刻返回。真正昂贵的部分（列目录、扫笔记）只在超限时才发生，
 * 而且还有一层分钟级节流。
 */
export const ROTATION_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 索引自愈的启动延迟。
 *
 * ⚠️ 比轮换那一次（3 秒）**更晚**：自愈不是"必须马上做"的事，而启动后那几百毫秒里
 * 还有索引加载、渲染钩子挂载、引用快照建立等等要做完 —— 排它们后面，
 * 免得抢同一段启动窗口。
 */
export const SELF_HEAL_STARTUP_DELAY_MS = 8 * 1000;

/**
 * 索引自愈的周期兜底间隔。
 *
 * ⚠️ 这一条是"**两轮确认**"能成立的前提（见 `createAbsenceConfirmer`）：
 * 启动那轮只标记"这次不在"，要等到**下一轮**仍不在才摘。
 * 间隔取 10 分钟与轮换同频 —— 一轮本身几乎零成本（常态下只是查宿主的内存索引），
 * 而会话短于一个间隔时最多"晚一轮修"，不再有任何正确性代价。
 */
export const SELF_HEAL_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** 一个后台任务。 */
export interface BackgroundTask {
	/** 稳定名（写进日志与断言；改了它等于换了一个任务）。 */
	readonly id: string;
	/** `timeout` = 启动后延迟一次；`interval` = 周期性。 */
	readonly kind: "timeout" | "interval";
	/** 延迟/间隔（毫秒）。 */
	readonly everyMs: number;
	/** ⭐ 为什么是这个触发点 —— 写在这里，"漏了一条线"才是可数的。 */
	readonly why: string;
	readonly run: () => void;
}

/** 这张流程需要的宿主能力。 */
export interface BackgroundTaskDeps {
	/** 缓存上限轮换。⚠️ 它是**四触发点**的（见下面那张表），这里只承担两条定时线。 */
	rotate: (reason: RotationReason) => void;
	/** 索引自愈一轮。 */
	selfHeal: () => void;
}

/**
 * ⭐⭐ **缓存轮换的触发点矩阵** —— 四档触发点各自的"谁来按"。
 *
 * 这张表是给"**漏了一条线**"这类缺陷用的（P8 / N11 同形：某个档位下某条线没跑，
 * 而且不报错）。它把两个问题变成**可读、可数**的：
 *
 * 1. 轮换一共有几个触发点？（类型 `RotationReason` 说 4 个）
 * 2. 每一个由谁触发、在哪？（下表说 2 个是本模块的定时器、2 个是事件现场）
 *
 * ⚠️ 表里"事件现场"那两条**不在本模块**，是刻意的：它们要贴着触发它们的那个动作
 *（保存设置 / 上传完成）才读得懂。本模块只保证**定时那两条**不漏。
 */
export const ROTATION_TRIGGER_MATRIX: ReadonlyArray<{
	reason: RotationReason;
	/** 谁按的。 */
	by: string;
	/** 在哪（`null` = 就在本模块的定时器里）。 */
	where: string | null;
}> = [
	{ reason: "startup", by: "启动后延迟一次（定时器）", where: null },
	{ reason: "interval", by: "周期性兜底（定时器）", where: null },
	{ reason: "settings", by: "用户改完设置立刻复核上限", where: "main.ts::saveSettings" },
	{ reason: "growth", by: "一次上传让占用涨了", where: "main.ts 的粘贴/上传那条链" },
];

/**
 * ⭐ **后台任务的清单**（触发点 → 任务）。
 *
 * 三档「本地副本」× 这几个触发点是本项目栽过跟头的地方（P8 / N11 同形：
 * 某个档位下某条线**没跑**，而且不报错）。所以清单做成**数据**：增删要动这张表，
 * 而表里的每条都有 `why` 说明它为什么存在。
 */
export function backgroundTaskList(deps: BackgroundTaskDeps): readonly BackgroundTask[] {
	return [
		{
			id: "rotation-startup",
			kind: "timeout",
			everyMs: ROTATION_STARTUP_DELAY_MS,
			why: "启动后延迟一次：超限时这一轮要列目录、扫全库笔记，不能挡在插件加载路径上",
			run: () => deps.rotate("startup"),
		},
		{
			id: "rotation-interval",
			kind: "interval",
			everyMs: ROTATION_CHECK_INTERVAL_MS,
			why: "周期性兜底：先走便宜的门槛（内存求和），没超就直接返回",
			run: () => deps.rotate("interval"),
		},
		{
			id: "self-heal-startup",
			kind: "timeout",
			everyMs: SELF_HEAL_STARTUP_DELAY_MS,
			why: "比轮换那次更晚：自愈不紧急，排在索引加载/渲染钩子/引用快照之后",
			run: () => deps.selfHeal(),
		},
		{
			id: "self-heal-interval",
			kind: "interval",
			everyMs: SELF_HEAL_CHECK_INTERVAL_MS,
			why: "「两轮确认」的前提：启动那轮只标记，要等下一轮仍不在才摘",
			run: () => deps.selfHeal(),
		},
	];
}

/** 启动结果：`started` 供自证（表里几条就该起几条），`dispose` 把它们全取消。 */
export interface BackgroundTasks {
	/** 已启动的任务 id，顺序即启动顺序。 */
	readonly started: readonly string[];
	/** 取消**全部**已启动的定时器（幂等）。 */
	dispose(): void;
}

/**
 * 把清单里的任务按顺序排上，并把"取消"登记到插件的生命周期里。
 *
 * @param register 插件的 `register`（卸载时回调）—— 由它接收取消函数，
 *   于是**不需要在 `onunload` 里手写任何一行**（这正是这个模块存在的理由）。
 */
export function startBackgroundTasks(
	deps: BackgroundTaskDeps,
	register: (cleanup: () => void) => void
): BackgroundTasks {
	/** id → 句柄与种类（种类要留着：取消时用哪个 API 取决于它）。 */
	const handles = new Map<string, { handle: number; kind: BackgroundTask["kind"] }>();

	/** 取消一条；**从表里删掉**，于是 `dispose` 天然幂等。 */
	function clear(id: string): void {
		const entry = handles.get(id);
		if (!entry) return;
		handles.delete(id);
		if (entry.kind === "interval") window.clearInterval(entry.handle);
		else window.clearTimeout(entry.handle);
	}

	for (const task of backgroundTaskList(deps)) {
		const handle =
			task.kind === "interval"
				? window.setInterval(task.run, task.everyMs)
				: window.setTimeout(task.run, task.everyMs);
		handles.set(task.id, { handle, kind: task.kind });
		// ⚠️ 每条都登记取消 —— "漏一个定时器"从"靠人记得"变成"表里有几条就是几条"
		register(() => clear(task.id));
	}

	return {
		started: [...handles.keys()],
		dispose() {
			for (const id of [...handles.keys()]) clear(id);
		},
	};
}
