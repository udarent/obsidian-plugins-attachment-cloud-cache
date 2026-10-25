/**
 * 附件管理（R24 / F22）的**编排层**：把"枚举 → 卡片 → 动作"接起来。
 *
 * ## 分层（A1）
 *
 * `ui/gallery-modal.ts`（弹窗）→ **本模块** → `gallery/enumerate`（纯判据）、`ui/file-cards`（行）、
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

import { Notice, TFile as TFileClass } from "obsidian";

import { enumerateGallery } from "../gallery/enumerate";
import type { GalleryItem, GallerySnapshot } from "../gallery/enumerate";
import { keyOfUrl, referenceSnapshot } from "./notes-query";
import { hashFromKey } from "../object-key";
import { scanReferences, runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { selectLocalOrphans } from "../maintenance/local-orphans";
import { runCloudCleanup } from "../maintenance/cloud-cleanup";
import { forgetReferences, sharedBucketGuardFor } from "./shared-bucket-flow";
import type { CloudCleanupResult } from "../maintenance/cloud-cleanup";
import { writeDeleteLog } from "./shared-flows";
import { formatSize } from "../gallery/enumerate";
import type { FileCardCell } from "../ui/file-cards";
import { parentFolderOf } from "../vault-files";
import { revertLinksForKeys } from "./revert-flow";
import { createLocalCopyEnsurer } from "../core/download";
import type { DeletedObjectRecord } from "../maintenance/delete-log";
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
	/**
	 * 「待清理」那一组：**与清理命令同一套判据**（R17 的三类候选 —— 没人引用的云端对象、
	 * 没有任何引用的本地文件、站外缓存下来的副本）。
	 *
	 * ⚠️ 它只回答“这条算不算待清理”，**不回答“该不该删”**：删不删由用户勾选 ＋ 动作判定。
	 * ⚠️ 复用 `selectLocalOrphans`（不是照着重写一遍）：那一份带着「宿主自己的目录一个都不碰」
	 * 与「站外缓存单独归类」两条判据，重写会在下一次收紧时分叉，而**分叉不报错**。
	 */
	cleanupPaths: ReadonlySet<string>;
}

/** 一行在表格里的**各列内容**（由调用方给的 `t` 决定语种）。 */
function cellsFor(item: GalleryItem, t: PluginContext["t"]): Record<string, FileCardCell> {
	const stateLabel =
		item.state === "uploaded"
			? t("galleryStateUploaded")
			: item.state === "cloud-only"
				? t("galleryStateCloudOnly")
				: item.evidence === "none"
					? t("galleryStateUnverified")
					: t("galleryStateNotUploaded");
	// ⭐ D-77：站外缓存下来的那份要**标出来** —— 删它只是清缓存（下次显示重新下载），
	// 与“用户自己的附件”不是一回事。⚠️ 2026-10-24：口径只剩这一处（`origin === "external"`），
	// 孤儿清单那半退役时一并删掉了 `orphanRowCached` —— 别再加第二处标记。
	const stateText = item.origin === "external" ? `${stateLabel} · ${t("galleryStateCached")}` : stateLabel;
	// 位置：云端有本地无的行**没有**库内路径 ⇒ 给一个明确的"没有"，不留空格
	//（空格会被读成"这一行缺了东西"，与"云端那份没有本地副本"不是一回事）。
	const folder = item.path === null ? "" : parentFolderOf(item.path);

	return {
		state: {
			text: stateText,
			tone: item.state === "uploaded" ? "ok" : item.state === "cloud-only" ? "accent" : "muted",
		},
		ref: item.referenced
			? { text: t("galleryCellReferenced"), tone: "muted" }
			: { text: t("galleryCellUnreferenced"), tone: "warn", title: t("galleryCellUnreferencedHint") },
		folder: folder === ""
			? { text: item.path === null ? t("galleryCellNoLocal") : t("galleryCellVaultRoot"), tone: "muted" }
			: { text: folder, title: folder },
		size: item.size === null
			? { text: t("galleryCellNoLocal"), tone: "muted" }
			: { text: formatSize(item.size) },
	};
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
		result.items.map((item) => ({
			id: item.id,
			name: item.name,
			localPath: item.path ?? undefined,
			remoteKey: item.key ?? undefined,
			cells: cellsFor(item, ctx.t),
		})),
		CARD_LIMIT
	);

	// ── 「待清理」：复用清理命令的候选判据（R17），不另写一套 ──
	// 台账里的 key ↔ 本地副本路径（同一个对象两处都要用到）
	const pathOfKey = new Map<string, string>();
	const externalPaths = new Set<string>();
	for (const entry of index.toArray()) {
		if (!entry.cachePath) continue;
		pathOfKey.set(entry.key, entry.cachePath);
		if (entry.origin === "external") externalPaths.add(entry.cachePath);
	}
	/** 还有人在用的本地路径 = 本地引用 ∪ 「被远端 URL 引用的对象」的本地副本。 */
	const usedPaths = new Set<string>(snapshot.referenced);
	for (const key of referencedKeys) {
		const path = pathOfKey.get(key);
		if (path) usedPaths.add(path);
	}
	/** 云端那一组清单已经覆盖的路径（同一个文件不列两遍）。 */
	const coveredPaths = new Set<string>();
	for (const key of index.uploadedKeys()) {
		const path = pathOfKey.get(key);
		if (path) coveredPaths.add(path);
	}
	const configDir = String(ctx.app.vault.configDir ?? "").replace(/\/+$/, "");
	const orphans = selectLocalOrphans(files, {
		usedPaths,
		coveredPaths,
		externalPaths,
		excludedPrefixes: configDir ? [`${configDir}/`, ".trash/"] : [".trash/"],
	});
	const cleanupPaths = new Set<string>([...orphans.paths, ...orphans.cachedPaths]);

	return {
		items: result.items,
		cards,
		counts: result.counts,
		byId: new Map(result.items.map((item) => [item.id, item])),
		cleanupPaths,
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
/**
 * 删云端对象（**不可恢复**）。
 *
 * ⚠️ 判据在 `gallery/actions.ts` 里（`delete-cloud` 只对“已在云端且没人引用”成立，
 * CR-05 的默认档）—— 这一层**不再判一遍**，只负责执行。调用方必须先把不可用的筛掉，
 * 否则就等于绕过了那条判据。
 *
 * ⚠️ 复用 `runCloudCleanup`：删一个摘一条索引、忘掉台账、404 记 `alreadyGone`（不是失败）、
 * 其它错误如实报失败。**不在这里重写一遍删除语义**（那是全产品唯一不可恢复的动作）。
 * ⚠️ 留痕用 `scope: "command"`：视图的这个动作就是原来那条清理命令的手动入口，
 * 事后排查时与它同一档（不是自动询问那一档）。
 */
export async function deleteCloudSelected(
	ctx: PluginContext,
	keys: readonly string[],
	onItem?: (key: string, status: "done" | "skipped" | "failed") => void
): Promise<CloudCleanupResult> {
	const client = ctx.buildClient();
	if (!client) {
		return {
			deleted: 0,
			alreadyGone: 0,
			failed: keys.length,
			unindexed: 0,
			denied: 0,
		};
	}
	const records: DeletedObjectRecord[] = [];
	// ⭐ 共享桶（R25）：功能关着就是 `null` —— 一次多余的请求都不发
	const guard = sharedBucketGuardFor(ctx, client) ?? undefined;
	const result = await runCloudCleanup(
		{
			client,
			index: () => ctx.currentIndex(),
			persistIndex: () => ctx.hostContext().persistIndex(),
			notify: (message) => new Notice(message),
			t: ctx.t,
			guard,
			onRemoved: (record) => records.push({ ...record, scope: "command" }),
			onItem: (event) => onItem?.(event.key, event.status),
		},
		keys
	);
	await writeDeleteLog(ctx, records);
	// ⭐ 对象真的没了 ⇒ **从本设备的声明里摘掉这些引用**（声明是"当前引用了什么"的状态）。
	// ⚠️ 只摘真删掉的：删除失败时对象还在云端，摘掉会让它失去保护。
	const goneHashes: string[] = [];
	for (const record of records) {
		const hash = hashFromKey(record.key);
		if (hash) goneHashes.push(hash);
	}
	if (goneHashes.length > 0) await forgetReferences(ctx, client, goneHashes);
	// ⚠️ 三种"没删成"必须各说一句，否则用户只看到"全部跳过"却不知道原因：
	// ① 被别的设备占着（跳过是**设计如此**）；② 整批被挡（没声明 / 读不到）；
	// ③ 跑到一半声明变了（停剩余批次）。三种都不许说成"清理完成"。
	if (result.blocked) {
		new Notice(
			ctx.t(result.blocked === "no-declaration" ? "sharedBucketNoDeclaration" : "sharedBucketBlocked", {
				error: result.blockedDetail ?? "",
			})
		);
	}
	if (result.stopped) {
		new Notice(
			ctx.t(result.stopped === "changed" ? "sharedBucketStopped" : "sharedBucketCheckpointFailed", {
				count: result.deleted + result.alreadyGone,
			})
		);
	}
	return result;
}

/**
 * 「改为本地引用」：先把缺的本地副本下回来，再把笔记里的远端 URL 换成本地路径。
 *
 * ## 为什么要有这一步（而不是直接删云端）
 *
 * 删云端是**不可恢复**的，而删掉之后那条链接立刻取不到对象；更糟的是删除会摘掉索引条目
 * ⇒ 就算本地还有副本，插件也不再认这个 URL。所以对**仍被引用**的对象，正确顺序只能是：
 * **先让它变成“本地引用”（云端那份于是没人引用）→ 再删云端**。
 *
 * ⚠️ 「不留副本」那一档下下载被关掉（`ensureLocalCopy` 返回 `disabled`）——
 * 这不是失败，是用户选过的档位；调用方要如实说“先在设置里允许本地副本”。
 */
export async function convertToLocalSelected(
	ctx: PluginContext,
	items: readonly GalleryItem[],
	onItem?: (id: string, status: "done" | "skipped" | "failed") => void
): Promise<{ downloaded: number; blocked: number; notes: number; links: number; missing: number }> {
	const ensureLocalCopy = createLocalCopyEnsurer({
		app: ctx.app,
		settings: () => ctx.settings,
		client: () => ctx.buildClient(),
		index: () => ctx.currentIndex(),
		persistIndex: () => ctx.hostContext().persistIndex(),
		// 这条是**用户显式点的**，所以下载失败要说出来（渲染路径上才逐张刷屏）
		notify: (message) => new Notice(message),
		t: ctx.t,
	});

	let downloaded = 0;
	let blocked = 0;
	const keys: string[] = [];
	for (const item of items) {
		if (!item.key) {
			if (item.path) onItem?.(item.id, "skipped");
			continue;
		}
		// 本地没有副本的，先下回来（否则改回本地路径会造坏链）
		if (item.state === "cloud-only") {
			const entry = ctx.currentIndex().get(item.key);
			const outcome = await ensureLocalCopy(item.key, entry?.remoteUrl ?? "", null);
			if (outcome.status === "downloaded") {
				downloaded += 1;
			} else if (outcome.status === "reused") {
				// 已经有了（索引 + 文件都在）：不算下载，但可以继续改链接
			} else {
				// disabled / refused / unavailable / failed：这一行改不了，如实跳过
				blocked += 1;
				onItem?.(item.id, outcome.status === "failed" ? "failed" : "skipped");
				continue;
			}
		}
		keys.push(item.key);
	}

	if (keys.length === 0) return { downloaded, blocked, notes: 0, links: 0, missing: 0 };
	const result = await revertLinksForKeys(ctx, keys);
	for (const item of items) {
		if (item.key && keys.includes(item.key)) onItem?.(item.id, "done");
	}
	return { downloaded, blocked, ...result };
}

export async function renameItem(ctx: PluginContext, id: string, newPath: string): Promise<void> {
	const file = ctx.app.vault.getAbstractFileByPath(id);
	if (!(file instanceof TFileClass)) throw new Error("gallery rename: not a file");
	await ctx.app.fileManager.renameFile(file, newPath);
}
