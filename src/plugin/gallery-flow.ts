/**
 * 附件管理（R24 / F22）的**编排层**：把"枚举 → 卡片 → 动作"接起来。
 *
 * ## 分层（A1）
 *
 * `ui/gallery-view.ts`（视图）→ **本模块** → `gallery/enumerate`（纯判据）、`ui/file-cards`（行）、
 * `maintenance/run`（执行）。⚠️ 视图**不**直接连领域模块：它只说"用户勾了哪些、点了哪个动作"。
 *
 * ## 这一层只做三件事
 *
 * 1. **读一次全库**（文件清单、索引、引用快照、URL 键）→ 交给纯函数算出行与计数；
 * 2. 把行变成卡片（缩略图 / 名称 / 状态标签）；
 * 3. 把动作转给**既有执行链**（上传走 `runBatchUpload`、删本地走 `trashFile`、改名走 `renameFile`）。
 *
 * ⚠️ **不新写执行逻辑**：上传的三类候选、预检、改写链接、收尾删重复副本都在 `runBatchUpload` 里；
 * 这一层只把"用户的取舍"传进去（`onlyPaths`）。一旦发现要改它的签名，说明方向错了。
 *
 * ## ⚠️ 本轮**没有**接的两个动作
 *
 * - **删云端**：判据未定案（CR-05：仍被引用的对象允不允许删）。默认档是"禁用"，所以**不画这颗按钮**
 *   —— 清单里只该出现"点了能成"的东西。
 * - **取回本地**：R6 的回退下载已在渲染时自动发生；单独给一颗按钮会与它抢同一份动作，等真机确认必要性再补。
 */

import { TFile as TFileClass } from "obsidian";

import { enumerateGallery } from "../gallery/enumerate";
import type { GalleryItem, GallerySnapshot } from "../gallery/enumerate";
import { keyOfUrl, referenceSnapshot } from "./notes-query";
import { scanReferences, runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import type { PluginContext } from "./context";
import type { FileCard } from "../ui/file-cards";

/** 卡片数量上限（与清单壳的分块无关：这是"一次算多少张卡片"的上限）。 */
const CARD_LIMIT = 5000;

export interface GalleryModel {
	items: GalleryItem[];
	cards: FileCard[];
	counts: GallerySnapshot["counts"];
	/** id → 行（视图按勾选回查状态，判可用性）。 */
	byId: Map<string, GalleryItem>;
}

/** 卡片的状态标签文案（由调用方给的 `t` 决定语种）。 */
function hintFor(item: GalleryItem, t: PluginContext["t"]): { hint: string; hintIcon: string } {
	const stateLabel =
		item.state === "uploaded"
			? t("galleryStateUploaded")
			: item.state === "cloud-only"
				? t("galleryStateCloudOnly")
				: item.evidence === "none"
					? t("galleryStateUnverified")
					: t("galleryStateNotUploaded");
	if (!item.referenced) return { hint: `${stateLabel} · ${t("galleryStateUnreferenced")}`, hintIcon: "" };
	return { hint: stateLabel, hintIcon: "" };
}

/**
 * 读一次全库并算出模型。
 *
 * ⚠️ 每次打开 / 每次手动刷新调一次（引用快照是全库扫描，**不许**随每次敲键盘重算）。
 */
export async function loadGallery(ctx: PluginContext): Promise<GalleryModel> {
	const snapshot = await referenceSnapshot(ctx.app);
	const { keys: referencedKeys } = await scanReferences(ctx.app, (url) =>
		keyOfUrl(ctx.settings, url)
	);
	const index = ctx.currentIndex();
	const files = ctx.app.vault.getFiles().map((file) => ({
		path: file.path,
		size: typeof file.stat?.size === "number" ? file.stat.size : 0,
		extension: file.extension,
	}));
	const result = enumerateGallery({
		files,
		entries: index.toArray().map((entry) => ({
			key: entry.key,
			cachePath: entry.cachePath,
			size: entry.size,
			origin: entry.origin,
		})),
		uploadedKeys: index.uploadedKeys(),
		referencedPaths: snapshot.referenced,
		referencedKeys,
	});

	const cards = ctx.fileCards(
		result.items.map((item) => {
			const label = hintFor(item, ctx.t);
			return {
				id: item.id,
				name: item.name,
				localPath: item.path ?? undefined,
				remoteKey: item.key ?? undefined,
				hint: label.hint,
			};
		}),
		CARD_LIMIT
	);

	return {
		items: result.items,
		cards,
		counts: result.counts,
		byId: new Map(result.items.map((item) => [item.id, item])),
	};
}

/** 上传：把勾中的本地路径交给既有批量链（判据、预检、改写、收尾都在那边）。 */
export async function uploadSelected(
	ctx: PluginContext,
	ids: readonly string[],
	onItem?: (id: string, status: "done" | "skipped" | "failed") => void
): Promise<BatchResult> {
	const paths = new Set(ids);
	const snapshot = await referenceSnapshot(ctx.app);
	return runBatchUpload(ctx.maintenanceDeps(), {
		referencedPaths: snapshot.referenced,
		repairablePaths: snapshot.rewritable,
		onlyPaths: paths,
		includeUnreferenced: true,
		onItem: (event) => {
			if (event.kind === "vault") onItem?.(event.path, event.status);
		},
	});
}

/**
 * 删除本地副本：一律走回收站（§6.4 来路 ⑤）。
 *
 * ⚠️ **未上传的文件**在这里就是"唯一一份" —— 调用方必须已经按 `gallery/actions` 的判据
 * 确认过"可以删"，并由界面明示"没有云端副本"。本函数不再重复判一遍（判据只有一处）。
 */
export async function deleteLocalSelected(
	ctx: PluginContext,
	ids: readonly string[]
): Promise<{ deleted: number; failed: number }> {
	const index = ctx.currentIndex();
	let deleted = 0;
	let failed = 0;
	for (const id of ids) {
		const file = ctx.app.vault.getAbstractFileByPath(id);
		if (!file) {
			failed += 1;
			continue;
		}
		if (!(file instanceof TFileClass)) {
			failed += 1;
			continue;
		}
		try {
			await ctx.app.fileManager.trashFile(file);
			// 索引跟随：那份副本已经不在了 ⇒ 摘掉条目（对象仍在云端，故**不动台账**）。
			const entry = index.findByCachePath(id);
			if (entry) index.remove(entry.key);
			deleted += 1;
		} catch {
			failed += 1;
		}
	}
	if (deleted > 0) await ctx.hostContext().persistIndex();
	return { deleted, failed };
}

/**
 * 改名 / 移动（单条）。
 *
 * - 宿主的 `renameFile` 会把**全库链接**一起改（真机验过）；
 * - 索引跟随由 `main.ts` 的 `vault.on("rename")` 负责，这里**不重复搬**；
 * - ⚠️ R25 的云端声明更新（`refs[hash].name`）属 CR-16，本函数暂不涉及。
 */
export async function renameItem(ctx: PluginContext, id: string, newPath: string): Promise<void> {
	const file = ctx.app.vault.getAbstractFileByPath(id);
	if (!(file instanceof TFileClass)) throw new Error("gallery rename: not a file");
	await ctx.app.fileManager.renameFile(file, newPath);
}
