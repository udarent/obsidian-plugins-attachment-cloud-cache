/**
 * 缓存审计与清理计划：**纯判定**，不碰文件、不碰宿主。
 *
 * ## 为什么这一层必须与执行分开
 *
 * 这是本项目里唯一会**删用户文件**的功能。删错的代价是不可逆的，而"该删哪些"
 * 完全由几个输入决定（索引内容、磁盘上的文件、笔记里的引用），
 * 全都是可以直接构造的 —— 所以判定穷举、执行层只剩"照着清单删"。
 *
 * ## 四类对象，各自处置不同
 *
 * | 类别 | 判定 | 处置 |
 * |---|---|---|
 * | **失效条目** | 索引里有、磁盘上没有 | **自愈**：只改索引，**不碰任何文件** |
 * | **孤儿文件** | 磁盘上有、索引里没有 | 可清理（见下） |
 * | **未引用副本** | 索引与磁盘都有，但没有任何笔记引用 | 可清理（见下） |
 * | 正常副本 | 其余 | 保留 |
 *
 * ### ⚠️ 先自愈，再判孤儿
 *
 * "索引记的路径失效、但文件其实还在别处"的对象，在索引视角下**看起来就像孤儿**。
 * 这意味着**用户执行命令的顺序会决定他是否丢文件**：先"修复"后"清理"没事，
 * 先"清理"后"修复"白丢。不能要求用户记住顺序 —— 所以清理流程内置自愈
 * （自愈只改元数据、不动文件，零副作用）。
 *
 * ### ⚠️ 三类对象一律**不删**
 *
 * 1. `localCopy: "keep"` 时副本在附件目录里，那些文件是**正常附件**，
 *    用户可能正在用 —— 只清理缓存目录内的文件；
 * 2. 不在缓存目录内的路径（索引记的路径可能被用户改过）；
 * 3. 拿不到删除凭据的对象（宿主的文件索引滞后于磁盘）——
 *    **跳过并如实汇报**，绝不退化成底层删除（那会绕过宿主的文件索引，
 *    留下"看得见、读不到"的幽灵条目。详见 `remove.ts`）。
 */

import type { CacheEntry } from "../cache/index";
import { isUnderCacheFolder } from "../cache-path";
// 路径归一用**共享**的实现（`vault-files.ts` → 宿主的 `normalizePath`）。
// 审计要拿「索引里记的路径」与「磁盘上枚举到的路径」做字符串比较，所以两侧必须同源；
// 原来是这里自己写的一份，规则与宿主不完全一致（`a//b`、`a/` 对不上）。
import { normalizeVaultPath } from "../vault-files";

/** 磁盘上的一个缓存文件。 */
export interface DiskFile {
	/** vault 相对路径。 */
	path: string;
	bytes: number;
}

export interface CacheAuditInput {
	/** 索引里的条目。 */
	entries: readonly CacheEntry[];
	/** 缓存目录下的文件（调用方负责只列这个目录）。 */
	files: readonly DiskFile[];
	/**
	 * 笔记里引用到的**对象 key** 集合。
	 *
	 * `undefined` 表示"没有扫描引用"（例如用户只想知道占用）——
	 * 此时**不**产生"未引用副本"，因为那会把所有副本都判成未引用。
	 */
	referencedKeys?: ReadonlySet<string>;
	/** 缓存目录（相对 vault 根），用于确认路径确实在缓存目录内。 */
	cacheFolder: string;
}

export interface CacheAudit {
	/** 索引有、磁盘没有 → 自愈（只改索引）。 */
	missingCopies: CacheEntry[];
	/** 磁盘有、索引没有 → 可清理。 */
	orphans: DiskFile[];
	/** 索引与磁盘都有，但没有笔记引用 → 可清理（仅在提供了 `referencedKeys` 时才有内容）。 */
	unused: CacheEntry[];
	/** 正常副本（索引与磁盘一致，且都在缓存目录内）。 */
	healthy: CacheEntry[];
	/**
	 * 副本**不在缓存目录内**的条目（`localCopy: "keep"` 时会是这样）。
	 *
	 * ⚠️ 它们既不算"健康"也不算"失效"，**必须单独归一类**：
	 * 那些文件是用户的正常附件，不在本命令的管理范围内。
	 * 若把它们混进"失效条目"去自愈，会摘掉索引记录 —— 于是那些图**失去离线能力**
	 * （功能悄悄退化，用户只会觉得"以前能离线看的图现在不行了"）。
	 * 若把它们混进"未引用"，则会去删用户的附件 —— 那是不可逆的破坏。
	 *
	 * 这是**测试抓出来的**：第一版把附件目录里的副本判成了"磁盘上没有"。
	 */
	outsideCache: CacheEntry[];
	bytes: {
		/** 缓存目录里所有文件的总字节数。 */
		total: number;
		/** 其中可回收的字节数（孤儿 + 未引用）。 */
		reclaimable: number;
	};
}

/**
 * 审计一次。**纯函数**：不改索引、不碰文件。
 *
 * 调用方负责两件事：① 只把**缓存目录下**的文件传进来；
 * ② 若想识别"未引用副本"，先扫描笔记并传 `referencedKeys`。
 */
export function auditCache(input: CacheAuditInput): CacheAudit {
	const onDisk = new Map<string, DiskFile>();
	for (const file of input.files) {
		// 只认缓存目录内的文件：`localCopy: "keep"` 时副本在附件目录里，
		// 那些是用户的正常附件，绝不能被当成孤儿清掉。
		if (!isUnderCacheFolder(file.path, input.cacheFolder)) continue;
		onDisk.set(normalizeVaultPath(file.path), file);
	}

	const indexedPaths = new Set<string>();
	const missingCopies: CacheEntry[] = [];
	const unused: CacheEntry[] = [];
	const healthy: CacheEntry[] = [];
	const outsideCache: CacheEntry[] = [];

	for (const entry of input.entries) {
		const path = normalizeVaultPath(entry.cachePath);

		// ⚠️ 只管缓存目录里的副本。`localCopy: "keep"` 时副本在附件目录，
		// 那是用户的正常附件 —— 既不归我们自愈，更不归我们清理。
		if (!isUnderCacheFolder(path, input.cacheFolder)) {
			outsideCache.push(entry);
			continue;
		}

		const file = onDisk.get(path);

		if (!file) {
			missingCopies.push(entry);
			continue;
		}
		indexedPaths.add(path);

		// 只在调用方提供了引用集合时才判"未引用"——
		// 否则（只想看占用时）会把每一份都误报成可删。
		if (input.referencedKeys && !input.referencedKeys.has(entry.key)) {
			unused.push(entry);
			continue;
		}
		healthy.push(entry);
	}

	const orphans: DiskFile[] = [];
	for (const [path, file] of onDisk) {
		if (!indexedPaths.has(path)) orphans.push(file);
	}

	let total = 0;
	for (const file of input.files) {
		if (isUnderCacheFolder(file.path, input.cacheFolder)) total += file.bytes;
	}

	// 可回收 = 孤儿文件的字节 + 未引用副本**在磁盘上**的字节。
	// ⚠️ 后者必须从 `onDisk` 取（那才是真实大小）：索引里的 `size` 可能与磁盘不符
	// （用户手工替换过文件、或同步过程中断）。用索引的数字只是"报个数"，
	// 而这里要报的是"能腾出多少空间"，必须按磁盘算。
	let reclaimable = 0;
	for (const file of orphans) reclaimable += file.bytes;
	for (const entry of unused) {
		const file = onDisk.get(normalizeVaultPath(entry.cachePath));
		if (file) reclaimable += file.bytes;
	}

	return { missingCopies, orphans, unused, healthy, outsideCache, bytes: { total, reclaimable } };
}

export interface CleanupOptions {
	audit: CacheAudit;
	/** 展示用的上限（列表太长会刷爆提示框）。 */
	previewLimit?: number;
}

export interface CleanupPlan {
	/** 展示用（**可截断**）。 */
	preview: string[];
	/** 执行用（**必须全量**）。 */
	all: string[];
	/** 回收字节数。 */
	bytes: number;
	/** 自愈要摘掉的索引条目（只改索引，不碰文件）。 */
	healKeys: string[];
	/** 展示时省略掉的数量（提示里要如实说明"还有 N 项"）。 */
	hidden: number;
}

/**
 * 把审计结果变成一份**可执行**的清理计划。
 *
 * ⚠️ 两条安全性质在这里落地：
 * - **展示可截断、执行不可**：`preview` 按上限裁剪，`all` 永远是全量。
 *   用截断后的列表去删会静默漏掉第 N+1 个之后的对象（用户以为清干净了，其实没有）。
 * - **自愈与清理同批下发**：`healKeys` 与 `all` 一起给出，调用方应当**先自愈**
 *   （它不动文件，零风险），避免"先清理后修复"这种会白丢文件的顺序。
 */
export function planCleanup(options: CleanupOptions): CleanupPlan {
	const limit = options.previewLimit ?? 10;
	const audit = options.audit;

	const all = [...audit.orphans.map((file) => normalizeVaultPath(file.path)), ...audit.unused.map((entry) => normalizeVaultPath(entry.cachePath))];

	const preview = all.slice(0, Math.max(0, limit));
	const hidden = all.length - preview.length;

	return {
		preview,
		all,
		bytes: audit.bytes.reclaimable,
		healKeys: audit.missingCopies.map((entry) => entry.key),
		hidden,
	};
}
