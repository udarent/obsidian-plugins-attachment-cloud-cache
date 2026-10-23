/**
 * 「从宿主读事实」的那一组**只读**查询。
 *
 * ## 为什么单独一个模块
 *
 * 这七个函数原本是 `main.ts` 里的私有方法，彼此**零依赖**、只吃 `app` 与 `settings`。
 * 搬出来的收益不是"省几十行"，而是把「读宿主」变成**可单独推理的落点**：
 * 拆 `main.ts` 的每一批都得重新确认"这些读法还认不认得宿主"，而它们其实与编排无关。
 *
 * ## 依赖方向（硬约束）
 *
 * `main.ts → plugin/* → 领域模块`。本模块**只许** import 领域模块
 * （`maintenance/*`、`s3/*`、`render/*`、`../types`）与 `obsidian`，
 * **不许** import `main.ts` 或任何其它 `plugin/*`。
 *
 * ## ⚠️ 两处刻意的错误默认值，方向相反，**不能合并**
 *
 * - 这里的 `vaultPathExists` 出错 ⇒ 返回 **`true`**（"在"）：它的 `false` 意思是
 *   "记录失效了，摘掉它" —— **不安全方向**（那张图的离线可用性被悄悄拿掉）。
 * - `core/download.ts` 的 `exists` 出错 ⇒ 返回 **`false`**（"不在"）：它的 `false`
 *   意思是"没有副本，去下载" —— **安全方向**（多下一次而已）。
 *
 * ⇒ 合并必然把其中一边弄反，而**两种弄反都不报错**。两条判据分别由
 * `self-heal-suite` 与 `download-suite` 各自钉住。
 */

import type { App } from "obsidian";
import { TFile } from "obsidian";
import { debugTimed } from "../debug-log";
import type { NoteTextLike } from "../maintenance/batch";
import {
	canvasTextTargets,
	findLinkSpans,
	hasScheme,
	referencedPathsFrom,
	resolveVaultTargets,
} from "../maintenance/references";
import { keyFromUrl } from "../render/render-target";
import { publicUrlFor } from "../s3/client";
import type { PluginSettings } from "../types";

/** 本存储 URL → key（判定层的推导，维护功能复用同一套）。 */
export function keyOfUrl(settings: PluginSettings, url: string): string | null {
	return keyFromUrl(url, settings.s3);
}

/**
 * key → 它在存储里的地址（`keyOfUrl` 的逆运算）。
 *
 * 只用于**确认框里的缩略图**：清单上只有一串 sha256 时，用户没法核对
 * "这到底是不是我要删的那张图"。推不出来（端点没配好 / key 形状不对）就返回 `null`
 * —— 宁可那一行没有图，也不给一个半截地址（那会让用户以为自己看到的就是存储里的东西）。
 */
export function remoteUrlForKey(settings: PluginSettings, key: string): string | null {
	try {
		return publicUrlFor(settings.s3, key);
	} catch (error) {
		console.error("[attachment-cloud-cache] 推导对象地址失败，该行不给缩略图", error);
		return null;
	}
}

/**
 * 一个 vault 相对路径**确实存在**吗（自愈判"记录是否失效"的唯一依据）。
 *
 * ## ⚠️ 这里的错误默认值，与 `core/download.ts` 的 `exists` **相反**
 *
 * 两处的 `false` 含义完全不同：
 * - 那边 `false` ⇒ "没有副本，去下载" —— **安全方向**（多下一次而已），所以查询出错返回 `false`；
 * - 这边 `false` ⇒ "记录失效了，摘掉它" —— **不安全方向**（那张图的离线可用性被悄悄拿掉），
 *   所以查询出错返回 `true`（宁可多留一条记录）。
 *
 * ⇒ **两处不能合并**：合并必然把其中一边的方向弄反，而两种弄反都不报错。
 * 这条判据由 `self-heal-suite` 与 `download-suite` 各自钉住。
 *
 * ## 为什么"两条路"都要问
 *
 * 宿主的文件索引是**内存快照**（快，但可能滞后于磁盘：刚同步进来的文件它还没收录）；
 * 适配器直接问文件系统（准，但慢）。任一条说"在"就算在 —— 只有两条都说不在才认失效。
 */
export async function vaultPathExists(app: App, path: string): Promise<boolean> {
	if (app.vault.getAbstractFileByPath(path)) return true;
	try {
		if (await app.vault.adapter.exists(path)) return true;
	} catch (error) {
		// ⚠️ 查询出错按"存在"处理（见上面那段：误摘的代价不对称）
		console.error("[attachment-cloud-cache] 查询本地副本是否存在失败", error);
		return true;
	}
	return false;
}

/** 抽成方法是为了让测试能替换掉它（真弹窗点不了）。 */
export async function readActiveNoteText(app: App): Promise<NoteTextLike[]> {
	const file = app.workspace.getActiveFile();
	if (!file) return [];
	try {
		return [{ path: file.path, text: await app.vault.read(file) }];
	} catch {
		return [];
	}
}

/**
 * 读一遍全库笔记的正文（外链扫描要用）。
 *
 * 单篇读不到就跳过：这条命令要处理的是**其它**东西，
 * 不该因为一篇笔记读不了而整条失败（用户只会看到"什么都没发生"）。
 */
export async function readAllNoteTexts(app: App): Promise<NoteTextLike[]> {
	const notes: NoteTextLike[] = [];
	for (const note of app.vault.getMarkdownFiles()) {
		try {
			notes.push({ path: note.path, text: await app.vault.read(note) });
		} catch {
			// 跳过这一篇
		}
	}
	return notes;
}

/**
 * 一次扫描给出的两份答案（见 {@link referenceSnapshot}）。
 *
 * ⚠️ 两份**刻意不一样**，而且方向相反，理由见 `rewritable` 的说明 ——
 * 合并成一份会让「能不能安全删」与「能不能靠改写修好」互相污染。
 */
export interface ReferenceSnapshot {
	/**
	 * 被笔记或画布**指向**的库内文件路径 —— 回答「还有没有人指着它」。
	 * 来源：宿主的链接索引 ＋ 我们自己解析的正文（下面那一段解释为什么两路都要）。
	 */
	referenced: ReadonlySet<string>;
	/**
	 * 其中**我们能自己改写**的那一部分（笔记正文里的链接 ＋ 画布**文本节点**里的链接）。
	 *
	 * ⭐ 用途只有一个：判断一条链接**是不是还没改到云端**（于是「上传附件」可以重修）。
	 * - 它**不含**宿主的链接索引：索引只说"有人指着这个文件"，不说"以什么写法指着"；
	 *   而我们能修的只有自己认得的那些写法。
	 * - 它**不含**画布的 `file` 节点：那类节点**只能**指向库内文件（宿主限制），
	 *   永远不会被改成 URL ⇒ 把它们算进来会让每一个摆在画布上的附件都成了"待修"
	 *   （每次运行都把它们列一遍、还要读一遍字节，而它们根本改不了）。
	 */
	rewritable: ReadonlySet<string>;
}

/**
 * 有一篇笔记读不到 —— **调用方必须放弃这次判定并如实说出来**。
 *
 * ⚠️ 与 `readAllNoteTexts`（读不到就跳过）**方向相反**，而且必须相反：那条路的调用方
 * 问的是"要不要处理这个文件"（漏一篇只是少处理几个）；而 {@link locallyReferencedPaths}
 * 的调用方问的是"要不要**删掉**这个东西"（漏一篇就可能删掉正文还在用的对象）。
 * 把"不知道"当成"没有引用"是这里唯一不可接受的方向。
 */
export class UnreadableNoteError extends Error {
	constructor(readonly path: string) {
		super(`读不到笔记：${path}`);
		this.name = "UnreadableNoteError";
	}
}

/**
 * 正文里**直接指着**的库内路径（本地链接 / 画布 `file` 与文本节点）—— 严格口径。
 *
 * ## ⭐ 这个函数存在，是因为四条命令对同一件事答得不一样（2026-10-22 审计）
 *
 * 「这份附件还有人在用吗」有两种写法：**迁移前是本地路径**、**迁移后是远端 URL**。
 * 而 `check-orphans` 当年只查了 URL 那一半（`keysInText`），于是"链接改写失败/被改回本地"
 * 的那些对象会被判成孤儿 —— 一模一样的理由它自己在 `isExternal` 里写着
 *（见 `orphan-watch.ts::dropLocallyReferenced`），只是库内那半边漏了。
 * ⇒ 现在"谁被本地链接指着"只有 {@link referenceSnapshot} 一处实现，这个函数是它的
 * **严格版出口**：读不到一篇就抛，让调用方放弃这次判定。
 */
/**
 * 一次**严格口径**的全库阅读，同时交出正文与「本地引用集合」（D-81）。
 *
 * ## 为什么要把“读”与“算”拆开
 *
 * 清理命令需要**两份**答案：本地引用集合（它自己要用）、远端 key 集合（判「还有人用吗」）。
 * 两件事的原料都是**同一批正文** —— 从前各自读一遍，几千篇笔记的库上就是秒级 × 2。
 * ⇒ 读一遍、把正文交出去，谁要算什么自己拿。
 *
 * ⚠️ **严格度不变**：读不到一篇就抛 `UnreadableNoteError`。宽松那个口径（跳过）属于另一条链
 *（`readAllNoteTexts`），两者不能合并 —— “不知道”不能当成“没有引用”。
 */
export async function localReferencePass(
	app: App,
	options: { debug?: boolean } = {}
): Promise<{ notes: NoteTextLike[]; referenced: ReadonlySet<string> }> {
	// ⚠️ 读不到就**抛**（不是跳过）：调用方要删东西，漏一篇就可能删掉仍在用的对象
	const notes: NoteTextLike[] = [];
	for (const note of app.vault.getMarkdownFiles()) {
		try {
			notes.push({ path: note.path, text: await app.vault.read(note) });
		} catch {
			throw new UnreadableNoteError(note.path);
		}
	}
	const snapshot = await referenceSnapshot(app, { notes, strict: true, debug: options.debug === true });
	return { notes, referenced: snapshot.referenced };
}

/**
 * 正文里**直接指着**的库内路径（严格口径）—— {@link localReferencePass} 的一半。
 *
 * ⚠️ 它与同名的“一次扫描两份答案”共用同一份实现（上面那个函数）：两处各写一遍读库循环，
 * 迟早一边严一边松。
 */
export async function locallyReferencedPaths(app: App, options: { debug?: boolean } = {}): Promise<ReadonlySet<string>> {
	return (await localReferencePass(app, options)).referenced;
}

/**
 * 一段笔记正文里的**本地**链接目标（两个视角：认 / 能改）。
 *
 * ## ⚠️ 为什么单独一个函数
 *
 * 「什么算引用」只能有一份判据。全库快照（{@link referenceSnapshot}）与单篇视角
 * （{@link referencesInNote}）都要它 —— 两处各写一遍的话，迟早一边把代码块算进来、
 * 另一边不算（D-62 修的正是这种"一处硬一处软"），而两侧都不会报错。
 *
 * ⭐ 带 scheme 的目标（`https://…` / `file:///D:/…`）**不在这里**：它们归站外缓存 / 本机文件
 * 那条链（`batch.ts::selectExternalUploadCandidates`）。按短名去比会把"云端地址里的文件名"
 * 错认成"某份本地副本还被人指着" —— 判据是"它是不是本地链接"，不是"它看起来像哪个文件"。
 */
export function localTargetsIn(text: string): { targets: string[]; rewritableTargets: string[] } {
	/** 全部本地引用（含**不可改写**的属性区）。⚠️ 代码块/注释里的那些**不在内**（D-62）。 */
	const targets: string[] = [];
	/** 其中**真能改写**的那些 —— 「重修」只能落在这个集合上。 */
	const rewritableTargets: string[] = [];
	for (const span of findLinkSpans(text)) {
		if (hasScheme(span.raw)) continue;
		targets.push(span.raw);
		// ⚠️⚠️ **属性区里的不算"可修"**（2026-10-22，D-61）：改写器**刻意不碰**它
		// （改属性值会写坏结构化数据；只换路径那段又会得到死链）。
		// 若把它算进来，那个文件会在「上传附件」里**每次**都列为待修、每次改 0 处
		// —— D-57 的重修路径把"可修"用成了"改得掉"，两者必须是同一个集合。
		// ⚠️ 但它**照旧算"被引用"**（`targets`）：属性链接是宿主真的在用的东西
		//（`frontmatterLinks` 里有它）。
		// ⚠️ 代码块 / 行内代码 / `%%注释%%` 里的目标在这一层**已经不存在**了
		// （`findLinkSpans` 不产出，D-62）—— 它们既不算引用，也不算可修。
		if (!span.inFrontmatter) rewritableTargets.push(span.raw);
	}
	return { targets, rewritableTargets };
}

/**
 * **一篇笔记**直接指向的库内路径 —— 全库快照的「单篇视角」。
 *
 * ## 为什么需要它（2026-10-22，用户要求「只看当前笔记」）
 *
 * 「上传附件」的清单可以只看当前这篇笔记引用了哪些附件（勾选项）。而"这篇笔记引用了什么"
 * 必须与全库快照**同一个口径** —— 否则清单里会冒出全库有、当前笔记其实没有的行
 * （或者反过来，漏掉它真的引用了的行）。所以两份答案都从 {@link localTargetsIn} 出。
 *
 * ⚠️ `vaultPaths` 由调用方递进来（**别在这里再枚举一遍库**）：调用方通常已经有一份，
 * 而这里只做解析，不做 I/O。
 */
export function referencesInNote(
	text: string,
	vaultPaths: readonly string[]
): { referenced: ReadonlySet<string>; rewritable: ReadonlySet<string> } {
	const local = localTargetsIn(text);
	return {
		referenced: resolveVaultTargets(local.targets, vaultPaths),
		rewritable: resolveVaultTargets(local.rewritableTargets, vaultPaths),
	};
}

/**
 * 扫一遍库里的引用，同时给出 {@link ReferenceSnapshot} 的两份答案（**一次 I/O**）。
 *
 * ⚠️ 两个消费者（「上传附件」的候选清单与它内部那一趟执行）必须看到同一份快照，
 * 否则"按清单授权、按另一份执行"。所以这里只扫一次、两份都从这里出。
 */
export async function referenceSnapshot(
	app: App,
	options: { notes?: readonly NoteTextLike[]; strict?: boolean; debug?: boolean } = {}
): Promise<ReferenceSnapshot> {
	const startedAt = Date.now();
	const debug = options.debug === true;
	const vaultPaths = app.vault.getFiles().map((file) => file.path);
	const referenced = new Set(referencedPathsFrom(app.metadataCache?.resolvedLinks));

	// ⭐⭐ 2026-10-15（D-32）：**再加一路 —— 我们自己解析笔记正文**。
	//
	// 宿主的 `resolvedLinks` 有盲区，而每一处盲区的后果都一样（**那份文件被判成"没人引用"**，
	// 于是命令不处理它、引用快照也说没人用）：
	// - **属性区**（`cover: "[[x.png]]"`）：那类链接记在 `frontmatterLinks` 里，不算进 `resolvedLinks`；
	// - **行内 HTML**（`<img src="x.png">`）：宿主收不收没有保证（画布那条已经吃过同一个亏）；
	// - **引用式链接**（`![alt][ref]` + `[ref]: x.png`）。
	//
	// ⚠️ 这一路与删除前的复核（`references.ts::stillMentionsPath`）走**同一套解析** ——
	// 分类层与守卫同口径，才不会出现"报告说没人用、真删又被拦下"（D-31 的教训）。
	const notes = options.notes ?? (await readAllNoteTexts(app));
	const rewritable = new Set<string>();
	/** 全部本地引用（含**不可改写**的属性区）—— 一次解析，`targets` / `rewritableTargets` 分开记账。 */
	const targets: string[] = [];
	const rewritableTargets: string[] = [];
	for (const note of notes) {
		// ⚠️ 「什么算引用」只有一份（`localTargetsIn`）—— 单篇视角走的是同一个函数，
		// 于是「只看当前笔记」那份清单不会与全库这份说出两种话。
		const local = localTargetsIn(note.text);
		targets.push(...local.targets);
		rewritableTargets.push(...local.rewritableTargets);
	}
	for (const path of resolveVaultTargets(targets, vaultPaths)) referenced.add(path);
	for (const path of resolveVaultTargets(rewritableTargets, vaultPaths)) rewritable.add(path);

	let canvasCount = 0;
	for (const file of app.vault.getFiles()) {
		if (file.extension !== "canvas") continue;
		canvasCount += 1;
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			// ⚠️ 严格口径下**抛**（同上：这一侧的调用方要删东西）；
			// 宽松口径下跳过 —— 那时多一份候选只会多一点工作。
			if (options.strict) throw new UnreadableNoteError(file.path);
			continue;
		}
		const canvasTargets = canvasTextTargets(text).filter((raw) => !hasScheme(raw));
		// ⚠️ 解析**只做一次**、两份答案共用（原来这里调了两遍同一个函数 ——
		// 同一个 `from` 算两遍，改判据时只会改到一处）。
		const canvasPaths = resolveVaultTargets(canvasTargets, vaultPaths);
		// 画布**文本节点**里的链接与笔记同规则（`planCanvasRewrites` 的 linkRules）⇒ 可修。
		// ⚠️ 画布文本里也可能有属性区（画布节点没有 frontmatter）—— 所以这一侧的可修
		// 与引用是同一个集合；代码块那些已经由 `findLinkSpans` 剔除（D-62）。
		// ⚠️ `canvasTextTargets` 只取**文本节点**：画布的 `file` 节点只指向库内文件、
		// 永远不会被改成 URL，算进"可修"会让每个摆在画布上的附件每轮都被列一遍
		//（见 `ReferenceSnapshot.rewritable`）。
		for (const path of canvasPaths) {
			referenced.add(path);
			rewritable.add(path);
		}
	}
	// ⭐ 排障出口（D-67）：**一处**说清这次扫描各段的数目。
	// ⚠️ 只读已有变量，不为日志多扫一遍库；`targets` 与 `rewritableTargets` 的差
	// 就是「属性区那种认但不改」的量 —— 这两条数不一致时，先看这里。
	debugTimed(debug, "引用快照", startedAt, {
		笔记: notes.length,
		画布: canvasCount,
		目标: targets.length,
		可改写目标: rewritableTargets.length,
		引用路径: referenced.size,
		可改写路径: rewritable.size,
	});
	return { referenced, rewritable };
}

/**
 * **被引用着**的文件路径集合（宿主的链接索引 + 我们自己扫的正文 + 画布文本）。
 *
 * 这一条服务于"哪些文件不能动"：引用会被相应地改写，而没有任何引用的文件一概不碰。
 * ⚠️ 与 {@link referenceSnapshot} 是同一份判据的两种取法（那边一次给两份答案）。
 */
export async function referencedVaultPaths(
	app: App,
	options: { notes?: readonly NoteTextLike[]; debug?: boolean } = {}
): Promise<ReadonlySet<string>> {
	return (await referenceSnapshot(app, options)).referenced;
}

/**
 * vault 相对路径 → 能直接放进 `img[src]` 的地址。
 *
 * ⚠️ 用 `Vault.getResourcePath(file)`（要 `TFile`）而**不是**
 * `adapter.getResourcePath(path)`：后者只声明在 `FileSystemAdapter`
 * （桌面）与 `CapacitorAdapter`（移动）上，基类 `DataAdapter` **没有**这一项 ——
 * 用它在移动端会直接抛错。本项目"不做平台假设"的纪律就是这个意思。
 *
 * 拿不到文件（不在宿主索引里、或路径不对）时返回 `null`：调用方据此**保持原样**，
 * 而不是写一个坏地址进去（那会让在线用户也看不到图）。
 */
export function resourceUrlFor(app: App, vaultPath: string): string | null {
	try {
		const file = app.vault.getAbstractFileByPath(vaultPath);
		if (file instanceof TFile) return app.vault.getResourcePath(file);
	} catch (error) {
		// 宿主实现差异不该让整篇笔记渲染失败
		console.error("[attachment-cloud-cache] 取本地资源地址失败", error);
	}
	return null;
}
