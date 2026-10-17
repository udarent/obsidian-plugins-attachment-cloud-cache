/**
 * 「上传附件」（P1 #8）—— 把**还没进你自己存储**的附件搬上去，并把笔记里的链接换成远端链接。
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
import { localFileExists } from "../local-file";
import {
	dropMissingLocalCandidates,
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "../maintenance/batch";
import { runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { connectionReadiness } from "../s3/credentials";
import { pickKey } from "../ui/external-picker-logic";
import { externalRowMeta } from "../ui/file-cards";
import { buildTaskLabels } from "../ui/task-list";
import { baseNameForDuplicate, parentFolderOf } from "../vault-files";
import { readAllNoteTexts, referencedVaultPaths } from "./notes-query";
import type { PluginContext } from "./context";

/**
 * 确认框里最多列几条**本机路径**（`file:///D:/…`）。
 *
 * ⚠️ 本机路径动辄七八十字（`D:/企业微信文件/WXWork/…`），列十条会把确认框撑成一面墙 ——
 * 而条数仍然是**如实**给的（`{count}` 是全部）。
 */
const LOCAL_FILE_LIST_MAX = 3;

/**
 * 把本机路径列成一行（最多 `LOCAL_FILE_LIST_MAX` 条，多的用省略号）。
 *
 * ⚠️ **分隔符只用 `", "`**（与上面那句列站点的 `hosts` 一致）：它是**用户可见**的文本，
 * 而一行里写死一个中文顿号会让英文用户看到中文字符 —— `check:notice-i18n` 门禁当场会拦
 *（2026-10-16 我在 `new Notice(...)` 的参数里就是这么被抓住的）。中性分隔两边都读得通，
 * 也就不必为它单开一条文案键。
 */
function localPathList(paths: readonly string[]): string {
	const shown = paths.slice(0, LOCAL_FILE_LIST_MAX).join(", ");
	return paths.length > LOCAL_FILE_LIST_MAX ? `${shown} …` : shown;
}

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

	// ⭐⭐ **本机文件先问一句"还在不在"**（只 `stat`、不读内容）：本机文件那条判定是**纯**的，
	// 于是"文件早被删掉"的地址照样会进清单，而它**必然失败** —— 临时目录里的东西
	// （WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存）天天在消失。
	// 用户 2026-10-16 实测报的正是这个：一行连缩略图都没有的 `file:///…/wpsDD.tmp.jpg`，
	// 他的原话：「没有缩略图的文件实际上已经不存在了，**不应该上传，即便上传也会失败**」。
	// ⚠️ 站外候选不受影响（它们的"在不在"要联网才知道，那是执行层的活）。
	const { kept: externals, missing: missingLocal } = await dropMissingLocalCandidates(
		external.candidates,
		// ⚠️ 接缝优先（装配点可以替换），默认真去 `stat`；手机端走不到这里（平台判据在前面拦过了）
		deps.localFileExists ?? localFileExists
	);
	/** 站外那批的条数 —— **不含**本机文件（两句话各说各的，见下面）。 */
	const remoteCount = externals.filter((candidate) => !candidate.local).length;
	/** 本机文件（`file:///…`）的条数 —— 只剩**确实还在**的那些。 */
	const localCount = externals.length - remoteCount;

	if (selection.paths.length === 0 && externals.length === 0) {
		// 没有可处理的：但**如果刚摘掉的是"已经不在了"的本机文件**，得如实说一句 ——
		// 否则用户会以为"什么都没发生"（而那几条链接在笔记里正是坏链）。
		new Notice(
			missingLocal.length > 0
				? ctx.t("maintainBatchLocalFilesMissing", {
						count: missingLocal.length,
						paths: localPathList(missingLocal.map((candidate) => candidate.url)),
					})
				: ctx.t("maintainBatchNothing")
		);
		return;
	}

	const lines = [
		// ⭐⭐ 这里**不列文件名**、也**不说"还有 N 个"**（2026-10-16 用户实测提的：
		// 「在上部有文件列表的摘要，但其实已经做了下面的列表了，可以精简内容」）。
		// 他看到的是一屏里同一份清单写了两遍：摘要里贴前十条路径 + 「……还有 424 个」，
		// 而下面那张表**把每一个文件都摆出来了**（还带缩略图、还能勾选）。
		//
		// ⚠️ 判据是**那张表是不是全量**（见下面 `ctx.fileCards(rows, …)`：limit 传的就是
		// 全部行数）。同一个壳的另一处**必须留着**「还有 N 个」——`release-space-flow` 传的是
		// `RELEASE_SPACE_LIST_MAX`、`orphan-flow` 自动那一路传 `LIST_MAX`，那里列表**被截断**，
		// 「还有 N 个」是唯一能说明"还有多少没显示"的信息。两处的事实不同，处理也就不同：
		// **列表全量 ⇒ 摘要不重复；列表截断 ⇒ 摘要必须补上**。
		// ⚠️ 这个数字**必须等于下面那张清单的行数**（`paths` + `externals`）：
		// 只数 `paths` 时，真机上出现过"摘要说 0 个、清单列 8 行"的一屏（2026-10-17 真机复验）。
		ctx.t("maintainBatchSummary", { count: selection.paths.length + externals.length }),
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

	if (remoteCount > 0) {
		// ⚠️ 必须把**站点**列出来：这个确认框就是那份授权（点它就是显式同意）。
		// 只说"还有 3 张站外图"等于让用户盲签一份许可。
		// ⚠️ 这一句只说**站外**（`remoteCount`）—— 本机文件由下面那句另说。
		// 混在一起会出现"另有 1 个文件托管在站外，来自 0 个站点"这种自相矛盾的话
		//（2026-10-16 用户实测看到的就是它）。
		lines.push(
			ctx.t("maintainBatchExternal", {
				count: remoteCount,
				sites: external.sites.length,
				hosts: external.sites.map((site) => site.host).join(", "),
			})
		);
	}
	// ⭐ **本机文件**另说一句，而且**必须带上路径**（截断也要带）：
	// 用户 2026-10-15 定的边界是"不加目录白名单"，于是"看得见要读哪条路径"就是那次授权
	// 唯一能成立的前提 —— 只报个数字等于让人盲签（与上面"必须列出站点"同一条纪律）。
	// ⚠️ 条数**如实**（{count} 是全部），列表最多三条（多的用省略号）—— 数字准确、清单诚实。
	if (localCount > 0) {
		const paths = externals.filter((candidate) => candidate.local).map((candidate) => candidate.url);
		lines.push(
			ctx.t("maintainBatchLocalFiles", {
				count: localCount,
				paths: localPathList(paths),
			})
		);
	}
	// ⚠️ 刚摘掉的那几条也得说：它们在笔记里是**坏链**，用户找不到它们会以为"漏了"。
	// 同样带上路径（那是他唯一能核对的线索）。
	if (missingLocal.length > 0) {
		lines.push(
			ctx.t("maintainBatchLocalFilesMissing", {
				count: missingLocal.length,
				paths: localPathList(missingLocal.map((candidate) => candidate.url)),
			})
		);
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
			...externals.map((candidate) => ({
				id: pickKey(candidate),
				name: fileNameFromUrl(candidate.url) || candidate.url,
				// ⭐⭐ **给一串候选**：站外 `http(s)` 就是它自己的地址；本机 `file:///…` 那一条
				// 则是「宿主自己的本地文件前缀 + 绝对路径」优先、原文兜底。
				//
				// ⚠️⚠️ 这条链上"猜"错了**两次**，两次都是"替宿主提前断言"，记下来免得再犯：
				// ① 写成 `candidate.local ? undefined : candidate.url`，理由写着"宿主的协议白名单
				//   也拒 `file:`（控制台那条 `net::ERR_FILE_NOT_FOUND` 就是它）"—— **归因是错的**：
				//   `ERR_FILE_NOT_FOUND` 说的是「**这个文件不存在**」，它对应的正是 D-38 已确证的
				//   那个被删掉的 WPS 临时文件，与协议**无关**；
				// ② 撤销之后改成"把 `file:` 原文递给宿主、能画就画"（D-44）—— 方向对，但
				//   **真机判定的结果是它画不出来**：Chromium 拒绝从 `app://` 原点的页面加载
				//   `file://` 子资源。用户 2026-10-16 **第二次**报同一句话：
				//   「列表上有对应文件了，但是**预览看不到**」。
				// ⇒ 现在的做法：宿主**自己的**本地文件前缀（`Platform.resourcePathPrefix`，
				//   文档写着它就是"resolving local files"用的）优先，原文兜底，**渲染时逐个试**
				//   —— 判据只有一份（`local-file.ts::localThumbCandidates`），决定权留给运行时。
				thumb: ctx.localThumbUrls(candidate.url),
				// ⚠️ 副标题的拼法**只有一处**（`externalRowMeta`）：主机 + 它出现在哪篇笔记里。
				// 原来这里自己拼过一次 `host — notePath`，而设置里那个挑选弹窗又拼了一遍 ——
				// 一处改了另一处不改，症状就是"两个入口的清单看起来不一样"。
				meta: externalRowMeta(candidate),
			})),
		],
		selection.paths.length + externals.length
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
						candidates: externals.filter((candidate) => chosen.has(pickKey(candidate))),
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
