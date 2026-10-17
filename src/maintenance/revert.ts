/**
 * **把链接改回本地路径**（LFS 的 `migrate export` 那一侧）：用户要停止使用本插件、
 * 或想把某批附件变回"普通附件"时的**退出路径**。
 *
 * ## 为什么它必须与"删除本地副本"分开
 *
 * 两者方向相反，而名字很容易被读成同一件事：
 * - `releaseLocalSpace`：笔记还指着**云端**，把本地那份**删掉**腾空间；
 * - 这里：把笔记改回**指向本地那份**，文件**一个都不删**。
 *
 * 弄反任何一边，用户看到的都是"图没了"。
 *
 * ## 判据（三条，缺一不可）
 *
 * 1. 只改**索引里记着、且本地副本确实还在**的那些 —— 本地那份不在时改回去就是**造坏链**；
 * 2. 只改**能对上 URL** 的链接（索引里记的 `remoteUrl` 就是当年写进笔记的那一串）；
 * 3. 改写走 `planLinkRewrites`（**唯一**一份链接改写实现）—— 不在这里另写一套正则，
 *    否则 Markdown / wikilink / 行内 HTML / 引用式定义行这四种写法定会漏掉一两种。
 *
 * ⚠️ 不含画布：画布的 `file` 节点本来就指向库内路径，上传时也没被改成 URL。
 */

import type { RewriteRule } from "./references";
import { planLinkRewrites } from "./references";

/** 一条可回退的目标：笔记里那串 URL → 库内路径。 */
export interface RevertTarget {
	url: string;
	path: string;
	/** 链接里该显示的名字（优先用原始文件名，缺了就用路径最后一段）。 */
	name: string;
}

export interface RevertTargetsInput {
	entries: readonly { remoteUrl: string; cachePath: string; sourceName?: string }[];
	/** 这份库内路径现在还存不存在（**必须**是真实存在性，不是索引里的记录）。 */
	present: (path: string) => boolean;
}

export interface RevertTargets {
	targets: RevertTarget[];
	/** 索引里有、但本地副本已经不在了的条数 —— 这些**不能**改回本地路径（会造坏链）。 */
	missing: number;
}

/** 数组形式：只保留"本地那份还在"的，并按 URL 去重（同一对象可能有多条记录）。 */
export function revertTargets(input: RevertTargetsInput): RevertTargets {
	const seen = new Set<string>();
	const targets: RevertTarget[] = [];
	let missing = 0;
	for (const entry of input.entries) {
		const url = String(entry.remoteUrl ?? "").trim();
		const path = String(entry.cachePath ?? "").trim();
		if (!url || !path) continue;
		if (!input.present(path)) {
			missing += 1;
			continue;
		}
		if (seen.has(url)) continue;
		seen.add(url);
		targets.push({ url, path, name: entry.sourceName?.trim() || path.split("/").pop() || path });
	}
	return { targets, missing };
}

/**
 * 把**一篇**正文里的 URL 改回库内路径。
 *
 * 返回 `count = 0` 表示这篇没有可改的 —— 调用方据此跳过写盘（**不写**等于少一次改动，
 * 少一次"文件被外部改动"的同步冲突）。
 */
export function planRevertText(text: string, targets: readonly RevertTarget[]): { text: string; count: number } {
	if (targets.length === 0) return { text, count: 0 };
	// `from` 用 URL 原文、`to` 用库内路径：剩下的匹配/归一化/四种写法全部交给
	// `planLinkRewrites`（那里已经处理了 `%20`、`<带空格>`、`\|600`、引用式定义行）。
	const rules: RewriteRule[] = targets.map((target) => ({
		from: target.url,
		to: target.path,
		display: target.name,
	}));
	return planLinkRewrites(text, rules);
}
