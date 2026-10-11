/**
 * 把孤儿对象在本地的副本删掉（需求 R17 的"连本地一起清"那一档）。
 *
 * ## 为什么单独一个模块，而不是顺手写在插件主入口里
 *
 * 这是全库**唯一**会删"用户自己的文件"的地方里、最容易被顺手加上的那一个：
 * 调用它的路径是**自动弹出的询问**，而它的判据（哪份副本落在缓存目录外）来自别处。
 * 主入口里的几行循环既进不了套件、也没有变异锚点 —— 本项目已经因此吃过一次亏
 *（弹窗那层"选项传进来了但没人用"，只有真机才量得出来）。
 * 放成一个只有一条出口的模块，就能用记账替身把每条分支钉住。
 *
 * ## ⚠️ 两种副本走两条路，判错的代价不对称
 *
 * | 副本在哪 | 是什么 | 走哪条路 | 判错的后果 |
 * |---|---|---|---|
 * | 缓存目录内 | 我们落的**可再生**副本 | `removeCacheFile`（`vault.delete`） | 该档只是"空间没立刻释放" |
 * | 缓存目录外 | `localCopy: "keep"` 时**用户自己的附件** | `fileManager.trashFile` | 绕过回收站**永久删掉用户的图** |
 *
 * 所以两类**不是**"危险程度不同"的同一个动作，而是两个动作：
 * 前者的可恢复性由"下次渲染会重新下载"提供，后者没有这层保障（重新下载会落在缓存目录里，
 * 路径都不一样），所以必须留给用户自己的回收站。
 *
 * ## 三条纪律（每条都有具体后果）
 *
 * 1. **先删文件、再摘记录**：顺序反了的话记录先消失而文件还在磁盘上 ——
 *    渲染层于是以为"本地没有副本"，又去下载一个**其实还在**的文件。
 * 2. **拿不到删除凭据就整条跳过（文件与记录都不动）**：宿主的文件索引可能滞后于磁盘
 *    （刚同步进来的文件还没被它索引）。此时既不能绕过宿主自己删（会留下"看得见、读不到"
 *    的幽灵条目），也不该摘记录 —— 文件其实还在，记录还是对的。
 * 3. **删失败的不能记成删成功**：计数与索引记录都以"文件真的没了"为准。
 *    吞掉失败等于向上报一个假的"已清理"。
 */

import type { App } from "obsidian";

import type { OrphanLocalTarget } from "./orphan-watch";
import { removeCacheFile } from "./remove";

export interface OrphanRemovalDeps {
	app: App;
	/** 摘掉一条索引记录；返回它**是否真的存在**（用来决定要不要落盘）。 */
	forget: (key: string) => boolean;
	/** 索引落盘。 */
	persist: () => Promise<void>;
	/** 落盘失败：如实汇报（与批量清理同一条纪律，绝不静默）。 */
	onPersistError: (error: unknown) => void;
	/** 单个文件删失败：记下来（诊断用，不中断整批）。 */
	onDeleteError?: (error: unknown, path: string) => void;
}

/**
 * 删掉清单上的副本，返回**真的删掉了几个**。
 *
 * 索引只在真的删掉过东西时才落盘一次（不是每个文件一次）。
 */
export async function removeOrphanCopies(
	targets: readonly OrphanLocalTarget[],
	deps: OrphanRemovalDeps
): Promise<number> {
	if (targets.length === 0) return 0;

	let removed = 0;
	let dirty = false;

	for (const target of targets) {
		const file = deps.app.vault.getAbstractFileByPath(target.path);
		// 纪律 2：拿不到删除凭据 ⇒ 文件与记录都不动
		if (!file) continue;

		try {
			if (target.isUserFile) await deps.app.fileManager.trashFile(file);
			else await removeCacheFile(deps.app, file);
		} catch (error) {
			// 纪律 3：删不掉就留着（多一个文件远好过丢一张图），但绝不记成成功
			deps.onDeleteError?.(error, target.path);
			continue;
		}

		removed += 1;
		if (deps.forget(target.key)) dirty = true;
	}

	if (dirty) {
		try {
			await deps.persist();
		} catch (error) {
			deps.onPersistError(error);
		}
	}

	return removed;
}
