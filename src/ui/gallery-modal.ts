/**
 * **附件管理弹窗**（R24 / F22）：筛选胶囊 ＋ 清单 ＋ 批量动作。
 *
 * ## 形态：弹窗，不是侧边栏（2026-10-23 定的，推翻此前"常驻视图"）
 *
 * 判据是**手机端**：手机上侧边栏是一条滑出来的抽屉、比屏幕还窄，而这一屏是
 * 五列列表 ＋ 六个带件数的胶囊 ＋ 五个动作 ⇒ 抽屉是所有容器里最差的。弹窗在手机上
 * 几乎是全屏，在桌面上可以放到 ~880px。⚠️ 主区标签页原本是另一个候选（更宽、能分屏），
 * 但它需要真机证明"手机上的主区视图"可用，而我们**一次都没在手机上跑过**；
 * 弹窗是宿主的核心 API（所有确认框都靠它），是这三个里唯一确定能在手机上工作的。
 *
 * ## 版面（自上而下）
 *
 * ```
 * 筛选胶囊：全部 18 │ 待清理 3 │ 未上传 5 │ … │            刷新
 * 固定说明一句（不含数字）
 * ┌ 附件清单 ………………………… 已选 0 / 18 ┐   ← 标题栏：☑ 全选 + 标题 + 计数（粘顶）
 * │ ☐ 勾选框 缩略图 路径 状态标签            │
 * └─────────────────────────────────────────┘
 * 动作区：上传 / 删除本地 / 改为本地引用 / 删除云端 / 重命名    取消
 * ```
 *
 * 标题栏与全选复选框由**清单壳**画（`task-list-shell.ts`）：与另外两条链同一份装配。
 *
 * ## 它只做三件事
 *
 * 1. 画筛选栏（全部 / 待上传 / 已上传 / 云端有本地无 / 没人引用），每个胶囊带**件数**；
 * 2. 把筛选结果交给**清单壳**；
 * 3. 用户点动作时把"勾了哪些"转给 `plugin/gallery-flow.ts`，跑完把结果**说出来**。
 *
 * ⚠️ **不在这一层判定"能不能做"**：可用性来自 `gallery/actions.ts`（纯函数），
 * 这一层只把它的结论变成按钮上的数字与禁用状态。
 *
 * ## ⭐ 跑完**收起窗口**，用通知把结果说清（D-80 的反向，唯一一处）
 *
 * 另两条链（上传附件 / 清理附件）跑完停在原地，失败行留着（D-80）。这一屏不一样：
 * 它是长任务（几分钟、几十项），停在原地意味着**一个挡着笔记、必须手动关掉的窗口**，
 * 而手机上的返回键又会把它误关。⇒ 壳的 `autoCloseOnFinish` 只在这里打开，
 * 关窗时把「完成 / 跳过 / 失败」三个数与前几个失败文件名放进一条通知。
 *
 * ⚠️ 代价（认了）：失败**原因**看不到（它本来在失败行上）。要查原因就再开一次、看状态标签。
 *
 * ## ⚠️ 本轮没画的两颗按钮
 *
 * - **删云端**：判据未定案（CR-05）⇒ 默认禁用，而"禁用且不说明"比"没有这颗按钮"更差，
 *   所以先不画；
 * - **取回本地**：R6 的回退下载已在渲染时自动发生，单独一颗按钮会与它抢动作。
 */

import { Modal, Notice, Setting } from "obsidian";

import { actionAvailability } from "../gallery/actions";
import type { GalleryAction } from "../gallery/actions";
import type { GalleryItem } from "../gallery/enumerate";
import type { PluginContext } from "../plugin/context";
import {
	convertToLocalSelected,
	deleteCloudSelected,
	deleteLocalSelected,
	loadGallery,
	renameItem,
	uploadSelected,
} from "../plugin/gallery-flow";
import type { GalleryModel } from "../plugin/gallery-flow";
import { mountTaskListShell } from "./task-list-shell";
import type { TaskListAction, TaskListColumn, TaskListLabels, TaskListResult } from "./task-list-shell";
import type { FileCardOpenTarget } from "./file-cards";
import type { TaskReporter } from "./task-list";

/**
 * 弹窗根节点的类名（`Modal#modalEl` 上）。
 * ⚠️ 真机脚本按它定位这一屏（`document.querySelector(".acc-gallery-modal .modal-content")`）⇒
 * 改名要同步 `scripts/verify-flows.mjs`。
 */
export const GALLERY_MODAL_CLASS = "acc-gallery-modal";

const FILTERS = [
	{ key: "all", labelKey: "galleryFilterAll" },
	// ⚠️ 「待清理」不是「没人引用」的同义词：它多两类（没有任何引用的本地文件、站外缓存副本），
	// 判据复用清理命令的 `selectLocalOrphans`（见 `gallery-flow` 的 `cleanupPaths`）。
	{ key: "to-clean", labelKey: "galleryFilterToClean" },
	{ key: "not-uploaded", labelKey: "galleryFilterNotUploaded" },
	{ key: "uploaded", labelKey: "galleryFilterUploaded" },
	{ key: "cloud-only", labelKey: "galleryFilterCloudOnly" },
	{ key: "unreferenced", labelKey: "galleryFilterUnreferenced" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

/** 改名 / 移动的输入框（宿主没有内置 prompt）。 */
class RenameModal extends Modal {
	private value: string;
	private readonly done: (value: string | null) => void;

	constructor(ctx: PluginContext, current: string, done: (value: string | null) => void) {
		super(ctx.app);
		this.value = current;
		this.done = done;
		this.titleEl?.setText?.(ctx.t("galleryRenameTitle"));
		const el = this.contentEl;
		new Setting(el).setName(ctx.t("galleryRenameField")).addText((text) =>
			text.setValue(current).onChange((next) => {
				this.value = next;
			})
		);
		new Setting(el)
			.addButton((button) =>
				button
					.setButtonText(ctx.t("galleryRenameConfirm"))
					.setCta?.()
					.onClick(() => {
						this.done(this.value.trim() || null);
						this.close();
					})
			)
			.addButton((button) =>
				button.setButtonText(ctx.t("galleryClose")).onClick(() => {
					this.done(null);
					this.close();
				})
			);
	}

	onClose(): void {
		// ESC / 点背景：交 null（重复交会被 `done` 侧忽略）
		this.done(null);
	}
}

/**
 * 附件管理弹窗。
 *
 * ⚠️ 容器只负责"有地方画 ＋ 什么时候收起"：清单的装配、勾选、进度、动作接线全在壳里，
 * 动作的可用性判定全在 `gallery/actions.ts`。这一层只留**筛选状态**与**跨次读库**。
 */
export class GalleryModal extends Modal {
	private model: GalleryModel | null = null;
	private filter: FilterKey = "all";
	/**
	 * 打开时那一次"读全库"的 Promise。
	 *
	 * ⚠️ 命令侧 **必须** `await` 它（见 `main.openGallery`）：这一次读库要过
	 * `vault.getFiles()` 与全库引用扫描，**可能抛**。不 await 的话它只是一条
	 * unhandled rejection —— 用户看到的是一个空弹窗，控制台里才有一条错
	 * （"点了没反应"的经典形态，2026-10-16 实测报过）。
	 */
	private loading: Promise<void> | null = null;

	/**
	 * @param deps.onOpen 行尾「打开」（D-66）。**判定**（哪些行能打开、打开路径还是地址）在
	 *   `ui/file-cards.ts`，真正的打开动作只有装配点（`main.ts`）知道怎么问宿主。
	 *   不给就不画链接 —— 点不动的链接比没有更糟。
	 * @param deps.onClosed 窗口关掉了（装配点用它清掉"当前开着的那一个"）。
	 */
	constructor(
		private readonly ctx: PluginContext,
		private readonly deps: { onOpen?: (target: FileCardOpenTarget) => void; onClosed?: () => void } = {}
	) {
		super(ctx.app);
	}

	/** 首次读取的结果（命令侧等它，失败就抛给 `runCommand` 的兜底去说话）。 */
	get ready(): Promise<void> {
		return this.loading ?? Promise.resolve();
	}

	async onOpen(): Promise<void> {
		// ⭐ 类名挂在 `modalEl` 上：宽度、移动端全屏、以及真机脚本的定位都靠它。
		this.modalEl?.addClass?.(GALLERY_MODAL_CLASS);
		this.titleEl?.setText?.(this.ctx.t("galleryTitle"));
		this.loading = this.refresh();
		try {
			await this.loading;
		} catch {
			// ⚠️ **这里必须吞掉**：宿主的 `open()` 不会 await `onOpen`，抛出去就只是一条
			// unhandled rejection（界面上是空弹窗）。失败由 `ready` 交给命令侧去说话。
			// 同一个 rejection 被两处 await 是合法的：这里接住它，`ready` 那边再抛给调用方。
		}
	}

	onClose(): void {
		this.model = null;
		this.deps.onClosed?.();
	}

	/** 重新读一遍全库并重画（打开时、点刷新时）。 */
	private async refresh(): Promise<void> {
		this.model = await loadGallery(this.ctx);
		this.render();
	}

	private visible(): GalleryItem[] {
		return this.itemsFor(this.filter);
	}

	/**
	 * 某个筛选下的行（**一份判据**：清单与胶囊上的数字都从这里出）。
	 *
	 * ⚠️ 数字与实际行数必须同源 —— 各算一遍的话，迟早出现"胶囊说 3、点开是 2"。
	 */
	private itemsFor(key: FilterKey): GalleryItem[] {
		const items = this.model?.items ?? [];
		switch (key) {
			case "to-clean":
				// 三类候选（R17）：云端没人引用的对象 ＋ 判据算出来的本地孤立/站外缓存副本
				return items.filter(
					(item) =>
						(item.path !== null && (this.model?.cleanupPaths.has(item.path) ?? false)) ||
						(item.state === "cloud-only" && !item.referenced)
				);
			case "not-uploaded":
				return items.filter((item) => item.state === "not-uploaded");
			case "uploaded":
				return items.filter((item) => item.state === "uploaded");
			case "cloud-only":
				return items.filter((item) => item.state === "cloud-only");
			case "unreferenced":
				return items.filter((item) => !item.referenced);
			default:
				return items;
		}
	}

	private labels(): TaskListLabels {
		const t = this.ctx.t;
		return {
			empty: t("galleryEmpty"),
			selectAll: t("gallerySelectAll"),
			selectNone: t("gallerySelectNone"),
			// 标题栏右侧那句：与弹窗共用一句话（"已选 N / 共 M"只维护一处）
			selectedCount: (selected: number, total: number) => t("taskListSelected", { selected, total }),
			cancel: t("galleryClose"),
			close: t("galleryClose"),
			cta: (count: number) => t("galleryCtaUpload", { count }),
			running: (progress) => t("galleryRunning", { finished: progress.finished, total: progress.total }),
			finished: (progress) => t("galleryFinished", { finished: progress.finished, total: progress.total }),
			statusDone: t("galleryStatusDone"),
			statusFailed: t("galleryStatusFailed"),
			statusSkipped: t("galleryStatusSkipped"),
			showMore: (count: number) => t("galleryShowMore", { count }),
			open: t("galleryOpen"),
		};
	}

	/** 勾选里"这个动作真能作用"的件数（按钮数字）。 */
	private applicable(ids: readonly string[], action: GalleryAction): number {
		const model = this.model;
		if (!model) return 0;
		let count = 0;
		for (const id of ids) {
			const item = model.byId.get(id);
			if (!item) continue;
			// ⚠️ `isUploadCandidate` 这里按"库内非笔记类文件都算候选"近似：
			// 精确候选由 `runBatchUpload` 在**执行时**再算一遍（它才知道站外/本机那几条闸门）。
			if (actionAvailability(item, action, { isUploadCandidate: true }).available) count += 1;
		}
		return count;
	}

	private actions(): TaskListAction[] {
		const t = this.ctx.t;
		return [
			{
				key: "upload",
				label: (count: number) => t("galleryActionUpload", { count }),
				primary: true,
				countFor: (ids) => this.applicable(ids, "upload"),
			},
			{
				key: "delete-local",
				label: (count: number) => t("galleryActionDeleteLocal", { count }),
				destructive: true,
				countFor: (ids) => this.applicable(ids, "delete-local"),
			},
			{
				// ⭐ 删云端的前置（用户 2026-10-23 定的顺序）：先把它变成本地引用，
				// 云端那份才“没人引用”，删云端才可用。
				key: "fetch-local",
				label: (count: number) => t("galleryActionLocalize", { count }),
				countFor: (ids) => this.applicable(ids, "fetch-local"),
			},
			{
				key: "delete-cloud",
				label: (count: number) => t("galleryActionDeleteCloud", { count }),
				destructive: true,
				countFor: (ids) => this.applicable(ids, "delete-cloud"),
			},
			{
				key: "rename",
				label: (count: number) => t("galleryActionRename", { count }),
				// 重命名只能单选：勾了多个 ⇒ 数字 0（灰掉）
				countFor: (ids) => (ids.length === 1 ? this.applicable(ids, "rename") : 0),
			},
		];
	}

	private render(): void {
		const root = this.contentEl;
		root.empty?.();
		root.addClass?.("acc-gallery");

		this.renderFilters(root);

		const listHost = root.createDiv?.({ cls: "acc-gallery-list" });
		if (!listHost) return;

		const ids = new Set(this.visible().map((item) => item.id));
		const cards = (this.model?.cards ?? []).filter((card) => ids.has(card.id));

		mountTaskListShell(
			listHost,
			{
				title: this.ctx.t("galleryTitle"),
				lines: [this.ctx.t("galleryRuleLine")],
				cards,
				labels: this.labels(),
				// ⭐ 多列：附件的不同属性各占一列（用户 2026-10-23 要求）。
				// ⚠️ 列宽写在这里、由壳统一灌进 `--acc-cols`：表头与行共用同一份模板。
				columns: this.columns(),
				defaultSelected: "none",
				actions: this.actions(),
				// 行尾「打开」（D-66）：判定在 `file-cards.ts`，真正的打开动作在装配点（`main.ts`）
				onOpen: this.deps.onOpen,
				// ⭐ 长任务工作台装在弹窗里 ⇒ 跑完收起窗口，结果用通知说（见文件头那条取舍）
				autoCloseOnFinish: true,
				run: (selected, report, action) => this.execute(selected, report, action),
			},
			{
				requestClose: () => this.close(),
				settle: (result) => this.reportResult(result),
			}
		);
	}

	/**
	 * 表格的列（顺序即视觉顺序）。
	 *
	 * ⚠️ 列宽是**刻意**给的：五列平分会让"状态""引用"这种短词占一屏的三分之一，
	 * 而"名称"（文件名最长、最需要看清）反而被挤。名称与位置用 fr（可伸缩），
	 * 其余给固定 px —— 固定列宽也顺带保证"切换筛选时列不会左右跳"。
	 *
	 * ⚠️ 窄屏（手机）由 `styles.css` 直接换一套 `--acc-cols` 并藏掉位置 / 引用 / 大小三列，
	 * 这里不做响应式判断：列宽是样式，不是逻辑。
	 */
	private columns(): TaskListColumn[] {
		const t = this.ctx.t;
		return [
			// 名称 2 : 位置 1 —— 文件名普遍比目录长，平分会让"认得出是哪个文件"这件事先坏掉
			{ key: "name", label: t("galleryColName"), kind: "name", width: "minmax(0, 2fr)" },
			{ key: "folder", label: t("galleryColFolder"), width: "minmax(0, 1fr)" },
			{ key: "state", label: t("galleryColState"), width: "120px" },
			{ key: "ref", label: t("galleryColRef"), width: "84px" },
			{ key: "size", label: t("galleryColSize"), width: "68px" },
			{ key: "open", label: t("galleryColOpen"), kind: "open", width: "40px" },
		];
	}

	/**
	 * 把这一趟的结果**说出来**（窗口已经/即将收起，这是用户唯一能看到的结论）。
	 *
	 * ⚠️ 三类分开报（成 / 跳 / 败）：`skipped` 不是故障，把它并进"失败"会让用户去修一件
	 * 本来就不需要修的事（与 `TaskStatus` 那条注释同一条纪律）。
	 * ⚠️ 失败项**点名**（最多 3 个）：窗口没了以后，失败原因只能靠重新打开、看状态标签；
	 * 至少要让用户知道"是哪几个"，否则他连重开去查哪几个都不知道。
	 */
	private reportResult(result: TaskListResult | null): void {
		if (!result?.ran || !result.progress) return;
		const t = this.ctx.t;
		const progress = result.progress;
		const lines = [
			t("galleryDoneSummary", {
				done: progress.done,
				skipped: progress.skipped,
				failed: progress.failed,
			}),
		];
		const names = (result.failed ?? [])
			.map((id) => this.model?.byId.get(id)?.name ?? id)
			.slice(0, 3)
			.filter((name) => name !== "");
		if (names.length > 0) lines.push(t("galleryDoneFailed", { names: names.join(", ") }));
		new Notice(lines.join("\n"));
	}

	/**
	 * 筛选栏：一排**胶囊**，每个带件数。
	 *
	 * ## ⭐ 两种状态（用户 2026-10-23 要求）
	 *
	 * `is-active` = **按下**（这个筛选正在生效）、没有它 = **弹起**。视觉差异在
	 * `styles.css` 的 `.acc-gallery-filter` 一处定义。
	 *
	 * ⚠️⚠️ 这一条**原来是有类名没样式**：`is-active` 从来没有任何 CSS 规则
	 * ⇒ 六个按钮长得一模一样，用户看不出在看哪一档（这正是他提这条的原因）。
	 * 所以判据不能只是"代码里加了类"，要有一条**真的画出来**的断言（`verify:flows`
	 * 读 `aria-pressed`，也就是读屏软件会念出来的那个状态）。
	 *
	 * ## ⚠️ 为什么是**单选**而不是多选
	 *
	 * 六个预设里「未上传 / 已上传 / 云端有本地无」是三态的**互斥**分支（`enumerate.ts`），
	 * 「待清理」「没人引用」是叠加维度。同时按下两个互斥分支只能得到"并集"，
	 * 而并集不是任何用户想要的答案 ⇒ 这里是**分段控件**语义（有且只有一个按下），
	 * 不是多选筛子。件数放在胶囊上，让"按下去会得到几行"在按下**之前**就能看见。
	 */
	private renderFilters(root: HTMLElement): void {
		const bar = root.createDiv?.({ cls: "acc-gallery-filters" });
		if (!bar) return;

		for (const filter of FILTERS) {
			const active = filter.key === this.filter;
			const count = this.itemsFor(filter.key).length;
			const button = bar.createEl?.("button", {
				cls: active ? "acc-gallery-filter is-active" : "acc-gallery-filter",
				attr: {
					type: "button",
					// ⭐ 结构化的身份：脚本按它点名，不按中文文案（文案改一次，断言就假红一次）
					"data-filter": filter.key,
					// ⭐ 读屏："按下 / 弹起"必须与视觉说同一件事
					"aria-pressed": active ? "true" : "false",
				},
			});
			button?.createSpan?.({ cls: "acc-gallery-filter-label", text: this.ctx.t(filter.labelKey) });
			button?.createSpan?.({ cls: "acc-gallery-filter-count", text: String(count) });
			// 这一档一行也没有 ⇒ 淡一点（点了也不会有内容），但仍然可点：
			// 禁用它会让"为什么是 0"无从追问，而空清单那句说明本身就是答案。
			if (count === 0) button?.addClass?.("is-empty");
			button?.addEventListener?.("click", () => {
				if (this.filter === filter.key) return;
				this.filter = filter.key;
				this.render();
			});
		}

		const refreshButton = bar.createEl?.("button", {
			cls: "acc-gallery-refresh",
			text: this.ctx.t("galleryRefresh"),
			attr: { type: "button" },
		});
		refreshButton?.addEventListener?.("click", () => {
			void this.refresh();
		});
	}

	private async execute(selected: readonly string[], report: TaskReporter, action?: string): Promise<void> {
		if (action === "upload") {
			const reported = new Set<string>();
			await uploadSelected(this.ctx, selected, (id, status) => {
				reported.add(id);
				report(id, status);
			});
			// ⚠️ 没上报的（不在候选里 / 站外那类）如实说"跳过"，不能默认算成功
			for (const id of selected) if (!reported.has(id)) report(id, "skipped");
			return;
		}

		if (action === "fetch-local") {
			const model = this.model;
			if (!model) return;
			const chosen = selected
				.map((id) => ({ id, item: model.byId.get(id) }))
				.filter((entry): entry is { id: string; item: GalleryItem } => Boolean(entry.item));
			const usable = chosen.filter(
				(entry) => actionAvailability(entry.item, "fetch-local", { isUploadCandidate: true }).available
			);
			if (usable.length === 0) {
				for (const entry of chosen) report(entry.id, "skipped");
				return;
			}
			const t = this.ctx.t;
			const ok = await this.ctx.confirmMaintenance({
				title: t("galleryLocalizeTitle"),
				lines: [t("galleryLocalizeBody", { count: usable.length }), t("galleryLocalizeKeepsCloud")],
				cta: t("galleryLocalizeCta", { count: usable.length }),
				// 它只改笔记里的链接、不动任何文件 ⇒ 不是破坏性动作
				destructive: false,
			});
			if (!ok) {
				for (const entry of chosen) report(entry.id, "skipped");
				return;
			}
			const idOf = new Map(usable.map((entry) => [entry.id, entry.id]));
			await convertToLocalSelected(
				this.ctx,
				usable.map((entry) => entry.item),
				(id, status) => report(idOf.get(id) ?? id, status)
			);
			return;
		}

		if (action === "delete-cloud") {
			const model = this.model;
			if (!model) return;
			const chosen = selected
				.map((id) => ({ id, item: model.byId.get(id) }))
				.filter((entry): entry is { id: string; item: GalleryItem } => Boolean(entry.item));
			// ⚠️ **再判一次可用性**（与按钮数字同一份判据）：勾选里可能混着“仍被引用”或“云端没有”的，
			// 它们不进这次执行，但要如实说“跳过”，不能默认算成功。
			const usable = chosen.filter(
				(entry) => entry.item.key !== null && actionAvailability(entry.item, "delete-cloud", { isUploadCandidate: true }).available
			);
			const blocked = chosen.length - usable.length;
			if (usable.length === 0) {
				for (const entry of chosen) report(entry.id, "skipped");
				return;
			}
			const t = this.ctx.t;
			const ok = await this.ctx.confirmMaintenance({
				title: t("galleryCloudConfirmTitle"),
				lines: [
					t("galleryCloudConfirmBody", { count: usable.length }),
					...(blocked > 0 ? [t("galleryCloudConfirmBlocked", { count: blocked })] : []),
					t("galleryCloudConfirmLocalStays"),
				],
				cta: t("galleryCloudConfirmCta", { count: usable.length }),
				destructive: true,
			});
			if (!ok) {
				for (const entry of chosen) report(entry.id, "skipped");
				return;
			}
			const keyToId = new Map<string, string>();
			for (const entry of usable) keyToId.set(entry.item.key as string, entry.id);
			for (const entry of chosen) if (!keyToId.has(entry.item.key ?? "")) report(entry.id, "skipped");
			await deleteCloudSelected(this.ctx, [...keyToId.keys()], (key, status) => {
				report(keyToId.get(key) ?? key, status);
			});
			return;
		}

		if (action === "delete-local") {
			for (const id of selected) {
				report(id, "running");
				const result = await deleteLocalSelected(this.ctx, [id]);
				report(id, result.deleted > 0 ? "done" : "failed");
			}
			return;
		}

		if (action === "rename") {
			if (selected.length !== 1) {
				for (const id of selected) report(id, "skipped");
				return;
			}
			const id = selected[0];
			const next = await new Promise<string | null>((resolve) => {
				const modal = new RenameModal(this.ctx, id, resolve);
				modal.open();
			});
			if (!next || next === id) {
				report(id, "skipped");
				return;
			}
			report(id, "running");
			try {
				await renameItem(this.ctx, id, next);
				report(id, "done");
			} catch {
				report(id, "failed");
			}
		}
	}
}
