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
import type { NoteTextLike } from "../maintenance/batch";
import { referencedPathsFrom, resolveCanvasTargets } from "../maintenance/batch";
import { canvasTextTargets } from "../maintenance/references";
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
 * **被引用着**的文件路径集合（宿主的链接索引 + 我们自己扫的画布文本）。
 *
 * 这一条服务于"哪些文件不能动"：引用会被相应地改写，而没有任何引用的文件一概不碰。
 *
 * ⚠️ 两条来源**都要看**（需求 R16：画布与笔记同等算数）：
 * - 宿主的链接索引（`resolvedLinks`）—— 覆盖笔记里的所有写法；
 * - **画布文本节点**里自己扫出来的目标 —— 那部分是文本内容，宿主是否索引没有保证
 *   （取证点 E-1c），少了它"只被画布文本引用的附件"会永远不被处理。
 *   多出来的候选由后续判据兜底，**少掉的那些才是真缺陷**。
 *
 * ⚠️ 本次搬迁时补上本注释：这段说明原先**漂移到了邻近的另一个方法上**
 * （`main.ts` 里 `readAllNoteTexts` 与 `isKnownCloudCopy` 之间），
 * 而方法自己一行注释也没有 —— 见 `refactor-plan.md` §7。
 */
export async function referencedVaultPaths(app: App): Promise<ReadonlySet<string>> {
	const referenced = new Set(referencedPathsFrom(app.metadataCache?.resolvedLinks));

	const vaultPaths = app.vault.getFiles().map((file) => file.path);
	for (const file of app.vault.getFiles()) {
		if (file.extension !== "canvas") continue;
		let text: string;
		try {
			text = await app.vault.read(file);
		} catch {
			// 读不到就当它没有引用：这里多一份候选只会多一点工作，
			// 而"读失败"绝不能变成"把它的引用当成不存在"以外的断言。
			continue;
		}
		for (const path of resolveCanvasTargets(canvasTextTargets(text), vaultPaths)) {
			referenced.add(path);
		}
	}
	return referenced;
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
