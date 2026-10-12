/**
 * 本地副本审计：**纯判定**，不碰文件、不碰宿主。
 *
 * ## 为什么这一层必须与执行分开
 *
 * 它决定的那些"哪份副本可以回收"最终会变成**删用户文件**的动作。删错的代价不可逆，
 * 而"该回收哪些"完全由几个输入决定（索引内容、副本此刻在不在、笔记里的引用），
 * 全都是可以直接构造的 —— 所以判定穷举、执行层只剩"照着清单做"。
 *
 * ## ⭐ 1.2.0（D-17）：口径从"扫缓存目录"换成"索引 + 存在性"
 *
 * 从前这一层有两半：列缓存目录找**孤儿**（磁盘有、索引无）+ 拿这个清单与索引对账。
 * 缓存目录取消之后，"孤儿"这一类在**整个产品里不存在了**：
 *
 * - 本地副本只有一种来源 —— 我们上传成功时登记的那一条；
 * - 而**索引外的文件可能是用户自己的附件**（没有那条目录替我们把它们分开），
 *   扫出来也绝不能动。
 *
 * 所以现在只剩三类，而且全部**只认索引里记过的路径**：
 *
 * | 类别 | 判定 | 处置 |
 * |---|---|---|
 * | **失效条目** | 索引里有、磁盘上没有 | **自愈**：只改索引，**不碰任何文件** |
 * | **未引用副本** | 索引与磁盘都有，但没有任何笔记引用 | 可回收（具体动作见 R17 的询问 / 上限淘汰） |
 * | 正常副本 | 其余 | 保留 |
 *
 * ⚠️ 这一层**不再接受"磁盘上的文件清单"**。那个输入是旧架构的产物，而它一旦回来，
 * "删索引外的文件"就会跟着回来 —— 那是一件我们**永远不该做**的事。
 *
 * ⚠️ **"可回收"是估算，不是许可**：上限淘汰要逐个云端 HEAD 复核（确认不上的不删），
 * R17 那两条路要用户明确确认。报告里的数字只是"大致还有多少"，这一点要写给用户看。
 */

import type { CacheEntry } from "../cache/index";
// 路径归一用**共享**的实现（`vault-files.ts` → 宿主的 `normalizePath`）。
// 审计要拿"索引里记的路径"与"磁盘上查到的路径"做字符串比较，所以两侧必须同源
//（曾经这里自己写了一份，规则与宿主不完全一致：`a//b`、`a/` 对不上）。
import { normalizeVaultPath } from "../vault-files";

/** 磁盘上的一份副本（只由调用方按**索引里的路径**查出来，绝不来自扫目录）。 */
export interface DiskFile {
	/** vault 相对路径。 */
	path: string;
	bytes: number;
}

export interface CacheAuditInput {
	/** 索引里的条目。 */
	entries: readonly CacheEntry[];
	/**
	 * 我们记过的那些副本**此刻在磁盘上的样子**（键 = 归一后的路径）。
	 *
	 * 不在表里 = 那份副本已经不在磁盘上（⇒ 失效条目）。
	 * ⚠️ 只该包含**索引里出现过**的路径 —— 见文件头那条。
	 */
	copies: ReadonlyMap<string, DiskFile>;
	/**
	 * 笔记里引用到的**对象 key** 集合。
	 *
	 * `undefined` 表示"没有扫描引用"（例如用户只想知道占用）——
	 * 此时**不**产生"未引用副本"，因为那会把所有副本都判成未引用，
	 * 而报告里那个数字会被读成"可回收"。
	 */
	referencedKeys?: ReadonlySet<string>;
}

export interface CacheAudit {
	/** 索引有、磁盘没有 → 自愈（只改索引）。 */
	missingCopies: CacheEntry[];
	/** 索引与磁盘都有，但没有笔记引用 → 可回收（仅在提供了 `referencedKeys` 时才有内容）。 */
	unused: CacheEntry[];
	/** 正常副本（索引与磁盘都在）。 */
	healthy: CacheEntry[];
	bytes: {
		/** 还在磁盘上的那些副本的**真实**总字节（按磁盘算，不按索引记的值 —— 见下）。 */
		total: number;
		/** 其中"未被任何笔记引用"的那些：**估算**的可回收量（见文件头）。 */
		reclaimable: number;
	};
}

/**
 * 审计一次。**纯函数**：不改索引、不碰文件。
 *
 * 调用方负责三件事：① 按**索引里的路径**去查副本此刻在不在（`copies`）；
 * ② 若想识别"未引用副本"，先扫描笔记并传 `referencedKeys`；
 * ③ 别把索引外的文件塞进来。
 *
 * ⚠️ 字节数一律取自 **`copies`（磁盘真相）**，不用 `entry.size`：
 * 索引里的值可能与磁盘不符（用户手工替换过文件、同步中断过），
 * 而这里两个数字都要回答"占了多少 / 能腾多少" —— 报个数不能用估算。
 */
export function auditCache(input: CacheAuditInput): CacheAudit {
	const missingCopies: CacheEntry[] = [];
	const unused: CacheEntry[] = [];
	const healthy: CacheEntry[] = [];

	// ⚠️ 同一个路径只计一次：两条记录指着同一份副本是索引不该有的状态，
	// 但"占用总量"不该因此虚高。
	const counted = new Set<string>();

	let total = 0;
	let reclaimable = 0;

	for (const entry of input.entries ?? []) {
		const path = normalizeVaultPath(entry.cachePath);
		const copy = path ? input.copies.get(path) : undefined;

		if (!copy) {
			missingCopies.push(entry);
			continue;
		}

		const size = Math.max(0, copy.bytes);
		if (!counted.has(path)) {
			counted.add(path);
			total += size;
		}

		// 只在调用方提供了引用集合时才判"未引用"——
		// 否则（只想看占用时）会把每一份都误报成可回收。
		if (input.referencedKeys && !input.referencedKeys.has(entry.key)) {
			unused.push(entry);
			reclaimable += size;
			continue;
		}

		healthy.push(entry);
	}

	return { missingCopies, unused, healthy, bytes: { total, reclaimable } };
}
