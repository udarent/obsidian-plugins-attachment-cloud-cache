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
import { fileNameFromUrl } from "../core/external-cache";
import { describeError } from "../error-text";
import {
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "../maintenance/batch";
import { runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { connectionReadiness } from "../s3/credentials";
import { pickKey } from "../ui/external-picker-logic";
import { buildTaskLabels } from "../ui/task-list";
import { baseNameForDuplicate, parentFolderOf } from "../vault-files";
import { readAllNoteTexts, referencedVaultPaths } from "./notes-query";
import type { PluginContext } from "./context";

/** 确认框里最多列几条路径（超出的只报个数）。 */
const BATCH_LIST_MAX = 10;

/**
 * 确认框里最多列几条**本机路径**（`file:///D:/…`）。
 *
 * ⚠️ 比 `BATCH_LIST_MAX` 小得多：本机路径动辄七八十字（`D:/企业微信文件/WXWork/…`），
 * 列十条会把确认框撑成一面墙 —— 而条数仍然是**如实**给的（`{count}` 是全部）。
 */
const LOCAL_FILE_LIST_MAX = 3;

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
	// ⭐ 笔记正文**读一次、两处用**（引用集合 + 站外候选）：读两遍除了浪费，
	// 还给了两条链看到不同正文的余地（而它们必须看同一份 —— 清单即授权）。
	const notes = await readAllNoteTexts(ctx.app);
	const referencedPaths = await referencedVaultPaths(ctx.app, { notes });
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
	const external = selectExternalUploadCandidates(notes, {
		settings: ctx.settings,
		configured: connectionReadiness(ctx.app.secretStorage, ctx.settings).ready,
		// ⭐ 平台判据由装配点给（这一层不碰宿主）：本机文件（`file:///D:/…`）只有桌面读得到。
		isDesktop: ctx.isDesktop(),
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

	// ⚠️ 也要说清"清单里那些重复副本会被删掉"（用户 2026-10-14 要求：
	// **链接改写成功**之后即可删掉，且不进回收站）。
	//
	// 判据刻意只到"**看起来**像"：名字是宿主撞名的形状（`baseNameForDuplicate`，
	// 与写入侧 `uniqueVaultPath` 同一份约定）+ 同名主干文件确实在。
	// 真正的判定在**执行层**（还要"内容逐字节相同"才算），所以这里多说一句不会谎报；
	// 反过来，删了却不提才是没交代 —— 用户会以为文件丢了。
	// ⚠️ 只在**看起来有**的时候加这一行：每次运行都写一遍会变成没人看的噪音。
	const lookLikeDuplicates = selection.paths.filter((path) => {
		const original = baseNameForDuplicate(path.slice(path.lastIndexOf("/") + 1));
		if (!original) return false;
		const folder = parentFolderOf(path);
		return ctx.app.vault.getAbstractFileByPath(folder ? `${folder}/${original}` : original) !== null;
	}).length;
	if (lookLikeDuplicates > 0) {
		lines.push(ctx.t("maintainBatchDuplicates", { count: lookLikeDuplicates }));
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
		// ⭐ **本机文件**另说一句，而且**必须带上路径**（截断也要带）：
		// 用户 2026-10-15 定的边界是"不加目录白名单"，于是"看得见要读哪条路径"就是那次授权
		// 唯一能成立的前提 —— 只报个数字等于让人盲签（与上面"必须列出站点"同一条纪律）。
		// ⚠️ 条数**如实**（{count} 是全部），列表最多三条（多的用省略号）—— 数字准确、清单诚实。
		if (external.localFiles > 0) {
			const paths = external.candidates
				.filter((candidate) => candidate.local)
				.map((candidate) => candidate.url);
			const shown = paths.slice(0, LOCAL_FILE_LIST_MAX).join("、");
			lines.push(
				ctx.t("maintainBatchLocalFiles", {
					count: external.localFiles,
					paths: paths.length > LOCAL_FILE_LIST_MAX ? `${shown} …` : shown,
				})
			);
		}
	}

	/**
	 * 执行结果（在 `run` 回调里填）。
	 *
	 * ⚠️ 用**一个可变盒子**装它，而不是 `let summary = null` 那种写法：
	 * TS 的控制流分析只看得到回调外的初始值，于是 `if (!summary) return;` 之后
	 * 会把它收窄成 `never`（读它的字段就编译不过）。属性的类型不会因为
	 * 回调里的赋值而"看不见"，所以这么写既清楚又过得了类型检查。
	 */
	const state: { summary: BatchResult | null } = { summary: null };
	/** 执行层**意料之外**抛出的错（如实说出来，不静默）。 */
	let failure = "";

	// ⭐ **清单里的两处键必须与执行层上报的键是同一份**（否则进度会挂到别的行上）：
	// 库内文件 ⇒ 它的 vault 路径；站外 / 本机候选 ⇒ `pickKey`（笔记 + 地址）。
	// ⚠️ 本机文件那一类必须把**绝对路径**原样放进副标题：用户 2026-10-15 定的边界是
	// "只走显式入口 + 不加目录白名单"，于是"看得见要读哪条路径"就是那次同意的前提。
	const rows = ctx.fileCards(
		[
			...selection.paths.map((path) => ({
				id: path,
				name: path.split("/").pop() ?? path,
				// 库内文件 ⇒ 缩略图用它自己那份（零网络）
				localPath: path,
				meta: path,
			})),
			...external.candidates.map((candidate) => ({
				id: pickKey(candidate),
				name: fileNameFromUrl(candidate.url) || candidate.url,
				// 站外地址 / 本机 `file://…`：图就在那个地址上
				thumb: candidate.url,
				meta: candidate.local ? candidate.url : `${candidate.host} — ${candidate.notePath}`,
			})),
		],
		selection.paths.length + external.candidates.length
	);

	const result = await ctx.pickTasks({
		title: ctx.t("maintainBatchTitle"),
		lines,
		cards: rows,
		labels: buildTaskLabels(ctx.t, "maintainBatchCta"),
		// ⭐ 勾选**在这里生效**：候选（安全判据）与取舍（勾选）是两件事。
		// 站外那一批按 `pickKey` 过滤，库内那批交给执行层的 `onlyPaths`。
		run: async (selected, report) => {
			const chosen = new Set(selected);
			try {
				state.summary = await runBatchUpload(deps, {
					external: {
						...external,
						candidates: external.candidates.filter((candidate) => chosen.has(pickKey(candidate))),
					},
					referencedPaths,
					onlyPaths: new Set(selection.paths.filter((path) => chosen.has(path))),
					onItem: (event) => {
						report(event.kind === "external" ? pickKey(event.candidate) : event.path, event.status);
					},
				});
			} catch (error) {
				// 执行层内部逐件兜了错，走到这里说明是意料之外的（如实说出，不静默）
				failure = describeError(error);
			}
		},
	});
	// `null` = 取消或直接关掉（两种情况都不做事，与"确认了但一件没勾"区分开）
	if (!result) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}
	if (failure) {
		new Notice(failure);
		return;
	}
	if (!state.summary) return;
	const outcome: BatchResult = state.summary;
	new Notice(
		ctx.t("maintainBatchDone", {
			uploaded: outcome.uploaded,
			reused: outcome.reused,
			failed: outcome.failed,
			notes: outcome.notesChanged,
			links: outcome.linksRewritten,
		})
	);
	// ⚠️ 画布里"没敢动"的值要**单独说出来**：它不属于失败，但用户必须知道
	// 某一处引用可能还指着旧位置（否则他会以为全改好了）。
	if (outcome.canvasSkipped > 0) {
		new Notice(ctx.t("maintainBatchCanvasSkipped", { count: outcome.canvasSkipped }));
	}
	// ⭐ 删掉重复副本也要**单独说一句**：那是清单里的文件之一，不交代就等于"少了一个"。
	if (outcome.redundantRemoved > 0) {
		new Notice(ctx.t("maintainBatchDuplicatesRemoved", { count: outcome.redundantRemoved }));
	}
}
