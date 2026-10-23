/**
 * 「把链接改回本地路径」这条流程（**不删任何文件**）。
 *
 * 与「腾出空间」正好相反：那条把笔记仍指向云端的那些本地副本**删掉**；
 * 这条把笔记改回**指向本地那份**，云端对象与本地副本都保持原样。
 *
 * ## 三道闸门，缺一条就会造坏链
 *
 * 1. 只收**本地副本确实还在**的（`revertTargets` 的 `present`）——
 *    索引里记着但文件已被删/被回收站清掉的，改回去就是一条打不开的链接；
 * 2. 改写走 `planLinkRewrites`（唯一一份链接改写实现），不在这里另写正则；
 * 3. **先确认再动手**，并且明确告诉用户"云端对象不会被删"——
 *    否则他会以为这是一次"取消上传"的清理动作。
 *
 * ⚠️ 画布不在范围内：画布的 `file` 节点本来就指向库内路径（上传时也没有被改成 URL）。
 * 这一点在确认框里如实说，而不是悄悄跳过。
 */

import { Notice, type TFile } from "obsidian";

import { planRevertText, revertTargets } from "../maintenance/revert";
import type { PluginContext } from "./context";
import { readAllNoteTexts } from "./notes-query";

/**
 * 只把**指定几个 key** 的链接改回本地路径（附件管理的「改为本地引用」用这条）。
 *
 * 与 `revertLinksToLocal` 共用 `revertTargets` / `planRevertText` 两份判据：
 * 一条改全部、一条改勾中的几行 —— **判据只有一份**，差别只在"输入哪些条目"。
 *
 * ⚠️ 本地副本**不在**的条目会被 `revertTargets` 跳过（`missing` 计数）——
 * 改回本地路径会造坏链，所以"缺副本"必须先去下载（调用方负责）。
 */
export async function revertLinksForKeys(
	ctx: PluginContext,
	keys: readonly string[]
): Promise<{ notes: number; links: number; missing: number }> {
	const wanted = new Set(keys);
	const entries = ctx.currentIndex()
		.toArray()
		.filter((entry) => wanted.has(entry.key));
	const present = new Set(ctx.app.vault.getFiles().map((file) => file.path));
	const { targets, missing } = revertTargets({
		entries,
		present: (path) => present.has(path),
	});
	if (targets.length === 0) return { notes: 0, links: 0, missing };

	const notes = await readAllNoteTexts(ctx.app);
	let written = 0;
	let links = 0;
	for (const note of notes) {
		const plan = planRevertText(note.text, targets);
		if (plan.count === 0) continue;
		const file = ctx.app.vault.getAbstractFileByPath(note.path) as TFile | null;
		if (!file) continue;
		try {
			// ⚠️ 在 `process` 里重算（用户可能在两次读之间改过这篇笔记）
			await ctx.app.vault.process(file, (data) => planRevertText(data, targets).text);
			written += 1;
			links += plan.count;
		} catch (error) {
			console.error(`[attachment-cloud-cache] 改为本地引用失败：${note.path}`, error);
		}
	}
	return { notes: written, links, missing };
}

export async function revertLinksToLocal(ctx: PluginContext): Promise<void> {
	const entries = ctx.currentIndex().toArray();
	// ⚠️ 判据是**宿主的文件清单**，不是索引：索引只记"我们上传过什么"，
	// 不保证那份文件现在还在（用户可能把它删了）。
	const present = new Set(ctx.app.vault.getFiles().map((file) => file.path));
	const { targets, missing } = revertTargets({
		entries,
		present: (path) => present.has(path),
	});

	if (targets.length === 0) {
		new Notice(missing > 0 ? ctx.t("revertAllMissing", { count: missing }) : ctx.t("revertNothing"));
		return;
	}

	const notes = await readAllNoteTexts(ctx.app);
	const changed: string[] = [];
	let links = 0;
	for (const note of notes) {
		const plan = planRevertText(note.text, targets);
		if (plan.count === 0) continue;
		changed.push(note.path);
		links += plan.count;
	}

	if (changed.length === 0) {
		new Notice(ctx.t("revertNothing"));
		return;
	}

	const lines = [
		ctx.t("revertSummary", { notes: changed.length, links }),
		// ⚠️ 这一句是**这次动作的边界**，必须写：不删云端、不删本地。
		ctx.t("revertKeepsEverything"),
	];
	if (missing > 0) lines.push(ctx.t("revertMissing", { count: missing }));
	lines.push(ctx.t("revertCanvasSkipped"));

	const confirmed = await ctx.confirmMaintenance({
		title: ctx.t("revertTitle"),
		lines,
		cta: ctx.t("revertCta"),
		// 它不改文件、不删对象，只是把链接换回本地路径 ⇒ **不是**破坏性动作
		destructive: false,
	});
	if (!confirmed) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}

	let done = 0;
	for (const path of changed) {
		// ⚠️ 不写成 `instanceof TFile`：我们只需要"这是个能读写的库内文件"，
		// 而类身份是**宿主的实现细节**（测试替身的 TFile 与真宿主不是同一个类，
		// 一旦按类判，测试里这条链会静默整段跳过 —— 那种"全绿但其实没跑"最贵）。
		const file = ctx.app.vault.getAbstractFileByPath(path) as TFile | null;
		if (!file) continue;
		try {
			// ⚠️ 在 `process` 里**重新算一遍**，而不是写回上面那份文本：
			// 两次读之间用户可能改过这篇笔记，写回旧文本会吞掉他的改动。
			await ctx.app.vault.process(file, (data) => planRevertText(data, targets).text);
			done += 1;
		} catch (error) {
			console.error(`[attachment-cloud-cache] 回退链接失败：${path}`, error);
		}
	}
	new Notice(ctx.t("revertDone", { notes: done, links }));
}
