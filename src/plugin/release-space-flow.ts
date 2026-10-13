/**
 * **入口 ④ / F18**：「清理本地占用」—— 把**已上传且仍带远端链接**的本地副本
 * **永久删除**，把磁盘空间立刻还回来（设计 §20.10）。
 *
 * ## 两个入口共用这一条流程
 *
 * 1. **用户主动**（设置页「不留副本」档下那个按钮）⇒ `whenEmpty: "notice"`
 *    —— 他是特地来清东西的，没有可清项必须说一声；
 * 2. **切档时的那次询问** ⇒ `whenEmpty: "silent"`
 *    —— 没东西可清就别打扰他（他刚做的事是"改设置"，不是"清理"）。
 *
 * ⚠️ **更不自动删**：那是不可逆的批量动作，两个入口都要走确认框。
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
import { formatMegabytes } from "../maintenance/eviction";
import { planReleaseSpace } from "../maintenance/release-space";
import type { ReleaseSpaceSelection } from "../maintenance/release-space";
import { readCopies, runReleaseSpace } from "../maintenance/run";
import { displayNameForKey } from "../object-key";
import type { PluginContext } from "./context";
import { cloudReferencedKeys } from "./shared-flows";

/** 确认框里最多列几项（对象可能很多，列少一点）。 */
const RELEASE_SPACE_LIST_MAX = 10;

/**
 * 算一遍"哪些本地副本可以清掉"（F18 的**唯一**计算入口）。
 *
 * 候选的四条判据在 `planReleaseSpace`（纯函数，套件穷举）；这里只负责把
 * "索引 + 磁盘 + 笔记正文"三样东西凑齐：
 *
 * 1. **索引条目** —— 候选的来源（索引外的文件一概不碰，那可能是用户自己的附件）；
 * 2. **磁盘上的样子** —— 一次 `stat` 一条索引路径（**不扫目录**，理由同 `readCopies`）；
 * 3. ⭐ **"仍被引用"的对象 key** —— 复用云端清理那份 `cloudReferencedKeys()`：
 *    同一套 URL→key 换算，于是"哪些对象算带远端链接"与渲染、与云端清理**永远一致**。
 *    ⚠️ 它在**读不到某篇笔记时会抛错 ⇒ 整体放弃**（调用方要如实告知、什么都不清）——
 *    那正是我们要的方向：不知道有没有人引用，就不该删文件。
 */
async function localSpaceSelection(ctx: PluginContext): Promise<ReleaseSpaceSelection> {
	const index = ctx.currentIndex();
	const entries = index.toArray();
	const copies = await readCopies(
		ctx.app,
		entries.map((entry) => entry.cachePath)
	);
	const referencedKeys = await cloudReferencedKeys(ctx);

	return planReleaseSpace({
		entries,
		uploaded: new Set(index.uploadedKeys()),
		present: (path) => copies.has(path),
		referencedKeys,
	});
}

/**
 * 「清理本地占用」（F18）：确认之后删掉候选副本，并如实汇报删了几个、腾了多少。
 *
 * @param whenEmpty 没有可清项时要不要出声（见文件头"两个入口"那段）。
 */
export async function releaseLocalSpace(
	ctx: PluginContext,
	whenEmpty: "notice" | "silent"
): Promise<void> {
	let selection: ReleaseSpaceSelection;
	try {
		selection = await localSpaceSelection(ctx);
	} catch (error) {
		// 扫引用失败（有笔记读不到）⇒ 什么都不清，并把原因说清楚。
		// ⚠️ 不能"跳过那篇笔记继续"：漏掉的那篇可能正是引用着这些图的笔记，
		// 于是候选会凭空变大 —— 这是这个功能唯一能"因为读不到而多删"的方向。
		//
		// ⚠️⚠️ 这条兜底与 `cloud-cleanup-flow.ts` 那份**成对存在**：两条流程共用
		// `cloudReferencedKeys`，而它抛错的唯一原因就是"有东西读不到"。缺了它
		// 异常会冒泡进没有 catch 的回调 ⇒ 变成一句 unhandled rejection（用户什么都看不到）。
		new Notice(describeError(error));
		return;
	}

	if (selection.candidates.length === 0) {
		if (whenEmpty === "silent") return;
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
		ctx.t("releaseSpaceSummary", {
			count: selection.candidates.length,
			mb: formatMegabytes(selection.bytes),
		}),
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
	new Notice(
		ctx.t("releaseSpaceDone", {
			deleted: result.evicted,
			mb: formatMegabytes(result.freed),
			skipped: result.skipped.length,
		})
	);
	// ⚠️ "一个都没删"必须解释清楚 —— 否则用户刚按下"永久删除"、看到"跳过 N 个"，
	// 完全不知道发生了什么（他会以为功能坏了）。
	// 真实原因只有一个：候选是**纯判定**（不联网），而删除前要逐个 HEAD 复核
	// "云端现在确实还有它"（那可能是最后一份）⇒ 确认不上的那些会被跳过。
	if (result.evicted === 0 && result.skipped.length > 0) {
		new Notice(ctx.t("releaseSpaceNothingDeleted", { skipped: result.skipped.length }));
	}
}
