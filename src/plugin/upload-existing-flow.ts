/**
 * 「上传已有附件」（P1 #8）—— 把**还没进你自己存储**的附件搬上去，并把笔记里的链接换成远端链接。
 *
 * ## 两类候选、一个确认框
 *
 * 1. **库内文件**：被笔记引用着的那些（没被引用的不碰 —— 那多半是废弃旧图）；
 * 2. **笔记里的外链文件**：指向别处的同样没进你的存储，只是它们在别人的服务器上。
 *
 * ⚠️ 两类都由**纯判定层**挑（`maintenance/batch.ts` 的 `selectUploadCandidates` /
 * `selectExternalUploadCandidates`），这里只负责凑齐输入、写清清单、把结果如实报出来。
 *
 * ## ⚠️ 这条命令会**改用户的笔记**
 *
 * 它把本地链接换成远端链接 —— 所以上传前必须先出确认框，而且要把
 * "什么都不搬、文件留在原处""哪些不会被处理""站外是哪几个站点"都写出来。
 */

import { Notice } from "obsidian";
import {
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "../maintenance/batch";
import { runBatchUpload } from "../maintenance/run";
import { connectionReadiness } from "../s3/credentials";
import { readAllNoteTexts, referencedVaultPaths } from "./notes-query";
import type { PluginContext } from "./context";

/** 确认框里最多列几条路径（超出的只报个数）。 */
const BATCH_LIST_MAX = 10;

/**
 * 上传附件目录里已有的图片（P1 #8）。
 *
 * 上传前先确认：这条命令会**改用户的笔记**（把本地链接换成远端链接）。
 */
export async function uploadExistingAttachments(ctx: PluginContext): Promise<void> {
	const deps = ctx.maintenanceDeps();
	if (!ctx.buildClient()) {
		new Notice(ctx.t("maintainNotConfigured"));
		return;
	}

	const files = ctx.app.vault.getFiles().filter((file) => typeof file?.path === "string");
	// ⭐ 引用集合**算一次、用两次**（确认框的清单 + 真正执行的那趟）——
	// 两份不一致的话，用户会按清单授权、却按另一份执行。
	const referencedPaths = await referencedVaultPaths(ctx.app);
	const selection = selectUploadCandidates(files, {
		settings: ctx.settings,
		index: ctx.currentIndex(),
		referencedPaths,
	});

	// ⭐ 笔记里的**外链文件**也算候选：这条命令补的是"把还没进你自己存储的搬进去"，
	// 而指向别处的同样没进存储 —— 只是它们在别人的服务器上。
	// 判定用的是**同一个纯函数**（`decideExternalCache`），所以"自己的存储 /
	// 回环地址 / 存储未就绪"全都自动一致，不另立一套标准。
	// ⚠️ 它走 `purpose: "manual"`：**点这个确认框本身就是显式动作**，
	// 于是功能开关与站点名单都不约束它（关掉开关也照样能跑这条命令）。
	const external = selectExternalUploadCandidates(await readAllNoteTexts(ctx.app), {
		settings: ctx.settings,
		configured: connectionReadiness(ctx.app.secretStorage, ctx.settings).ready,
	});

	if (selection.paths.length === 0 && external.candidates.length === 0) {
		new Notice(ctx.t("maintainBatchNothing"));
		return;
	}

	const lines = [
		ctx.t("maintainBatchSummary", { count: selection.paths.length }),
		...selection.paths.slice(0, BATCH_LIST_MAX),
		...(selection.paths.length > BATCH_LIST_MAX
			? [
					ctx.t("maintainMoreItems", {
						count: selection.paths.length - BATCH_LIST_MAX,
					}),
				]
			: []),
		// ⚠️ 1.2.0（D-17）后这条必须照实说"什么都不搬"：文件留在原处就地当本地副本，
		// 变的只有笔记里的链接。不写清楚，用户跑完发现文件还在会以为没生效
		//（旧文案承诺的正是"会被搬进缓存目录"）。
		ctx.t("maintainBatchOriginalsStay"),
	];

	// ⚠️ 也要说清"哪些**不会**被处理" —— 用户跑这条命令的预期往往是"把没搬的全搬"，
	// 而它只动被笔记引用着的那些（没引用的搬走只会让人以为丢东西）。
	// 不说的话他会以为漏了，然后反复重跑。
	if (selection.unreferenced > 0) {
		lines.push(ctx.t("maintainBatchSkipsUnreferenced", { count: selection.unreferenced }));
	}

	if (external.candidates.length > 0) {
		// ⚠️ 必须把**站点**列出来：这个确认框就是那份授权（点它就是显式同意）。
		// 只说"还有 3 张站外图"等于让用户盲签一份许可。
		lines.push(
			ctx.t("maintainBatchExternal", {
				count: external.candidates.length,
				sites: external.sites.length,
				hosts: external.sites.map((site) => site.host).join(", "),
			})
		);
	}

	const confirmed = await ctx.confirmMaintenance({
		title: ctx.t("maintainBatchTitle"),
		lines,
		cta: ctx.t("maintainBatchCta"),
	});
	if (!confirmed) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}

	const result = await runBatchUpload(deps, { external, referencedPaths });
	new Notice(
		ctx.t("maintainBatchDone", {
			uploaded: result.uploaded,
			reused: result.reused,
			failed: result.failed,
			notes: result.notesChanged,
			links: result.linksRewritten,
		})
	);
	// ⚠️ 画布里"没敢动"的值要**单独说出来**：它不属于失败，但用户必须知道
	// 某一处引用可能还指着旧位置（否则他会以为全改好了）。
	if (result.canvasSkipped > 0) {
		new Notice(ctx.t("maintainBatchCanvasSkipped", { count: result.canvasSkipped }));
	}
}
