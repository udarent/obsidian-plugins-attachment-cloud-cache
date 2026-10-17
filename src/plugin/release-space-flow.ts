/**
 * **入口 ④ / F18**：「清理本地副本」——把**已上传**的本地副本**永久删除**，
 * 把磁盘空间立刻还回来（设计 §20.10）。
 *
 * ## ⭐⭐ 清到什么程度由**档位**决定（2026-10-15，用户报告后改）
 *
 * | 档位 | 目标 | 说什么 |
 * |---|---|---|
 * | 不留副本 | 一份不留 | 现状口径（"这些本地副本将被永久删除"） |
 * | 保留副本 + 上限 N | **清到上限以内**（只清超出的部分） | "清到 N 以内 ⇒ 清完约剩 M"（如实报，包括清不到时） |
 *
 * 判据在 `ui/settings-logic.ts` 的 `localCopyCleanupTarget`（与设置页显隐**同一处**），
 * 量的计算在 `maintenance/release-space.ts` 的 `planReleaseSpace`。
 *
 * ## 三个入口共用这一条流程
 *
 * 1. **用户主动**（设置页「释放本地空间」那个按钮）⇒ `whenEmpty: "notice"`
 *    —— 他是特地来清东西的，没有可清项必须说一声；
 * 2. **切档时的那次询问** ⇒ `whenEmpty: "silent"`
 *    —— 没东西可清就别打扰他（他刚做的事是"改设置"，不是"清理"）；
 * 3. **保留副本档下的同一个按钮** —— 目标换成"上限"，其余一样。
 *
 * ⚠️ **更不自动删**：那是不可逆的批量动作，每个入口都要走确认框。
 *
 * ## ⚠️ 为什么是"直接删"而不是回收站
 *
 * 这一档的新上传那段走回收站（`planLocalCopy`），这里走 `Vault.delete` ——
 * 两段删法**故意不同**：判据是"**要不要立刻释放空间**"（设计 §20.16 #7）。
 * 用户按下这个按钮的**全部目的**就是腾空间，而回收站（系统回收站与 `.trash`
 * 都在同一块盘上）**不释放** —— 走回收站等于让他跑完发现"空间没变"。
 * 代价是**不可撤销**，所以确认框必须写明白（`releaseSpaceCannotUndo`），
 * 而且执行层会**逐个 HEAD 复核"云端现在确实还有它"**，确认不上就不删。
 */

import { Notice } from "obsidian";
import { describeError } from "../error-text";
import { formatMegabytes, megabytesToBytes } from "../maintenance/eviction";
import { planReleaseSpace } from "../maintenance/release-space";
import type { ReleaseSpaceSelection } from "../maintenance/release-space";
import { readCopies, runReleaseSpace } from "../maintenance/run";
import { displayNameForKey } from "../object-key";
import { localCopyCleanupTarget } from "../ui/settings-logic";
import type { PluginContext } from "./context";
import { referencedVaultPaths } from "./notes-query";
import { cloudReferencedKeys } from "./shared-flows";

/** 确认框里最多列几项（对象可能很多，列少一点）。 */
const RELEASE_SPACE_LIST_MAX = 10;

/**
 * 算一遍"哪些本地副本可以清掉"（F18 的**唯一**计算入口）。
 *
 * 判据与顺序在 `planReleaseSpace`（纯函数，套件穷举）；这里只负责把
 * "索引 + 磁盘 + 笔记正文 + 目标"四样东西凑齐：
 *
 * 1. **索引条目** —— 候选的来源（索引外的文件一概不碰，那可能是用户自己的附件）；
 * 2. **磁盘上的样子** —— 一次 `stat` 一条索引路径（**不扫目录**，理由同 `readCopies`）；
 * 3. ⭐ **"仍被引用"的对象 key** —— 复用云端清理那份 `cloudReferencedKeys()`：
 *    同一套 URL→key 换算，于是"哪些对象算带远端链接"与渲染、与云端清理**永远一致**。
 *    ⚠️ 它在**读不到某篇笔记时会抛错 ⇒ 整体放弃**（调用方要如实告知、什么都不清）——
 *    那正是我们要的方向：不知道有没有人引用，就不该删文件。
 * 4. ⭐ **目标** —— 见文件头那张表。
 */
async function localSpaceSelection(ctx: PluginContext, keepBytes: number): Promise<ReleaseSpaceSelection> {
	const index = ctx.currentIndex();
	const entries = index.toArray();
	const copies = await readCopies(
		ctx.app,
		entries.map((entry) => entry.cachePath)
	);
	const referencedKeys = await cloudReferencedKeys(ctx);
	// ⭐ "还有人用吗"的另一半：笔记**直接指着**哪些库内文件（判据见 `release-space.ts` 的
	// `referencedPaths`）。少了它，一份正被笔记显示的副本会被当成可删的。
	const referencedPaths = await referencedVaultPaths(ctx.app);

	return planReleaseSpace({
		entries,
		uploaded: new Set(index.uploadedKeys()),
		present: (path) => copies.has(path),
		referencedKeys,
		referencedPaths,
		keepBytes,
		// ⚠️ 上限那条路要用它判"刚用过的这轮不动"（宽限期）
		now: Date.now(),
	});
}

/**
 * 「清理本地副本」：确认之后删掉候选，并如实汇报删了几个、腾了多少、**清到了没有**。
 *
 * @param whenEmpty 没有可清项时要不要出声（见文件头"三个入口"那段）。
 */
export async function releaseLocalSpace(
	ctx: PluginContext,
	whenEmpty: "notice" | "silent"
): Promise<void> {
	const target = localCopyCleanupTarget(ctx.settings.localCopy, ctx.settings.cacheLimitMb);
	// 没有目标（保留副本档 + 没设上限）⇒ 设置页里那个按钮**本来就不显示**
	// （见 `shouldShowReleaseSpace`）；走到这里只可能是陈旧的设置页。
	// 什么都不做、也不出声：它不是一个用户能到达的状态，而"没有目标"最不该被
	// 解释成"那就全清"。
	if (target.kind === "none") return;

	// ⚠️ 换算**只**用 `megabytesToBytes`（与后台淘汰同一个口径）：这里手写一遍
	// `mb * 1024 * 1024` 就等于让"500"在两条路上变成两个数。
	const keepBytes = target.kind === "limit" ? megabytesToBytes(target.mb) : 0;
	let selection: ReleaseSpaceSelection;
	try {
		selection = await localSpaceSelection(ctx, keepBytes);
	} catch (error) {
		// 扫引用失败（有笔记读不到）⇒ 什么都不清，并把原因说清楚。
		// ⚠️ 不能"跳过那篇笔记继续"：漏掉的那篇可能正是引用着这些图的笔记，
		// 于是候选会凭空变大 —— 这是这个功能唯一能"因为读不到而多删"的方向。
		//
		// ⚠️⚠️ 这条兜底与 `orphan-flow.ts`（`checkNow`）那份**成对存在**：两条流程共用
		// `cloudReferencedKeys`，而它抛错的唯一原因就是"有东西读不到"。缺了它
		// 异常会冒泡进没有 catch 的回调 ⇒ 变成一句 unhandled rejection（用户什么都看不到）。
		//（2026-10-16：「清理云端未使用对象…」退役前，与这里成对的是它那一份。）
		new Notice(describeError(error));
		return;
	}

	if (selection.candidates.length === 0) {
		if (whenEmpty === "silent") return;
		// "没有可清理的"在两条路上的**含义不同**，措辞也必须不同：
		// 上限档下它意味着"已经在上限以内"（那是个好消息，不是故障）。
		if (target.kind === "limit") {
			new Notice(ctx.t("releaseSpaceNothingUnderLimit", { limit: ctx.t("cacheLimitValue", { mb: target.mb }) }));
			return;
		}
		new Notice(
			selection.missing > 0
				? ctx.t("releaseSpaceNothingMissing", { count: selection.missing })
				: ctx.t("releaseSpaceNothing")
		);
		return;
	}

	const index = ctx.currentIndex();
	const cards = ctx.fileCards(
		selection.candidates.map((candidate) => {
			const entry = index.get(candidate.key);
			return {
				id: candidate.key,
				name: entry?.sourceName || displayNameForKey(candidate.key),
				localPath: candidate.cachePath,
				remoteKey: candidate.key,
			};
		}),
		RELEASE_SPACE_LIST_MAX
	);

	const lines = [
		// ⭐ 上限档必须**先说目标**：用户设的 500 MB 在这一屏上要被认出来，
		// 否则"为什么只删这三个"永远解释不清。
		target.kind === "limit"
			? ctx.t("releaseSpaceSummaryToLimit", {
					count: selection.candidates.length,
					mb: formatMegabytes(selection.bytes),
					remainMb: formatMegabytes(selection.projectedBytes),
					limit: ctx.t("cacheLimitValue", { mb: target.mb }),
				})
			: ctx.t("releaseSpaceSummary", {
					count: selection.candidates.length,
					mb: formatMegabytes(selection.bytes),
				}),
		// ⚠️ 这一句**必须留着** —— 与「上传附件」那边**正好相反**：
		// 那里的列表是全量的，所以摘要里的"前十条 + 还有 N 个"被删掉了（重复）；
		// 这里 `cards` 传的是 `RELEASE_SPACE_LIST_MAX` ⇒ **列表被截断**，
		// 不说一句用户就不知道还有多少没显示。
		// ⭐ 判据是**列表全不全**（`ctx.fileCards` 的 limit 传了什么），不是"哪个界面更好看"。
		...(selection.candidates.length > RELEASE_SPACE_LIST_MAX
			? [
					ctx.t("maintainMoreItems", {
						count: selection.candidates.length - RELEASE_SPACE_LIST_MAX,
					}),
				]
			: []),
		// ⚠️ 这两句是按下按钮前**唯一**读到的安全信息，必须如实：
		// 一句说"不可撤销"，一句说"云端与笔记都不动"（否则用户会怕把图删死）。
		ctx.t("releaseSpaceCannotUndo"),
		ctx.t("releaseSpaceCloudUntouched"),
	];

	const confirmed = await ctx.confirmMaintenance({
		title: ctx.t("releaseSpaceTitle"),
		lines,
		cards,
		cta: ctx.t("releaseSpaceCta"),
		destructive: true,
	});
	if (!confirmed) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}

	const result = await runReleaseSpace(ctx.maintenanceDeps(), selection);
	if (target.kind === "limit") {
		// ⭐ 剩余量用**实际**释放量算（执行时可能有文件被跳过）—— 报计划值会骗用户。
		const remaining = Math.max(0, selection.totalBytes - result.freed);
		new Notice(
			ctx.t("releaseSpaceDoneToLimit", {
				deleted: result.evicted,
				mb: formatMegabytes(result.freed),
				remainMb: formatMegabytes(remaining),
				limit: ctx.t("cacheLimitValue", { mb: target.mb }),
				skipped: result.skipped.length,
			})
		);
		// ⚠️ 清不到目标**必须**再说一句：否则用户看到"已删除 3 个"却发现占用没变，
		// 只会以为功能坏了（这个功能唯一说不清的地方就是"为什么没清到"）。
		if (remaining > keepBytes) {
			new Notice(ctx.t("releaseSpaceStillOver", { overMb: formatMegabytes(remaining - keepBytes) }));
		}
		// ⚠️⚠️ 还有一类**压根不在这里**：没人引用的本地副本。它们要连云端对象一起决定
		// （R17 的三档询问），本流程按纪律不碰 ⇒ 有的话必须告诉他，
		// 否则"我设了 500、也清了，占用怎么还高于 500"会变成一个说不清的谜。
		if (selection.unlinkedBytes > 0) {
			new Notice(
				ctx.t("releaseSpaceUnlinkedLeft", {
					mb: formatMegabytes(selection.unlinkedBytes),
					command: ctx.t("cmdCheckOrphans"),
				})
			);
		}
	} else {
		// ⚠️ 「不留副本」档**不**说孤儿那件事：那一档的说明里已经写明"没被引用的不归它管"
		// （`releaseSpaceDesc`），再在每次清完时补一句就是噪音。
		new Notice(
			ctx.t("releaseSpaceDone", {
				deleted: result.evicted,
				mb: formatMegabytes(result.freed),
				skipped: result.skipped.length,
			})
		);
	}
	// ⚠️ "一个都没删"必须解释清楚 —— 否则用户刚按下"永久删除"、看到"跳过 N 个"，
	// 完全不知道发生了什么（他会以为功能坏了）。
	// 真实原因只有一个：候选是**纯判定**（不联网），而删除前要逐个 HEAD 复核
	// "云端现在确实还有它"（那可能是最后一份）⇒ 确认不上的那些会被跳过。
	if (result.evicted === 0 && result.skipped.length > 0) {
		new Notice(ctx.t("releaseSpaceNothingDeleted", { skipped: result.skipped.length }));
	}
}
