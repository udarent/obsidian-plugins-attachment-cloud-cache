/**
 * 「上传附件」（P1 #8）—— 把**还没进你自己存储**的附件搬上去，并把笔记里的链接换成远端链接。
 *
 * ## 候选有四类、一个清单
 *
 * 1. **库内被引用的文件**：笔记里指着它们（传完要改写链接）；
 * 2. **库内没有被引用的文件**：没有任何笔记引用它们，只上传、不改写（D-68，默认不勾）；
 * 3. **笔记里的外链文件**：指向别处、同样没进你的存储（只是它们在别人的服务器上）；
 * 4. **本机文件**（`file:///D:/…`）：在你电脑上、不在库里。
 *
 * ⚠️ 全部由**纯判定层**挑（`maintenance/batch.ts` 的 `selectUploadCandidates` /
 * `selectExternalUploadCandidates`），这里只负责凑齐输入、写清清单、把结果如实报出来。
 *
 * ## 两个范围（2026-10-22，用户要求）
 *
 * 清单上方有一个勾选项「只看当前笔记」：勾上之后**只列这一篇笔记里的候选**。
 * ⚠️ 切换时**重新算**候选与正文（不是把行藏起来）—— 正文里的"共 N 个""来自 M 个站点"
 * 也会跟着变；只藏行会让摘要变成假话，而用户是按那份摘要点确认的。
 *
 * ## ⚠️ 这条命令会**改用户的笔记**
 *
 * 它把本地链接换成远端链接 —— 所以上传前必须先出确认框，而且要把
 * "什么都不搬、文件留在原处""哪些不会被处理""站外是哪几个站点"都写出来。
 */

import { Notice } from "obsidian";
import { fileNameFromUrl } from "../core/external-cache";
import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import { localFileExists } from "../local-file";
import {
	type CandidateSelection,
	type ExternalCandidate,
	type ExternalSelection,
	dropMissingLocalCandidates,
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "../maintenance/batch";
import { runBatchUpload } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { connectionReadiness } from "../s3/credentials";
import { pickKey } from "../ui/selection-logic";
import { externalRowMeta } from "../ui/file-cards";
import type { FileCard } from "../ui/file-cards";
import { buildTaskLabels } from "../ui/task-list";
import { readAllNoteTexts, referenceSnapshot, referencesInNote } from "./notes-query";
import type { PluginContext } from "./context";

/**
 * 一个**范围**下的全部候选。
 *
 * ⚠️ 清单与执行都从这一份里取（`selection` / `externals`）—— 用户按清单授权，
 * 执行就不能再看别的集合（本项目那条"一份快照两处用"的纪律）。
 */
interface Scope {
	/** 这个范围是不是「只看当前笔记」（勾选框的状态）。 */
	currentOnly: boolean;
	/** 库内候选（被引用的 ＋ 没有被任何引用的）。 */
	selection: CandidateSelection;
	/** 站外候选的汇总（`sites` / `skipped` 已按这个范围算好）。 */
	external: ExternalSelection;
	/** 站外 / 本机候选里**活着的**那些。 */
	externals: ExternalCandidate[];
	/** `file:///…` 指向的东西已经不在的那些（它们是坏链，得如实说一句）。 */
	missingLocal: ExternalCandidate[];
	/** 站外地址的条数（**不含**本机文件，两句话各说各的）。 */
	remoteCount: number;
	/** 本机文件的条数（只剩**确实还在**的那些）。 */
	localCount: number;
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

	// ⭐ 排障（D-67）：只读计数，不改行为；关着时这几行连 `Date.now()` 都不取。
	const debug = ctx.settings.debugLogging;
	const startedAt = Date.now();
	const files = ctx.app.vault.getFiles().filter((file) => typeof file?.path === "string");
	const vaultPaths = files.map((file) => file.path);
	// ⭐ **引用快照算一次、两处用**（确认框的清单 + 真正执行的那趟）——
	// 两份不一致的话，用户会按清单授权、却按另一份执行。
	// ⭐ 笔记正文**读一次、两处用**（引用集合 + 站外候选）：读两遍除了浪费，
	// 还给了两条链看到不同正文的余地（而它们必须看同一份 —— 清单即授权）。
	// ⭐⭐ 快照给两份答案：`referenced`（谁被指着）与 `rewritable`（谁的链接还能被我们改写）。
	// 后者让"**已经传过、而正文里那条还是本地路径**"的文件重新成为候选（重修），
	// 否则「重新上传附件」永远修不好那种只做了一半的记录（用户 2026-10-21 报的正是这个）。
	const notes = await readAllNoteTexts(ctx.app);
	const snapshot = await referenceSnapshot(ctx.app, { notes, debug });

	// ── 「只看当前笔记」这个范围（2026-10-22）──
	//
	// ⭐ 当前笔记的引用集合走 `referencesInNote` —— 它与上面那份全库快照**同一套判据**
	//（`localTargetsIn` + `resolveVaultTargets`），于是两个范围不会对"什么算引用"说出两种话。
	// ⚠️ 只支持 **Markdown 笔记**：画布的"当前"是另一套视图（`canvasTextTargets`），
	// 而这条命令的站外候选也只从 md 正文里扫（`readAllNoteTexts`）—— 与其造一个半对的
	// 范围，不如不给这个开关（没有活动笔记时也不给，见下面的 `filter`）。
	const activeFile = ctx.app.workspace.getActiveFile();
	let currentRefs: { referenced: ReadonlySet<string>; rewritable: ReadonlySet<string> } | null = null;
	if (activeFile && activeFile.extension === "md") {
		// 正文通常已经在 `notes` 里（全库刚读过）；读不到时才补读一次
		let text = notes.find((note) => note.path === activeFile.path)?.text;
		if (text === undefined) {
			try {
				text = await ctx.app.vault.read(activeFile);
			} catch {
				text = undefined;
			}
		}
		if (text !== undefined) currentRefs = referencesInNote(text, vaultPaths);
	}
	const currentPath = currentRefs ? activeFile?.path ?? "" : "";

	/**
	 * 按范围算候选（纯判定层 + 本机文件那一步 `stat`）。
	 *
	 * ⚠️ 当前笔记那一路**不传** `includeUnreferenced`（D-68 的口子只属于全库）：
	 * "没有任何笔记引用"的文件不可能出现在某一篇笔记的范围里 —— 那正是它的定义。
	 */
	const resolveScope = async (currentOnly: boolean): Promise<Scope> => {
		const refs = currentOnly ? currentRefs : null;
		const selection = selectUploadCandidates(files, {
			settings: ctx.settings,
			index: ctx.currentIndex(),
			referencedPaths: refs ? refs.referenced : snapshot.referenced,
			// ⭐⭐ 2026-10-22（D-68，用户明确要求）：**没有任何引用的附件也进清单**。
			// 它们只会上传、不会被改写（`unreferencedPaths` 标出来，清单里默认不勾）。
			// ⚠️ 这个口子**只在这条命令的全库范围**打开：自动接管那条路绝不能收未引用的文件
			//（会留死链，见 `CandidateOptions.includeUnreferenced`）。
			includeUnreferenced: !currentOnly,
			repairablePaths: refs ? refs.rewritable : snapshot.rewritable,
		});

		// ⭐ 笔记里的**外链文件**也算候选：这条命令补的是"把还没进你自己存储的搬进去"，
		// 而指向别处的同样没进存储 —— 只是它们在别人的服务器上。
		// 判定用的是**同一个纯函数**（`decideExternalCache`），所以"自己的存储 /
		// 回环地址 / 存储未就绪"全都自动一致，不另立一套标准。
		// ⚠️ 它走 `purpose: "manual"`：**点这个确认框本身就是显式动作**，
		// 于是功能开关与站点名单都不约束它（关掉开关也照样能跑这条命令）。
		// ⭐ 范围过滤交给判定层（`notePaths`）而不是这里筛结果：站点汇总（`sites`）
		// 必须按同一批笔记重算，否则"来自 M 个站点"会写着全库的数字。
		const external = selectExternalUploadCandidates(notes, {
			settings: ctx.settings,
			configured: connectionReadiness(ctx.app.secretStorage, ctx.settings).ready,
			// ⭐ 平台判据由装配点给（这一层不碰宿主）：本机文件（`file:///D:/…`）只有桌面读得到。
			isDesktop: ctx.isDesktop(),
			notePaths: currentOnly && currentPath ? new Set([currentPath]) : undefined,
		});

		// ⭐⭐ **本机文件先问一句"还在不在"**（只 `stat`、不读内容）：本机文件那条判定是**纯**的，
		// 于是"文件早被删掉"的地址照样会进清单，而它**必然失败** —— 临时目录里的东西
		// （WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存）天天在消失。
		// 用户 2026-10-16 实测报的正是这个：一行连缩略图都没有的 `file:///…/wpsDD.tmp.jpg`，
		// 他的原话：「没有缩略图的文件实际上已经不存在了，**不应该上传，即便上传也会失败**」。
		// ⚠️ 站外候选不受影响（它们的"在不在"要联网才知道，那是执行层的活）。
		const { kept, missing } = await dropMissingLocalCandidates(
			external.candidates,
			// ⚠️ 接缝优先（装配点可以替换），默认真去 `stat`；手机端走不到这里（平台判据在前面拦过了）
			deps.localFileExists ?? localFileExists
		);
		/** 站外那批的条数 —— **不含**本机文件（两句话各说各的，见下面）。 */
		const remoteCount = kept.filter((candidate) => !candidate.local).length;
		return {
			currentOnly,
			selection,
			external,
			externals: kept,
			missingLocal: missing,
			remoteCount,
			localCount: kept.length - remoteCount,
		};
	};

	const allScope = await resolveScope(false);
	// ⭐ 排障出口（D-67）：`skipped` 的分布就是"为什么只传了 N 个"的答案，
	// 而它以前只在确认框里给用户看一两句 —— 排障时看不到**全部**原因。
	debugTimed(debug, "上传候选", startedAt, {
		库内文件: files.length,
		候选: allScope.selection.paths.length,
		重修: allScope.selection.repairPaths.length,
		未引用: allScope.selection.unreferenced,
		跳过: Object.fromEntries(allScope.selection.skipped.map((row) => [row.reason, row.count])),
	});
	debugTimed(debug, "站外候选", startedAt, {
		收下的: allScope.externals.length,
		站外地址: allScope.remoteCount,
		本机文件: allScope.localCount,
		// 本机那些"早就不在了"的：用户报过的那类（`file:///…wpsDD.tmp.jpg`）
		已不在: allScope.missingLocal.length,
		跳过: Object.fromEntries(allScope.external.skipped.map((row) => [row.reason, row.count])),
	});
	// ⚠️ 当前笔记那份**先算好**（而不是切换时才算）：勾来勾去不该有等待，
	// 而"点了勾选框、清单半天不变"是最容易被当成插件坏掉的表现。
	const currentScope = currentRefs ? await resolveScope(true) : null;

	if (allScope.selection.paths.length === 0 && allScope.externals.length === 0 && allScope.missingLocal.length === 0) {
		new Notice(ctx.t("maintainBatchNothing"));
		return;
	}

	/**
	 * 确认框正文（随范围重算）。
	 *
	 * ⚠️ 这里的每一个数字都取自**同一个 scope**：摘要说几个、清单就得列几行
	 *（2026-10-17 真机复验见过"摘要说 0 个、清单列 8 行"的一屏）。
	 */
	/**
	 * 确认框正文（随范围重算）。
	 *
	 * ## ⚠️ 2026-10-22（D-71，用户要求）：上部只留三类，其余信息**下沉到列表**
	 *
	 * 用户原话：「上传附件命令打开的界面上部的文案取消掉,信息改到列表上面去,比如刚测试发现
	 * 已经找不到的本机文件,在列表中用图标表示出来」。
	 *
	 * 原来这里有 **8 段**（共 N 个 / 什么都不搬 / 未引用 N 个 / 重修 N 个 / 重复副本 N 个 /
	 * 站外 N 个来自 M 个站点 / 本机 N 个＋路径 / 失效 N 个＋路径）。现在只留三类，
	 * 而这三类都是**删不掉**的：
	 *
	 * 1. **摘要一句**（`maintainBatchSummary`）：它同时承担"将上传 N 个"（数字要与**可勾的行数**
	 *    相等，见 §7.3.4）与"文件不移动、不改名"那个承诺（1.2.0 / D-17 之后必须照实说）；
	 * 2. **站点名单**：这个确认框就是那份授权，不列等于让用户盲签（2026-10-15 定的）；
	 * 3. **失效图例**：列表里那些行只有一个图标，得有一句话说明图标是什么意思。
	 *
	 * 其余四类**全部下沉到行**：`没有笔记引用` / `只改链接`（行内小标签）、
	 * 本机路径（副标题）、失效（图标 ＋ 悬停说明）。
	 * ⚠️ 删掉的不是**事实**，是"同一件事说两遍"：摘要说一遍、行里再说一遍就是噪音，
	 * 而用户核对时看的是行。
	 */
	/**
	 * 确认框正文 —— ⭐⭐ **一句固定说明，不随内容变**（2026-10-22，D-72）。
	 *
	 * ## 用户为什么要求这个
	 *
	 * 「测试发现上传功能,还是有顶部会根据内容调整的文案,把文案简化成固定的说明文字」。
	 * D-71 把 8 段收成了至多 3 段，但每一段仍然带量（"将上传 N 个""来自 M 个站点"
	 * "有 K 个已经不在了"）—— 用户每换一篇笔记、每多一张站外图，这一块就变一次。
	 *
	 * ## 现在这块是**说明书**，不是摘要
	 *
	 * 它只回答三件事：**勾了的会怎样**（上传 ＋ 改链接）、**文件会不会被搬**
	 *（不移动、不改名）、**清单里的地址会不会被访问**（会，且那正是"点确认"授权的范围）。
	 * 最后一句顺带解释行内的警示图标（否则那个三角是哑谜）。
	 *
	 * ## ⚠️ 数字与名单去哪了
	 *
	 * - **数量**在**按钮**上（`maintainBatchCta(count)`：「上传并改写链接 (12)」）；
	 * - **站外站点**在**那一行的副标题**里（`externalRowMeta` 给主机）——
	 *   授权所需的是"看得见会访问哪台主机"，逐行看得见比一句汇总更具体；
	 * - **"已不在"的条数**不再说：那几行的图标 ＋ 灰着的勾选框已经说明，
	 *   而条数对用户没有额外决策价值（他总会逐条看）。
	 *
	 * ⚠️ 判据：这段文字**不含任何数字、不含任何主机名**（验收里有两条反向断言钉着）。
	 */
	const summaryLines = (): string[] => [ctx.t("maintainBatchSummary")];

	/**
	 * 确认框里的清单行（随范围重算）。
	 *
	 * ⭐ **清单里的两处键必须与执行层上报的键是同一份**（否则进度会挂到别的行上）：
	 * 库内文件 ⇒ 它的 vault 路径；站外 / 本机候选 ⇒ `pickKey`（笔记 + 地址）。
	 */
	const buildRows = (scope: Scope): FileCard[] => {
		// ⚠️ 本机文件那一类必须把**绝对路径**原样放进副标题：用户 2026-10-15 定的边界是
		// "只走显式入口 + 不加目录白名单"，于是"看得见要读哪条路径"就是那次同意的前提。
		// ⭐ 未引用的那些要"看得出来"（D-68）：清单里默认不勾，而用户得知道**为什么**。
		// ⚠️ 集合在循环外算一次（清单可能几百行）。
		const unreferencedSet = new Set(scope.selection.unreferencedPaths);
		// ⭐ 2026-10-22（D-71）：这两类信息原来在**摘要**里（"其中 N 个没有笔记引用"
		// "其中 N 个早就传过了"），现在落在**行上** —— 用户核对的是行，而摘要那两句
		// 让列表上方堆了八段话。⚠️ 两者互斥（未引用 ⇒ 不可能有可改写的链接）。
		const repairSet = new Set(scope.selection.repairPaths);
		return ctx.fileCards(
			[
				...scope.selection.paths.map((path) => ({
					id: path,
					name: path.split("/").pop() ?? path,
					// 库内文件 ⇒ 缩略图用它自己那份（零网络）
					localPath: path,
					// ⭐ 行内小标签：这一份没有任何笔记引用（传上去只是备份）；
					// 或者"早就传过、只差改链接"（勾了也不会重传字节）。
					hint: unreferencedSet.has(path)
						? ctx.t("maintainBatchUnreferencedHint")
						: repairSet.has(path)
							? ctx.t("maintainBatchRepairHint")
							: undefined,
					// ⭐ 副标题**不在这里拼**（D-66）：`planFileCards` 从 `localPath` 推出**目录**
					// 并单独给出「打开」目标。原来这里写 `meta: path`（含文件名）——
					// 于是第二行是"名字的重复"，而用户要的是"文件名带路径"（名字 + 所在目录）。
				})),
				...scope.externals.map((candidate) => ({
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
					// ⭐ 站外地址给「打开」（D-66，浏览器打开它）；**本机文件不给** ——
					// `file:///…` 递给浏览器只会得到一句打不开，而那一行的风险提示是"看得见路径"。
					open: candidate.local ? null : { kind: "url" as const, value: candidate.url },
				})),
				// ⭐⭐ **已经失效的那些**（D-70）：附件自己打不开了，但引用它的那篇笔记能打开 ——
				// 用户要的是"跳过去把那条坏链修掉"，而不是被一句通知打发。
				// ⚠️ `selectable: false`：它必然做不成任何事（文件都不在了），
				// 而清单里出现"勾了也不会被处理"的行会被读成插件漏了它。
				...scope.missingLocal.map((candidate) => ({
					id: pickKey(candidate),
					name: fileNameFromUrl(candidate.url) || candidate.url,
					// ⭐ 2026-10-22（D-71，用户要求）：**在列表里用图标表示**，不再用文字标签 ——
					// 文字只留作悬停说明（`title` / `aria-label`），图标由弹窗层用宿主的 `setIcon` 画。
					hint: ctx.t("maintainBatchMissingHint"),
					hintIcon: "alert-triangle",
					// 副标题给**完整绝对路径**（本机那条路唯一能核对"是哪一份"的线索）
					meta: externalRowMeta(candidate),
					// 打开的是**笔记**（打开方式由装配点按 `vault` 走宿主的视图，见 `main.ts::openCardTarget`）
					open: { kind: "vault" as const, value: candidate.notePath },
					openLabel: ctx.t("fileCardOpenNote"),
					selectable: false,
				})),
			],
			// ⚠️ 行数**必须**把失效那些算进去（limit 小于行数 ⇒ 末尾那几行不显示，
			// 而用户会以为它们根本没被列出来）
			scope.selection.paths.length + scope.externals.length + scope.missingLocal.length
		);
	};

	/** 默认勾选 = **会被改写链接的那些** ＋ 站外/本机（D-68）。 */
	const initiallySelectedOf = (scope: Scope): string[] => {
		// ⚠️ 没有被任何引用的库内文件**默认不勾**：它们传上去不会出现在任何笔记里，
		// 而这类文件可能有几百个（旧图、废弃稿）—— 默认全勾等于替用户做了"全备份"这个决定。
		// ⚠️ 键必须与行 `id` 同一份：库内 ⇒ 路径，站外/本机 ⇒ `pickKey`。
		const unreferencedSet = new Set(scope.selection.unreferencedPaths);
		return [
			...scope.selection.paths.filter((path) => !unreferencedSet.has(path)),
			...scope.externals.map((candidate) => pickKey(candidate)),
		];
	};

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

	/**
	 * 用户**最后看到的**那个范围 —— 执行必须按它来（见下面 `run`）。
	 * ⚠️ 状态放在这一层而不是弹窗里：弹窗只交出"勾了哪些键"，而"这些键属于哪个范围"
	 * 只有这里知道（同一个键在两个范围里的含义可能不同：库内是路径、站外是"笔记 + 地址"）。
	 */
	let activeScope: Scope = allScope;

	const result = await ctx.pickTasks({
		title: ctx.t("maintainBatchTitle"),
		// ⭐ 固定一句（不随范围/内容变，见 `summaryLines`）
		lines: summaryLines(),
		cards: buildRows(allScope),
		// ⭐ 范围过滤（2026-10-22，用户要求「只看当前笔记 / 全库」可以留一个勾选项）：
		// 只有"当前确实站着一篇 Markdown 笔记"时才给 —— 否则勾上之后清单必然空，
		// 而用户会以为是插件漏了东西。
		filters: currentScope
			? [{ key: "current-note", name: ctx.t("maintainBatchOnlyCurrentNote"), value: false }]
			: undefined,
		onFiltersChange: currentScope
			? (state) => {
					// ⚠️ 两份候选在打开时都算好了：勾来勾去零等待。
					const scope = state["current-note"] ? currentScope : allScope;
					activeScope = scope;
					// ⚠️ 不交 `lines`：正文是**固定说明**，换范围不该动它
					//（`TaskListOptions.lines` 的初值就是那句）。
					return Promise.resolve({ cards: buildRows(scope) });
				}
			: undefined,
		initiallySelected: initiallySelectedOf(allScope),
		labels: buildTaskLabels(ctx.t, "maintainBatchCta"),
		// ⭐ 勾选**在这里生效**：候选（安全判据）与取舍（勾选）是两件事。
		// 站外那一批按 `pickKey` 过滤，库内那批交给执行层的 `onlyPaths`。
		run: async (selected, report) => {
			const chosen = new Set(selected);
			const scope = activeScope;
			try {
				state.summary = await runBatchUpload(deps, {
					external: {
						...scope.external,
						candidates: scope.externals.filter((candidate) => chosen.has(pickKey(candidate))),
					},
					// ⚠️ 这里传的是**全库**快照，不是当前范围那份：执行层用它判断"传完要不要改链接"，
					// 而"有没有人引用"是全库的事实（别的笔记里也可能指着它）。
					// 范围只体现在 `onlyPaths` / 站外候选上 —— 那才是用户的取舍。
					referencedPaths: snapshot.referenced,
					repairablePaths: snapshot.rewritable,
					// ⚠️ 未引用的口子跟着范围走：当前笔记范围里本来就没有它们。
					includeUnreferenced: !scope.currentOnly,
					onlyPaths: new Set(scope.selection.paths.filter((path) => chosen.has(path))),
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
	/**
	 * ⭐⭐ 2026-10-22（D-80，评审 3-2）：**一次上传只发一条通知**。
	 *
	 * 原来这里最多连发三条（完成 ＋ 画布跳过 ＋ 重复副本已删）。Android 上它们会叠成
	 * 一摞、互相盖住，而三条里只有第一条是"结论" —— 后两条是**同一次操作的补充事实**。
	 * ⇒ 合成一条：失败条数本来就在第一条里，补充事实用空格接在后面（哪一条都没有丢）。
	 *
	 * ⚠️ 判据是"**用户要读的是不是同一件事**"，不是"条数"：清理那条命令结束时也只有一条
	 *（它的三种结局本来就互斥），所以两屏在这件事上是一致的。
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
	// ⚠️ 画布里"没敢动"的值要**说出来**：它不属于失败，但用户必须知道
	// 某一处引用可能还指着旧位置（否则他会以为全改好了）。
	if (outcome.canvasSkipped > 0) {
		parts.push(ctx.t("maintainBatchCanvasSkipped", { count: outcome.canvasSkipped }));
	}
	// ⭐ 删掉重复副本也要**说一句**：那是清单里的文件之一，不交代就等于"少了一个"。
	if (outcome.redundantRemoved > 0) {
		parts.push(ctx.t("maintainBatchDuplicatesRemoved", { count: outcome.redundantRemoved }));
	}
	// ⚠️ 分隔符用空格而不是中文标点：文案本身已经以句号结尾，且这一层不许写死标点
	//（`check:notice-i18n` 的判据）。
	new Notice(parts.join(" "));
}
