/**
 * 维护功能的执行层：真的去读磁盘、删文件、改笔记。
 *
 * ## 三条安全性质在这里落地
 *
 * 1. **先自愈再清理。** 调用顺序写死在这个模块里（`runCleanup` 内部先摘除失效条目），
 *    而不是留给调用方记得先跑哪个命令 —— 顺序记错会白丢文件（见 `audit.ts` 的说明）。
 * 2. **拿不到删除凭据就跳过，绝不退化为底层删除。** 宿主的文件索引可能滞后于磁盘
 *    （刚同步进来的文件还没被索引），此时 `getAbstractFileByPath` 返回 null。
 *    用 `adapter.remove` 硬删会**绕过宿主的文件索引** —— 文件从磁盘上没了，
 *    而宿主仍然认得它，留下"看得见、读不到"的幽灵条目 —— 所以宁可跳过并如实汇报。
 *    至于"怎么删"，由 `remove.ts` 统一决定（只有一种方式：直接删除）。
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
import { removeCacheFile } from "./remove";
import type { EvictionOutcome, EvictionPlan } from "./eviction";
import { keysInText, planLinkRewrites } from "./references";
import type { RewriteRule } from "./references";
import { selectUploadCandidates } from "./batch";
import type { ExternalSelection, VaultFileLike } from "./batch";
import type { IngestRequest, IngestResult } from "../core/ingest";
import type { ExternalCacheOutcome } from "../core/external-cache";
import { describeError } from "../error-text";

/** 一次清理的结果，供汇报。 */
export interface CleanupResult {
	/** 成功拿掉的文件数。 */
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
	/**
	 * 站外图的"下载 → 上传 → 改写链接"（复用「缓存站外图片」那条链）。
	 *
	 * 与 `ingest` 同理：只有一处实现，于是同意复核、失败分类、
	 * "URL 在笔记里总是字面出现"那几条纪律不会因为入口不同而分叉。
	 * 未提供时批量上传只处理库内文件。
	 */
	cacheExternal?: (url: string, notePath: string | undefined) => Promise<ExternalCacheOutcome>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
}

/**
 * 列出缓存目录下的所有文件。
 *
 * 走 `adapter.list`（移动端可用）而不是 Node `fs`。
 * 递归是为了容错：缓存目录本该只有一层（插件一直只往这一层写），
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
 * 执行清理：**先自愈，再删掉清单里的文件**。
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
				deps.notify(deps.t("maintainPersistFailed", { error: describeError(error) }));
			}
		}
	}

	// ── 2. 清理：删除（唯一实现见 `remove.ts`）──
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
			//（那会绕过宿主的文件索引，留下"看得见、读不到"的幽灵条目）。
			result.skipped.push({ path, reason: deps.t("maintainSkipNotIndexed") });
			continue;
		}

		try {
			await removeCacheFile(deps.app, file);
			result.removed += 1;
		} catch (error) {
			result.skipped.push({ path, reason: describeError(error) });
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
 * 按计划执行淘汰：**把文件删掉，并摘掉它们的索引记录**。
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
 * 两个入口都通过 `remove.ts` 删文件（走宿主 API、拿不到删除凭据就**跳过**、
 * 绝不退化成 `adapter.remove`）。这是**自动**运行的路径、没人在旁边看，
 * 所以纪律更要守；而"怎么删"只有一处定义，两个入口不可能分叉。
 *
 * ## 为什么是"直接删除"而不是先进回收站
 *
 * 上限的用途是"别让缓存把磁盘吃光"，而回收站**不解**这个问题：文件离开了 vault，
 * 物理空间却还占着，于是表现成"设了上限，磁盘还是满的"。
 * 而这里删的只是**缓存副本**（笔记里存的始终是远端地址），副本下次看到那张图时
 * 会自动重新下载 —— 所以可恢复性由**重新下载**提供，不必由回收站提供。
 * 那个"移入回收站"的备选因此被有意去掉了，理由详见 `remove.ts`。
 */
export async function runEviction(deps: MaintenanceDeps, plan: EvictionPlan): Promise<EvictionRunResult> {
	const result: EvictionRunResult = { evicted: 0, freed: 0, skipped: [], unindexed: 0 };
	const removedKeys: string[] = [];

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
			await removeCacheFile(deps.app, file);
			result.evicted += 1;
			result.freed += Math.max(0, victim.bytes);
			// 只有"有索引记录"的才需要摘（孤儿本来就没有记录）
			if (victim.key) removedKeys.push(victim.key);
		} catch (error) {
			result.skipped.push({ path: victim.cachePath, reason: describeError(error) });
		}
	}

	if (removedKeys.length > 0) {
		const index = deps.index();
		for (const key of removedKeys) {
			if (index.remove(key)) result.unindexed += 1;
		}
		try {
			await deps.persistIndex();
		} catch (error) {
			// 摘记录失败不该让"文件已经淘汰"这件事看起来没发生 —— 但要留下话
			deps.notify(deps.t("maintainPersistFailed", { error: describeError(error) }));
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

export interface BatchOptions {
	/**
	 * 站外图候选 —— **必须只放已经拿到授权的那些**（授权发生在命令的确认框里）。
	 *
	 * ⚠️ 这一层**不自己判断授权**：`cacheExternal` 那条链在路上只复核"功能还开着吗 /
	 * 是不是本存储 / 主机被拦了吗"，它**不知道用户答没答过** —— 按需缓存那条路是
	 * "先问、问到了才调它"。所以调用方漏了授权，这里就会替用户答应下来。
	 */
	external?: ExternalSelection;
}

/**
 * 批量上传：库内的老附件（+ 笔记里的外链图），并把笔记里的链接换成远端链接。
 *
 * ## 两趟，各管一类候选
 *
 * 1. **站外图**（候选已获授权）→ 走 `deps.cacheExternal`，也就是「缓存站外图片」
 *    那条链（下载 → 上传 → 落本地副本 → 改写链接）。它自带同意复核，
 *    所以这里只负责按候选逐个跑、并把结果并进同一份统计。
 * 2. **库内文件** → 读字节 → `ingest`（带 `existingPath`，见下）→ 收集改写规则 →
 *    最后统一扫一遍笔记改链接。
 *
 * ⚠️ 站外那趟排在前面，是为了让第二趟的 `planLinkRewrites` 读到**最新**正文
 *（它要重新读每一篇笔记；顺序反过来的话，读到的是外链那趟改写之前的版本）。
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
 *
 * ⚠️ 另一条与"不删原文件"配套的性质：**不得在原处留下中转副本**。
 * 文件本来就在库里，若把 ingest 的"先落盘再上传"照搬过来，每个文件都会先被写成
 * 一个 `xxx 1.png`（原文件占着名字 ⇒ 另取序号）再搬进缓存 ——
 * 那是"凭空多出来的文件"，搬移失败时还会永久残留。所以这里必须把
 * `existingPath` 指出来，让编排层知道**字节已经在库里**（见 `IngestRequest`）。
 */
export async function runBatchUpload(deps: MaintenanceDeps, options: BatchOptions = {}): Promise<BatchResult> {
	const settings = deps.settings();
	const result: BatchResult = {
		uploaded: 0,
		reused: 0,
		failed: 0,
		notesChanged: 0,
		linksRewritten: 0,
		skipped: [],
	};

	/**
	 * 被这次命令改过链接的笔记（**去重**）。
	 *
	 * ⚠️ 两条路径都可能改同一篇笔记（一篇笔记里既有本地老图、又有外链图），
	 * 各数各的会把"改了 3 篇"报成"改了 5 篇" —— 用户没法用它核对。
	 */
	const changedNotes = new Set<string>();

	// ── 1. 站外图（候选已获授权；只处理，不再判断该不该问）──
	//
	// ⚠️ 放在库内文件之前：改写过的笔记随后会被本地那一趟重新读一遍，
	// 于是 `planLinkRewrites` 拿到的一定是最新正文（顺序反过来就先改后读，读到旧的）。
	if (options.external && options.external.candidates.length > 0 && deps.cacheExternal) {
		for (const candidate of options.external.candidates) {
			let outcome: ExternalCacheOutcome;
			try {
				outcome = await deps.cacheExternal(candidate.url, candidate.notePath);
			} catch {
				// 这条链是 fire-and-forget 友好的，但还是兜一层：
				// 一张图出事不该让整条命令停在这里
				result.failed += 1;
				continue;
			}

			if (outcome.status === "cached") {
				result.uploaded += 1;
				result.linksRewritten += 1;
				changedNotes.add(candidate.notePath);
			} else if (outcome.status === "cached-no-rewrite") {
				// 图进了存储，但笔记里的链接没改成 —— **算未完成**：
				// 命令的承诺是"上传并改写"，只做了一半就报成功，用户会以为搬完了，
				// 而笔记里那串地址还指着别人的服务器。（重跑一次会补上。）
				result.failed += 1;
			} else {
				result.failed += 1;
			}
		}
	}

	// 只取判定需要的字段，转成结构化对象 —— 免得在 TFile 上做类型谓词（那会与宿主类型耦合）
	const files: VaultFileLike[] = deps.app.vault.getFiles().map((file) => ({
		path: file.path,
		extension: file.extension,
		stat: { size: file.stat?.size ?? 0 },
	}));

	const selection = selectUploadCandidates(files, { settings, index: deps.index() });
	// 两条路径的"为什么跳过"汇总到一起（形状相同，都是给人看的诊断）
	result.skipped = [...selection.skipped, ...(options.external?.skipped ?? [])];

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
				// ⭐ 明确指出"字节已经在这个文件里"。没有它，编排层会走"先落盘"那条路，
				// 于是附件目录里会凭空多出一个 `xxx 1.png`（原文件占着名字 ⇒ 另取序号），
				// 上传后再把它搬进缓存 —— 而原文件仍在。结果是：用户传了 N 张老图，
				// 附件目录里就多出 N 个中转文件（搬移失败时永久残留），
				// 而他要的只是"把这些图传上去"。
				existingPath: path,
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

	// 没有库内候选时**也要**走完赋值：站外那一趟可能已经改过笔记了
	if (rules.length === 0) {
		result.notesChanged = changedNotes.size;
		return result;
	}

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
			changedNotes.add(note.path);
			result.linksRewritten += rewritten.count;
		} catch {
			result.failed += 1;
		}
	}

	result.notesChanged = changedNotes.size;
	return result;
}

