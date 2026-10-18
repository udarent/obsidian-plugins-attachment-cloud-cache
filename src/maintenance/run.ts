/**
 * 维护功能的执行层：真的去读磁盘、删文件、改笔记。
 *
 * ## 三条安全性质在这里落地
 *
 * 1. **删文件只有一条路，且拿不到凭据就跳过。** 宿主的文件索引可能滞后于磁盘
 *    （刚同步进来的文件还没被索引），此时 `getAbstractFileByPath` 返回 null。
 *    用 `adapter.remove` 硬删会**绕过宿主的文件索引** —— 文件从磁盘上没了，
 *    而宿主仍然认得它，留下"看得见、读不到"的幽灵条目 —— 所以宁可跳过并如实汇报。
 *    至于"怎么删"，由 `remove.ts` 统一决定（只有一种方式：直接删除）。
 *    ⚠️ 1.2.0（D-17）起那份文件**同时是用户的附件**，所以"能不能重新拿到"成了
 *    删它的唯一依据 ⇒ 自动淘汰那条路**必须先确认云端还有**（`confirmRemote`），
 *    详见 `runEviction` 的说明。
 * 2. **改笔记前先把原文取到手。** `vault.modify` 是**整文件覆盖**：若写入的是空串
 *    （例如读取失败却继续往下走），用户的笔记就没了。所以读失败一律跳过该文件。
 * 3. **判定与执行分开。** "该动哪些"由纯函数决定（`audit.ts` / `eviction.ts`），
 *    这一层只负责"照着清单做"，并把每一步的失败如实记进结果。
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { CacheIndex } from "../cache/index";
import type { ExternalCandidate, NoteTextLike } from "./batch";
import type { LocalFileProbe } from "../local-file";
import type { PluginSettings } from "../types";
import { auditCache } from "./audit";
import type { CacheAudit, DiskFile } from "./audit";
import { removeCacheFile } from "./remove";
import type { EvictionOutcome, EvictionPlan } from "./eviction";
import type { ReleaseSpaceSelection } from "./release-space";
import { canvasStillMentionsPath, keysInText, stillMentionsPath, planCanvasRewrites, planLinkRewrites } from "./references";
import type { RewriteRule } from "./references";
import { selectUploadCandidates } from "./batch";
import type { ExternalSelection, VaultFileLike } from "./batch";
import type { IngestRequest, IngestResult } from "../core/ingest";
import type { ExternalCacheOutcome } from "../core/external-cache";
import { describeError } from "../error-text";
import { normalizeVaultPath } from "../vault-files";

export interface MaintenanceDeps {
	app: App;
	settings: () => PluginSettings;
	index: () => CacheIndex;
	/** 索引变更后落盘。 */
	persistIndex: () => Promise<void>;
	/** 上传编排（复用粘贴那条链，避免两套行为）。 */
	ingest: (request: IngestRequest) => Promise<IngestResult>;
	/**
	 * 站外图的"下载 → 上传 → 改写链接"（复用「上传外部文件…」那条链）。
	 *
	 * 与 `ingest` 同理：只有一处实现，于是同意复核、失败分类、
	 * "URL 在笔记里总是字面出现"那几条纪律不会因为入口不同而分叉。
	 * 未提供时批量上传只处理库内文件。
	 */
	cacheExternal?: (url: string, notePath: string | undefined) => Promise<ExternalCacheOutcome>;
	/**
	 * ⭐ "云端**现在**确实还有这个对象吗"（1.2.0 新增，`maintenance/eviction.ts` 用）。
	 *
	 * 淘汰本地副本前逐个复核。**为什么不能只查台账**：台账记的是"我们传过它"，
	 * 而别的设备可能已经把云端对象清掉了 —— 那种情况下本机这份副本是**最后一份**，
	 * 删它就是丢数据。缓存目录时代不需要这一问（那条目录里的东西必然是刚传上去的），
	 * 现在副本可能活得比云端对象久。
	 *
	 * 未提供 ⇒ 一律当作"确认不了" ⇒ **不淘汰**（安全的一侧）。
	 */
	confirmRemote?: (key: string) => Promise<boolean>;
	/**
	 * ⭐⭐ 笔记 / 画布的链接**直接指着的** vault 路径集合（= `referencedVaultPaths` 那一份）。
	 *
	 * ⚠️ 它与 `scanReferencedKeys` 合起来才回答得了"这份副本还有人在用吗"，而两个问题的
	 * 后果相反（见 `audit.ts` 的 `referencedPaths`）：那一半问"笔记还写着**云端地址**吗"，
	 * 这一半问"笔记**直接指着这份文件**吗"。
	 *
	 * ⚠️ **必填**（编译期保证）：缺了它，一份笔记正在显示的图会被报成"没有任何笔记引用"，
	 * 于是用户照着这个数字去清、或者后台淘汰把它排到最前面 —— 两个后果都是"图没了"。
	 */
	referencedPaths: (notes?: readonly NoteTextLike[]) => Promise<ReadonlySet<string>>;
	/**
	 * ⭐ 「这份**本机文件**（`file:///…`）现在还读得到吗」（列表阶段用：只 `stat`、**不读内容**）。
	 *
	 * ⚠️ 为什么要在**列清单之前**问一次：本机文件的判定是**纯**的（`decideLocalFile` 不碰磁盘），
	 * 于是"文件早被删掉"的地址照样会进清单、而它**必然失败** —— 临时目录里的东西
	 * （WPS 的 `Temp/ksohtml/…`）天天在消失。用户 2026-10-16 实测报的就是这个：
	 * 一行 `file:///C:/…/Temp/ksohtml/wpsDD.tmp.jpg` 连缩略图都没有，文件已经不在了。
	 *
	 * 未提供 ⇒ 退回 `local-file.ts::localFileExists`（真去 `stat`；手机端走不到这里）。
	 * ⚠️ 它是**安全的一侧**：问不出来只会少列一条，不会列出一条必然失败的。
	 */
	localFileExists?: LocalFileProbe;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
}

/**
 * 读出这些路径**此刻在磁盘上的样子**（不在表里 = 那份副本已经不在了）。
 *
 * ⚠️ 输入是**索引里记过的路径**，不是"某个目录下的所有文件"。
 * 1.2.0（D-17）之前这里列的是缓存目录，那个做法随那条目录一起没了：
 * 现在**索引外的文件可能是用户自己的附件**，扫出来也绝不能动（见 `audit.ts` 文件头）。
 * B3 的迁移命令要枚举**老缓存目录**，那份枚举由它自己实现 ——
 * 别把"扫目录"重新接回这里，否则"删索引外的文件"会跟着回来。
 *
 * 走 `adapter.stat` 而不是 Node `fs`：移动端只有前者可用；
 * 失败/读不到一律当作"不在"（报告里会算进"失效"），绝不让整条命令失败。
 */
export async function readCopies(app: App, paths: readonly string[]): Promise<Map<string, DiskFile>> {
	const out = new Map<string, DiskFile>();
	for (const raw of paths ?? []) {
		const path = normalizeVaultPath(raw);
		// 空路径与重复路径都要挡：交给宿主 `getAbstractFileByPath` 空串是在赌它怎么处理，
		// 而我们没有任何理由为这种输入冒风险。
		if (!path || out.has(path)) continue;
		try {
			const info = await app.vault.adapter.stat(path);
			if (info && typeof info.size === "number") out.set(path, { path, bytes: Math.max(0, info.size) });
		} catch {
			// 读不到 = 当作不在（报告里会算成"索引指向的文件已不在"）
		}
	}
	return out;
}

/**
 * 扫描全库笔记，收集"仍被引用"的对象 key。
 *
 * 顺带产出每个文件里出现的本存储 URL（批量上传改写时直接用这份结果，
 * 避免为了"哪些笔记引用了它"再扫一遍库）。
 */
export async function scanReferences(
	app: App,
	keyFromUrl: (url: string) => string | null
): Promise<{ keys: Set<string>; byPath: Map<string, string> }> {
	const keys = new Set<string>();
	const byPath = new Map<string, string>();

	for (const file of app.vault.getMarkdownFiles()) {
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			continue; // 读不了就跳过：这条命令不该因为一个坏文件整体失败
		}
		byPath.set(file.path, text);
		for (const key of keysInText(text, keyFromUrl)) keys.add(key);
	}
	return { keys, byPath };
}

export interface LocalCopyInspection {
	audit: CacheAudit;
}

/**
 * 看一遍本地副本现在的状况（只读，不动任何东西）。
 *
 * 它是「查看缓存占用」那条命令的全部数据来源，也是判定层与磁盘之间**唯一**的接缝：
 * 这里把"索引里的路径"变成"磁盘上的实际样子"，交给纯函数 `auditCache` 去分类。
 *
 * ⚠️ 只查**索引里出现过的**路径（每条一次 `stat`）：不再扫目录，也就不会再有
 * "索引外的文件"进到判定里 —— 那是不可逆错误唯一的入口。
 */
export async function inspectLocalCopies(
	deps: MaintenanceDeps,
	keyFromUrl: (url: string) => string | null
): Promise<LocalCopyInspection> {
	const entries = deps.index().toArray();
	const copies = await readCopies(
		deps.app,
		entries.map((entry) => entry.cachePath)
	);
	const { keys, byPath } = await scanReferences(deps.app, keyFromUrl);
	// ⭐ "还有人用吗"的另一半：笔记**直接指着**哪些库内文件（见 `MaintenanceDeps.referencedPaths`）。
	// 少了它，一份正被显示的图会被报成"没有任何笔记引用"。
	// ⚠️ 把**刚读到的正文**递过去：同一个命令里别把全库笔记读两遍。
	const referencedPaths = await deps.referencedPaths(
		[...byPath].map(([path, text]) => ({ path, text }))
	);

	return {
		audit: auditCache({ entries, copies, referencedKeys: keys, referencedPaths }),
	};
}

/**
 * 一条**要删掉的本地副本**。
 *
 * ⚠️ 上限淘汰（`eviction.ts`）与存量清理（`release-space.ts`）共用这个形状 ——
 * 它们是**同一条执行路径**（F18 与 §4.4.3 的差别只在"候选怎么挑"，不在"怎么删"）。
 * 少一种形状就少一处可能被改歪的删除代码。
 */
export interface RemovalVictim {
	/** 对象 key（执行时按它复核云端）。 */
	key: string;
	/** 本地副本的 vault 相对路径。 */
	cachePath: string;
	/** 字节数（**索引记的值** —— 用于汇报"释放了多少"）。 */
	bytes: number;
}

/** 按计划执行淘汰（缓存上限轮换的执行层）。 */
export interface EvictionRunResult extends EvictionOutcome {
	/** 顺手摘掉的索引记录数。 */
	unindexed: number;
}

/**
 * **唯一的删除循环**：把清单上的副本**验证后删掉**，并摘掉它们的索引记录。
 *
 * ## 谁在用
 *
 * 1. `runEviction`（自动淘汰，超上限时）；
 * 2. `runReleaseSpace`（F18 存量清理，用户在「不留副本」档下主动确认）。
 *
 * 两者**必须**走同一份：它们都删**用户的附件目录里的文件**，
 * 判据也不完全一样（一个按 LRU、一个按用户勾选），但"删之前要复核什么"一模一样 ——
 * 而那才是风险所在。分成两份代码，早晚会有一份漏掉某道复核。
 *
 * ## ⚠️ 双保险（1.2.0 换掉了旧的那道）
 *
 * 清单是**上一拍**算出来的，而这个函数在**删文件**，少一层校验的代价不可逆：
 *
 * 1. **索引此刻仍认这份副本**（key 与路径都对得上）—— 这一拍之间用户可能已经
 *    把它挪走、改名，或者换成了另一个同名文件；
 * 2. **云端现在确实还有这个对象**（`confirmRemote`）—— 否则删掉的是**最后一份**。
 *    台账只证明"我们传过它"，而别的设备可能已经把云端对象清掉了。
 *    ⚠️ 这条在 1.2.0 之前**不需要**（缓存目录里的东西必然是刚传上去的）；
 *    现在副本可能比云端对象活得久，所以必须问服务端。确认不上（离线/出错）⇒ 不分删。
 *
 * ## ⚠️ 为什么一定要摘索引
 *
 * 索引的用途是回答"这条 URL 对应的本地副本在哪"。文件被删掉之后若还留着记录，
 * 渲染层会以为本地还有那份副本 → 换成 `app://` 地址 → 加载失败 → 走 error 兜底 →
 * **每次渲染都白试一次**（还每次都去请求一遍补齐）。摘掉之后判定会回到
 * "属于本存储、但本地没有副本"，于是下次看到这张图时**自动重新下载** ——
 * 这正是"删掉之后还能自己长回来"的机制。
 *
 * ## ⭐ 为什么删得干脆是可以的
 *
 * 那份文件**同时是用户附件目录里的一份可见文件**，所以论证要讲全 ——
 * 判据不是"文件在哪"，而是**"能不能重新拿到"**：
 *
 * 1. 对象**已经确认还在云端**（上面第 2 道复核，确认不上就不删）；
 * 2. 笔记里存的**始终是远端地址**（我们从没改写过它们）⇒ 副本消失不影响任何链接；
 * 3. 于是可恢复性由**重新下载**提供，而这份副本的行踪**不依赖回收站**。
 *
 * 而"为什么不走回收站"：这两条路径的用途都是"别让副本把磁盘吃光"，
 * 回收站**不解**这个问题 —— 文件离开了 vault、物理空间却还占着，
 * 于是表现成"清了下限/清了缓存，磁盘还是满的"。用户确认的整理（R17）走回收站，
 * 那是**另一条路**：它不需要立刻腾空间（见设计 §6.4）。
 */
export async function deleteVerifiedCopies(
	deps: MaintenanceDeps,
	victims: readonly RemovalVictim[],
	result: EvictionRunResult
): Promise<void> {
	const removedKeys: string[] = [];

	for (const victim of victims) {
		// 两道复核的完整理由见函数头（为什么不能只信清单、为什么必须问云端）
		const known = deps.index().findByCachePath(victim.cachePath);
		if (!known || known.key !== victim.key) {
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipUnknownCopy") });
			continue;
		}
		if (!deps.confirmRemote) {
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipUnconfirmed") });
			continue;
		}
		let stillInCloud = false;
		try {
			stillInCloud = (await deps.confirmRemote(victim.key)) === true;
		} catch (error) {
			result.skipped.push({ path: victim.cachePath, reason: describeError(error) });
			continue;
		}
		if (!stillInCloud) {
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipNotInCloud") });
			continue;
		}

		const file = deps.app.vault.getAbstractFileByPath(victim.cachePath);
		if (!file) {
			// 宿主的文件索引滞后于磁盘：**跳过**并如实汇报，绝不退化为底层删除
			result.skipped.push({ path: victim.cachePath, reason: deps.t("maintainSkipNotIndexed") });
			continue;
		}

		try {
			await removeCacheFile(deps.app, file);
			result.evicted += 1;
			result.freed += Math.max(0, victim.bytes);
			// 候选一律来自索引（孤儿那一类已随缓存目录取消），所以每个受害者都有一条记录要摘
			removedKeys.push(victim.key);
		} catch (error) {
			result.skipped.push({ path: victim.cachePath, reason: describeError(error) });
		}
	}

	if (removedKeys.length > 0) {
		const index = deps.index();
		for (const key of removedKeys) {
			if (index.remove(key)) result.unindexed += 1;
		}
		try {
			await deps.persistIndex();
		} catch (error) {
			// 摘记录失败不该让"文件已经淘汰"这件事看起来没发生 —— 但要留下话
			deps.notify(deps.t("maintainPersistFailed", { error: describeError(error) }));
		}
	}
}

/**
 * 按计划执行淘汰（缓存上限轮换的执行层）。
 *
 * 判定在 `eviction.ts`（纯函数），删除在 `deleteVerifiedCopies`（与存量清理共用）——
 * 这一层只负责把两者接起来。
 */
export async function runEviction(deps: MaintenanceDeps, plan: EvictionPlan): Promise<EvictionRunResult> {
	const result: EvictionRunResult = { evicted: 0, freed: 0, skipped: [], unindexed: 0 };
	await deleteVerifiedCopies(deps, plan.evict, result);
	return result;
}

/**
 * 执行**存量清理**（F18，设计 §4.4.3）：把用户在「不留副本」档下确认的那批副本删掉。
 *
 * ⚠️ 走的是**与自动淘汰同一份删除循环**（`deleteVerifiedCopies`）——
 * 两道复核（索引此刻仍认它 / 云端现在确实还有它）一个字都不改。
 * 这是刻意的：**候选的来源不同，不代表删之前要看的东西不同**，
 * 而"删错了"是不可逆的。区别只在 `eviction` 按 LRU + 超限字节挑人，
 * 这里按用户的勾选（或全量）挑人。
 *
 * 结果形状与淘汰相同（`EvictionRunResult`）：`evicted` = 真删了几个、
 * `freed` = 释放了多少字节、`skipped` = 为什么跳过（逐条原因）、`unindexed` = 摘了几条记录。
 */
export async function runReleaseSpace(
	deps: MaintenanceDeps,
	selection: ReleaseSpaceSelection
): Promise<EvictionRunResult> {
	const result: EvictionRunResult = { evicted: 0, freed: 0, skipped: [], unindexed: 0 };
	await deleteVerifiedCopies(deps, selection.candidates, result);
	return result;
}

export interface BatchResult {
	uploaded: number;
	reused: number;
	failed: number;
	/** 改了链接的笔记数（含画布 —— 它也是笔记的一种）。 */
	notesChanged: number;
	/** 改掉的链接处数（含画布里的两种节点）。 */
	linksRewritten: number;
	/**
	 * 画布里**解不开 JSON 字符串**、因而按原则④跳过没改的值个数。
	 *
	 * 单独给一个数字而不是并进 `failed`：它不是"没做成"，是"没敢动" ——
	 * 而用户需要知道某张图可能还指着旧位置（否则他会以为全改好了）。
	 */
	canvasSkipped: number;
	/**
	 * ⭐ 删掉的"宿主撞名另落的重复副本"份数（见 `dropRedundantCopies`）。
	 *
	 * 单独一个数字而不是并进 `uploaded`：用户要能对账 —— 他看到的可能是"清单里 10 个文件，
	 * 上传 10 个、却少了 1 个"。这一栏就是他少掉那个的去向。
	 */
	redundantRemoved: number;
	skipped: { reason: string; count: number }[];
}

export interface BatchOptions {
	/**
	 * 站外图候选 —— **必须只放已经拿到授权的那些**（授权发生在命令的确认框里）。
	 *
	 * ⚠️ 这一层**不自己判断授权**：`cacheExternal` 那条链在路上只复核"功能还开着吗 /
	 * 是不是本存储 / 主机被拦了吗"，它**不知道用户答没答过** —— 按需缓存那条路是
	 * "先问、问到了才调它"。所以调用方漏了授权，这里就会替用户答应下来。
	 */
	external?: ExternalSelection;
	/**
	 * 被笔记引用着的文件路径集合（见 `selectUploadCandidates` 的 `referencedPaths`）。
	 *
	 * ⚠️ 必须与调用方**给确认框用的那一份是同一个** —— 否则"清单里列了 3 个、
	 * 实际处理了 2 个"这种对不上账的情况就会出现，而用户是按清单授权的。
	 * 所以它由调用方算一次、传两次（确认框 + 这里）。
	 */
	referencedPaths: ReadonlySet<string>;
	/**
	 * 逐个候选**处理完**时上报（界面据此画进度）。
	 *
	 * ⚠️ 报的是**领域对象本身**（候选 / 路径），不是界面那一行的键 ——
	 * "哪一行"是界面的事（映射在 `plugin/*` 那一层做，见 `ui/external-picker-logic.ts::pickKey`）。
	 * 让这一层去算界面键，就得让 `maintenance/` 反过来认识 `ui/`，方向是错的。
	 *
	 * ⚠️ **只在"这一个候选真的被处理了"时上报**（成功 / 失败 / 跳过）。
	 * 改写与收尾两趟**不在这里报**（它们是全局的）：所以最后一件处理完时进度就满了，
	 * 而命令还在改写链接 —— 界面上那句"已结束"由**调用方**在返回之后才说
	 * （见 `ui/task-list-modal.ts` 的 `runFinished`）。
	 */
	onItem?: (
		event:
			| { kind: "external"; candidate: ExternalCandidate; status: "done" | "failed" }
			| { kind: "vault"; path: string; status: "done" | "skipped" | "failed" }
	) => void;
	/**
	 * 只处理这些库内路径（勾选的结果）。缺省 = 全部候选。
	 *
	 * ⚠️ 与"候选怎么挑"是两件事：候选仍由 `selectUploadCandidates` 决定
	 * （安全判据在那儿），这里只做**用户的取舍**。两者相乘 = 真正要上传的那些。
	 */
	onlyPaths?: ReadonlySet<string>;
}

/**
 * 批量上传：**被笔记引用着**的库内老附件（+ 笔记里的外链图），并把笔记里的链接换成远端链接。
 *
 * ## 两趟，各管一类候选
 *
 * 1. **站外图**（候选已获授权）→ 走 `deps.cacheExternal`，也就是「上传外部文件…」
 *    那条链（下载 → 上传 → 落本地副本 → 改写链接）。它自带同意复核，
 *    所以这里只负责按候选逐个跑、并把结果并进同一份统计。
 * 2. **库内文件** → 读字节 → `ingest`（带 `existingPath`，见下）→ 收集改写规则 →
 *    最后统一扫一遍笔记改链接。
 *
 * ⚠️ 站外那趟排在前面，是为了让第二趟的 `planLinkRewrites` 读到**最新**正文
 *（它要重新读每一篇笔记；顺序反过来的话，读到的是外链那趟改写之前的版本）。
 *
 * ## ⭐ 只管被引用的文件；上传成功后**什么都不搬**
 *
 * 命令的语义是"把已有的附件传上去、把笔记里的链接改指云端"，**不改变文件的位置**：
 *
 * 1. **候选只收被笔记引用着的文件**（`options.referencedPaths`，取自宿主的链接索引）。
 *    没有任何笔记引用的文件一概不碰 —— 那种文件多半是废弃的旧图，动了只会让人
 *    以为丢东西。
 * 2. 上传成功后，`ingest` 按 `localCopy` 处置那个文件：**唯一的保留形态就是原地留着**
 *    （`keep-in-place`，见 `planLocalCopy`）。1.2.0（D-17）取消了缓存目录 ——
 *    附件本身**就是**本地副本，于是"搬运 + 改名"这一步整个消失；只有 `trash` 档
 *    才动文件（进回收站）。
 *
 * ⚠️ 另一条配套性质：**不得在原处留下中转副本**。
 * 文件本来就在库里，若把 ingest 的"先落盘再上传"照搬过来，每个文件都会先被写成
 * 一个 `xxx 1.png`（原文件占着名字 ⇒ 另取序号）—— 那是"凭空多出来的文件"，
 * 上传失败时还会永久残留。所以这里必须把 `existingPath` 指出来，
 * 让编排层知道**字节已经在库里**（见 `IngestRequest`）。
 */
export async function runBatchUpload(deps: MaintenanceDeps, options: BatchOptions): Promise<BatchResult> {
	const settings = deps.settings();
	const result: BatchResult = {
		uploaded: 0,
		reused: 0,
		failed: 0,
		notesChanged: 0,
		linksRewritten: 0,
		canvasSkipped: 0,
		redundantRemoved: 0,
		skipped: [],
	};

	/**
	 * "宿主撞名另落的重复副本"：路径 → 留下来那一份（主干）的路径。
	 *
	 * 收尾时按 `dropRedundantCopies` 的条件删掉这些路径（链接改写成功 + 改写之后没人指着它）。
	 */
	const redundantCopies: { path: string; twinPath: string }[] = [];

	/**
	 * ⭐ **改写之后**正文里仍有链接指向的那些候选（判据是**当场读到的正文**，见 `stillMentionsPath`）。
	 *
	 * 填它的地方就是两趟改写循环本身 —— 那里正文已经在手上，不必再扫一遍库；
	 * 而"有没有人还指着它"正是删它之前的最后一道复核。
	 */
	const stillMentioned = new Set<string>();

	/** 这一份正文（笔记或画布，**改写之后**的）里还有指向候选的链接吗。 */
	const noteMentions = (text: string, forCanvas: boolean): void => {
		if (redundantCopies.length === 0) return;
		for (const candidate of redundantCopies) {
			if (stillMentioned.has(candidate.path)) continue;
			const mentions = forCanvas ? canvasStillMentionsPath(text, candidate.path) : stillMentionsPath(text, candidate.path);
			if (mentions) stillMentioned.add(candidate.path);
		}
	};

	/**
	 * 被这次命令改过链接的笔记（**去重**）。
	 *
	 * ⚠️ 两条路径都可能改同一篇笔记（一篇笔记里既有本地老图、又有外链图），
	 * 各数各的会把"改了 3 篇"报成"改了 5 篇" —— 用户没法用它核对。
	 */
	const changedNotes = new Set<string>();

	// ── 1. 站外图（候选已获授权；只处理，不再判断该不该问）──
	//
	// ⚠️ 放在库内文件之前：改写过的笔记随后会被本地那一趟重新读一遍，
	// 于是 `planLinkRewrites` 拿到的一定是最新正文（顺序反过来就先改后读，读到旧的）。
	if (options.external && options.external.candidates.length > 0 && deps.cacheExternal) {
		for (const candidate of options.external.candidates) {
			let outcome: ExternalCacheOutcome;
			try {
				outcome = await deps.cacheExternal(candidate.url, candidate.notePath);
			} catch {
				// 一张图出事不该让整条命令停在这里
				result.failed += 1;
				options.onItem?.({ kind: "external", candidate, status: "failed" });
				continue;
			}

			if (outcome.status === "cached") {
				result.uploaded += 1;
				result.linksRewritten += 1;
				changedNotes.add(candidate.notePath);
				options.onItem?.({ kind: "external", candidate, status: "done" });
			} else if (outcome.status === "cached-no-rewrite") {
				// 图进了存储，但笔记里的链接没改成 —— **算未完成**：
				// 命令的承诺是"上传并改写"，只做了一半就报成功，用户会以为搬完了，
				// 而笔记里那串地址还指着别人的服务器。（重跑一次会补上。）
				result.failed += 1;
				options.onItem?.({ kind: "external", candidate, status: "failed" });
			} else {
				result.failed += 1;
				options.onItem?.({ kind: "external", candidate, status: "failed" });
			}
		}
	}

	// 只取判定需要的字段，转成结构化对象 —— 免得在 TFile 上做类型谓词（那会与宿主类型耦合）
	const files: VaultFileLike[] = deps.app.vault.getFiles().map((file) => ({
		path: file.path,
		extension: file.extension,
		stat: { size: file.stat?.size ?? 0 },
	}));

	const selection = selectUploadCandidates(files, {
		settings,
		index: deps.index(),
		referencedPaths: options.referencedPaths,
	});
	// ⭐ 用户**勾掉**的那些不进这一趟：候选（安全判据）与取舍（勾选）是两件事。
	// 判据用的是 `selection.paths` 的顺序 —— 界面上的清单也是这个顺序，于是
	// "第几行"在两处一致。
	const chosenPaths = options.onlyPaths
		? selection.paths.filter((path) => options.onlyPaths?.has(path))
		: selection.paths;
	// 两条路径的"为什么跳过"汇总到一起（形状相同，都是给人看的诊断）
	result.skipped = [...selection.skipped, ...(options.external?.skipped ?? [])];

	// 路径 → 远端 URL，用于随后改写笔记（`text` 节点与 Markdown 共用）
	const rules: RewriteRule[] = [];

	/**
	 * 路径 → **改写后的路径**：只给画布的 `file` 节点用。
	 *
	 * ⚠️ 为什么不能拿上面那份 `rules` 顶上：那份的目标是远端 URL，
	 * 而画布 `file` 字段**只能指向库内文件** —— 写成 URL 之后画布就找不到文件了
	 * （宿主按库内路径取文件渲染）。
	 *
	 * ⚠️ 1.2.0（D-17）：文件**原地不动**（上传不再搬进任何缓存目录），所以这里
	 * 事实上总是"旧路径 → 同一个路径"—— 保留这条规则是为了**与索引里记的落点对齐**
	 * （副本缺失时由回退下载按同一个 `attachmentFolderFor` 规则补回，见 `render/render-hook.ts`）。
	 */
	const fileRules: RewriteRule[] = [];

	for (const path of chosenPaths) {
		/** 这一份没成 ⇒ 计数 + 让界面那一行变红（两件事必须成对，见 `BatchOptions.onItem`）。 */
		const failed = (): void => {
			result.failed += 1;
			options.onItem?.({ kind: "vault", path, status: "failed" });
		};
		const file = deps.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			failed();
			continue;
		}

		let bytes: ArrayBuffer;
		try {
			bytes = await deps.app.vault.readBinary(file);
		} catch {
			failed();
			continue;
		}

		let ingestResult: IngestResult;
		try {
			ingestResult = await deps.ingest({
				bytes: new Uint8Array(bytes),
				name: file.name,
				sourcePath: path,
				// ⭐ 明确指出"字节已经在这个文件里"。没有它，编排层会走"先落盘"那条路，
				// 于是附件目录里会凭空多出一个 `xxx 1.png`（原文件占着名字 ⇒ 另取序号），
				// 上传后再把它搬进缓存 —— 而原文件仍在。结果是：用户传了 N 张老图，
				// 附件目录里就多出 N 个中转文件（搬移失败时永久残留），
				// 而他要的只是"把这些图传上去"。
				existingPath: path,
				// ⭐ 只在这一条路上预检（见 `IngestRequest.preflight`）：批量要处理的
				// 正是"历史上传过、这台设备答不上来"的那一批，一次 HEAD 能省整份字节。
				preflight: true,
			});
		} catch {
			failed();
			continue;
		}

		if (!ingestResult.remoteUrl) {
			failed();
			continue;
		}
		if (ingestResult.status === "reused") result.reused += 1;
		else result.uploaded += 1;
		options.onItem?.({ kind: "vault", path, status: "done" });

		rules.push({ from: path, to: ingestResult.remoteUrl, display: ingestResult.displayName });

		// ⚠️⚠️ **移动会让宿主自己顺手改笔记**（2026-10-09 真机实测）：
		// `fileManager.renameFile` 不只是改名，它还会把**别的笔记里指向这个文件的链接**
		// 一起更新成新位置/新名字 —— 形式取决于用户的「新链接格式」设置，默认是
		// 「尽可能短」⇒ `![[<hash>.png]]`、`![x](<hash>.png)`。
		// 于是它跟我们**下面那一趟改写抢时间**：宿主先改完，我们按**老路径**去匹配就
		// 一处都找不到 ⇒ 笔记里留下的是**本地副本**的链接（本机看着没事，换台设备
		// 就看不到图，而且笔记不再指向存储 —— 这条命令的承诺没兑现）。
		// ⇒ 把"搬完之后的新路径"也当成一条改写规则：谁先谁后都会收敛到远端地址。
		if (ingestResult.localPath && ingestResult.localPath !== path) {
			rules.push({ from: ingestResult.localPath, to: ingestResult.remoteUrl, display: ingestResult.displayName });
		}

		// 画布 file 节点：旧路径 → 搬移后的真实位置（拿不到真实位置时不登记 ——
		// 那样画布保持原样，是本设备仍然能显示的那一侧）。
		//
		// ⚠️ **宿主撞名另落的那一份例外**：它稍后会被删掉（见 `dropRedundantCopies`），
		// 所以画布必须改指向**留下来的主干那一份**（内容逐字节相同）——
		// 否则画布上会留下一个指向已被删除文件的节点（用户看到的就是"画布上这张图没了"）。
		// 两个 rule 只登记**一条**：同一个 `from` 上挂两条互相矛盾的规则，谁生效取决于顺序。
		if (ingestResult.localPath) {
			fileRules.push({
				from: path,
				to: ingestResult.redundantDuplicateOf ?? ingestResult.localPath,
			});
		}

		if (ingestResult.redundantDuplicateOf) {
			redundantCopies.push({ path, twinPath: ingestResult.redundantDuplicateOf });
		}
	}

	// 没有库内候选时**也要**走完赋值：站外那一趟可能已经改过笔记了
	if (rules.length === 0) {
		result.notesChanged = changedNotes.size;
		return result;
	}

	// ── 改写画布里的引用（F13，需求 R16）──
	//
	// ⚠️ 画布**不是** `getMarkdownFiles()` 的一部分（它是 `.canvas`），
	// 所以必须单独扫一遍 —— 漏了这一步，画布引用会被上面那条"被引用"判据
	// 选进候选、文件被搬走，而画布里的路径原地不动 ⇒ 画布上的图直接没了。
	for (const canvas of deps.app.vault.getFiles()) {
		if (canvas.extension !== "canvas") continue;
		let text: string;
		try {
			text = await deps.app.vault.read(canvas);
		} catch {
			// 读失败必须跳过（`vault.modify` 是整文件覆盖，用空串写回去会毁掉画布）
			continue;
		}
		if (text === "") continue;

		const rewritten = planCanvasRewrites(text, { linkRules: rules, fileRules });
		result.canvasSkipped += rewritten.skipped;
		// ⭐ 删重复副本之前的复核要用**改写之后**的正文：改写没认出来的形态会原样留下，
		// 那才是"它还指着这一份"（见 `canvasStillMentionsPath`）。
		noteMentions(rewritten.count > 0 ? rewritten.text : text, true);
		if (rewritten.count === 0) continue;

		try {
			await deps.app.vault.modify(canvas, rewritten.text);
			changedNotes.add(canvas.path);
			result.linksRewritten += rewritten.count;
		} catch {
			result.failed += 1;
		}
	}

	// ── 改写笔记里指向这些文件的链接 ──
	for (const note of deps.app.vault.getMarkdownFiles()) {
		let text: string;
		try {
			text = await deps.app.vault.read(note);
		} catch {
			// ⚠️ 读失败**必须跳过**：`vault.modify` 是整文件覆盖，
			// 用空串写回去等于把用户的笔记清空。
			continue;
		}
		if (text === "") continue;

		const rewritten = planLinkRewrites(text, rules);
		// ⭐ 同上：复核用的是**改写之后**的正文（没认出来的形态会原样留下）
		noteMentions(rewritten.count > 0 ? rewritten.text : text, false);
		if (rewritten.count === 0) continue;

		try {
			await deps.app.vault.modify(note, rewritten.text);
			changedNotes.add(note.path);
			result.linksRewritten += rewritten.count;
		} catch {
			result.failed += 1;
		}
	}

	result.notesChanged = changedNotes.size;

	// ── 收尾：删掉"宿主撞名另落的重复副本"（在**改写全部做完之后**）──
	//
	// ⚠️ 顺序是这个功能的正确性条件：删文件**必须**排在链接改写之后 ——
	// 反过来会先留出一条指向刚被删掉文件的链接（用户视角就是"图丢了"）。
	await dropRedundantCopies(deps, redundantCopies, stillMentioned, result);

	return result;
}

/**
 * 删掉"宿主撞名另落的重复副本"（用户 2026-10-14 的要求：**链接 ok 以后就可以删掉**，
 * 而且**不用放回收站**）。
 *
 * ## 这是个什么东西
 *
 * 同一张图插第二次时，**宿主自己**会把新文件叫 `照片 1.png`（它的唯一化规矩，我们拦不住），
 * 并写一条指向它的链接。于是磁盘上留下两份逐字节相同的文件，而我们刚把链接改写成
 * **同一个云端地址**（见 `IngestResult.redundantDuplicateOf`）—— 那一份重复文件此后
 * 没有任何笔记引用它，只是占着磁盘（而且插件看不见它：它没进索引）。
 *
 * ## 为什么可以删
 *
 * ① **上传成功了** —— 那份字节已经在云端，删本地副本不会丢内容（与「不留副本」档同一条理由，
 *    而这里连"重新拿到"都是确定的：同一个对象，别的引用也指着它）；
 * ② **"还有没有人指着它"由 `stillMentioned` 说话** —— 那个集合来自**改写时当场读到的正文**
 *    （见 `stillMentionsPath`），不是宿主的链接索引（索引滞后于刚写下的笔记，用它当判据
 *    会变成"永远删不掉"，验收套件当场抓到过）；
 * ③ **主干那一份还在**（否则这一份就是最后一份，删了本地就没副本可看了）。
 *
 * ## 为什么**直接删**、不进回收站
 *
 * ⚠️ 这是本项目的**有意偏离**（与 D-21 的 ①③ 同类：②⑤ 与社区一致走回收站）。
 * 用户 2026-10-14 明确要求"不用放回收站"：这一份与仍在原地的那一份**逐字节相同**，
 * 进回收站 = 把同样的垃圾从附件目录挪到回收站，用户还得自己去清一次。
 * 删除动作走 `removeCacheFile`（与淘汰、存量清理**同一处**删除原语），
 * 不是绕开宿主自己删。
 */
async function dropRedundantCopies(
	deps: MaintenanceDeps,
	candidates: readonly { path: string; twinPath: string }[],
	stillMentioned: ReadonlySet<string>,
	result: BatchResult
): Promise<void> {
	if (candidates.length === 0) return;

	/** 按原因汇总（逐个 push 会让 `skipped` 变成一长串同义条目）。 */
	const skipped = new Map<string, number>();
	const countSkip = (reason: string): void => {
		skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
	};

	if (result.failed > 0 || result.canvasSkipped > 0) {
		// ⚠️ 这一趟**有改写没落地**（笔记/画布写失败，或画布里解不开的值被跳过）。
		//
		// 那时"谁还指着它"问不出完整答案：画布 `file` 节点走的是另一条路（`fileRules`），
		// 它没改写成功时那个节点仍指着这一份，而正文里也看不出来（那个值解不开）。
		//
		// 判据刻意粗：**一处失败就一个都不删**。方向由代价不对称决定 ——
		// 少删一份只是多占一点磁盘（下次运行还会再来一次），错删一份是用户的东西不见了。
		countSkip(`这一趟有引用没能改写（写入失败 ${result.failed}、画布值跳过 ${result.canvasSkipped}）`);
		for (const [reason, count] of skipped) result.skipped.push({ reason, count });
		return;
	}

	for (const { path, twinPath } of candidates) {
		if (stillMentioned.has(path)) {
			countSkip("改写之后正文里仍有链接指着它");
			continue;
		}
		// ⚠️ 变量名刻意与淘汰循环里那个不同（`duplicate` 而不是 `file`）：
		// 两处的删除调用**逐字相同**会让变异锚点无法唯一指向这一处
		//（锚点必须唯一，否则它打坏的是别人那一行）。
		const duplicate = deps.app.vault.getAbstractFileByPath(path);
		// 已经不在了（用户自己删了、或同步把它撤了）⇒ 没什么可做，也不算跳过
		if (!duplicate) continue;
		if (!deps.app.vault.getAbstractFileByPath(twinPath)) {
			countSkip("留下来的那一份不在了");
			continue;
		}
		try {
			await removeCacheFile(deps.app, duplicate);
			result.redundantRemoved += 1;
			// 索引若还指着这一份（老版本登记过的条目），顺手摘掉 ——
			// 否则它会一直"指向一个不存在的文件"，等自愈那一轮才被清理。
			// ⚠️ **只摘条目、不动上传台账**：对象还在云端（见 `forgetUploaded` 的说明）。
			const stale = deps.index().findByCachePath(path);
			if (stale && deps.index().remove(stale.key)) {
				await deps.persistIndex();
			}
		} catch (error) {
			countSkip(`删除失败（${describeError(error)}）`);
		}
	}

	for (const [reason, count] of skipped) result.skipped.push({ reason, count });
}

