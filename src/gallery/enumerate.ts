/**
 * 附件管理（R24 / F22）的**枚举与状态计算** —— 纯函数，不碰 UI、不碰网络。
 *
 * ## 它回答两个问题
 *
 * 1. **列表里有哪些行**：库内的全部附件（剔除笔记类）＋ 只在云端、本地没有的对象；
 * 2. **每一行处于什么状态**：已上传 / 未上传 / 云端有本地无 —— 外加上一层「有没有人引用」。
 *
 * ## ⚠️ 「三个状态」与「两条证据」
 *
 * 需求里的三态**互斥**，但实现上必须区分“凭什么这么判”：
 *
 * | 证据 | 含义 | 能推出什么 |
 * |---|---|---|
 * | `index` | 索引里有条目（路径 ↔ key 已知） | key 在台账里 ⇒ 已上传；不在 ⇒ 未上传 |
 * | `ledger` | 只有台账里有这个 key，本地没有文件也没有条目 | 云端有、本地无 |
 * | `none` | 既没有条目，也没有对应台账 | **只能报“未上传”** —— 要算 key 必须读字节算哈希，枚举阶段不做 |
 *
 * ⭐ 所以 `state` 是**给人看的结论**，`evidence` 是**结论的底子**。后者不许省：
 * 没有它，界面上“未上传”与“没核过”会长得一模一样，而这两件事对用户的意义不同
 * （前者可以传，后者可能早就在云端了 —— 这正是「待上传」≠「未上传」的原因）。
 *
 * ## ⚠️ 为什么“云端有本地无”不在文件列表里
 *
 * 它没有本地文件，`vault.getFiles()` 永远不会返回它 —— 只能从**索引条目**（路径已不在）
 * 或**台账**（有 key、没有条目）反推出来。少了这一步，用户把副本删掉之后，
 * 那份对象就从界面上彻底消失：既看不见、也删不掉云端那一份。
 *
 * ## ⚠️ 「有没有人引用」必须问两半
 *
 * `referencedPaths`（本地路径那一半）∪ `referencedKeys`（远端 URL 那一半）。
 * 只问一半的后果是**两种相反的错误**：只问路径 ⇒ 已经迁到云端的附件全成“没人引用”；
 * 只问 URL ⇒ 链接改回本地的那些全成“没人引用”。两半都由调用方算好（它们才知道索引与设置），
 * 这一层保持**纯**、可以穷举。
 */

import { displayNameForKey } from "../object-key";
import { isNoteLikeExtension } from "../vault-files";

/** 库内文件的最小形状（与 `batch.ts::VaultFileLike` 同一个约定）。 */
export interface GalleryFileInput {
	path: string;
	size: number;
	/** 归一化的小写扩展名（不含点）；取不到时为空串。 */
	extension: string;
}

/** 索引条目的最小形状（`CacheIndex.toArray()` 的子集）。 */
export interface GalleryIndexEntry {
	key: string;
	/** 副本此刻的落点；文件已被删掉时这个路径**不再存在**。 */
	cachePath: string;
	size: number;
	/** 站外缓存搬进来的那份（清理命令把它单列，界面标「站外缓存」）。 */
	origin?: "external";
}

/** 三态互斥；「没人引用」是叠加维度，不在这里。 */
export type GalleryState = "uploaded" | "not-uploaded" | "cloud-only";

/** 状态结论的证据强度（见文件头那张表）。 */
export type GalleryEvidence = "index" | "ledger" | "none";

export interface GalleryItem {
	/** 稳定标识：有本地文件用路径，否则用 key（视图按它回查要处理什么）。 */
	id: string;
	/** 显示名：本地文件名，或从 key 反推；两者都没有时退回 key 本身。 */
	name: string;
	/** 本地路径；`null` = 云端有、本地无。 */
	path: string | null;
	/** 对象 key；`null` = 还不知道（未核过的本地文件）。 */
	key: string | null;
	state: GalleryState;
	evidence: GalleryEvidence;
	/** 引用快照里有没有它（两半之并）。 */
	referenced: boolean;
	size: number | null;
	origin: "external" | null;
}

export interface GalleryEnumerateInput {
	/** 库内候选文件（调用方通常直接给 `vault.getFiles()`，这一层负责剔除笔记类）。 */
	files: readonly GalleryFileInput[];
	/** `CacheIndex.toArray()`。 */
	entries: readonly GalleryIndexEntry[];
	/** `CacheIndex.uploadedKeys()` —— 台账（“这个对象我们经手过”）。 */
	uploadedKeys: readonly string[];
	/** 被本地路径引用的库内路径（宽松那一半：宿主链接索引 ∪ 正文解析）。 */
	referencedPaths: ReadonlySet<string>;
	/** 被远端 URL 引用的对象 key（正文 ∪ 画布文本节点）。 */
	referencedKeys: ReadonlySet<string>;
}

export interface GalleryCounts {
	uploaded: number;
	"not-uploaded": number;
	"cloud-only": number;
	total: number;
	/** 三态里“没人引用”的总数（与清理命令同一份判据）。 */
	unreferenced: number;
}

export interface GallerySnapshot {
	items: GalleryItem[];
	counts: GalleryCounts;
}

/** 路径的最后一段（文件名）。 */
function nameOfPath(path: string): string {
	const segment = path.split("/").pop() ?? path;
	return segment || path;
}

/** 两半之并：本地路径被指着，或远端 URL 指向这个 key。 */
function isReferenced(
	path: string | null,
	key: string | null,
	input: GalleryEnumerateInput
): boolean {
	if (path !== null && input.referencedPaths.has(path)) return true;
	if (key !== null && input.referencedKeys.has(key)) return true;
	return false;
}

/** 确定性排序：先名字、再 id —— 不依赖 `Map` 的插入顺序。 */
function compareItems(a: GalleryItem, b: GalleryItem): number {
	if (a.name !== b.name) return a.name < b.name ? -1 : 1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? -1 : 1;
}

/**
 * 枚举一次，算出全部行与计数。
 *
 * ⚠️ **没有 IO、没有随机、没有时间**：同一份输入永远得到同一份输出
 * （分页、筛选、排序都在这一层之上，不许在这里加“当前时间”之类的隐式输入）。
 */
export function enumerateGallery(input: GalleryEnumerateInput): GallerySnapshot {
	const uploaded = new Set<string>();
	for (const key of input.uploadedKeys) {
		const clean = typeof key === "string" ? key.trim() : "";
		if (clean) uploaded.add(clean);
	}

	const entryByPath = new Map<string, GalleryIndexEntry>();
	for (const entry of input.entries) {
		if (entry && typeof entry.cachePath === "string" && entry.cachePath) {
			entryByPath.set(entry.cachePath, entry);
		}
	}

	const items: GalleryItem[] = [];
	const seenPaths = new Set<string>();
	const knownKeys = new Set<string>();

	for (const file of input.files) {
		const path = typeof file.path === "string" ? file.path : "";
		if (!path) continue;
		// 笔记 / 画布 / 数据库不是附件（与上传链同一份判据，D-34）。
		if (isNoteLikeExtension(file.extension)) continue;
		if (seenPaths.has(path)) continue;
		seenPaths.add(path);

		const entry = entryByPath.get(path);
		const key = entry && entry.key ? entry.key : null;
		if (key) knownKeys.add(key);
		const state: GalleryState =
			key !== null && uploaded.has(key) ? "uploaded" : "not-uploaded";

		items.push({
			id: path,
			name: nameOfPath(path),
			path,
			key,
			state,
			evidence: entry ? "index" : "none",
			referenced: isReferenced(path, key, input),
			size: typeof file.size === "number" ? file.size : null,
			origin: entry?.origin === "external" ? "external" : null,
		});
	}

	// 云端有、本地无（一）：索引条目还在，但它指的那个路径已经不在文件列表里。
	for (const entry of input.entries) {
		// 已在本地的对象由上面的循环产出（带 key）⇒ 这里按 key 去重；
		// ⚠️ 不再额外按 cachePath 判一次：那与 key 判据重叠，两条同时存在时
		// 其中一条永远不会被测试打到（变异验证会报“漏过”）。
		const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
		if (!key || !uploaded.has(key)) continue;
		if (knownKeys.has(key)) continue;
		knownKeys.add(key);
		items.push({
			id: key,
			name: displayNameForKey(key) || key,
			path: null,
			key,
			state: "cloud-only",
			evidence: "index",
			referenced: isReferenced(null, key, input),
			size: typeof entry.size === "number" ? entry.size : null,
			origin: entry.origin === "external" ? "external" : null,
		});
	}

	// 云端有、本地无（二）：只有台账（「不留副本」档就是这个形态 —— 从来没有条目）。
	for (const key of uploaded) {
		if (knownKeys.has(key)) continue;
		knownKeys.add(key);
		items.push({
			id: key,
			name: displayNameForKey(key) || key,
			path: null,
			key,
			state: "cloud-only",
			evidence: "ledger",
			referenced: isReferenced(null, key, input),
			size: null,
			origin: null,
		});
	}

	items.sort(compareItems);

	const counts: GalleryCounts = {
		uploaded: 0,
		"not-uploaded": 0,
		"cloud-only": 0,
		total: items.length,
		unreferenced: 0,
	};
	for (const item of items) {
		counts[item.state] += 1;
		if (!item.referenced) counts.unreferenced += 1;
	}

	return { items, counts };
}

/**
 * 把字节数变成一段短文本（表格"大小"列用）：`512 B` / `3.4 KB` / `12 MB`。
 *
 * ## 口径（都刻意定死，别改）
 *
 * - **1024 进制**：与宿主自己的 MB / GB 口径一致（设置页的内存上限也按它算）。
 * - **小于 10 时留一位小数，否则取整**：`1.5 KB` 比 `2 KB` 有用，而 `1234.6 KB` 只是噪音。
 * - **到 GB 就停**（附件不是磁盘镜像；再往上给 `TB` 只会让这一列变宽而没人看得懂）。
 * - 拿不到大小（`null` / 负数 / 非有限数）⇒ **空串**，由调用方决定显示什么 ——
 *   这里不编一个 `0 B` 出来（那会被读成"这个文件是空的"）。
 */
export function formatSize(bytes: number | null | undefined): string {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	// 小于 10 留一位（3.4 KB）；否则取整（12 MB）。`toFixed` 之后再 `Number` 是为了去掉 ".0"
	const rounded = value < 10 ? Number(value.toFixed(1)) : Math.round(value);
	return `${rounded} ${units[unit]}`;
}
