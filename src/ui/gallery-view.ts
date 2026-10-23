/**
 * **附件管理视图**（R24 / F22）：一个常驻列表 ＋ 筛选 ＋ 批量动作。
 *
 * ## 它只做三件事
 *
 * 1. 画筛选栏（全部 / 未上传 / 已上传 / 云端有本地无 / 没人引用）；
 * 2. 把筛选结果交给**清单壳**（`task-list-shell.ts`，与两条旧命令同一份装配）；
 * 3. 用户点动作时把"勾了哪些"转给 `plugin/gallery-flow.ts`。
 *
 * ⚠️ **不在这一层判定"能不能做"**：可用性来自 `gallery/actions.ts`（纯函数），
 * 这一层只把它的结论变成按钮上的数字与禁用状态。
 *
 * ## ⚠️ 本轮没画的两颗按钮
 *
 * - **删云端**：判据未定案（CR-05）⇒ 默认禁用，而"禁用且不说明"比"没有这颗按钮"更差，
 *   所以先不画；
 * - **取回本地**：R6 的回退下载已在渲染时自动发生，单独一颗按钮会与它抢动作。
 */

import { ItemView, Modal, Setting } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

import { actionAvailability } from "../gallery/actions";
import type { GalleryAction } from "../gallery/actions";
import type { GalleryItem } from "../gallery/enumerate";
import type { PluginContext } from "../plugin/context";
import { deleteCloudSelected, deleteLocalSelected, loadGallery, renameItem, uploadSelected } from "../plugin/gallery-flow";
import type { GalleryModel } from "../plugin/gallery-flow";
import { mountTaskListShell } from "./task-list-shell";
import type { TaskListAction, TaskListLabels } from "./task-list-shell";
import type { TaskReporter } from "./task-list";

export const GALLERY_VIEW_TYPE = "acc-gallery";

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

export class GalleryView extends ItemView {
	private model: GalleryModel | null = null;
	private filter: FilterKey = "all";

	constructor(leaf: WorkspaceLeaf, private readonly ctx: PluginContext) {
		super(leaf);
	}

	getViewType(): string {
		return GALLERY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.ctx.t("galleryTitle");
	}

	getIcon(): string {
		return "images";
	}

	async onOpen(): Promise<void> {
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.model = null;
	}

	/** 重新读一遍全库并重画（打开时、动作跑完后、点刷新时）。 */
	private async refresh(): Promise<void> {
		this.model = await loadGallery(this.ctx);
		this.render();
	}

	private visible(): GalleryItem[] {
		const items = this.model?.items ?? [];
		switch (this.filter) {
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

		const bar = root.createDiv?.({ cls: "acc-gallery-filters" });
		for (const filter of FILTERS) {
			const button = bar?.createEl?.("button", {
				cls: "acc-gallery-filter",
				text: this.ctx.t(filter.labelKey),
			});
			if (filter.key === this.filter) button?.addClass?.("is-active");
			button?.addEventListener?.("click", () => {
				if (this.filter === filter.key) return;
				this.filter = filter.key;
				this.render();
			});
		}
		const refreshButton = bar?.createEl?.("button", {
			cls: "acc-gallery-refresh",
			text: this.ctx.t("galleryRefresh"),
		});
		refreshButton?.addEventListener?.("click", () => {
			void this.refresh();
		});

		const listHost = root.createDiv?.({ cls: "acc-gallery-list" });
		if (!listHost) return;

		const ids = new Set(this.visible().map((item) => item.id));
		const cards = (this.model?.cards ?? []).filter((card) => ids.has(card.id));

		mountTaskListShell(
			listHost,
			{
				title: this.ctx.t("galleryTitle"),
				cards,
				labels: this.labels(),
				defaultSelected: "none",
				actions: this.actions(),
				run: (selected, report, action) => this.execute(selected, report, action),
			},
			{
				// 视图没有"关窗"：跑完的「关闭」= 重新读一遍（清单要反映新状态）
				requestClose: () => {
					void this.refresh();
				},
				settle: () => {
					// 结果已在 `run` 里上报；这里不重复刷新，避免与 requestClose 撞两次
				},
			}
		);
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
