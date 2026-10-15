/**
 * 「清理本地副本」的**纯判定**（F18）。
 *
 * ## 它解决什么
 *
 * 用户口径：**"清理已经上传附件在本地占用的存储空间"** —— 等同常规图床插件
 * "把图片改成远程链接之后清掉本地那份"。笔记里存的**始终是远端地址**（我们从没改写过），
 * 所以本地那份只为"离线可用"服务：删掉它，图照常显示，代价只是下次看时重新下载一遍。
 *
 * ## ⭐⭐ 目标来自档位（2026-10-15，用户报告"上限 500 时清理应留下 500 而不是全清"）
 *
 * 同一个按钮在两种档位下问的是**两个问题**，所以 `keepBytes` 是必填的：
 *
 * | 档位 | 目标 | 顺序 |
 * |---|---|---|
 * | **不留副本** | `0` = 一份不留 | 先大的（清单先给能腾得多的） |
 * | **保留副本 + 上限 N** | `N` = 清到上限以内 | 最久没用过的先走 + 10 分钟宽限（= 后台淘汰那一套） |
 *
 * ⚠️⚠️ **两条路的池子是同一个**：台账 ∩ **带远端链接** ∩ 磁盘上还在。
 * 用户 2026-10-15 特意纠正过一次"要不要把没人引用的也一起清"：**不要** ——
 * 没人引用的副本可能还要**连云端对象一起删**（R17 三档询问会问用户），
 * 那是**另一个决定**；而这里只是腾空间。⇒ 判据 ③ 是**硬门槛**，换目标也不放宽。
 * 代价如实说：孤儿占着空间时，这批清完**总占用仍可能高于上限** ——
 * 结果通知里会单独说明那部分字节去哪处理（`unlinkedBytes`）。
 *
 * ⭐ **上限那条路直接复用 `eviction.ts` 的挑选规则**（`planEviction`）：池过滤在**输入**上做，
 * 顺序与宽限都只有一份定义。后台淘汰那边的池更宽（它会连没人引用的副本一起淘汰，
 * 那是**容量**机制的既定行为）—— 两者的差别是**刻意**的，见 `single-pool` 那段注释。
 *
 * ## 「不留副本」那一路的四条判据，缺一不进候选
 *
 * 1. **索引里有记录** —— 索引外的文件一律不碰（那可能是用户自己的附件，见 `audit.ts` 文件头）；
 * 2. **`uploaded` 台账命中** —— 证明"这个对象是我们传上去的"，也保证它**有远端地址**；
 * 3. **⭐ 带远端链接** —— 该 key 出现在**某篇笔记或画布的引用里**（`referencedKeys`）；
 * 4. **磁盘上真的还在** —— 不在的话没有可删的东西（那条记录该由自愈摘，见 `self-heal.ts`）。
 *
 * 第 4 条在执行时还会再确认一次"云端现在确实还有它"（`confirmRemote`，见 `run.ts` 的
 * `deleteVerifiedCopies`）—— 那一步不在纯判定层，判定层不碰网络。
 *
 * ## ⚠️ `referencedKeys` 是**必填**的，而且方向与 `eviction.ts` 相反
 *
 * `buildEvictionCandidates` 把 `referencedKeys` 省略当成"**一律当作已引用**"（宁可少删）；
 * 这条反过来：**没有引用扫描结果就一个候选都不给** —— 因为"带远端链接"是
 * 它的**准入条件**，而不是排序偏好。两处默认值方向相反是有意的：谁更保守的方向不同。
 */

import type { CacheEntry } from "../cache/index";
import { buildEvictionCandidates, planEviction } from "./eviction";
// 路径归一用**共享**的实现（与淘汰、审计同源）：调用方要拿索引里的路径去磁盘上找，
// 两侧必须用同一套规则，否则"索引里写着 A、磁盘上叫 B"会被判成"文件不在"。
import { normalizeVaultPath } from "../vault-files";

/** 一条可清理的本地副本。 */
export interface ReleaseSpaceCandidate {
	/** 对象 key（桶内唯一标识）。 */
	key: string;
	/** 本地副本的 vault 相对路径（1.2.0 起通常在附件目录里）。 */
	cachePath: string;
	/** 字节数（索引记的值 —— 这份文件是我们写下的）。 */
	bytes: number;
}

export interface ReleaseSpaceInput {
	/** 索引里的全部条目。 */
	entries: readonly CacheEntry[];
	/** 上传台账：我们传上去过的对象 key（`CacheIndex.uploadedKeys()`）。 */
	uploaded: ReadonlySet<string>;
	/** "这份副本此刻在磁盘上吗"（同步谓词 —— 由调用方算好，见 `rotation.ts` 的说明）。 */
	present: (path: string) => boolean;
	/**
	 * 笔记与画布里引用着的对象 key（= "带远端链接"）。
	 *
	 * ⚠️ **必填**：给不出来（例如没扫引用）就不该让用户"清理" —— 见文件头的说明。
	 */
	referencedKeys: ReadonlySet<string>;
	/** ⭐ 清理目标：清完**最多**保留多少字节。`0` = 一份不留（「不留副本」档）。 */
	keepBytes: number;
	/**
	 * 当前时间（epoch ms）。只有目标 > 0 那条路用得上（宽限期要它），
	 * 注入是为了**可穷举** —— 拿 `Date.now()` 的判定没法写"刚用过"的用例。
	 */
	now: number;
	/** 目标 > 0 时：刚用过多久之内的副本不参与（默认 `DEFAULT_EVICTION_GRACE_MS`）。 */
	graceMs?: number;
}

export interface ReleaseSpaceSelection {
	/** 可清理的副本，**按该走的顺序**排好（第一个最该走）。 */
	candidates: ReleaseSpaceCandidate[];
	/** 合计可释放字节（**清单口径**，不代表实际释放量 —— 执行时会再逐个确认云端）。 */
	bytes: number;
	/** 其余判据都过、但磁盘上已经没有了：没有可删的东西（自愈会摘掉那些记录）。 */
	missing: number;
	/** 磁盘上**确实还在**的副本的字节和（目标 > 0 时用它比目标）。 */
	totalBytes: number;
	/** 目标（字节）。 */
	keepBytes: number;
	/**
	 * 清完之后**预计**还占多少（**只算本流程能动的这批**）。
	 *
	 * ⚠️ 大于 `keepBytes` 就说明这一轮**清不到目标**（有副本在宽限期内 / 可删的已经挑完），
	 * 界面必须如实说 —— 报一个达不到的数字等于骗用户。
	 */
	projectedBytes: number;
	/**
	 * 磁盘上还留着、但**没有任何笔记引用**的、我们上传过的副本有多少字节。
	 *
	 * ⚠️ 它**不在**上面任何一个数里 —— 那是刻意的：这一类归 R17 的三档询问
	 * （可能连云端一起删），本流程不碰。它唯一的用途是**如实解释**
	 * "为什么清完了总占用仍可能高于上限"。
	 */
	unlinkedBytes: number;
}

/**
 * 挑出可清理的本地副本。**纯函数**：不改索引、不碰文件、不联网。
 */
export function planReleaseSpace(input: ReleaseSpaceInput): ReleaseSpaceSelection {
	// ⚠️ 目标必须是**有限的非负数**。读不出来（NaN / undefined / 别的类型）⇒ 一个候选都不给：
	// "读不出目标"唯一安全的解释是**这次什么都别删**。
	//
	// ⚠️ 别把它当成 0 —— 0 在这里是"一份不留"，是三种解释里**最具破坏性**的一种，
	// 而"读不出来的值"没有任何理由触发它。调用方本来也该在这一层之前拦掉坏值
	//（`ui/settings-logic.ts` 的 `localCopyCleanupTarget` 就把它映射成"没有目标 ⇒ 按钮不显示"）。
	if (!Number.isFinite(input.keepBytes) || input.keepBytes < 0) {
		return {
			candidates: [],
			bytes: 0,
			missing: 0,
			totalBytes: 0,
			keepBytes: 0,
			projectedBytes: 0,
			unlinkedBytes: 0,
		};
	}

	const keepBytes = Math.floor(input.keepBytes);
	const planned = keepBytes > 0 ? planToLimit(input, keepBytes) : planWholeStock(input);
	return { ...planned, keepBytes };
}

/**
 * 目标 > 0：**把这批在用的副本清到上限以内**。
 *
 * ## ⭐ 池 = 台账 ∩ 带远端链接 —— 与「不留副本」档**同一个池**
 *
 * 目标换了（从"一份不留"换成"清到 N"），但**能动的范围不变**。用户 2026-10-15 特意纠正过
 * 这一点，理由是**两种清理行为不同**：
 *
 * - **没人引用的副本**可能还要**连云端对象一起删**（R17 三档询问里那一条，会问用户
 *   "只删本地 / 一起删 / 保留"）—— 那是一个**要用户参与的决定**；
 * - 而这里的"清到上限"只是**腾空间**，腾完还得保留"以后再看到它还能显示"的语义。
 *
 * ⇒ 这条流程**不替 R17 做决定**，也不去碰它那一类。代价如实记在结果通知里：
 * 有孤儿占着空间时，这批清了**总占用仍可能高于上限**（剩下的那部分会单独说明去哪处理）。
 *
 * ## ⭐ 复用 `planEviction`：顺序与宽限期都只有一份定义
 *
 * 池过滤在**输入**上做（`entries` 先筛），挑选规则仍然走 `planEviction` ——
 * 于是"最久没用过的先走"与"10 分钟内用过的不动"这两条**不会在这里第二次实现**
 * （重复实现的那一份迟早在某次改动里与后台分叉，而且不报错）。
 * 池里每一份都带远端链接 ⇒ `planEviction` 的第一档"未引用优先"在这里恒不起作用。
 */
function planToLimit(input: ReleaseSpaceInput, keepBytes: number): Omit<ReleaseSpaceSelection, "keepBytes"> {
	const pool = input.entries.filter(
		(entry) => input.uploaded.has(entry.key) && input.referencedKeys.has(entry.key)
	);
	const { candidates, presentBytes, missing } = buildEvictionCandidates({
		entries: pool,
		present: input.present,
		referencedKeys: input.referencedKeys,
	});
	const plan = planEviction({
		candidates,
		totalBytes: presentBytes,
		limitBytes: keepBytes,
		now: input.now,
		...(input.graceMs === undefined ? {} : { graceMs: input.graceMs }),
	});

	return {
		candidates: plan.evict.map((victim) => ({
			key: victim.key,
			cachePath: victim.cachePath,
			bytes: victim.bytes,
		})),
		bytes: plan.reclaimable,
		missing,
		// ⚠️ 这两个数是"**这批**在用的副本"的：上限档的界面话术必须跟着说"这批"，
		// 不能声称"总占用已经降到上限以内" —— 孤儿那部分不在这个数里。
		totalBytes: plan.totalBytes,
		projectedBytes: plan.projectedBytes,
		unlinkedBytes: unlinkedPresentBytes(input),
	};
}

/**
 * 磁盘上还留着、但**没有任何笔记引用**的、我们上传过的副本有多少字节。
 *
 * 只有一个用途：**如实解释"为什么清完了占用还高于上限"** ——
 * 那一类归 R17 的三档询问（可能连云端一起删），本流程按纪律不碰它。
 * 它是纯内存计算，没有额外 I/O。
 */
function unlinkedPresentBytes(input: ReleaseSpaceInput): number {
	let total = 0;
	for (const entry of input.entries) {
		const path = normalizeVaultPath(entry.cachePath);
		if (!path) continue;
		if (!input.uploaded.has(entry.key)) continue;
		if (input.referencedKeys.has(entry.key)) continue;
		if (!input.present(path)) continue;
		total += Math.max(0, entry.size);
	}
	return total;
}

/**
 * 目标 = 0：**一份不留**（「不留副本」档的存量部分）。
 *
 * 候选顺序是"先大的"（而不是"最久没用过的"）：这一档没有"留谁"的问题（全都要走），
 * 于是顺序只该服务一件事 —— 让清单第一时间给出**能腾多少**。
 */
function planWholeStock(input: ReleaseSpaceInput): Omit<ReleaseSpaceSelection, "keepBytes"> {
	const candidates: ReleaseSpaceCandidate[] = [];
	// 同一路径只算一次：索引理论上不会有两条记录指向同一份文件，
	// 但"理论上"不是判据 —— 而**报给用户的字节数**会被重复计入。
	const seen = new Set<string>();
	let missing = 0;

	for (const entry of input.entries) {
		const path = normalizeVaultPath(entry.cachePath);
		if (!path || seen.has(path)) continue;
		// ① 是不是我们上传的（台账口径 —— 别借"索引里有没有条目"，见 `n11`）
		if (!input.uploaded.has(entry.key)) continue;
		// ② ⭐ 有没有远端链接（笔记/画布确实引用着它的远端地址）
		if (!input.referencedKeys.has(entry.key)) continue;
		// ③ 磁盘上还在不在
		if (!input.present(path)) {
			missing += 1;
			continue;
		}

		seen.add(path);
		candidates.push({
			key: entry.key,
			cachePath: path,
			// 索引记的字节：这份文件是我们写下的（用户改过它就不是我们的副本了，
			// 那时真正的修复是自愈/重新下载，不是在这里猜大小）
			bytes: Math.max(0, entry.size),
		});
	}

	// 排序：先大的；同样大时按 key —— 只为了让**同一份数据每次挑的顺序一样**
	// （否则用户会看到"每次列出来的顺序都不一样"，没法核对也没法复现）。
	candidates.sort((a, b) => {
		if (a.bytes !== b.bytes) return b.bytes - a.bytes;
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});

	let bytes = 0;
	for (const candidate of candidates) bytes += candidate.bytes;

	// 这一档的目标就是"一份不留"：池里所有还在磁盘上的副本都是候选 ⇒ 清完预计剩 0。
	return { candidates, bytes, missing, totalBytes: bytes, projectedBytes: 0, unlinkedBytes: unlinkedPresentBytes(input) };
}
