/**
 * **云端清理的自动入口（R17 / F15）**：某个已上传对象**失去最后一个引用**（= 出现孤儿）时，
 * 问用户一次要不要连云端一起清。
 *
 * ## ⚠️ 为什么它必须自己持有状态
 *
 * 这条流程的全部信息都是"跨事件攒出来的"：
 *
 * | 状态 | 是什么 | 丢了会怎样 |
 * |---|---|---|
 * | 引用快照（在 `orphan-watch` 的闭包里） | 每篇笔记引用了哪些对象 | **谁都不会再变成孤儿**（每个 key 都像第一次见到） |
 * | `asked` | 本会话已问过的 key | 同一条引用被反复删 → 反复弹窗打扰 |
 * | `pending` | 攒着还没问的孤儿 | 一次编辑删掉三条引用会被问三次 |
 * | 两个防抖定时器 | 引用重算 / 询问 | 编辑途中每次自动保存都算一遍全篇 |
 *
 * ⇒ 所以它在 `main.ts` 里是**5 个字段 + 6 个方法**，而且字段注释反复强调"必须是稳定的一份"。
 * 搬出来之后这些状态与它们的方法在同一处，`main.ts` 只剩"事件来了叫它一声"。
 *
 * ## 为什么不是"用户删掉那个文件时问"（上一版的落地方式）
 *
 * 那个动作选错了：用户在 Obsidian 里表达"我不要这张图了"几乎总是**删掉笔记里的引用**
 *（或删掉整篇笔记）—— 两者都**不删文件**；而默认档（移入缓存目录）下那个附件文件
 * 根本不在附件目录里（上传时就被搬进缓存目录了）。⇒ 挂在"删文件"上的询问，
 * 默认配置下**一次都不会出现**（设计 §6.2.1）。
 *
 * ## 判定链
 *
 * 1. 快照里某个 key 的引用数归零 ⇒ 候选；
 * 2. 筛掉**不是我们上传的**（查**上传台账** —— 不是"索引里有没有条目"，见 `selectOrphanAsks`）；
 * 3. 筛掉**本会话已经问过的**（冷却：用户做过选择就不再追着问）；
 * 4. 攒批后**只弹一次**。
 *
 * ## ⚠️ 两条必须如实告知（需求 R17 的纪律）
 *
 * - **云端删除不可恢复**；
 * - **多设备盲区**：只看得到本设备的引用，别的设备/别的 vault 可能仍在用同一个对象。
 *
 * 而且默认是**保留**（主按钮），删除是破坏性样式 —— 这个弹窗会自动出现，
 * 顺手按回车的代价在两个方向上并不对等。
 */

import { Notice, TFile } from "obsidian";
import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import { externalKeysOf, runCloudCleanup } from "../maintenance/cloud-cleanup";
import { selectLocalOrphans } from "../maintenance/local-orphans";
import type { CacheIndex } from "../cache/index";
import { keysInTextsAndCanvases } from "../maintenance/run";
import type { CloudCleanupResult } from "../maintenance/cloud-cleanup";
import type { DeletedObjectRecord } from "../maintenance/delete-log";
import {
	createOrphanWatcher,
	dropLocallyReferenced,
	planOrphanLocalRemoval,
	selectOrphanAsks,
} from "../maintenance/orphan-watch";
import type { NoteKind, OrphanLocalTarget } from "../maintenance/orphan-watch";
import { removeOrphanCopies as removeCopies } from "../maintenance/orphan-removal";
import { displayNameForKey } from "../object-key";
import { askOrphanCloudDelete } from "../ui/cloud-delete-modal";
import { buildTaskLabels } from "../ui/task-list";
import type { TaskReporter } from "../ui/task-list";
import type { PluginContext } from "./context";

/**
 * 清单里两类候选的 id 前缀（D-74：同一屏混排）。
 *
 * ⚠️ 必须分开：云端对象的键是 `<名字>-<哈希>.<扩展名>`，本地文件是 `attachments/x.png`，
 * 两者**没有共同形状**，靠前缀才能在执行层分流（`applyChoice`）。
 * ⚠️ 自动那条询问传的是**裸 key**（它没有界面），所以执行层三种形状都要认。
 */
const CLOUD_ID = "cloud:";
const VAULT_ID = "vault:";
import { cloudReferencedKeys, extractStoredKeys, writeDeleteLog } from "./shared-flows";
import { keyOfUrl, localReferencePass, UnreadableNoteError } from "./notes-query";

/** 引用重算的防抖窗口。编辑途中宿主的自动保存会反复触发 `modify`。 */
const CHECK_DEBOUNCE_MS = 1500;

/**
 * 询问的防抖窗口。
 *
 * 它比上面那个**更长**：一次编辑可能连着让好几个对象变成孤儿（删掉一段带三张图的文字），
 * 而"一次整理"里用户可能连着删好几次 —— 攒在一起只问一次，比连着弹三次礼貌得多。
 */
const ASK_DEBOUNCE_MS = 4000;

/**
 * 询问框里最多列出几个对象（再多就只报数量）。
 *
 * ⚠️ 上限影响的是**展示**，不是判定：判定永远跑完整份清单。
 * 每一行现在都带一张缩略图，所以这个数也是"最多同时加载几张图"。
 */
const LIST_MAX = 8;

/**
 * 这篇文件是不是"引用的来源"（只监视笔记与画布）。
 *
 * ⚠️ 只认扩展名，不读内容：`modify` 事件很频繁，这里必须便宜。
 * 认错方向的代价只是"多读一次文件"，而漏认的代价是"孤儿问不出来" ⇒ 宁可多认。
 */
function noteKindOf(file: unknown): NoteKind | null {
	const extension = (file as { extension?: unknown } | null)?.extension;
	if (extension === "md") return "md";
	if (extension === "canvas") return "canvas";
	return null;
}

/**
 * 这条流程对外只有"事件来了叫它一声"，加上卸载时的收尾。
 *
 * ⚠️ 接口收的是**原始文件对象**而不是"已经判好类别"的路径：**"哪些文件算引用的来源"
 * 是这条流程自己的口径**（只认 `md` / `canvas` 扩展名），放在调用方就等于把这条口径
 * 复制到每一个事件处理器里 —— 本项目已经吃过"同一个判据两处各写一遍"的苦。
 */
export interface OrphanFlow {
	/** 库内文件内容变了（非笔记/画布自动忽略；内部防抖后只重算**那一篇**）。 */
	fileChanged(file: unknown): void;
	/**
	 * 库内新增文件（非笔记/画布自动忽略）。
	 *
	 * ⚠️ 新建的笔记/画布要**立刻登记**进快照 —— 原先只监听 `modify` 时，一篇新建的笔记
	 * 在快照里还不存在 ⇒ 它**第一次内容变化**被当成"第一次见到这篇"（只登记、不判定），
	 * 那一刻的引用消失被丢掉。症状是"新建笔记里删掉一张图的引用，不问"（老笔记正常）。
	 * 登记本身不会产出孤儿（`apply` 对没有旧快照的路径返回空），所以这一步安全。
	 */
	fileCreated(file: unknown): void;
	/** 文件被删（含删整篇笔记）：它引用过的对象都少了一个引用。 */
	noteRemoved(file: unknown): void;
	/** 改名：快照跟着搬（改名不是"引用消失"，计数不变）。 */
	noteRenamed(oldPath: string, newPath: string): void;
	/**
	 * 引用快照的冷启动。语义是"第一次看到它们"，**不会**弹任何询问。
	 * 放在布局就绪之后、不阻塞启动。
	 */
	warmUp(): Promise<void>;
	/**
	 * **命令入口**：按本库此刻的引用立刻算一遍，把"我们传过、但没人引用"的对象摆出来问。
	 *
	 * ⚠️ 与自动那条路的差别只在两处：**不吃冷却**、**不吃 `never` 档** ——
	 * 两者都是"别主动打扰"的措施，而这是用户自己按的（见 {@link createOrphanFlow} 里的实现）。
	 */
	checkNow(): Promise<void>;
	/** 清掉两个防抖定时器、丢掉快照（卸载时）。 */
	dispose(): void;
}

/**
 * 算出「**没有任何引用的本地文件**」—— 清理命令的第二类候选（D-74）。
 *
 * ## 「还有人在用」是两份集合的并集（与其它三条命令同一份口径）
 *
 * 1. **本地引用**：正文里直接指着这条路径（`locallyReferencedPaths`，调用方已经算好递进来）；
 * 2. **远端引用**：笔记里写着我们存储的 URL，而那个对象**落在这条路径上**。
 *    ⚠️ 少了第 2 条，"已经迁到云端、链接也改好了"的附件会被当成孤立 ⇒ 一清就删掉
 *    正在显示的图（那份副本没了就得重新下载，离线直接看不到）。
 *
 * ## ⚠️ 代价：这一趟要**再读一遍全库正文**（`scanReferences`）
 *
 * `locallyReferencedPaths` 已经读过一遍（在 `presentOrphans` 里，为了"本地还引用着"那一半）。
 * 两次读库是刻意的取舍：合并需要把"严格口径（读不到就抛）"与"宽松口径（跳过）"揉在一起，
 * 而那条边界在 `UnreadableNoteError` 的注释里写着"绝不能把不知道当成没有引用"。
 * 这是一条**用户显式触发**的命令，几十毫秒换一条不含糊的边界，值得。
 *
 * ## 失败时**不列**（而不是把全部本地文件当孤立）
 *
 * 远端引用统计不出来 ⇒ 我们**不知道**哪些还在用 ⇒ 这一趟本地孤立文件一律不列。
 * 方向是"少列"：那条方向的后果是"这次没清干净"，反方向是"删了正在用的图"。
 */
async function collectLocalOrphans(
	ctx: PluginContext,
	index: CacheIndex,
	cloudKeys: readonly string[],
	locallyReferenced: ReadonlySet<string>,
	/**
	 * 已经读好的全库正文（D-81）。
	 *
	 * ⚠️ **必幅必送**：这里不再自己读库 —— 调用方已经为了「本地引用」读过一遍，
	 * 再读一遍就是几千篇笔记的库上多花一个秒级。
	 */
	notes: readonly { text: string }[]
): Promise<{
	/** 用户自己的、没有任何引用的本地文件。 */
	targets: { path: string; key: string }[];
	/** 站外缓存下来的本地副本（D-77）—— 删了下次显示重新下载。 */
	cached: { path: string; key: string }[];
	skipped: { reason: string; count: number }[];
}> {
	const pathOfKey = new Map<string, string>();
	const keyOfPath = new Map<string, string>();
	const externalPaths = new Set<string>();
	for (const entry of index.toArray()) {
		if (!entry.cachePath) continue;
		pathOfKey.set(entry.key, entry.cachePath);
		keyOfPath.set(entry.cachePath, entry.key);
		if (entry.origin === "external") externalPaths.add(entry.cachePath);
	}

	const used = new Set<string>(locallyReferenced);
	try {
		// ⚠️ 用**已经读好的正文**算远端 key（D-81）：「什么算引用」仍然只有一份实现
		//（`keysInTextsAndCanvases`，连画布也在里面），只是不再读第二遍库。
		const keys = await keysInTextsAndCanvases(
			ctx.app,
			notes.map((note) => note.text),
			(url) => keyOfUrl(ctx.settings, url)
		);
		for (const key of keys) {
			const path = pathOfKey.get(key);
			if (path) used.add(path);
		}
	} catch (error) {
		console.error("[attachment-cloud-cache] 统计远端引用失败，这一趟不列本地孤立文件", error);
		return { targets: [], cached: [], skipped: [{ reason: "远端引用统计失败", count: 0 }] };
	}

	/** 云端对象那条清单已经覆盖的路径 —— 同一个文件不列两行（否则两行各删一次）。 */
	const coveredPaths = new Set<string>();
	for (const key of cloudKeys) {
		const path = pathOfKey.get(key);
		if (path) coveredPaths.add(path);
	}

	// ⚠️ 宿主自己的目录：**配置目录名是用户可配的**（`Vault#configDir`，不一定叫 `.obsidian`），
	// 所以由这里把**当前**那个名字递进去 —— 只靠「顶层目录以点开头」会漏掉 `myconfig/` 这种。
	const configDir = String(ctx.app.vault.configDir ?? "").replace(/\/+$/, "");
	const excludedPrefixes = configDir ? [`${configDir}/`, ".trash/"] : [".trash/"];
	const selection = selectLocalOrphans(ctx.app.vault.getFiles(), {
		usedPaths: used,
		coveredPaths,
		externalPaths,
		excludedPrefixes,
	});
	return {
		targets: selection.paths.map((path) => ({ path, key: keyOfPath.get(path) ?? "" })),
		cached: selection.cachedPaths.map((path) => ({ path, key: keyOfPath.get(path) ?? "" })),
		skipped: selection.skipped,
	};
}

export function createOrphanFlow(ctx: PluginContext): OrphanFlow {
	/**
	 * ⚠️ 稳定的一份：每篇笔记的引用快照与全局引用计数挂在它的闭包里 ——
	 * 每次新建就等于把"哪篇笔记引用过什么"全忘掉，于是**谁都不会再变成孤儿**。
	 */
	const watcher = createOrphanWatcher({
		listNotes: () => {
			const notes: Array<{ path: string; kind: NoteKind }> = [];
			for (const file of ctx.app.vault.getFiles()) {
				const kind = noteKindOf(file);
				if (kind) notes.push({ path: file.path, kind });
			}
			return notes;
		},
		readText: async (path) => {
			const file = ctx.app.vault.getAbstractFileByPath(path);
			if (!file || !(file instanceof TFile)) throw new Error(`不是文件：${path}`);
			return await ctx.app.vault.cachedRead(file);
		},
		extractKeys: (kind, text) => extractStoredKeys(ctx, kind, text),
		onError: (error) => {
			// 读不到某一篇只是"这一篇这一趟没算进来"，下一轮事件会重新算它
			console.error("[attachment-cloud-cache] 建立引用快照时读文件失败", error);
		},
	});

	/** 本会话里已经问过的孤儿 key（冷却：问过就不再打扰）。 */
	const asked = new Set<string>();

	/** 待询问的孤儿（一次编辑可能删掉好几条引用 ⇒ 攒成一批只问一次）。 */
	const pending = new Set<string>();

	/**
	 * 定时器的类型是 `number` 而不是 `ReturnType<typeof setTimeout>`：这里排的定时器一律走
	 * `window.setTimeout`（弹出窗口里裸 `setTimeout` 不是同一个），而浏览器侧的返回值是数字。
	 */
	let checkTimer: number | null = null;
	let askTimer: number | null = null;

	/** 攒批：一次编辑/一次删笔记可能让好几个对象同时成为孤儿 ⇒ 只问一次。 */
	function collect(keys: readonly string[]): void {
		if (keys.length === 0) return;
		for (const key of keys) pending.add(key);
		if (askTimer) window.clearTimeout(askTimer);
		askTimer = window.setTimeout(() => {
			askTimer = null;
			void askAboutOrphans();
		}, ASK_DEBOUNCE_MS);
	}

	/**
	 * 某个文件"内容变了/刚被创建" —— 防抖之后只重算**这一篇**（不是全库）。
	 *
	 * ⚠️ 两个事件共用这一份实现是刻意的：`create` 与 `modify` 对这条链要做的事**完全一样**
	 * （把这一篇重新登记进快照）。早先只挂 `modify` 时，新建的笔记在快照里还不存在，
	 * 于是它第一次内容变化被当成"第一次见到"而丢掉那次的引用消失（见接口里的说明）。
	 */
	function touch(file: unknown): void {
		const kind = noteKindOf(file);
		if (!kind) return;
		const path = (file as { path: string }).path;
		// ⚠️ 一律用 `window.setTimeout`（弹出窗口里裸 `setTimeout` 不是同一个定时器 ——
		// 与 `core/external-cache.ts`、`host/runtime.ts` 同一条理由）。
		if (checkTimer) window.clearTimeout(checkTimer);
		checkTimer = window.setTimeout(() => {
			checkTimer = null;
			void checkOrphans(path, kind);
		}, CHECK_DEBOUNCE_MS);
	}

	/** 重算**这一篇**的引用，看有没有对象因此变成孤儿（只扫一篇，不是全库）。 */
	async function checkOrphans(path: string, kind: NoteKind): Promise<void> {
		const file = ctx.app.vault.getAbstractFileByPath(path);
		// 文件可能刚被删/改名 ⇒ 那不是"内容变了"（删除与改名各有自己的事件）
		if (!file || !(file instanceof TFile)) return;

		let text: string;
		try {
			// 用 `read`（真实读取）而不是 `cachedRead`：后者读宿主的文本缓存，
			// 而"缓存有没有跟上刚才那次修改"是**额外的一个时序假设**。
			// ⚠️ 如实记：真机上**没有**观察到它滞后（探针的诊断显示快照被正确更新）——
			// 所以这不是"修了一个 bug"，而是把假设去掉：这条链已经在防抖之后，
			// 每篇改动读一次磁盘的代价可以接受，而判错的代价是"该弹的框不弹"。
			text = await ctx.app.vault.read(file);
		} catch (error) {
			// 读不到就跳过这一轮（下一条事件会重算）。
			// ⚠️ **绝不能**因此当成"它没有引用了" —— 那会把仍在用的对象判成孤儿。
			console.error("[attachment-cloud-cache] 读笔记以统计引用失败", error);
			return;
		}
		collect(watcher.noteChanged(path, kind, text));
	}

	/**
	 * 把一批候选摆到用户面前 —— **自动与命令共用的唯一实现**。
	 *
	 * ## ⭐ 一个孤儿占**两份**资源，所以询问是三档而不是"删 / 不删"
	 *
	 * 云端对象（删了**找不回来**）+ 本地副本（删掉只是"以后重新下载一次"）。
	 * 用户答"只删本地"时**一次网络写都不做** —— 这条路径存在的意义就是
	 * "让库小一点，但别动我的源文件"。
	 *
	 * @param keys 候选 key（调用方只该传"我们上传过、且本库此刻看不见引用"的）
	 * @param bypassCooldown 命令那条路传 `true`：**冷却只管自动那一侧**
	 *（它存在的理由是"别反复打扰"，而用户主动跑命令不属于打扰）。
	 *⚠️ 但**记还是照记** —— 记下来的是"这个问题已经问过他了"，下一次自动触发不该再冒出来。
	 */
	async function presentOrphans(keys: readonly string[], bypassCooldown: boolean): Promise<void> {
		// ⭐ 排障（D-67）：这条路只在"真的攒出候选"时才跑，所以日志量很小；
		// 而它最需要日志 —— 删掉的东西不可恢复，"为什么它被当成孤儿"要能一眼看清。
		const startedAt = Date.now();
		const debug = ctx.settings.debugLogging;
		const index = ctx.currentIndex();
		// ⚠️ 站外缓存的 key 集合**在循环外算一次**：放进 `isExternal` 里逐个查索引
		// 会让这一遍变成 O(n²)（清单可能几百行）。
		const external = externalKeysOf(index);

		// ⚠️⚠️ 先摘掉"**本地副本还被正文直接指着**"的那些（2026-10-22 审计查出的冲突：
		// 同一个对象，引用快照说"在用"、这条命令却把它列成孤儿 ⇒ 用户可能删掉正文
		// 还在显示的东西）。判据在 `orphan-watch.ts::dropLocallyReferenced`，
		// 路径那一侧与其它命令**同一份**（`notes-query.ts::locallyReferencedPaths`）。
		// ⚠️ 读不到某篇笔记 ⇒ **这次什么都不问**（这一侧是"删"的方向，不能把"不知道"
		// 当成"没有引用"）—— 文案与云端清理那条路同一句。
		// ⚠️ 代价：这一趟要读一遍全库正文（与 `cloudReferencedKeys` 同量级）。它只在
		// **真的攒出了候选**时跑（前面的防抖与差分已经把绝大多数拍挡掉了），而这个判据
		// 决定的是一次**不可恢复的删除** —— 这个代价换得起。
		let locallyReferenced: ReadonlySet<string>;
		/**
		 * ⭐⭐ 2026-10-22（D-81）：这一遍读库同时留下正文。
		 *
		 * 清理命令需要两份答案（本地引用 / 远端 key），原料是同一批正文；
		 * 从前各读一遍，而“读不到就抛”那个严格口径更不该写两次。
		 */
		let notes: { text: string }[] = [];
		try {
			const pass = await localReferencePass(ctx.app, { debug });
			locallyReferenced = pass.referenced;
			notes = pass.notes;
		} catch (error) {
			new Notice(
				error instanceof UnreadableNoteError
					? ctx.t("cloudCleanupUnreadableNote", { path: error.path })
					: describeError(error)
			);
			return;
		}
		const { kept } = dropLocallyReferenced(keys, {
			cachePathOf: (key) => index.get(key)?.cachePath,
			referencedPaths: locallyReferenced,
		});

		// ⭐ 三段数目：台账里没有 URL 引用的 → 又被本地引用保下来的 → 最终要问的。
		// 中间那段是 D-59 加的判据，**它的数值非零就是"命中了那类冲突"**。
		debugTimed(debug, "云端清理候选", startedAt, {
			台账孤儿: keys.length,
			本地仍引用: keys.length - kept.length,
			待问: kept.length,
		});

		const selection = selectOrphanAsks(kept, {
			// ⭐ 判"是不是我们的"必须查**上传台账**，不能查"索引里有没有条目"：			// 条目只管"本地副本在哪"，而「不留副本」那一档没有副本、按纪律不写条目
			// ⇒ 问条目会在那一档对**所有**对象答"不是我们的"，这个询问于是永不出现
			// （N11，与 P8 同一形状）。台账不看副本，三档都答得对。
			isOurs: (key) => index.wasUploaded(key),
			// ⭐ 站外缓存一律不问（判据的完整理由在 `selectOrphanAsks` 的 `isExternal`）——
			// 2026-10-16 从退役的「清理云端未使用对象…」继承来，**两条路共用这一处**。
			isExternal: (key) => external.has(key),
			hasAsked: (key) => (bypassCooldown ? false : asked.has(key)),
		});
		// ⭐⭐ 命令路的本地候选（D-74 / D-77）：**没有任何引用的本地文件**
		// ＋ **站外缓存下来的副本**。
		// ⚠️ 必须在"云端候选为空就早退"**之前**算 —— 台账空不等于没事可清，
		// 本地文件与台账毫无关系（从来没有上传过的那些根本没有 key）。
		const localOrphans = bypassCooldown
			? await collectLocalOrphans(ctx, index, selection.asks, locallyReferenced, notes)
			: null;
		// ⚠️ **三部分**都要算：D-77 之后「只有站外缓存副本」也是一种"有东西可清"。
		const localCount = (localOrphans?.targets.length ?? 0) + (localOrphans?.cached.length ?? 0);
		if (selection.asks.length === 0 && localCount === 0) {
			// ⚠️ **命令那条路必须出声**（2026-10-16 加）：用户特地按了它，静默会被读成"命令坏了"
			//（D-43 的同一形状）。而"候选被筛空"从此有了新的来路 —— 站外缓存的对象会被
			// `isExternal` 挡掉，所以"台账里明明有一堆已上传对象却一个都不问"是**正常可达**的。
			if (bypassCooldown) new Notice(ctx.t("orphanNoneToCheck"));
			return;
		}

		// ⭐ 问过就记住，**无论用户怎么回答** —— 这是"不打扰"的底线
		//（他可能还在整理笔记，同一条引用被删掉的原因有很多种）
		for (const key of selection.asks) asked.add(key);

		const mode = ctx.settings.orphanAsk;

		// ⭐ `notice` 档：不弹窗，只给一条**不阻塞**的通知（并指路到命令）。
		// 它同样吃冷却 —— 通知反复冒出来，与弹窗一样烦人。
		// ⚠️ 指路指向的是**新命令**（"检查未引用的云端附件…"）：它按同一批判据再列一次，
		// 正是"想再处理一次"时该去的地方（`cleanup-cloud` 走列桶，是另一件事）。
		// ⚠️ `selection.asks.length > 0`：本地孤立文件不走这一档（那句通知说的是"已上传的附件"），
		// 少了这个条件，台账空但本地有孤立文件时会说"有 0 个已上传的附件…"。
		if (mode === "notice" && selection.asks.length > 0) {
			new Notice(
				ctx.t("orphanNotice", {
					count: selection.asks.length,
					command: ctx.t("cmdCheckOrphans"),
				})
			);
			return;
		}

		// 存储没配好就**不问了**：这个弹窗的三个选项里有两个以"云端"为前提，
		// 而只有一个能成立时，问法本身是误导（"只删本地副本"那一档由 R17 的询问
		// 与 `cleanup-cloud` 承担，跟这里的三选一不是一件事）。
		const client = ctx.buildClient();
		// ⚠️ 只在**真有云端候选**时拦：删本地孤立文件不需要存储连接（D-74）。
		if (!client && selection.asks.length > 0) return;

		// ⭐ 清单给的是**图 + 名字**，不是一串 key：老 key 是 `<sha256>.<扩展名>`，
		// 用户看它认不出是哪张图，而这是不可恢复动作前**唯一能核对**的东西。
		// ⚠️ 名字的三个来源按序兜底：条目 sourceName → 从 key 反推（key 自带名字：`<名字>-<哈希>.<扩展名>`）
		// → 退化成 key 本身；图仍然是可核对的（有副本用副本，没有就用存储里的地址）。
		const inputs = selection.asks.map((key) => {
			const entry = index.get(key);
			// 「不留副本」档没有条目 ⇒ 从 key 反推（key 自带名字）
			return {
				id: key,
				name: entry?.sourceName || displayNameForKey(key),
				localPath: entry?.cachePath,
				remoteKey: key,
			};
		});

		/** 三档都要说清的两句（**可恢复性**与**多设备盲区**），自动与命令共用同一份措辞。 */
		const lines = [ctx.t("orphanLocalNote"), ctx.t("cloudCleanupDeviceBlindSpot")];

		/**
		 * 把用户选的那一档落到**他勾中的那些**上 —— 自动与命令两条路**共用这一份**。
		 *
		 * ⚠️ `report` 只有命令那条路给（它有进度界面）：自动那条只有一两个孤儿，
		 * 弹窗自己已经把话说完了。
		 */
		const applyChoice = async (
			choice: "local" | "both",
			chosen: readonly string[],
			report?: TaskReporter
		): Promise<void> => {
			// ⭐ 清单里混了两类（D-74）：云端对象（`cloud:<key>`）与本地孤立文件（`vault:<path>`）。
			// 自动那条询问传的是**裸 key**（它没有界面）⇒ 三种形状都认。
			const cloudKeys: string[] = [];
			const vaultPaths: string[] = [];
			/** `kind|值` → 清单行的 id：进度要按**界面上的那一行**上报（键与 id 不是同一个东西）。 */
			const idOf = new Map<string, string>();
			for (const id of chosen) {
				if (id.startsWith(VAULT_ID)) {
					const path = id.slice(VAULT_ID.length);
					vaultPaths.push(path);
					idOf.set(`vault|${path}`, id);
					continue;
				}
				const key = id.startsWith(CLOUD_ID) ? id.slice(CLOUD_ID.length) : id;
				cloudKeys.push(key);
				idOf.set(`cloud|${key}`, id);
			}

			const index = ctx.currentIndex();
			/** 路径 → key（索引里记着的那条）。用来在删完之后**摘掉记录**。 */
			const keyOfPath = new Map<string, string>();
			for (const entry of index.toArray()) {
				if (entry.cachePath) keyOfPath.set(entry.cachePath, entry.key);
			}
			const localTargets: OrphanLocalTarget[] = [
				// 云端对象：删的是它在本地的那份副本（索引记的落点）
				...planOrphanLocalRemoval(cloudKeys, { cachePathOf: (key) => index.get(key)?.cachePath }),
				// 本地孤立文件（D-74）：**它自己就是待删的那一份**（没有云端对象可依）。
				// ⚠️ 若它在索引里（上传过、只是引用没了），把 key 带上 —— 删完要摘记录，
				// 否则渲染层会以为副本还在、去加载一个已经不存在的文件。
				// ⚠️ 不在索引里的（从来没上传过）key 留空：`forget("")` 是安全的 no-op。
				...vaultPaths.map((path) => ({ key: keyOfPath.get(path) ?? "", path })),
			];
			const failed = new Set<string>();
			const markAll = (status: "running" | "done"): void => {
				for (const key of chosen) {
					if (status === "done" && failed.has(key)) continue;
					report?.(key, status);
				}
			};
			markAll("running");

			// 先删云端（不可恢复的那一半先做：失败时下面那句提示会如实说明"云端对象未动"）
			let cloud: CloudCleanupResult | null = null;
			const logRecords: DeletedObjectRecord[] = [];
			// ⚠️ `cloudKeys.length > 0`：清单里可能**只有**本地孤立文件（D-74），
			// 那时"连云端一起删"对它就是"删本地那份"，没有云端可调。
			if (choice === "both" && cloudKeys.length > 0 && client) {
				try {
					cloud = await runCloudCleanup(
						{
							client,
							index: () => ctx.currentIndex(),
							persistIndex: () => ctx.hostContext().persistIndex(),
							notify: (message) => new Notice(message),
							t: ctx.t,
							onRemoved: (record) => logRecords.push({ ...record, scope: "orphan" }),
							// 进度：把执行层的事件接到界面上（键与清单行的 `id` 同一份）
							onItem: (event) => {
								// ⚠️ 执行层报的是**裸 key**，界面那一行的 id 带 `cloud:` 前缀 ⇒ 映射回去，
								// 否则进度会挂不上（那一行永远停在等待）。
								const id = idOf.get(`cloud|${event.key}`) ?? event.key;
								if (event.status === "failed") failed.add(id);
								report?.(id, event.status);
							},
						},
						cloudKeys
					);
				} catch (error) {
					new Notice(ctx.t("cloudDeleteFailed", { error: describeError(error) }));
				}
			}
			// 留痕：这条询问可能是**自动出现**的，而删除不可恢复 ⇒ 至少要让"删过什么"事后可查
			await writeDeleteLog(ctx, logRecords);

			const removed = await removeLocalCopies(localTargets);
			// 本地那一步做完 = 这一件真的走完了。⚠️ 云端删失败的那几件**保持失败**
			// （下一行只给没失败的那些收尾）—— 否则界面会替用户说"都成功了"。
			markAll("done");

			new Notice(
				cloud
					? ctx.t("orphanDeletedBoth", {
							removed,
							deleted: cloud.deleted,
							alreadyGone: cloud.alreadyGone,
							failed: cloud.failed,
						})
					: ctx.t("orphanLocalDeleted", { removed })
			);
		};

		// ⭐ 命令那条路：**清单式弹窗**（缩略图 + 勾选 + 进度，与另外三条链同一个壳）。
		// 它列的是**全部**候选（不截断：要逐项勾选），并在勾选之后就地把三档之一跑完。
		// ⚠️ `bypassCooldown === true` 就是**命令**那条路（冷却只管自动那一侧，见函数头）。
		if (bypassCooldown) {
			// ⭐⭐ 第二类候选：**没有任何引用的本地文件**（D-74）。
			//
			// ⚠️ 只在这条**命令**路算：自动那条询问的语义是"这些云端对象你还留着吗"
			// （`orphanAsk` 的开关），把用户的本地文件塞进去等于"我没做任何事，它却弹窗
			// 问我要不要删我自己的文件"。

			// ⚠️ 云端那一批的 `id` 原来是裸 key（自动那条路还用着）⇒ 这里**只加前缀**，
			// 不动 `inputs` 本身：两条路共用同一份输入，改一处会把自动路也带歪。
			const cloudInputs = inputs.map((input) => ({ ...input, id: CLOUD_ID + input.id, hint: ctx.t("orphanRowCloud") }));
			// ⚠️ `localOrphans` 在上面的早退判断之前就算好了（台账空也可能有它）
			// ⭐ 2026-10-22（D-77）：两类都是「本地那一份」（删法一样 ⇒ 同一个 `vault:` 前缀），
			// 但**标签不同**：一个是用户自己的文件（可能是唯一一份），
			// 另一个是站外缓存下来的副本（删了下次显示重新下载）。
			const toRow = (target: { path: string }, hint: string) => ({
				id: VAULT_ID + target.path,
				name: target.path.split("/").pop() ?? target.path,
				localPath: target.path,
				hint,
			});
			const vaultInputs = [
				...(localOrphans?.targets ?? []).map((target) => toRow(target, ctx.t("orphanRowLocal"))),
				...(localOrphans?.cached ?? []).map((target) => toRow(target, ctx.t("orphanRowCached"))),
			];
			/**
			 * 按过滤开关重算清单与正文。
			 * ⚠️ 正文里的数字跟着变 —— 它与清单必须是**同一批**（§7.3.4 那条纪律），
			 * 否则"共 N 个"与下面几行对不上，而用户是按那句话判断要不要动手的。
			 */
			const buildView = (state: Readonly<Record<string, boolean>>) => {
				const showCloud = state.cloud !== false;
				const showLocal = state.local !== false;
				const shown = [...(showCloud ? cloudInputs : []), ...(showLocal ? vaultInputs : [])];
				return {
					cards: ctx.fileCards(shown, shown.length),
					// ⭐⭐ 2026-10-22（D-76）：正文是**一句固定说明**（与「上传附件」同一个规则）——
					// 不随内容 / 随过滤变，也不含数量：数量在**两个删除档的按钮上**。
					// ⚠️ 所以这里**不交 `lines`**（交了就是“换个过滤器顶部变一次”）。
					lines: [ctx.t("orphanListBody")],
				};
			};
			const initial = buildView({ cloud: true, local: true });

			const answer = await ctx.pickTasks({
				// ⭐ 2026-10-22（D-76）：标题 = **命令名去省略号**（与「上传附件」同一条规则；
				// 疑问句留给**自动**那条询问：那次打扰确实是一个问题）。
				title: ctx.t("orphanListTitle"),
				lines: initial.lines,
				cards: initial.cards,
				// ⭐ 默认只勾**云端对象**：本地孤立文件从来没上传过，删了**没有云端可依**
				//（会进回收站，但那是用户设置说了算的事）。要清它们得自己勾 ——
				// 与「上传附件」里"没有任何笔记引用的那些默认不勾"同一条纪律。
				initiallySelected: cloudInputs.map((input) => input.id),
				// ⭐ 两个类别开关（2026-10-22 用户要求：「加过滤选项，可以不勾本地，也可以不勾云端」）。
				filters: [
					{ key: "cloud", name: ctx.t("orphanFilterCloud"), value: true },
					{ key: "local", name: ctx.t("orphanFilterLocal"), value: true },
				],
				onFiltersChange: (state) => Promise.resolve(buildView(state)),
				// ⚠️ 三档动作由 `actions` 给，这套 `labels` 只用到「全选 / 全不选 / 取消」与行尾「打开」那几句；
				// `cta` 那一句用不到（没有单一主按钮），传一个**已被别处用着**的键，别造死键。
				labels: buildTaskLabels(ctx.t, "orphanKeep"),
				actions: [
					// ⭐ 保守那一档是**主按钮**：顺手按回车的代价在两个方向上不对等
					// （误删云端不可恢复，"保留"最多是下次再清一次）。理由见 `cloud-delete-modal.ts`。
					{ key: "keep", label: () => ctx.t("orphanKeep"), primary: true, idle: true },
					// ⭐ D-76：两个删除档都带数量（与「上传附件」的主按钮同一个读法：
					// “这一下动几个”写在要按的那个按钮上）。「保留」不动任何东西 ⇒ 不带。
					{ key: "local", label: (count) => ctx.t("orphanLocalOnly", { count }) },
					{ key: "both", label: (count) => ctx.t("orphanBoth", { count }), destructive: true },
				],
				run: async (chosen, report, action) => {
					// `keep` 那一档是 `idle` ⇒ 根本不会走到这里（由弹窗直接收口）
					if (action === "both" || action === "local") await applyChoice(action, chosen, report);
				},
			});
			// `null` = 取消 / 直接关掉 ⇒ 如实说一句（这一条以前是"点边上就不见了"的场景）
			if (!answer) new Notice(ctx.t("maintainCancelled"));
			return;
		}

		// ⭐ 自动那条路：保持**三选一弹窗**（主按钮是保守项）。它通常只摆一两个孤儿，
		// 不是"清单"场景；而它出现时用户多半没在期待它 ⇒ 措辞与按钮顺序都按那个前提设计的
		// （见 `cloud-delete-modal.ts` 头注释）。两条路**共用同一个执行体** `applyChoice`。
		const cards = ctx.fileCards(inputs, LIST_MAX);
		const choice = await askOrphanCloudDelete(ctx.app, {
			title: ctx.t("orphanTitle"),
			lines: [
				ctx.t("orphanBody", { count: selection.asks.length }),
				// ⚠️ 上面 `cards` 传的是 `LIST_MAX` ⇒ **列表被截断**，所以这一句必须说
				//（与「上传附件」那边正好相反：那里列表是全量的，摘要里的举例已删掉）。
				// ⭐ 判据是**列表全不全**，不是"哪个界面更好看"。
				...(selection.asks.length > LIST_MAX
					? [ctx.t("orphanMore", { count: selection.asks.length - LIST_MAX })]
					: []),
				...lines,
			],
			cards,
			keepCta: ctx.t("orphanKeep"),
			// ⚠️ 这两个模板现在带 `{count}`（D-76）：不传参数就会原样显示 `{count}`。
			localCta: ctx.t("orphanLocalOnly", { count: selection.asks.length }),
			bothCta: ctx.t("orphanBoth", { count: selection.asks.length }),
		});
		// ⚠️ `dismissed`（点背景 / ESC 关掉）与 `keep` 在**动作**上相同（都不删），
		// 但在**沟通**上相反：误关的人需要知道"什么都没发生、想再问一次该去哪"。
		// 用户 2026-10-14 在 Android 上报的正是这个 —— "点一下边上就不见了"，
		// 而那个询问**只自动出现一次**（冷却记住之后不会再问）。
		if (choice === "dismissed") {
			new Notice(ctx.t("orphanDismissed", { command: ctx.t("cmdCheckOrphans") }));
			return;
		}
		if (choice === "keep") return;

		await applyChoice(choice, selection.asks);
	}

	/**
	 * 删掉孤儿对象在本地的副本（用户答"连本地一起清"之后）。
	 *
	 * ⚠️ 判定与执行都不在这里：分类由 `planOrphanLocalRemoval`（纯函数，套件与变异锚点都在）
	 * 给出，删除顺序与两类文件的分工在 `maintenance/orphan-removal.ts`。
	 * 这一层只负责把两条依赖接上去 —— 本项目的教训是"接线层里的几行"最容易
	 * 悄悄长出没人验的分支（弹窗那层就出过一次）。
	 */
	function removeLocalCopies(targets: readonly OrphanLocalTarget[]): Promise<number> {
		return removeCopies(targets, {
			app: ctx.app,
			forget: (key) => ctx.currentIndex().remove(key),
			persist: () => ctx.hostContext().persistIndex(),
			onPersistError: (error) => {
				// 与批量清理同一条纪律：索引存不下去必须说出来，不能静默
				new Notice(ctx.t("cloudCleanupPersistFailed", { error: describeError(error) }));
			},
			onDeleteError: (error, path) => {
				console.error(`[attachment-cloud-cache] 删除孤儿的本地副本失败（${path}）`, error);
			},
		});
	}

	/**
	 * 把攒下的孤儿筛一遍、问用户一次（**自动**那一侧）。
	 *
	 * ⚠️ 它只做两件事：把 `pending` 拿走、过滤掉"别主动告诉我"那一档 ——
	 * 剩下的全在 {@link presentOrphans} 里（命令那条路走的是同一个函数）。
	 */
	async function askAboutOrphans(): Promise<void> {
		const batch = [...pending];
		pending.clear();
		if (batch.length === 0) return;

		// ⭐ 用户可以直接说"别主动告诉我"。这一档在**筛选之前**就返回：
		// 连扫一遍都省了，而且**没有任何信息丢失** —— 「检查未引用的云端附件…」那条命令
		// 按同一批判据随时能再列一次（它算的也是"台账里有、本库看不见引用"）。
		// ⚠️ 这一档**只管自动这一侧**：命令是用户主动要的，不吃它（见 {@link checkNow}）。
		if (ctx.settings.orphanAsk === "never") return;

		await presentOrphans(batch, false);
	}

	/**
	 * 命令入口：**立刻**按本库当前引用算一遍，把"我们传过、但本库已经看不见引用"的对象摆出来问。
	 *
	 * ## 为什么需要它（用户 2026-10-14 Android 报告）
	 *
	 * 那个三档弹窗**只自动出现一次**：冷却（`asked`）记住之后不会再问，而弹窗还可能被
	 * **误关**（点背景 / ESC —— 用户的原话是"点一下边上就不见了"）⇒ 他从此失去那次决定，
	 * 云端对象永远留着。这条命令就是"自己把那次决定拿回来"的路。
	 *
	 * ## 三条纪律
	 *
	 * - **不吃冷却**：冷却防的是"反复打扰"，而这是显式动作；
	 * - **不吃 `never` 档**：那一档的语义是"别**主动**告诉我"，命令是用户主动要的
	 *（与"开关/名单只管自动那一路"同一条纪律）；
	 * - **判据与自动那条同源**：候选来自**上传台账**（`wasUploaded`，不是索引条目 —— N11），
	 *   引用来自 `cloudReferencedKeys`（与「清理云端未使用对象…」同一处实现）。
	 *   ⚠️ 与那条命令的区别在**候选来源**：这里只问"我们上传过的"（不列桶 ⇒ 不需要
	 *   `ListBucket` 权限，也快得多）；那一条列全桶，管的是"桶里所有看不见引用的对象"。
	 */
	async function checkNow(): Promise<void> {
		const index = ctx.currentIndex();
		let referenced: Set<string>;
		try {
			referenced = await cloudReferencedKeys(ctx);
		} catch (error) {
			// ⚠️ 有笔记读不到 ⇒ **什么都不问**。这一侧是危险方向：漏掉的那篇可能正引用着
			// 这些对象，把"读不到"当成"没人引用"会凭空多出一批候选（清理命令那条路同样兜）。
			new Notice(describeError(error));
			return;
		}
		const orphans = index.uploadedKeys().filter((key) => !referenced.has(key));
		// ⚠️⚠️ 2026-10-22（D-74）：**不再在这里早退**。台账空 ≠ 没事可清 ——
		// 本地孤立文件与台账毫无关系（从来没上传过的东西根本没有 key），
		// 一早退它们就永远进不了清单。两类**都空**时由 `presentOrphans` 说"没有需要处理的"。
		await presentOrphans(orphans, true);
	}

	return {
		// ⚠️ 两个事件**共用同一个函数**（不是"互相调用"）：`create` 与 `modify` 对这条链
		// 要做的事完全一样，写成两个实现迟早在某一次改动里分叉。
		fileChanged: touch,
		fileCreated: touch,
		noteRemoved(file) {
			const path = (file as { path?: unknown } | null)?.path;
			if (typeof path !== "string") return;
			collect(watcher.noteRemoved(path) ?? []);
		},
		noteRenamed(oldPath, newPath) {
			watcher.noteRenamed(oldPath, newPath);
		},
		// 命令入口（不是事件）：用户主动要一次"本库现在有哪些已上传但没人引用的附件"。
		checkNow,
		async warmUp() {
			try {
				await watcher.warmUp();
			} catch (error) {
				// 快照建不起来只是"这一趟不工作"，不该影响插件其余部分；
				// 之后任何一条编辑事件都会从那一篇开始重新建立。
				console.error("[attachment-cloud-cache] 建立引用快照失败", error);
			}
		},
		dispose() {
			if (checkTimer) window.clearTimeout(checkTimer);
			if (askTimer) window.clearTimeout(askTimer);
			checkTimer = null;
			askTimer = null;
			pending.clear();
		},
	};
}
