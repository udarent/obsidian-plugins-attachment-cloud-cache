/**
 * 维护功能的执行层：真的去读磁盘、删文件、改笔记。
 *
 * ## 三条安全性质在这里落地
 *
 * 1. **先自愈再清理。** 调用顺序写死在这个模块里（`runCleanup` 内部先摘除失效条目），
 *    而不是留给调用方记得先跑哪个命令 —— 顺序记错会白丢文件（见 `audit.ts` 的说明）。
 * 2. **拿不到删除凭据就跳过，绝不退化为底层删除。** 宿主的文件索引可能滞后于磁盘
 *    （刚同步进来的文件还没被索引），此时 `getAbstractFileByPath` 返回 null。
 *    用 `adapter.remove` 硬删会**绕过用户"删除即进回收站"的设置**，属不可逆 ——
 *    所以宁可跳过并如实汇报。
 * 3. **改笔记前先把原文取到手。** `vault.modify` 是**整文件覆盖**：若写入的是空串
 *    （例如读取失败却继续往下走），用户的笔记就没了。所以读失败一律跳过该文件。
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { CacheIndex } from "../cache/index";
import type { PluginSettings } from "../types";
import { isUnderCacheFolder } from "../cache-path";
import { auditCache, planCleanup } from "./audit";
import type { CacheAudit, CleanupPlan, DiskFile } from "./audit";
import type { EvictionOutcome, EvictionPlan } from "./eviction";
import { keysInText, planLinkRewrites } from "./references";
import type { RewriteRule } from "./references";
import { selectUploadCandidates } from "./batch";
import type { VaultFileLike } from "./batch";
import type { IngestRequest, IngestResult } from "../core/ingest";

/** 一次清理的结果，供汇报。 */
export interface CleanupResult {
	/** 成功送进回收站的数量。 */
	removed: number;
	/** 拿不到删除凭据而跳过的（宿主的索引滞后于磁盘）。 */
	skipped: { path: string; reason: string }[];
	/** 自愈摘除的索引条目数。 */
	healed: number;
	bytes: number;
}

export interface MaintenanceDeps {
	app: App;
	settings: () => PluginSettings;
	index: () => CacheIndex;
	/** 索引变更后落盘。 */
	persistIndex: () => Promise<void>;
	/** 上传编排（复用粘贴那条链，避免两套行为）。 */
	ingest: (request: IngestRequest) => Promise<IngestResult>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
}

/**
 * 列出缓存目录下的所有文件。
 *
 * 走 `adapter.list`（移动端可用）而不是 Node `fs`。
 * 递归是为了容错：缓存目录本该只有一层（SCOPE 的移动端约束），
 * 但用户可能手工建过子目录，那样的文件我们**看不见就当孤儿删掉**是不对的，
 * 所以照实列出来、交给审计判定。
 */
export async function collectCacheFiles(app: App, cacheFolder: string): Promise<DiskFile[]> {
	const root = String(cacheFolder ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	if (!root) return [];

	const out: DiskFile[] = [];
	const queue = [root];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const folder = queue.shift();
		if (folder === undefined || seen.has(folder)) continue;
		seen.add(folder);

		let listing: { files: string[]; folders: string[] };
		try {
			listing = await app.vault.adapter.list(folder);
		} catch {
			continue; // 目录不存在 / 读不了 → 当作没有文件，而不是让整条命令失败
		}

		for (const path of listing.files) {
			let bytes = 0;
			try {
				const stat = await app.vault.adapter.stat(path);
				bytes = typeof stat?.size === "number" ? stat.size : 0;
			} catch {
				// 拿不到大小不影响清理判定，按 0 计（只是"可回收字节"会略少）
			}
			out.push({ path, bytes });
		}
		for (const sub of listing.folders) {
			if (!seen.has(sub)) queue.push(sub);
		}
	}
	return out;
}

/**
 * 扫描全库笔记，收集"仍被引用"的对象 key。
 *
 * 顺带产出每个文件里出现的本存储 URL（批量上传改写时直接用这份结果，
 * 避免为了"哪些笔记引用了它"再扫一遍库）。
 */
export async function scanReferences(
	app: App,
	keyFromUrl: (url: string) => string | null
): Promise<{ keys: Set<string>; byPath: Map<string, string> }> {
	const keys = new Set<string>();
	const byPath = new Map<string, string>();

	for (const file of app.vault.getMarkdownFiles()) {
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			continue; // 读不了就跳过：这条命令不该因为一个坏文件整体失败
		}
		byPath.set(file.path, text);
		for (const key of keysInText(text, keyFromUrl)) keys.add(key);
	}
	return { keys, byPath };
}

export interface AuditForCleanup {
	audit: CacheAudit;
	plan: CleanupPlan;
}

/**
 * 审计 + 出清理计划（供"先给用户看一眼再执行"）。
 *
 * ⚠️ 判定与执行分开两步是刻意的：用户要能看到**具体要删哪些**。
 * 一条"已清理 N 个文件"的提示等于让人闭着眼睛按确认。
 */
export async function auditForCleanup(
	deps: MaintenanceDeps,
	keyFromUrl: (url: string) => string | null,
	previewLimit = 10
): Promise<AuditForCleanup> {
	const settings = deps.settings();
	const files = await collectCacheFiles(deps.app, settings.cacheFolder);
	const { keys } = await scanReferences(deps.app, keyFromUrl);

	const audit = auditCache({
		entries: deps.index().toArray(),
		files,
		referencedKeys: keys,
		cacheFolder: settings.cacheFolder,
	});

	return { audit, plan: planCleanup({ audit, previewLimit }) };
}

/**
 * 执行清理：**先自愈，再把清单里的文件送进回收站**。
 *
 * 顺序写死在这里，不给调用方选 —— 顺序搞反会白丢文件（见 `audit.ts`）。
 */
export async function runCleanup(deps: MaintenanceDeps, plan: CleanupPlan): Promise<CleanupResult> {
	const result: CleanupResult = { removed: 0, skipped: [], healed: 0, bytes: 0 };

	// ── 1. 自愈：只改索引，不碰文件 ──
	if (plan.healKeys.length > 0) {
		const index = deps.index();
		for (const key of plan.healKeys) {
			if (index.remove(key)) result.healed += 1;
		}
		if (result.healed > 0) {
			try {
				await deps.persistIndex();
			} catch (error) {
				deps.notify(deps.t("maintainPersistFailed", { error: describe(error) }));
			}
		}
	}

	// ── 2. 清理：走宿主的回收站 ──
	for (const path of plan.all) {
		// 双保险：清单理论上只含缓存目录内的路径，但这是**删文件**的循环，
		// 少一层校验的代价不可逆。
		if (!isUnderCacheFolder(path, deps.settings().cacheFolder)) {
			result.skipped.push({ path, reason: deps.t("maintainSkipOutsideCache") });
			continue;
		}

		const file = deps.app.vault.getAbstractFileByPath(path);
		if (!file) {
			// 宿主的索引滞后于磁盘：**跳过**，绝不退化为 adapter.remove
			//（那会绕过用户"删除即进回收站"的设置，不可逆）。
			result.skipped.push({ path, reason: deps.t("maintainSkipNotIndexed") });
			continue;
		}

		try {
			await deps.app.fileManager.trashFile(file);
			result.removed += 1;
		} catch (error) {
			result.skipped.push({ path, reason: describe(error) });
		}
	}

	result.bytes = plan.bytes;
	return result;
}

/** 按计划执行淘汰（缓存上限轮换的执行层）。 */
export interface EvictionRunResult extends EvictionOutcome {
	/** 顺手摘掉的索引记录数。 */
	unindexed: number;
}

/**
 * 按计划执行淘汰：**把文件送进回收站，并摘掉它们的索引记录**。
 *
 * ## ⚠️ 为什么一定要摘索引
 *
 * 索引的用途是回答"这条 URL 对应的本地副本在哪"。文件被淘汰之后若还留着记录，
 * 渲染层会以为本地还有那份副本 → 换成 `app://` 地址 → 加载失败 → 走 error 兜底 →
 * **每次渲染都白试一次**（还每次都去请求一遍补齐）。摘掉之后判定会回到
 * "属于本存储、但本地没有副本"，于是下次看到这张图时**自动重新下载** ——
 * 这正是"淘汰之后还能自己长回来"的机制。
 *
 * ## 与 `runCleanup` 共用同一条安全纪律
 *
 * 走宿主的回收站（`fileManager.trashFile`），拿不到删除凭据就**跳过**，
 * 绝不退化成 `adapter.remove`（那会绕过用户"删除即进回收站"的设置）。
 * 这是**自动**运行的路径、没人在旁边看，所以纪律更要守。
 *
 * ## 一个如实说明的代价
 *
 * 进回收站 → 文件**立刻离开 vault**（同步/备份的体积马上变小），
 * 而**磁盘空间要等系统清空回收站才真正释放**。对"上限"这个诉求来说，
 * 前者通常才是用户真正在意的（同步配额、vault 体积），换来的好处是误删可恢复。
 * 想立刻释放物理空间就去清空回收站 —— 设置项的描述里也写明了这一点。
 */
export async function runEviction(deps: MaintenanceDeps, plan: EvictionPlan): Promise<EvictionRunResult> {
	const result: EvictionRunResult = { evicted: 0, freed: 0, skipped: [], unindexed: 0 };
	const trashedKeys: string[] = [];

	for (const victim of plan.evict) {
		// 双保险：清单理论上只含缓存目录内的路径，但这是**删文件**的循环，
		// 少一层校验的代价不可逆。
		if (!isUnderCacheFolder(victim.cachePath, deps.settings().cacheFolder)) {
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipOutsideCache") });
			continue;
		}

		const file = deps.app.vault.getAbstractFileByPath(victim.cachePath);
		if (!file) {
			// 宿主的文件索引滞后于磁盘：**跳过**并如实汇报，绝不退化为底层删除
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipNotIndexed") });
			continue;
		}

		try {
			await deps.app.fileManager.trashFile(file);
			result.evicted += 1;
			result.freed += Math.max(0, victim.bytes);
			// 只有"有索引记录"的才需要摘（孤儿本来就没有记录）
			if (victim.key) trashedKeys.push(victim.key);
		} catch (error) {
			result.skipped.push({ path: victim.cachePath, reason: describe(error) });
		}
	}

	if (trashedKeys.length > 0) {
		const index = deps.index();
		for (const key of trashedKeys) {
			if (index.remove(key)) result.unindexed += 1;
		}
		try {
			await deps.persistIndex();
		} catch (error) {
			// 摘记录失败不该让"文件已经淘汰"这件事看起来没发生 —— 但要留下话
			deps.notify(deps.t("maintainPersistFailed", { error: describe(error) }));
		}
	}

	return result;
}

export interface BatchResult {
	uploaded: number;
	reused: number;
	failed: number;
	/** 改了链接的笔记数。 */
	notesChanged: number;
	/** 改掉的链接处数。 */
	linksRewritten: number;
	skipped: { reason: string; count: number }[];
}

/**
 * 批量上传附件目录里的图片，并把笔记里的本地链接换成远端链接。
 *
 * ## ⚠️ 一个刻意的保守选择：**不删原文件**
 *
 * 上传完之后，附件目录里的原文件仍然在。理由是它**不可逆**：
 * 删掉一个可能没有其它副本的文件，一旦用户的某篇笔记里还有一条我们没认出来的
 * 引用（比如被引号包起来的路径、或别的插件生成的写法），那张图就真没了。
 * 留着它只是占点磁盘，用户可以自己确认后再删 —— 代价小得多。
 *
 * 所以这条命令做完之后，磁盘上会有两份（原文件 + 缓存副本）。
 * 提示里会如实说明这一点。
 */
export async function runBatchUpload(deps: MaintenanceDeps): Promise<BatchResult> {
	const settings = deps.settings();
	const result: BatchResult = {
		uploaded: 0,
		reused: 0,
		failed: 0,
		notesChanged: 0,
		linksRewritten: 0,
		skipped: [],
	};

	// 只取判定需要的字段，转成结构化对象 —— 免得在 TFile 上做类型谓词（那会与宿主类型耦合）
	const files: VaultFileLike[] = deps.app.vault.getFiles().map((file) => ({
		path: file.path,
		extension: file.extension,
		stat: { size: file.stat?.size ?? 0 },
	}));

	const selection = selectUploadCandidates(files, { settings, index: deps.index() });
	result.skipped = selection.skipped;

	// 路径 → 远端 URL，用于随后改写笔记
	const rules: RewriteRule[] = [];

	for (const path of selection.paths) {
		const file = deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			result.failed += 1;
			continue;
		}

		let bytes: ArrayBuffer;
		try {
			bytes = await deps.app.vault.readBinary(file);
		} catch {
			result.failed += 1;
			continue;
		}

		let ingestResult: IngestResult;
		try {
			ingestResult = await deps.ingest({
				bytes: new Uint8Array(bytes),
				name: file.name,
				sourcePath: path,
			});
		} catch {
			result.failed += 1;
			continue;
		}

		if (!ingestResult.remoteUrl) {
			result.failed += 1;
			continue;
		}
		if (ingestResult.status === "reused") result.reused += 1;
		else result.uploaded += 1;

		rules.push({ from: path, to: ingestResult.remoteUrl });
	}

	if (rules.length === 0) return result;

	// ── 改写笔记里指向这些文件的链接 ──
	for (const note of deps.app.vault.getMarkdownFiles()) {
		let text: string;
		try {
			text = await deps.app.vault.read(note);
		} catch {
			// ⚠️ 读失败**必须跳过**：`vault.modify` 是整文件覆盖，
			// 用空串写回去等于把用户的笔记清空。
			continue;
		}
		if (text === "") continue;

		const rewritten = planLinkRewrites(text, rules);
		if (rewritten.count === 0) continue;

		try {
			await deps.app.vault.modify(note, rewritten.text);
			result.notesChanged += 1;
			result.linksRewritten += rewritten.count;
		} catch {
			result.failed += 1;
		}
	}

	return result;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
