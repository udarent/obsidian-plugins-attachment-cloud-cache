/**
 * 孤儿监视：某个已上传对象**失去最后一个引用**时把它交出来（需求 R17 的主场景）。
 *
 * ## 为什么需要这么一层
 *
 * 需求要的是"用户不要这张图了，问他要不要连云端一起删"。而"不要了"这个意图，
 * 用户表达出来的方式几乎总是**删掉笔记里的引用**（或删掉整篇笔记）—— 两者都**不删文件**，
 * 所以挂在 `vault.on("delete")` 上的旧入口在默认档下永远不会出现（见详细设计 §13.1）。
 *
 * 真正的信号是"**这个对象在本库不再被任何笔记/画布引用**"。而宿主的
 * `metadataCache.resolvedLinks` **看不见它**：那个索引只覆盖库内链接，
 * 而上传之后我们写进笔记的是**远端 URL** ⇒ 必须自己读正文来算引用。
 * （判定复用渲染那一层的 `keyFromUrl`：于是"哪些对象算被引用"与"渲染时认不认这条 URL"
 * 永远是同一套规则 —— 这是"只在会解读它的那一侧算引用"的必然要求。）
 *
 * ## 状态机（这一层**没有定时器**）
 *
 * 它只做三件事：维护 `路径 → 该篇引用的 key 集合` 的快照、维护**全局引用计数**、
 * 在计数归零时把 key 交出去。防抖与攒批**不在这里** —— 那属于调度，
 * 放接线层（只有它知道"一次编辑结束"是什么意思）。于是这一层能用假事件序列穷举，
 * 不需要操纵时钟（与「退避重试要用注入的调度器测」同一条纪律）。
 *
 * ## ⚠️ 冷启动必须"建立"，不能"比较"
 *
 * 加载时还没有任何快照，那时第一遍扫描**不是**"引用变少了"，而是"第一次看到它们"。
 * 所以 `warmUp` 走"只登记、不判定"这条路（`apply` 对没有旧快照的路径返回空）——
 * 否则加载一次就会把所有已上传对象都当成孤儿，全弹一遍。
 *
 * ⭐ **同一条道理也适用于"刚新建的笔记"**：文件第一次出现在快照里时只登记。
 * 但那时接线层必须**尽快把这条登记跑掉**（所以它同时监听 `create`，真机探针查出来的缺口）——
 * 否则那篇笔记的**第一次内容变化**会被当成"第一次见到这篇"，那一刻的引用消失就被丢掉了
 * （症状：新建的笔记里删掉一张图的引用，不问；老笔记正常）。
 *
 * ## 边界（写下来而不是含糊过去）
 *
 * - **只看得到本设备此刻的引用**（多设备盲区，与 F15 同一条约束）：别的设备、别的 vault
 *   可能仍在用同一个对象 ⇒ 询问必须默认保守（保留），文案如实说明；
 * - **不知道"引用变少"的原因**：用户可能只是把那张图挪到另一篇笔记（先删、后加）。
 *   防抖挡得掉编辑中途的状态，挡不掉"先删、过一会儿再加" ⇒ 那种情况会问一次，
 *   用户答"保留"即可（接线层有会话内冷却，不会追着问）。
 *
 * ## 一个孤儿占用的是**两份**资源，所以"清掉它"不是一个动作
 *
 * 云端对象 + 本地副本。两者的**可恢复性完全不同**（云端删了就没了；本地删掉只是
 * 以后重新下载一次），所以询问必须把这两层分开给用户选 —— 把两句话揉成一个开关，
 * 用户就没法"只做他能接受的那一半"（见 `planOrphanLocalRemoval`）。
 */

import { isUnderCacheFolder } from "../cache-path";

/** 监视对象的类型。画布的引用藏在 JSON 字符串里，提取方式与笔记不同。 */
export type NoteKind = "md" | "canvas";

export interface OrphanWatchDeps {
	/** 要监视的文件（接线层按扩展名筛）。 */
	listNotes: () => ReadonlyArray<{ path: string; kind: NoteKind }>;
	/**
	 * 读正文。读不到要抛，由这里记下来。
	 *
	 * ⚠️ **事件驱动的重读必须用 `vault.read`，不能用 `cachedRead`** ——
	 * 后者读的是宿主的文本缓存，而 `modify` 到达时那个缓存还没跟上
	 *（真机实测：防抖 1.5 秒后仍读到修改**前**的内容 ⇒ 差不出"消失的引用" ⇒ 该弹的一次都不弹）。
	 * 冷启动那一趟可以用 `cachedRead`（那时不存在"刚改完"这件事，而且性能要紧）。
	 */
	readText: (path: string) => Promise<string>;
	/** 从正文里取出**属于本存储**的对象 key（接线层注入，复用 `keysInText`）。 */
	extractKeys: (kind: NoteKind, text: string) => Set<string>;
	onError?: (error: unknown) => void;
}

export interface OrphanWatcher {
	/** 建立快照（幂等）。返回 `false` 表示已经建过。 */
	warmUp: () => Promise<boolean>;
	/** 内容变了 → 返回**因此新出现的孤儿**（可能为空）。 */
	noteChanged: (path: string, kind: NoteKind, text: string) => string[];
	/** 文件被删 → 返回因此出现的孤儿（删整篇笔记也会让它的图失去引用）。 */
	noteRemoved: (path: string) => string[];
	/** 文件改名：快照跟着搬，引用计数不变。 */
	noteRenamed: (from: string, to: string) => void;
	/** 快照覆盖的路径数（诊断用）。 */
	watchedCount: () => number;
	/** 当前**还有引用**的 key 数（诊断用；孤儿的 key 不在这里）。 */
	referencedCount: () => number;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) if (!b.has(value)) return false;
	return true;
}

export function createOrphanWatcher(deps: OrphanWatchDeps): OrphanWatcher {
	/** 每篇笔记引用了哪些 key（只留属于本存储的）。 */
	const snapshots = new Map<string, Set<string>>();
	/** key → 引用它的**篇数**（同一篇里出现两次只算一次）。 */
	const counts = new Map<string, number>();
	let ready = false;

	/**
	 * 引用数 -1。返回"它是不是**刚刚**归零"。
	 *
	 * ⚠️ 只有"确实从 1 降到 0"才算孤儿。`counts` 里根本没有这个 key 时（漂移、
	 * 或它从来只出现在别处）返回 `false` —— 那属于"我们的账本对不上"，
	 * 不该因此弹一个删除云端的询问（那是不可恢复的动作）。
	 */
	const dec = (key: string): boolean => {
		const current = counts.get(key) ?? 0;
		if (current <= 0) return false;
		if (current === 1) {
			counts.delete(key);
			return true;
		}
		counts.set(key, current - 1);
		return false;
	};

	const inc = (key: string): void => {
		counts.set(key, (counts.get(key) ?? 0) + 1);
	};

	/**
	 * 用新算出的集合替换某个路径的快照，返回"因此新出现的孤儿"。
	 *
	 * ⚠️ 没有旧快照 ⇒ **只登记**、返回空：那要么是冷启动的第一遍，要么是刚出现的文件
	 *（例如新建的笔记）—— 两种情况都不是"引用变少了"。
	 */
	const apply = (path: string, next: Set<string>): string[] => {
		const before = snapshots.get(path);
		if (!before) {
			snapshots.set(path, next);
			for (const key of next) inc(key);
			return [];
		}
		if (sameSet(before, next)) return [];

		const orphans: string[] = [];
		for (const key of before) {
			if (next.has(key)) continue;
			if (dec(key)) orphans.push(key);
		}
		for (const key of next) {
			if (!before.has(key)) inc(key);
		}
		snapshots.set(path, next);
		return orphans;
	};

	return {
		async warmUp() {
			if (ready) return false;
			// 先置位：并发调用不该建两遍（第二遍会把计数加重复）
			ready = true;
			for (const note of deps.listNotes()) {
				// 已经由事件登记过的（warmUp 跑得慢时用户在编辑）→ 跳过，别覆盖成旧内容
				if (snapshots.has(note.path)) continue;
				try {
					const text = await deps.readText(note.path);
					apply(note.path, deps.extractKeys(note.kind, text));
				} catch (error) {
					// 读不到就当这篇没引用：下一轮事件会重新算它。
					// （绝不能因此当成"它的引用不算数"以外的任何断言 —— 那可能让对象被误判成孤儿。）
					deps.onError?.(error);
				}
			}
			return true;
		},

		noteChanged(path, kind, text) {
			return apply(path, deps.extractKeys(kind, text));
		},

		noteRemoved(path) {
			const before = snapshots.get(path);
			if (!before) return [];
			snapshots.delete(path);
			const orphans: string[] = [];
			for (const key of before) if (dec(key)) orphans.push(key);
			return orphans;
		},

		noteRenamed(from, to) {
			const before = snapshots.get(from);
			if (!before) return;
			snapshots.delete(from);
			snapshots.set(to, before);
		},

		watchedCount: () => snapshots.size,
		referencedCount: () => counts.size,
	};
}

/** 一个孤儿候选为什么不该拿去问用户。 */
export type OrphanSkipReason =
	/** 索引里没有它的记录 ⇒ 不是本插件上传的，我们不该动它。 */
	| "not-ours"
	/** 这个会话里已经问过它了（用户做过选择，别再追着问）。 */
	| "already-asked";

export interface OrphanAskSelection {
	/** 值得拿去问用户的 key（保持输入顺序）。 */
	asks: string[];
	skipped: Array<{ key: string; reason: OrphanSkipReason }>;
}

/**
 * 从"刚变成孤儿的 key"里挑出**值得问用户**的那几个（纯函数）。
 *
 * ⚠️ 为什么要筛"是不是我们上传的"：孤儿判据是"本库不再引用它"，而那个集合里
 * 完全可能出现**我们没见过的东西**（例如用户手写的、指向同一个存储的另一条 URL）。
 * 对不是我们上传的对象，我们**没有任何处置权** —— 不问，也不删。
 *
 * ⚠️ 冷却放在这里是刻意的：**问过一次就不再问**是"不打扰"的底线。
 * 用户回答"保留"之后，同一个对象在同一个会话里不该再弹（他可能还在整理笔记，
 * 而同一条引用被删掉的原因有很多种）。
 */
export function selectOrphanAsks(
	candidates: readonly string[],
	context: {
		/** 索引里有没有这个 key 的记录（= 本插件上传过它）。 */
		hasEntry: (key: string) => boolean;
		/** 这个 key 在本会话里是否已经问过。 */
		hasAsked: (key: string) => boolean;
	}
): OrphanAskSelection {
	const asks: string[] = [];
	const skipped: OrphanAskSelection["skipped"] = [];
	const seen = new Set<string>();

	for (const key of candidates ?? []) {
		// ⚠️ 空串**与纯空白**都要挡掉：空白不是合法的对象 key，
		// 而它会一路走到 `hasEntry` 去（那一步的答案是"没有"⇒ 被当成 not-ours 静默丢掉，
		// 但调用方看不到"这个候选根本没被看"这件事）。
		if (typeof key !== "string" || key.trim() === "") continue;
		// 同一次调用里重复出现的候选只算一次（调用方攒批时可能重复喂进来）
		if (seen.has(key)) continue;
		seen.add(key);

		if (!context.hasEntry(key)) {
			skipped.push({ key, reason: "not-ours" });
			continue;
		}
		if (context.hasAsked(key)) {
			skipped.push({ key, reason: "already-asked" });
			continue;
		}
		asks.push(key);
	}

	return { asks, skipped };
}

/** 一个孤儿对象在**本地**那份副本的处置目标。 */
export interface OrphanLocalTarget {
	/** 对象 key —— 文件删掉之后要按它摘索引记录。 */
	key: string;
	/** 本地副本的 vault 相对路径（索引里记的那条）。 */
	path: string;
	/**
	 * `true` = 这份副本在**缓存目录之外**（`localCopy: "keep"` 时就是用户自己的附件）
	 * ⇒ 走**回收站**；`false` = 缓存副本 ⇒ 直接删、空间立刻释放。
	 */
	isUserFile: boolean;
}

/**
 * 把"用户决定连本地副本一起清掉"翻译成**待删清单**（纯函数）。
 *
 * ## ⚠️ 为什么必须分两类，而不是一律 `vault.delete`
 *
 * 索引里的 `cachePath` **不保证**在缓存目录里：`localCopy: "keep"` 时它就是
 * 用户附件目录里的那份**原件**。两者"能不能重新拿到"不一样，删除方式因此也不一样：
 *
 * | 位置 | 是什么 | 删除方式 | 理由 |
 * |---|---|---|---|
 * | 缓存目录内 | 我们落的可再生副本 | `vault.delete` | 空间立刻释放；回收站不释放 |
 * | 缓存目录外 | **用户自己的附件** | `fileManager.trashFile` | 尊重用户的「删除即进回收站」设置 |
 *
 * 判错的后果**不对称**：把用户文件当成缓存文件 ⇒ 绕过回收站**永久删除用户的图**；
 * 反过来只是"空间没立刻释放"。所以分类用的是 `isUnderCacheFolder`（按**路径段**判断、
 * 拒绝 `..`），而不是字符串前缀。
 *
 * ## 为什么"没有记录"就什么都不做
 *
 * `cachePathOf` 给不出路径有两种情况，都不该动文件：
 * ① 索引里没有这个 key（不是我们上传的，或用户手写的另一条 URL）——
 *    对不属于我们的东西没有处置权（与 `selectOrphanAsks` 同一条纪律）；
 * ② `localCopy: "trash"` 档根本没留副本 —— 没有可删的本地文件。
 *
 * ## 边界（如实写下来）
 *
 * 这里只处理**索引登记过**的副本。一份**从未上传成功**的本地附件（笔记里是
 * `![[x.png]]` 这种库内链接 ⇒ 提取不出对象 key）变成孤儿时，这个入口**看不见它** ——
 * 那是另一类问题（本插件的职责是"围绕已上传对象"，不是通用的附件管家），
 * 见 `requirements.md` R17 的边界说明。
 */
export function planOrphanLocalRemoval(
	keys: readonly string[],
	context: {
		/** 索引里这个 key 的本地副本路径（没有记录就返回空）。 */
		cachePathOf: (key: string) => string | null | undefined;
		/** 缓存目录（vault 相对路径）。 */
		cacheFolder: string;
	}
): OrphanLocalTarget[] {
	const targets: OrphanLocalTarget[] = [];
	/** 同一个路径只删一次（两个 key 不该指向同一份，但清单来自外部，不假设它干净）。 */
	const seen = new Set<string>();

	for (const key of keys ?? []) {
		if (typeof key !== "string" || key.trim() === "") continue;

		const raw = context.cachePathOf(key);
		// 空串**与纯空白**都要挡：一个只有空格的路径交给 `getAbstractFileByPath` 是
		// 在赌宿主怎么处理它，而我们没有任何理由为这种输入冒删错文件的风险。
		if (typeof raw !== "string" || raw.trim() === "") continue;

		const path = raw.trim();
		if (seen.has(path)) continue;
		seen.add(path);

		targets.push({ key, path, isUserFile: !isUnderCacheFolder(path, context.cacheFolder) });
	}

	return targets;
}
