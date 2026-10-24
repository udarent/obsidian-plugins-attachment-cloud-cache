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
 *
 * ## ⚠️ 只有**自动**这一条路（2026-10-24，随设置页重排一起清掉的那半）
 *
 * 从前这里还有一条**命令**路：`presentOrphans(keys, true)` 会列一份"云端对象 ＋ 没有任何引用的
 * 本地文件"的清单，带两个类别开关与三个动作档。命令面板收敛成「附件管理」之后
 * **再没有调用方**（`bypassCooldown` 恒为 `false`），于是整条路连同它的清单壳 `filters` 能力一起删掉了。
 *
 * ⚠️ 那条路上的两件事**没有丢**：
 * - 「本地孤立文件」仍由附件管理的「待清理」筛选列出 —— 判据是同一个 `selectLocalOrphans`；
 * - 三档删除（只删本地 / 连云端一起删 / 保留）仍是这里的 `askOrphanCloudDelete` ＋ `applyChoice`。
 *
 * ⇒ 想再给一个"手动清单"入口，别把这半接回来：附件管理已经是那个入口，两处做同一件事
 * 必然有一天只有一处被改。
 */

import { Notice, TFile } from "obsidian";
import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import { externalKeysOf, runCloudCleanup } from "../maintenance/cloud-cleanup";
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
import type { PluginContext } from "./context";
import { extractStoredKeys, writeDeleteLog } from "./shared-flows";
import { localReferencePass, UnreadableNoteError } from "./notes-query";

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
	/** 清掉两个防抖定时器、丢掉快照（卸载时）。 */
	dispose(): void;
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
	 * 把一批候选摆到用户面前（**自动**那一路，唯一入口）。
	 *
	 * ## ⭐ 一个孤儿占**两份**资源，所以询问是三档而不是"删 / 不删"
	 *
	 * 云端对象（删了**找不回来**）+ 本地副本（删掉只是"以后重新下载一次"）。
	 * 用户答"只删本地"时**一次网络写都不做** —— 这条路径存在的意义就是
	 * "让库小一点，但别动我的源文件"。
	 *
	 * @param keys 候选 key（调用方只该传"我们上传过、且本库此刻看不见引用"的）
	 */
	async function presentOrphans(keys: readonly string[]): Promise<void> {
		// ⭐ 排障（D-67）：这条路只在"真的攒出候选"时才跑，所以日志量很小；
		// 而它最需要日志 —— 删掉的东西不可恢复，"为什么它被当成孤儿"要能一眼看清。
		const startedAt = Date.now();
		const debug = ctx.settings.debugLogging;
		const index = ctx.currentIndex();
		// ⚠️ 站外缓存的 key 集合**在循环外算一次**：放进 `isExternal` 里逐个查索引
		// 会让这一遍变成 O(n²)（候选可能几百个）。
		const external = externalKeysOf(index);

		// ⚠️⚠️ 先摘掉"**本地副本还被正文直接指着**"的那些（2026-10-22 审计查出的冲突：
		// 同一个对象，引用快照说"在用"、这条链却把它列成孤儿 ⇒ 用户可能删掉正文
		// 还在显示的东西）。判据在 `orphan-watch.ts::dropLocallyReferenced`，
		// 路径那一侧与其它命令**同一份**（`notes-query.ts::locallyReferencedPaths`）。
		// ⚠️ 读不到某篇笔记 ⇒ **这次什么都不问**（这一侧是"删"的方向，不能把"不知道"
		// 当成"没有引用"）—— 文案与云端清理那条路同一句。
		// ⚠️ 代价：这一趟要读一遍全库正文（与 `cloudReferencedKeys` 同量级）。它只在
		// **真的攒出了候选**时跑（前面的防抖与差分已经把绝大多数拍挡掉了），而这个判据
		// 决定的是一次**不可恢复的删除** —— 这个代价换得起。
		let locallyReferenced: ReadonlySet<string>;
		try {
			const pass = await localReferencePass(ctx.app, { debug });
			locallyReferenced = pass.referenced;
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
			// ⭐ 站外缓存一律不问（判据的完整理由在 `selectOrphanAsks` 的 `isExternal`）。
			isExternal: (key) => external.has(key),
			hasAsked: (key) => asked.has(key),
		});
		if (selection.asks.length === 0) return;

		// ⭐ 问过就记住，**无论用户怎么回答** —— 这是"不打扰"的底线
		//（他可能还在整理笔记，同一条引用被删掉的原因有很多种）
		for (const key of selection.asks) asked.add(key);

		const mode = ctx.settings.orphanAsk;

		// ⭐ `notice` 档：不弹窗，只给一条**不阻塞**的通知（并指路到附件管理）。
		// 它同样吃冷却 —— 通知反复冒出来，与弹窗一样烦人。
		// ⚠️ 指路指向的是**附件管理**（路径从 i18n 取）：它按同一批判据再列一次，
		// 正是"想再处理一次"时该去的地方（`cleanup-cloud` 走列桶，是另一件事）。
		if (mode === "notice") {
			new Notice(
				ctx.t("orphanNotice", {
					count: selection.asks.length,
					command: ctx.t("cmdManageAttachments"),
				})
			);
			return;
		}

		// 存储没配好就**不问了**：这个弹窗的三个选项里有两个以"云端"为前提，
		// 而只有一个能成立时，问法本身是误导（"只删本地副本"那一档由 F18 的清理承担，
		// 跟这里的三选一不是一件事）。
		const client = ctx.buildClient();
		if (!client) return;

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

		/** 三档都要说清的两句（**可恢复性**与**多设备盲区**）。 */
		const lines = [ctx.t("orphanLocalNote"), ctx.t("cloudCleanupDeviceBlindSpot")];

		/**
		 * 把用户选的那一档落到**他勾中的那些**上。
		 *
		 * ⚠️ 入参是**裸 key**：这条链只有一个没有界面的三选一弹窗（清单那条路 2026-10-24 已删），
		 * 所以这里不再需要"从清单行的 id 反解 key"那一层，也没有进度可上报。
		 */
		const applyChoice = async (choice: "local" | "both", chosen: readonly string[]): Promise<void> => {
			const index = ctx.currentIndex();
			// 云端对象：删的是它在本地的那份副本（索引记的落点）
			const localTargets = planOrphanLocalRemoval(chosen, {
				cachePathOf: (key) => index.get(key)?.cachePath,
			});

			// 先删云端（不可恢复的那一半先做：失败时下面那句提示会如实说明"云端对象未动"）
			let cloud: CloudCleanupResult | null = null;
			const logRecords: DeletedObjectRecord[] = [];
			if (choice === "both" && chosen.length > 0 && client) {
				try {
					cloud = await runCloudCleanup(
						{
							client,
							index: () => ctx.currentIndex(),
							persistIndex: () => ctx.hostContext().persistIndex(),
							notify: (message) => new Notice(message),
							t: ctx.t,
							onRemoved: (record) => logRecords.push({ ...record, scope: "orphan" }),
						},
						chosen
					);
				} catch (error) {
					new Notice(ctx.t("cloudDeleteFailed", { error: describeError(error) }));
				}
			}
			// 留痕：这条询问可能是**自动出现**的，而删除不可恢复 ⇒ 至少要让"删过什么"事后可查
			await writeDeleteLog(ctx, logRecords);

			const removed = await removeLocalCopies(localTargets);

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
			new Notice(ctx.t("orphanDismissed", { command: ctx.t("cmdManageAttachments") }));
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
	 * 剩下的全在 {@link presentOrphans} 里。
	 */
	async function askAboutOrphans(): Promise<void> {
		const batch = [...pending];
		pending.clear();
		if (batch.length === 0) return;

		// ⭐ 用户可以直接说"别主动告诉我"。这一档在**筛选之前**就返回：
		// 连扫一遍都省了，而且**没有任何信息丢失** —— 附件管理的「待清理」筛选
		// 按同一批判据随时能再列一次（它算的也是"台账里有、本库看不见引用"）。
		if (ctx.settings.orphanAsk === "never") return;

		await presentOrphans(batch);
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
