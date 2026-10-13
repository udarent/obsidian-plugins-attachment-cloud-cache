/**
 * 「清理已上传附件的本地占用」的**纯判定**（F18：候选只来自索引、且必须带远端链接；确认后逐个 HEAD 复核再删）。
 *
 * ## 它解决什么
 *
 * 用户口径：**"清理已经上传附件在本地占用的存储空间"** —— 等同常规图床插件
 * "把图片改成远程链接之后清掉本地那份"。笔记里存的**始终是远端地址**（我们从没改写过），
 * 所以本地那份只为"离线可用"服务：删掉它，图照常显示，代价只是下次看时重新下载一遍。
 *
 * ## ⭐ 它不是独立功能：它是「不留副本」那一档的**存量部分**
 *
 * 同一个档位两段行为（2026-10-12 用户定，D-19）：
 *
 * | 段 | 触发 | 删法 |
 * |---|---|---|
 * | **新上传** | 自动（上传成功后） | 回收站（`planLocalCopy` ⇒ `trash`） |
 * | **存量**（本模块） | **用户主动确认** | **直接删** + 逐个云端 HEAD 前置 |
 *
 * ⚠️ 两段删法**故意不同**：判据是"**要不要立刻释放空间**"（设计 §20.16 #7）——
 * 新上传是自动动作、不要求立刻腾空间 ⇒ 回收站；存量清理的目的**就是**腾空间，
 * 而回收站（系统回收站与 `.trash`）**不释放磁盘空间**，所以必须直接删。
 *
 * ## 四条判据，缺一不进候选
 *
 * 1. **索引里有记录** —— 索引外的文件一律不碰（那可能是用户自己的附件，见 `audit.ts` 文件头）；
 * 2. **`uploaded` 台账命中** —— 证明"这个对象是我们传上去的"，也保证它**有远端地址**；
 * 3. **⭐ 带远端链接** —— 该 key 出现在**某篇笔记或画布的引用里**（`referencedKeys`）。
 *    这条来自用户口径"只清理有远端链接的"，同时也是**分工线**：没有远端链接的那些
 *    （= 孤儿，没人引用了）**不归这里管** —— 那是 R17 三档询问里"只删本地"的活。
 *    两类**互不重叠**，别把这一条放宽成"反正都能重新下载"；
 * 4. **磁盘上真的还在** —— 不在的话没有可删的东西（那条记录该由自愈摘，见 `self-heal.ts`）。
 *
 * 第 4 条在执行时还会再确认一次"云端现在确实还有它"（`confirmRemote`），
 * 那一步在 `run.ts` 里，不在纯判定层 —— 判定层不碰网络。
 *
 * ## ⚠️ `referencedKeys` 是**必填**的，而且方向与 `eviction.ts` 相反
 *
 * `buildEvictionCandidates` 把 `referencedKeys` 省略当成"**一律当作已引用**"（宁可少删）；
 * 这里反过来：**没有引用扫描结果就一个候选都不给** —— 因为"带远端链接"是本功能的**准入条件**，
 * 而不是排序偏好。两处默认值方向相反是有意的：谁更保守的方向不同
 * （淘汰里"当作已引用"是保守；这里"当作没有链接"才是保守）。
 */

import type { CacheEntry } from "../cache/index";
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
}

export interface ReleaseSpaceSelection {
	/** 可清理的副本，**按字节降序**（清单先给大的，用户一眼看到能腾多少）。 */
	candidates: ReleaseSpaceCandidate[];
	/** 合计可释放字节（**清单口径**，不代表实际释放量 —— 执行时会再逐个确认云端）。 */
	bytes: number;
	/** 其余判据都过、但磁盘上已经没有了：没有可删的东西（自愈会摘掉那些记录）。 */
	missing: number;
}

/**
 * 挑出可清理的本地副本。**纯函数**：不改索引、不碰文件、不联网。
 */
export function planReleaseSpace(input: ReleaseSpaceInput): ReleaseSpaceSelection {
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

	return { candidates, bytes, missing };
}
