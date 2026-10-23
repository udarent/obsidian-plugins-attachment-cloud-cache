/**
 * 「**没有任何引用的本地文件**」—— 清理命令的本地那一半候选（D-74 / D-77）。
 *
 * ## 这个模块补的是哪些洞
 *
 * 清理命令（`check-orphans`，2026-10-22 起叫「清理附件…」）原来只列**云端对象**
 * （台账里有、引用没了）。库里还有两类同样"该清"的东西它根本看不见：
 *
 * 1. **从来没上传过、也没人引用的附件**（D-74，用户要求「把本地孤立文件也纳入清理」）；
 * 2. **站外缓存下来的本地副本**（D-77，用户要求「语义扩展到所有可以被清理的附件」）——
 *    从别的网站下载到 `attachments/` 的那份。⚠️ 它们此前被**整体排除**，
 *    而那条排除的理由（"认不出引用，可能误删"）只属于**云端那一半**：
 *    删本地副本不碰云端、不碰笔记，代价只是"下次显示要重新联网下载"（可恢复）。
 *
 * 两类都进清单，但**分开交出去**（`paths` / `cachedPaths`）—— 原因不同，界面上的标签、
 * 默认勾选、以及"删了会怎样"的解释都不同。
 *
 * ## ⚠️ 判据必须是「还有人在用吗」，不是「它在不在索引里」
 *
 * 两类"在用"的口径必须与其它命令**同一份**（D-59 的教训）：
 * 1. **本地引用**：笔记 / 画布正文里直接指着这个路径（`locallyReferencedPaths`）；
 * 2. **远端引用**：笔记里写着指向我们存储的 URL，而那个对象**落在这条路径上** ——
 *    它虽然"本地链接没了"，但仍然被用了（只是改成了远端写法）。
 *
 * ⚠️ 只查第 1 条会把"已经迁到云端、链接也改好了"的附件全列成孤立 ⇒ 用户一清就删掉
 * 正在显示的图（那份副本没了就得重新下载，离线时直接看不到）。
 *
 * ## ⚠️ 下面这三类必须**排除**（各自都有具体后果）
 *
 * | 排除 | 为什么 |
 * |---|---|
 * | 笔记 / 画布 / 数据库（`isNoteLikeExtension`） | 那不是附件；删了就是删笔记 |
 * | 云端对象那条清单**已经列过的路径** | 同一个文件在这一屏里出现两次（一行"云端"、一行"本地"），而两行会各自删一次 |
 * | 宿主自己的目录（`excludedPrefixes` + 顶层点目录） | 里面是插件与设置、以及回收站；删了就是坏配置 |
 *
 * ⚠️ **站外缓存的本地副本不再排除**（D-77）：它进 `cachedPaths`，但仍然要过
 * 「还有人在用」那道判据 —— 笔记里直接指着这条路径的那些当然不列。
 *
 * ## 它**不**决定"要不要删"
 *
 * 这一层只回答"哪些是孤立的"。默认不勾、三档动作怎么落到它身上，都在
 * `plugin/orphan-flow.ts` 与弹窗那一层 —— 因为"能不能恢复"是产品判断，不是分类判断。
 */

import { NOTE_LIKE_REASON, isNoteLikeExtension } from "../vault-files";

/** 库内文件的最小形状（与 `batch.ts::VaultFileLike` 同一个约定）。 */
export interface LocalOrphanFile {
	path: string;
	extension?: string;
}

export interface LocalOrphanOptions {
	/**
	 * **还有人在用**的库内路径：本地引用 ∪ 「被远端 URL 引用的对象」的本地副本。
	 *
	 * ⚠️ 由调用方算好（它才知道索引与设置）—— 这一层保持**纯**、可以穷举。
	 */
	usedPaths: ReadonlySet<string>;
	/** 云端对象那条清单**已经覆盖**的路径（同一个文件不列两行）。 */
	coveredPaths: ReadonlySet<string>;
	/**
	 * **站外缓存下来的本地副本**路径（`origin: "external"`）。
	 *
	 * ⚠️ 这**不是**"排除名单"，而是**分类依据**（D-77）：命中的那些进结果的
	 * `cachedPaths`，界面给它们标「站外缓存」并说明"删了下次显示要重新下载"。
	 * ⚠️ 但「还有人在用」仍然先行 —— 笔记里直接指着它的那些两份清单都不进。
	 */
	externalPaths: ReadonlySet<string>;
	/**
	 * 宿主自己的目录前缀（结尾带 `/`）：**配置目录**与**回收站**。
	 *
	 * ⚠️ 不能只靠"顶层目录以点开头"：Obsidian 的配置目录名是**用户可配的**
	 *（`Vault#configDir`，可能叫 `myconfig/`）⇒ 由调用方把**当前**那个名字递进来。
	 * 点开头那条是兜底（`.trash/` 之类），但主判据必须是这一份。
	 */
	excludedPrefixes: readonly string[];
}

export interface LocalOrphanSelection {
	/** 用户自己的、没有任何引用的本地文件路径（按库内顺序）。 */
	paths: string[];
	/**
	 * **站外缓存下来的本地副本**、且没有任何本地引用（D-77）。
	 *
	 * ⚠️ 与 `paths` **分开**：删这一类只是"清缓存"（下次显示重新下载），
	 * 而 `paths` 里那些可能是**唯一一份**。界面上的默认勾选与标签都按这个差别来。
	 */
	cachedPaths: string[];
	/** 被跳过的原因统计（诊断用，与 `batch.ts` 同一个形状）。 */
	skipped: { reason: string; count: number }[];
}

/**
 * 挑出孤立的本地文件。
 *
 * ⚠️ 顺序是有意的：**笔记类最先**（它是"这东西根本不是附件"），
 * 然后"还有人在用"，最后才是两个**去重/排除**口径。把去重放前面的话，
 * 一篇被排除的笔记会给出"已经在云端清单里"这种误导性的原因。
 */
export function selectLocalOrphans(
	files: readonly LocalOrphanFile[],
	options: LocalOrphanOptions
): LocalOrphanSelection {
	const paths: string[] = [];
	const cachedPaths: string[] = [];
	const reasons = new Map<string, number>();
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const file of files ?? []) {
		const path = typeof file?.path === "string" ? file.path : "";
		if (path.trim() === "") {
			bump("路径为空");
			continue;
		}
		// ⚠️⚠️ **宿主自己的目录一个都不碰**：Obsidian 的配置目录里是插件与设置（本插件自己的索引文件就在那儿），
		// `.trash/` 是回收站 —— 它们同样"没有任何笔记引用"，但删了就是坏配置。
		// 判据是"当前那个配置目录名"（由调用方给）＋"顶层点目录"兜底，而不是逐个列名单。
		// ① 宿主自己的目录（配置目录 ＋ 回收站）：由调用方把**当前**的配置目录名递进来
		//   （用户可配，不一定是 `.obsidian`）；② 兜底：任何**顶层点目录**也不列。
		const slashAt = path.indexOf("/");
		const topFolder = slashAt > 0 ? path.slice(0, slashAt) : "";
		if (options.excludedPrefixes.some((prefix) => prefix !== "" && path.startsWith(prefix)) || topFolder.startsWith(".")) {
			bump("宿主自己的目录（配置目录 / 回收站）");
			continue;
		}
		const extension = String(file.extension ?? "").replace(/^\./, "").toLowerCase();
		if (isNoteLikeExtension(extension)) {
			bump(NOTE_LIKE_REASON);
			continue;
		}
		if (options.usedPaths.has(path)) {
			bump("还有笔记或画布在引用");
			continue;
		}
		if (options.coveredPaths.has(path)) {
			bump("已经在云端对象那条清单里");
			continue;
		}
		// ⭐ 站外缓存下来的副本：**单独一栏**，不再排除（D-77）。
		// ⚠️ 位置在「还有人在用」之后 —— 笔记里直接指着它的那一份两份清单都不进；
		// 它的"没人用"只是"没有本地链接"，那正是缓存正常的样子。
		if (options.externalPaths.has(path)) {
			cachedPaths.push(path);
			continue;
		}
		paths.push(path);
	}

	return {
		paths,
		cachedPaths,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}
