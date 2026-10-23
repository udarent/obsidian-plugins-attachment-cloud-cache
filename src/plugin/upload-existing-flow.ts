/**
 * 「上传全部附件」—— 「把链接改回本地路径」的**反向**（2026-10-23，用户要求）。
 *
 * ## 一句话
 *
 * 把**库内附件**传到你的存储，并把笔记里指向它们的**本地链接改成远端地址**。
 *
 * ## 与 `plugin/revert-flow.ts` 正好互为逆操作
 *
 * | | 范围 | 动手的地方 | 交互 |
 * |---|---|---|---|
 * | `revertLinksToLocal` | 索引里、**本地副本还在**的条目 | 笔记：远端链接 → 本地路径 | 一次确认 |
 * | 本流程 | 库内、**被引用或只差改链接**的附件 | 笔记：本地路径 → 远端地址 | 一次确认 |
 *
 * ⚠️ 两边都**不删任何东西**：上传完文件仍在原处、名字不变；回退时云端那份也不会消失。
 *
 * ## ⚠️⚠️ 为什么**没有清单**（这一条是用户 2026-10-23 明确要的）
 *
 * 原话：「设置界面的"上传附件"改成与"恢复本地链接"相反的对应功能，**取消弹窗选择的
 * 复杂交互**」。于是这一层**不列清单、不勾选**：范围由**判据**定
 * （`selectUploadCandidates`），不由用户逐条勾。对称地看，`revertLinksToLocal` 也没有清单 ——
 * 两个互为逆操作的按钮，交互形状必须一样，否则用户要学两遍。
 *
 * 连带两条**收窄**（如实记在这里，别以为漏了）：
 *
 * 1. **站外图 / 本机文件不再是候选**：反向操作的两端都是"库内那份"，而站外/本机
 *    需要"看得见会访问哪台主机"的授权 —— 那必须有一份可读的清单才谈得上同意。
 *    自动处理站外文件的那条路（「站外文件」开关）不受影响，它有自己的入口与判据。
 * 2. **没有任何笔记引用的附件也不传**：传上去没有任何笔记会指向它，只是往云端塞字节。
 *    （旧清单里"未引用也列出来"那个口子（D-68）只在有清单时才有意义。）
 *
 * 这两条都写进了设置页那一项的说明里 —— 用户点之前就该知道范围。
 */

import { Notice } from "obsidian";

import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import { selectUploadCandidates } from "../maintenance/batch";
import { runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { readAllNoteTexts, referenceSnapshot } from "./notes-query";
import type { PluginContext } from "./context";

/**
 * 把库内附件全部传到云端，并把笔记里的链接改成远端地址。
 *
 * ⚠️ 只做**一件**事：它不改文件名、不移动文件、不删任何东西。
 * 这些边界必须在确认框里说清 —— 用户跑完发现文件还在，不该以为没生效。
 */
export async function uploadExistingAttachments(ctx: PluginContext): Promise<void> {
	const deps = ctx.maintenanceDeps();
	if (!ctx.buildClient()) {
		new Notice(ctx.t("maintainNotConfigured"));
		return;
	}

	// ⭐ 排障（D-67）：只读计数，不改行为；关着时这几行连 `Date.now()` 都不取。
	const debug = ctx.settings.debugLogging;
	const startedAt = Date.now();

	const files = ctx.app.vault.getFiles().filter((file) => typeof file?.path === "string");
	// ⭐ 笔记正文**读一次、两处用**（引用集合与改写目标）：读两遍除了浪费，还给了
	// 两条链看到不同正文的余地 —— 而"算哪些要改"和"改哪些"必须看同一份。
	const notes = await readAllNoteTexts(ctx.app);
	// ⭐⭐ 快照给两份答案：`referenced`（谁被指着）与 `rewritable`（谁的链接还能被我们改写）。
	// 后者让「**已经传过、而正文里那条还是本地路径**」的文件重新成为候选（只改链接、不重传字节）——
	// 少了它，那种只做了一半的记录永远修不好。
	const snapshot = await referenceSnapshot(ctx.app, { notes, debug });

	const selection = selectUploadCandidates(files, {
		settings: ctx.settings,
		index: ctx.currentIndex(),
		referencedPaths: snapshot.referenced,
		repairablePaths: snapshot.rewritable,
		// ⚠️ **不**收未引用的文件：反向操作的含义是"让笔记指向云端"，没有笔记可指的
		// 传上去只是往云端塞字节（旧清单里那个口子只属于清单形态）。
		includeUnreferenced: false,
	});

	debugTimed(debug, "上传候选", startedAt, {
		库内文件: files.length,
		候选: selection.paths.length,
		只差改链接: selection.repairPaths.length,
		跳过: Object.fromEntries(selection.skipped.map((row) => [row.reason, row.count])),
	});

	if (selection.paths.length === 0) {
		new Notice(ctx.t("maintainBatchNothing"));
		return;
	}

	/**
	 * 确认框：**一次，只有"是/否"**。
	 *
	 * ⚠️ 三个事实缺一不可：
	 * 1. **几件**（用户按这个决定要不要跑）；
	 * 2. **其中几件只是改链接**（不重传字节 —— 否则他会以为又要传一遍几百兆）；
	 * 3. **文件留在原处、云端不删**（这次动作的边界，与 `revertKeepsEverything` 对称）。
	 */
	const lines = [ctx.t("uploadAllSummary", { count: selection.paths.length })];
	if (selection.repairPaths.length > 0) {
		lines.push(ctx.t("uploadAllRepairOnly", { count: selection.repairPaths.length }));
	}
	lines.push(ctx.t("uploadAllKeeps"));
	const confirmed = await ctx.confirmMaintenance({
		title: ctx.t("uploadAllTitle"),
		lines,
		cta: ctx.t("uploadAllCta", { count: selection.paths.length }),
		// 它不改文件名、不删东西，只是把链接换成远端地址 ⇒ 不是破坏性动作
		destructive: false,
	});
	if (!confirmed) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}

	const state: { summary: BatchResult | null } = { summary: null };
	let failure = "";
	try {
		state.summary = await runBatchUpload(deps, {
			// ⚠️ 传**全库**快照：执行层用它判断"传完要不要改链接"，而"有没有人引用"
			// 是全库的事实（别的笔记里也可能指着它）。
			referencedPaths: snapshot.referenced,
			repairablePaths: snapshot.rewritable,
			// ⚠️ **不传 `includeUnreferenced`**：它默认就是 `false`，而"收不收未引用"
			// 只在**选候选**那一处判一次。写两遍的后果是"改一个不生效"（实测：变异只打开
			// 执行层那个开关时，行为一点没变 —— 候选里本来就没有未引用的文件）。
			// ⭐ 范围就是**上面算出来的那一批**：没有清单，也就没有"用户的取舍"这一层。
			onlyPaths: new Set(selection.paths),
			// 没有清单也就没有行，没有逐项进度可言 ⇒ 不给 `onItem`
		});
	} catch (error) {
		// 执行层内部逐件兜了错，走到这里说明是意料之外的（如实说出，不静默）
		failure = describeError(error);
	}
	if (failure) {
		new Notice(failure);
		return;
	}
	if (!state.summary) return;

	const outcome: BatchResult = state.summary;
	/**
	 * ⭐⭐ 一次上传只发**一条**通知（D-80，评审 3-2）：三条会叠成一摞，
	 * 而只有第一条是结论，其余是同一次操作的补充事实。
	 */
	const parts = [
		ctx.t("maintainBatchDone", {
			uploaded: outcome.uploaded,
			reused: outcome.reused,
			failed: outcome.failed,
			notes: outcome.notesChanged,
			links: outcome.linksRewritten,
		}),
	];
	// ⚠️ 画布里"没敢动"的值要**说出来**：它不属于失败，但用户必须知道某一处引用
	// 可能还指着旧位置（否则他会以为全改好了）。
	if (outcome.canvasSkipped > 0) {
		parts.push(ctx.t("maintainBatchCanvasSkipped", { count: outcome.canvasSkipped }));
	}
	// ⭐ 删掉重复副本也要说一句：一个附件只该留一份，多余的清掉不是"少了一个"。
	if (outcome.redundantRemoved > 0) {
		parts.push(ctx.t("maintainBatchDuplicatesRemoved", { count: outcome.redundantRemoved }));
	}
	// ⚠️ 分隔符用空格而不是中文标点：文案本身已经以句号结尾，且这一层不许写死标点
	//（`check:notice-i18n` 的判据）。
	new Notice(parts.join(" "));
}
