/**
 * 「上传全部附件」—— 「把链接改回本地路径」的**反向**（2026-10-23，用户要求）。
 *
 * ## 一句话
 *
 * 把附件传到你的存储，并把笔记里指向它们的**本地链接改成远端地址**。
 *
 * ## 与 `plugin/revert-flow.ts` 正好互为逆操作
 *
 * | | 范围 | 动手的地方 | 交互 |
 * |---|---|---|---|
 * | `revertLinksToLocal` | 索引里、**本地副本还在**的条目 | 笔记：远端链接 → 本地路径 | 一次确认 |
 * | 本流程 | 库内附件 ＋ 按设置允许的库外文件 | 笔记：本地链接 → 远端地址 | 一次确认 |
 *
 * ⚠️ 两边都**不删任何东西**：上传完文件仍在原处、名字不变；回退时云端那份也不会消失。
 *
 * ## ⚠️⚠️ 为什么**没有清单**（用户 2026-10-23 明确要的）
 *
 * 原话：「设置界面的"上传附件"改成与"恢复本地链接"相反的对应功能，**取消弹窗选择的
 * 复杂交互**」。于是这一层**不列清单、不勾选**：范围由**判据 ＋ 设置**定，不由用户逐条勾。
 * 对称地看，`revertLinksToLocal` 也没有清单 —— 两个互为逆操作的按钮，交互形状必须一样。
 *
 * ## ⭐⭐ 范围里的三类，各自的授权来自哪（2026-10-24 用户定的口径）
 *
 * 没有清单 ⇒ 用户看不到"逐行"的取舍，于是**授权必须由事前的设置表达**。
 * 三条判据各有一个开关，谁都不替谁做主：
 *
 * | 类 | 授权来自 | 默认 |
 * |---|---|---|
 * | **库内、被引用**的附件（含"只差改链接"的） | 这个按钮本身（点它就是要求"都传上去"） | — |
 * | **站外图**（`https://…`） | 设置里的「站外文件」开关 ＋ **站点名单**（走 `purpose: "auto"`） | 关 |
 * | **本机文件**（`file:///…`） | 设置里的「同时上传本机文件」 | 关 |
 *
 * ⚠️ 站外那一档必须走 `purpose: "auto"`（受开关与名单约束），**不能**走 `"manual"`：
 * 后者是"勾选即同意"的语义，而这条链已经没有勾选了 —— 接成 manual 的后果是
 * **关掉站外开关之后，插件照样去别人的服务器拉图**。
 * ⚠️ 用户 2026-10-24 的原话：「站外图可以用设置中的"站外文件是否上传云端"来确定。
 * 本机 file:///，可以采用相同的方案，在设置中做一个开关，让用户决定」。
 *
 * ## ⚠️ 唯一还被排除的一类：**没有任何笔记引用的附件**
 *
 * 反向操作的含义是"让笔记指向云端"；没有笔记能指向的那些传上去只是往云端塞字节。
 * 这一条**没有开关**：它不是"用户想不想碰库外"的问题，而是"这件事本身没有意义"。
 * （旧清单里"未引用也列出来、默认不勾"那个口子只属于清单形态。）
 */

import { Notice } from "obsidian";

import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import { localFileExists } from "../local-file";
import {
	type ExternalCandidate,
	dropMissingLocalCandidates,
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "../maintenance/batch";
import { formatMegabytes } from "../maintenance/eviction";
import { runBatchUpload, runReleaseSpace } from "../maintenance/run";
import type { BatchResult } from "../maintenance/run";
import { connectionReadiness } from "../s3/credentials";
import { readAllNoteTexts, referenceSnapshot } from "./notes-query";
import { planLocalCleanup } from "./release-space-flow";
import type { PluginContext } from "./context";

/** 确认框里最多列几个站点 / 几条本机路径；再多只报个数（一行文字装得下的量）。 */
const SAMPLE_MAX = 6;

/**
 * 把附件（库内 ＋ 按设置允许的库外）传到云端，并把笔记里的链接改成远端地址。
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
	// ⭐ 笔记正文**读一次、两处用**（引用集合与站外/本机候选）：读两遍除了浪费，还给了
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
		// 传上去只是往云端塞字节（这条没有开关，见文件头）。
		includeUnreferenced: false,
	});

	/**
	 * 库外候选（站外 ＋ 本机）。
	 *
	 * ⭐ `purpose: "auto"` = **按设置走**：站外开关关着就一个都不收，站点名单照样生效。
	 * ⭐ `includeLocalFiles` 来自设置里那个独立开关（默认关）。
	 */
	const external = selectExternalUploadCandidates(notes, {
		settings: ctx.settings,
		configured: connectionReadiness(ctx.app.secretStorage, ctx.settings).ready,
		// ⚠️ 平台判据由装配点给（这一层不碰宿主）：本机文件只有桌面读得到。
		isDesktop: ctx.isDesktop(),
		purpose: "auto",
		includeLocalFiles: ctx.settings.uploadLocalFiles,
	});

	// ⭐⭐ **本机文件先问一句"还在不在"**（只 `stat`、不读内容）：本机那条判定是**纯**的，
	// 于是"文件早被删掉"的地址照样会成为候选，而它**必然失败** —— 临时目录里的东西
	// （WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存）天天在消失。
	// 用户 2026-10-16 实测报的正是这个：「没有缩略图的文件实际上已经不存在了，
	// **不应该上传，即便上传也会失败**」。
	// ⚠️ 站外候选不受影响（它们的"在不在"要联网才知道，那是执行层的活）。
	const { kept, missing } = await dropMissingLocalCandidates(
		external.candidates,
		// ⚠️ 接缝优先（装配点可以替换），默认真去 `stat`
		deps.localFileExists ?? localFileExists
	);
	/** 站外那批的条数 —— **不含**本机文件（两句话各说各的）。 */
	const remoteCount = kept.filter((candidate) => !candidate.local).length;
	/** 本机文件（确实还在的）的条数。 */
	const localCount = kept.length - remoteCount;
	/** 这一趟要处理的总数（库内 ＋ 库外）。 */
	const total = selection.paths.length + kept.length;

	debugTimed(debug, "上传候选", startedAt, {
		库内文件: files.length,
		候选: selection.paths.length,
		只差改链接: selection.repairPaths.length,
		跳过: Object.fromEntries(selection.skipped.map((row) => [row.reason, row.count])),
	});
	debugTimed(debug, "库外候选", startedAt, {
		收下的: kept.length,
		站外地址: remoteCount,
		本机文件: localCount,
		// 本机那些"早就不在了"的：用户报过的那类（`file:///…wpsDD.tmp.jpg`）
		已不在: missing.length,
		跳过: Object.fromEntries(external.skipped.map((row) => [row.reason, row.count])),
	});

	/**
	 * ⭐⭐ 本地副本按**档位**顺手清（2026-10-24 用户要求）。
	 *
	 * 原话：「设置中的删除本地副本按钮可以取消,因为上传全部按钮的时候可以根据是否
	 * 保留附件的选项来决定是否顺便删除本地副本。」⇒ 那个独立按钮取消，能力**搬到这里**：
	 * 档位是「不保留」就全清，是「保留 + 上限」就清到上限以内。
	 *
	 * ⚠️ **判据不在这里写第二份**：走 `planLocalCleanup`（与切档询问同一个函数）——
	 * 这是删文件的判据，"两处各算一遍"迟早给出两种答案，而代价不是难看，是丢东西。
	 * ⚠️ 它可能抛（有笔记读不到）⇒ **跳过清理、继续上传**：上传不删任何东西，
	 * 不该被一个"算不清能不能删"的问题挡住；而清理那一步必须什么都不做（读不到就可能多删）。
	 */
	let cleanup: Awaited<ReturnType<typeof planLocalCleanup>> = null;
	let cleanupFailure = "";
	try {
		cleanup = await planLocalCleanup(ctx);
	} catch (error) {
		cleanupFailure = describeError(error);
	}
	const cleanupCount = cleanup?.selection.candidates.length ?? 0;

	debugTimed(debug, "本地副本清理计划", startedAt, {
		档位: ctx.settings.localCopy,
		上限: ctx.settings.cacheLimitMb,
		可清: cleanupCount,
		...(cleanupFailure ? { 算不出来: cleanupFailure } : {}),
	});

	if (total === 0 && cleanupCount === 0) {
		new Notice(ctx.t("maintainBatchNothing"));
		return;
	}

	/**
	 * 确认框：**一次，只有"是/否"**。
	 *
	 * ⚠️ 这里的每一句都在**替清单说话**：没有行可看，用户只能靠这几句判断"这一下会动什么"。
	 * 所以这几件事缺一不可：
	 * 1. **几件**（用户按这个决定要不要跑）；
	 * 2. **会不会去别人的服务器**（站外那几个主机名 —— 这就是那次授权的凭据）；
	 * 3. **会不会读这台电脑上的文件**（本机那几条路径的**样本**）；
	 * 4. **文件留在原处、云端不删**（这次动作的边界，与 `revertKeepsEverything` 对称）。
	 */
	const lines: string[] = [];
	// ⚠️ 只有真有东西要传时才说"要传几件"：`total === 0` 那一支是**纯清理**
	//（档位是"不保留"、而这一趟没有新附件可传）—— 那时候说"上传 0 个"只会让人困惑。
	if (total > 0) {
		lines.push(ctx.t("uploadAllSummary", { count: total }));
	}
	if (remoteCount > 0) {
		lines.push(ctx.t("uploadAllExternal", { count: remoteCount, sites: siteSummary(ctx, external.sites) }));
	}
	if (localCount > 0) {
		// ⚠️ 本机文件列**样本路径**：开关表达"允许读这台电脑"，而"读的是哪些路径"仍然要看得见
		//（本机路径比主机名更贴近用户的目录结构）。
		lines.push(ctx.t("uploadAllLocal", { count: localCount, paths: localPaths(kept) }));
	}
	if (missing.length > 0) {
		// ⚠️ 它们**不在**总数里（会被跳过），所以单独一句 —— 混进总数会让"几件"变成假话。
		lines.push(ctx.t("uploadAllMissingLocal", { count: missing.length }));
	}
	if (selection.repairPaths.length > 0) {
		lines.push(ctx.t("uploadAllRepairOnly", { count: selection.repairPaths.length }));
	}
	if (total > 0) lines.push(ctx.t("uploadAllKeeps"));

	/**
	 * ⭐⭐ 清理那一段（档位决定，见前面 `planLocalCleanup` 的说明）。
	 *
	 * ⚠️ 措辞里必须带**"永久删除"**那层意思：`releaseSpaceCannotUndo` 是这一步唯一的
	 * 安全信息，而顺手清理最容易被读成"顺手挪一下"。两档各一句（清到底 / 清到上限）。
	 */
	if (cleanup && cleanupCount > 0) {
		const mb = formatMegabytes(cleanup.selection.bytes);
		lines.push(
			cleanup.target.kind === "limit"
				? ctx.t("uploadAllCleanupToLimit", {
						count: cleanupCount,
						mb,
						limit: ctx.t("cacheLimitValue", { mb: cleanup.target.mb }),
					})
				: ctx.t("uploadAllCleanupAll", { count: cleanupCount, mb })
		);
		lines.push(ctx.t("releaseSpaceCannotUndo"));
	}

	/**
	 * 确认框分两支（2026-10-24）：
	 * - **有东西要传** ⇒ 上传那套标题 ＋ 按钮（清理写成附加的一段）；
	 * - **只有清理** ⇒ 用清理那套标题 ＋ "永久删除"按钮 —— 那时叫「上传 0 个」是假话。
	 *
	 * ⚠️ `destructive` 跟着**会不会删文件**走：只要含清理就是 `true`（按钮变危险色），
	 * 否则 `false`（只改链接、不删东西）。
	 */
	const confirmed = await ctx.confirmMaintenance(
		total > 0
			? {
					title: ctx.t("uploadAllTitle"),
					lines,
					cta: ctx.t("uploadAllCta", { count: total }),
					destructive: cleanupCount > 0,
				}
			: {
					title: ctx.t("releaseSpaceTitle"),
					lines,
					cta: ctx.t("releaseSpaceCta"),
					destructive: true,
				}
	);
	if (!confirmed) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}

	const state: { summary: BatchResult | null } = { summary: null };
	let failure = "";
	// ⚠️ 只在这一趟**真有东西要传**时才跑上传：`total === 0` 那一支是纯清理。
	if (total > 0) {
		try {
			state.summary = await runBatchUpload(deps, {
				// ⭐ 库外那批整份交给执行层（它自己按 `cacheExternal` 决定怎么下载/读）
				external: { ...external, candidates: kept },
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
			// ⚠️ 上传失败就**不再往下清**：此刻用户要看的是这条错误，
			// 而不是"顺手又删掉一批本地副本"（那会让现场更难收拾）。
			new Notice(failure);
			return;
		}
	}

	/**
	 * 一条通知说完这一趟（D-80：多条会叠成一摞，而只有第一条是结论）。
	 *
	 * ⚠️ 清理排在**上传之后**：`runReleaseSpace` 会逐个 HEAD 复核"云端现在确实还有它"，
	 * 所以顺序反过来就会有一批因为"刚传的还没确认上"而被跳过。
	 */
	const parts: string[] = [];
	const outcome: BatchResult | null = state.summary;
	if (outcome) {
		parts.push(
			ctx.t("maintainBatchDone", {
				uploaded: outcome.uploaded,
				reused: outcome.reused,
				failed: outcome.failed,
				notes: outcome.notesChanged,
				links: outcome.linksRewritten,
			})
		);
		// ⚠️ 画布里"没敢动"的值要**说出来**：它不属于失败，但用户必须知道某一处引用
		// 可能还指着旧位置（否则他会以为全改好了）。
		if (outcome.canvasSkipped > 0) {
			parts.push(ctx.t("maintainBatchCanvasSkipped", { count: outcome.canvasSkipped }));
		}
		// ⭐ 删掉重复副本也要说一句：一个附件只该留一份，多余的清掉不是"少了一个"。
		if (outcome.redundantRemoved > 0) {
			parts.push(ctx.t("maintainBatchDuplicatesRemoved", { count: outcome.redundantRemoved }));
		}
	}

	if (cleanup && cleanupCount > 0) {
		try {
			const released = await runReleaseSpace(deps, cleanup.selection);
			parts.push(
				ctx.t("releaseSpaceDone", {
					deleted: released.evicted,
					mb: formatMegabytes(released.freed),
					skipped: released.skipped.length,
				})
			);
			// ⚠️ "一个都没删"必须解释 —— 用户刚看到"会删除 N 份"，结果一份没删、
			// 只说"跳过 N 个"，他只会以为功能坏了（真实原因永远是"云端确认不上"）。
			if (released.evicted === 0 && released.skipped.length > 0) {
				parts.push(ctx.t("releaseSpaceNothingDeleted", { skipped: released.skipped.length }));
			}
		} catch (error) {
			// 清理失败不该淹没上传结果 ⇒ 追加一句，而不是替换 parts
			parts.push(describeError(error));
		}
	}

	// ⚠️ 分隔符用空格而不是中文标点：文案本身已经以句号结尾，且这一层不许写死标点
	//（`check:notice-i18n` 的判据）。
	if (parts.length > 0) new Notice(parts.join(" "));
	// ⚠️ 清理算不出来（有笔记读不到）时**明说**：否则用户切到"不保留"、跑了这一趟，
	// 发现本地副本一份没少，会以为是这个开关坏了。
	if (cleanupFailure) new Notice(ctx.t("uploadAllCleanupSkipped", { reason: cleanupFailure }));
}

/**
 * 站点名单 → 一句能放进确认框的话（最多 `SAMPLE_MAX` 个，其余报个数）。
 *
 * ⚠️ 这一句是**授权凭据**：没有清单之后，"会访问哪台主机"只能在这里看见。
 * 少列一个主机 = 用户同意了没看见的东西。
 */
function siteSummary(ctx: PluginContext, sites: readonly { host: string }[]): string {
	const names = sites.slice(0, SAMPLE_MAX).map((site) => site.host);
	const rest = sites.length - names.length;
	const joined = names.join(", ");
	return rest > 0 ? `${joined}${ctx.t("uploadAllSiteMore", { count: rest })}` : joined;
}

/**
 * 本机文件的样本路径（最多 `SAMPLE_MAX` 条）。
 *
 * ⚠️ 与站点那条同一个理由：开关表达"允许读这台电脑"，而"读哪几条"仍然要看得见。
 * 本机路径比主机名更贴近用户的目录结构 ⇒ 更不能只报个数。
 */
function localPaths(candidates: readonly ExternalCandidate[]): string {
	const all = candidates.filter((candidate) => candidate.local);
	const shown = all.slice(0, SAMPLE_MAX).map((candidate) => candidate.url.replace(/^file:\/{2,3}/i, ""));
	return all.length > shown.length ? `${shown.join(", ")} …` : shown.join(", ");
}
