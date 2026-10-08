/**
 * 「选择要缓存的外链图片」的**纯逻辑**（不碰 DOM、不碰宿主的 `Modal`）。
 *
 * ## 为什么必须把它抽出来
 *
 * 弹窗本身在测试里点不了（宿主的 `Modal` 没有可编程的 DOM），而"清单长什么样、
 * 勾选怎么算"恰恰是**容易错且不会报错**的那部分：
 *
 * - 勾选的单位写成"地址"→ 同一张图在两篇笔记里被合成一条 ⇒ **其中一篇没被搬**；
 * - 清单里漏掉本存储/回环地址的过滤 → 用户勾了才发现搬不了（或者更糟：去请求本机）；
 * - 全选/全不选算错 → 用户以为全勾上了，实际少了几张。
 *
 * 这些症状都只表现为"结果不太对"。所以：**能穷举的都放这里**，
 * 弹窗那一层只剩"把这几行画出来、把点击转成一次状态变更"。
 */

import type { ExternalCandidate } from "../maintenance/batch";

/** 清单的范围：当前打开的笔记 / 整个库。 */
export type ExternalPickScope = "note" | "vault";

/** 弹窗里那两档（顺序即界面顺序）。 */
export const EXTERNAL_PICK_SCOPES: readonly ExternalPickScope[] = ["note", "vault"];

/** 清单里的一行。`key` 是**勾选的单位**（见 {@link pickKey}）。 */
export interface ExternalPickItem {
	key: string;
	url: string;
	host: string;
	/** 它出现在哪篇笔记里 —— 会写进给用户看的那一行（全库范围下尤其必要）。 */
	notePath: string;
}

/**
 * 勾选的单位 = **笔记 + 地址**。
 *
 * ⚠️ 不能用地址单独当键：同一张图出现在两篇笔记里是**两个**要处理的条目
 * （各自要改各自那篇的链接）。合成一条的后果是其中一篇没被搬，
 * 而用户以为他勾过了 —— 这类"少做一件事"的错最难被发现。
 *
 * 用 `\u0000` 当分隔符：它在路径与 URL 里都不可能合法出现，
 * 于是不会有两个不同组合拼出同一个键。
 */
export function pickKey(candidate: { url?: unknown; notePath?: unknown }): string {
	const url = typeof candidate?.url === "string" ? candidate.url.trim() : "";
	const notePath = typeof candidate?.notePath === "string" ? candidate.notePath.trim() : "";
	return `${notePath}\u0000${url}`;
}

/**
 * 候选 → 清单行。
 *
 * 保持调用方给的顺序（候选那条链已经按笔记分组、并按地址去过重）。
 * 这里只做两件必要的清理：丢掉缺字段的条目、对同一个 `key` 去重
 * （去重是**防御性**的：候选链本身已经按"笔记 + 地址"去过重）。
 */
export function buildPickItems(candidates: readonly ExternalCandidate[] | null | undefined): ExternalPickItem[] {
	const items: ExternalPickItem[] = [];
	const seen = new Set<string>();

	for (const candidate of candidates ?? []) {
		const url = typeof candidate?.url === "string" ? candidate.url.trim() : "";
		const notePath = typeof candidate?.notePath === "string" ? candidate.notePath.trim() : "";
		if (!url || !notePath) continue;

		const key = pickKey(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({
			key,
			url,
			host: typeof candidate?.host === "string" ? candidate.host : "",
			notePath,
		});
	}

	return items;
}

/**
 * 切换一行。返回**新的集合**（不改原集合）。
 *
 * 用不可变集合而不是就地改，是为了让"当前勾了什么"只有一个来源 ——
 * 弹窗那一层重画时用的是同一个集合，不会出现"界面显示 A、实际提交 B"。
 */
export function toggleSelection(selected: ReadonlySet<string>, key: unknown): Set<string> {
	const next = new Set(selected);
	if (typeof key !== "string" || key === "") return next;
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * 全选。⚠️ 只勾**清单里现在这些**行的键 ——
 * 换成"把传进来的任何东西都塞进集合"会让切换范围后残留上一批的键，
 * 于是提交时多出几条**当前清单里根本没有**的条目。
 */
export function selectEverything(items: readonly ExternalPickItem[]): Set<string> {
	const next = new Set<string>();
	for (const item of items) next.add(item.key);
	return next;
}
