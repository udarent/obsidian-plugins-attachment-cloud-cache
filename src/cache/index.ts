/**
 * 缓存索引：远端对象 ←→ 本地副本。
 *
 * ## 它到底解决什么
 *
 * 笔记里存的是**远端 URL**。要在离线时把图显示出来，渲染钩子必须回答一个问题：
 * 「这条 URL 对应的本地副本在哪？」——而这个问题**光看 URL 是答不全的**：
 *
 * - 默认（`localCopy: "cache"`）时副本在缓存目录，路径可由 key 推导出来；
 * - 但用户也可能选「原地保留」，那时副本就在他自己的附件目录里，**推导不出来**；
 * - 而且"文件曾经缓存过、后来被清理了"与"从来没有过副本"是两件不同的事 ——
 *   前者该回退下载，后者说明这张图本来就不属于我们的存储。
 *
 * 所以索引记的是**事实**，不是可推导的量。这也是它必须能容错加载的原因：
 * 它是"从磁盘重建"的产物（见 `pruneMissing`），坏掉时应当降级而不是让插件打不开。
 *
 * ## 为什么索引不放 vault 里，而放插件目录
 *
 * **缓存是"每台设备各自的"**：手机与桌面各有一份本地缓存，路径也各按各自的
 * vault 结构。若把索引放进 vault，它会跟着 vault 同步到别的设备 ——
 * 于是 A 设备的索引在 B 设备上指向一批**不存在的路径**，
 * 而"文件不在"与"不是我们的文件"在判定上完全不同，会造成误判与无谓的下载。
 *
 * 放在插件目录（`data.json` 旁边）后，索引天然是每设备独立的，与缓存一致。
 *
 * ## 为什么不塞进 `data.json`
 *
 * 附件数量会持续增长。`data.json` 每次加载/保存都要整体读写，
 * 把索引混进设置里会让"读设置"这件事随附件数变慢 —— 而设置是启动路径上的东西。
 */

import { isPlainRecord } from "../records";

/** 索引文件的结构版本。将来改结构时用它决定要不要做迁移。 */
export const CACHE_INDEX_VERSION = 1;

/**
 * `touch()` 的默认节流间隔：同一个 key 一小时才更新一次"最近使用时间"。
 *
 * 一小时是刻意的**粗粒度**：这个时间只用来排序（淘汰谁），
 * 而"某张图是 10 分钟前看的还是 70 分钟前看的"对排序毫无影响；
 * 反之，细粒度会让索引被反复标脏、反复写盘。
 */
export const DEFAULT_TOUCH_MIN_INTERVAL_MS = 60 * 60 * 1000;

export interface CacheEntry {
	/** 对象 key（桶内的唯一标识）。 */
	key: string;
	/**
	 * 本地副本的 vault 相对路径。
	 *
	 * 名字叫 cachePath 是历史原因，但它**不保证**在缓存目录里 ——
	 * `localCopy: "keep"` 时它就是用户附件目录里的那份。
	 * 判定"文件在不在缓存目录里"请用 `isUnderCacheFolder`，不要靠字段名猜。
	 */
	cachePath: string;
	/** 写进笔记、也用于反查的远端 URL。 */
	remoteUrl: string;
	/** 字节数。 */
	size: number;
	/** 上传时声明的 Content-Type。 */
	contentType: string;
	/** 对象存储返回的 ETag（已去掉引号）。空串表示服务端没给。 */
	etag: string;
	/** 上传完成时间（ISO 字符串）。 */
	uploadedAt: string;
	/**
	 * 最近一次**被用到**的时间（epoch ms）。0 = 不确知。
	 *
	 * "被用到"= 渲染时这张图真的换成了这份本地副本（见 `render-hook.ts` 的
	 * `onLocalCopyUsed`）。它存在的唯一目的是给**缓存上限的轮换**排序：
	 * 淘汰时按"最久没用过"先走，而不是按"最早上传"。
	 *
	 * ⚠️ 与 `uploadedAt` 是两件不同的事，别混用：
	 * 一年前上传但天天在看的图，比昨天上传却再没打开过的图**更该留着**。
	 *
	 * ⚠️ 更新它走 `touch()`，是**有节流**的（同一个 key 一小时才改一次）：
	 * 渲染路径会对每张图调用它，不节流的话索引会被反复标脏、反复落盘。
	 */
	lastUsedAt: number;
	/** 原始文件名，仅供报告可读性 —— **不参与任何判定**。 */
	sourceName: string;
}

/** 加载时被丢弃的条目（让人看得见"索引里有东西没读进来"）。 */
export interface SkippedEntry {
	reason: string;
	raw: unknown;
}

export interface CacheIndexLoadResult {
	index: CacheIndex;
	skipped: SkippedEntry[];
}

/** 非空字符串，否则给默认值。 */
function pickString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function pickNonNegativeNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 把一条原始记录规整成 `CacheEntry`；不合规返回 null。
 *
 * 只有 `key` 与 `cachePath` 是**必不可少**的：没有 key 就无法与远端对应，
 * 没有 cachePath 就找不到本地副本 —— 缺任一条，这条记录就没有用途，
 * 留着只会让"清理"与"回退下载"的判断出错。
 *
 * 其余字段缺失时给安全默认值（`size: 0` 只是显示不准，不影响正确性）。
 * 这与 `settings.ts` 的纪律一致：**宁可少一条记录，也不要一条半坏的记录。**
 */
export function normalizeEntry(raw: unknown): CacheEntry | null {
	if (!isPlainRecord(raw)) return null;

	const key = pickString(raw.key).trim();
	if (!key) return null;

	const cachePath = pickString(raw.cachePath).trim();
	if (!cachePath) return null;

	return {
		key,
		cachePath,
		remoteUrl: pickString(raw.remoteUrl),
		size: pickNonNegativeNumber(raw.size),
		contentType: pickString(raw.contentType),
		etag: pickString(raw.etag),
		uploadedAt: pickString(raw.uploadedAt),
		// 坏值/缺失一律 0（= 不确知）。轮换把 0 当"最旧"处理 —— 见 eviction.ts 的说明。
		lastUsedAt: pickNonNegativeNumber(raw.lastUsedAt),
		sourceName: pickString(raw.sourceName),
	};
}

export class CacheIndex {
	/** 用 Map 而不是数组：按 key 查找是最频繁的操作，且 key 天然唯一。 */
	private readonly entries: Map<string, CacheEntry>;

	/**
	 * 远端 URL（**归一化后**）→ 条目。
	 *
	 * 存在的理由：渲染钩子要对页面上**每一个** `<img>` 问一次"这张图本地有吗"，
	 * 而一屏笔记可能有几十张图、索引又可能有上千条 —— 每次都线性扫一遍
	 * 会让滚动明显掉帧。派生映射在写入/删除时同步维护，查找降为 O(1)。
	 *
	 * ⚠️ 删除时必须按**当初存入时那个归一化 URL** 摘除，不能只看 key：
	 * 同一个 key 的 `remoteUrl` 可能被改写（用户换了域名再上传），
	 * 只删 key 会在映射里留下一条指向已消失条目的幽灵记录。
	 */
	private readonly byUrl: Map<string, CacheEntry>;

	constructor(entries: Iterable<CacheEntry> = []) {
		this.entries = new Map();
		this.byUrl = new Map();
		for (const entry of entries) {
			// 构造时也走去重：后写的覆盖先写的（与 `set` 一致），
			// 否则"同一 key 两条记录"会让行为取决于遍历顺序。
			this.write(entry);
		}
	}

	/** 写入的**唯一**入口：同时维护 entries 与 byUrl 两个视图。 */
	private write(entry: CacheEntry): void {
		const existing = this.entries.get(entry.key);
		// 先摘掉同一 key 的旧 URL 映射，否则换域名后会留下幽灵
		if (existing) {
			const oldUrl = normalizeUrl(existing.remoteUrl);
			if (oldUrl && this.byUrl.get(oldUrl)?.key === entry.key) this.byUrl.delete(oldUrl);
		}
		this.entries.set(entry.key, entry);
		const url = normalizeUrl(entry.remoteUrl);
		if (url) this.byUrl.set(url, entry);
	}

	/** 删除的**唯一**入口（同上，两个视图一起维护）。 */
	private erase(key: string): boolean {
		const existing = this.entries.get(key);
		if (!existing) return false;
		this.entries.delete(key);
		const url = normalizeUrl(existing.remoteUrl);
		if (url && this.byUrl.get(url)?.key === key) this.byUrl.delete(url);
		return true;
	}

	get size(): number {
		return this.entries.size;
	}

	get(key: string): CacheEntry | undefined {
		return this.entries.get(key);
	}

	has(key: string): boolean {
		return this.entries.has(key);
	}

	/** 写入或替换。 */
	set(entry: CacheEntry): void {
		this.write(entry);
	}

	/** 删除；返回是否真的删掉了（供调用方汇报）。 */
	remove(key: string): boolean {
		return this.erase(key);
	}

	keys(): string[] {
		return [...this.entries.keys()];
	}

	/**
	 * 所有条目，按 key 排序。
	 *
	 * 排序是刻意的：`Map` 的顺序取决于插入顺序，而插入顺序取决于用户的操作历史。
	 * 落盘与测试都需要**稳定**的顺序，否则同一份逻辑的数据会产出不同的文件内容
	 * （diff 噪音），测试也会变成"有时过有时不过"。
	 */
	toArray(): CacheEntry[] {
		return [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	/** 按本地副本路径反查（"这个文件是不是我们的某个缓存？"）。 */
	findByCachePath(cachePath: string): CacheEntry | undefined {
		return this.toArray().find((entry) => entry.cachePath === cachePath);
	}

	/**
	 * 按远端 URL 反查 —— 渲染钩子的入口。
	 *
	 * ⚠️ 同一个 key 可能被记成不同形式的 URL（配了 `publicUrlBase` 与没配、
	 * 尾斜杠差异、大小写）。这里做**归一化比较**而不是严格相等，
	 * 因为渲染时拿到的是笔记里写的那串文本，未必与当初写入时逐字相同
	 * （用户可能手工改过域名、或从旧配置迁移过来）。
	 *
	 * 走 `byUrl` 派生映射（O(1)）—— 这个方法在渲染路径上要对每张图调用一次。
	 */
	findByRemoteUrl(url: string): CacheEntry | undefined {
		const target = normalizeUrl(url);
		if (!target) return undefined;
		return this.byUrl.get(target);
	}

	/**
	 * 记下"这份副本刚被用到"。返回**是否真的更新了**（供调用方决定要不要落盘）。
	 *
	 * ## ⚠️ 为什么要节流
	 *
	 * 调用点在**渲染路径**上：一屏几十张图、滚动一次就再来一轮。若每次都把
	 * `lastUsedAt` 改成"现在"，索引会被无休止地标脏、被无休止地写盘 ——
	 * 而这件事的全部用途只是"淘汰时排序"。所以同一个 key 在 `minIntervalMs`
	 * 之内只更新一次：排序精度损失最多一小时，代价是不再有无谓的写盘。
	 *
	 * ## 为什么"没有这条记录"时不创建
	 *
	 * 索引里没有这条记录，说明这份副本不该由我们管理（`localCopy: "keep"` 的副本
	 * 在附件目录里、或者它只是个孤儿文件）。凭空造一条记录会让轮换把它当成
	 * "有索引的副本"，而它的路径其实不在我们该管的地方。
	 *
	 * ## ⚠️ 它只把时间**往前**推
	 *
	 * `at` 早于已记录的值时返回 `false`（什么都不改）。这是刻意的：这个入口的语义是
	 * "刚被用到"，把时间往回拨不属于它的职责 —— 而且那会让"越来越旧"这件事变得不可靠。
	 * 系统时钟回拨（NTP 校正）也会落到这条路径上，代价只是那条记录的时间暂时偏新，
	 * 而轮换本来就是按"最久没用过"排序的粗粒度判断。
	 */
	touch(key: string, at: number, minIntervalMs = DEFAULT_TOUCH_MIN_INTERVAL_MS): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return false;
		const previous = entry.lastUsedAt;
		if (previous > 0 && at - previous < minIntervalMs) return false;
		// 就地改：`lastUsedAt` 不参与 `byUrl` 的键，所以不需要走 `write()`
		entry.lastUsedAt = at;
		return true;
	}

	/**
	 * 丢弃本地副本已不存在的条目，返回被丢弃的 key。
	 *
	 * 存在的理由：缓存目录随时可能被用户删掉（这是承诺过的："缓存目录可随时整体删除"），
	 * 而索引留在插件目录里不会跟着消失。若不清掉，索引会持续指向一批不存在的文件，
	 * 于是"该回退下载"会被误判成"本地已有"。
	 *
	 * ⚠️ 这是**自愈**而非清理：它只改索引，不碰任何文件。
	 */
	pruneMissing(exists: (cachePath: string) => boolean): string[] {
		const removed: string[] = [];
		for (const entry of this.toArray()) {
			if (!exists(entry.cachePath)) {
				this.erase(entry.key);
				removed.push(entry.key);
			}
		}
		return removed;
	}

	/** 落盘用的稳定结构。 */
	toJSON(): { version: number; entries: CacheEntry[] } {
		return { version: CACHE_INDEX_VERSION, entries: this.toArray() };
	}

	/**
	 * 从任意输入容错加载。
	 *
	 * 输入可能是任何东西：手改过的 JSON、旧版本格式、被截断的文件。
	 * **坏条目丢弃并计数，绝不抛错** —— 索引坏了顶多是"缓存要重建"，
	 * 而让插件在启动时抛错会让用户完全用不了（连设置页都进不去）。
	 *
	 * 同时接受两种形状：带 `entries` 的对象，或一个裸数组（便于手工修复）。
	 */
	static fromJSON(value: unknown): CacheIndexLoadResult {
		const skipped: SkippedEntry[] = [];

		let rawEntries: unknown;
		if (Array.isArray(value)) {
			rawEntries = value;
		} else if (isPlainRecord(value) && Array.isArray(value.entries)) {
			rawEntries = value.entries;
		} else if (value === null || value === undefined) {
			// 没有索引文件是正常状态（首次运行），不算"跳过"
			return { index: new CacheIndex(), skipped };
		} else {
			return {
				index: new CacheIndex(),
				skipped: [{ reason: "顶层结构不是数组，也没有 entries 数组", raw: value }],
			};
		}

		const seen = new Set<string>();
		const accepted: CacheEntry[] = [];
		for (const raw of rawEntries as unknown[]) {
			const entry = normalizeEntry(raw);
			if (!entry) {
				skipped.push({ reason: "缺少 key 或 cachePath（该条目无法使用）", raw });
				continue;
			}
			// 重复 key：保留**第一条**并明确记账，而不是静默覆盖。
			// 覆盖会让"索引里到底哪条是真的"取决于文件里的顺序 —— 不可预测。
			if (seen.has(entry.key)) {
				skipped.push({ reason: `重复的 key（已保留先出现的那条）：${entry.key}`, raw });
				continue;
			}
			seen.add(entry.key);
			accepted.push(entry);
		}

		return { index: new CacheIndex(accepted), skipped };
	}
}

/**
 * URL 归一化，仅用于**比较**（绝不用于写入笔记）。
 *
 * 归一化三件事：协议与主机大小写（域名不区分大小写）、尾斜杠、以及重复斜杠。
 * **不动**路径里的百分号编码 —— 那部分区分大小写，动它会破坏"只编码一次"的约定。
 */
export function normalizeUrl(url: unknown): string {
	if (typeof url !== "string") return "";
	const trimmed = url.trim();
	if (!trimmed) return "";

	// 手工解析而不是用 `new URL`：笔记里可能写着相对路径或畸形 URL，
	// 那些情况下 `new URL` 会抛错，而"比较不上"才是我们要的结果。
	const schemeEnd = trimmed.indexOf("://");
	if (schemeEnd === -1) return trimmed.replace(/\/+$/, "");

	const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
	const rest = trimmed.slice(schemeEnd + 3);
	const slash = rest.indexOf("/");
	const authority = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
	const path = slash === -1 ? "" : rest.slice(slash).replace(/\/+$/, "").replace(/\/{2,}/g, "/");

	return `${scheme}://${authority}${path}`;
}
