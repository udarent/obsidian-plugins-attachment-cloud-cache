/**
 * 「改名要补到云端声明」的**待补队列**（R25 / CR-16）—— 纯逻辑。
 *
 * ## 它解决的问题
 *
 * 共享桶档的 key 里没有名字（纯内容哈希），显示名只剩两个来源：本机索引的 `sourceName`
 * 与**云端声明**里的 `refs[hash].name`。于是改名必须做一次云端写，别设备才看得到新名字。
 *
 * 但改名是**本地整理动作**：用户可能正离线、正赶时间。为了一次云端写去阻塞它，
 * 等于让"改个文件名"依赖网络 —— 那不可接受。所以：
 *
 * - 改名**先成功**（宿主已经把全库链接改好了，这是它的承诺）；
 * - 云端声明尽量当场写；写不进去就记在这里，**下次上传 / 清理 / 迁移启动前**补。
 *
 * ## 为什么是"覆盖"而不是"流水账"
 *
 * 同一个 hash 连改三次名，只有**最后一次**有意义（声明存的是状态，不是历史）。
 * 所以入队是**按键覆盖**，且 `at` 跟着刷新 —— 队列按 `at` 淘汰时，最该留下的是最近改的。
 *
 * ⚠️ 队列**不参与任何删除判定**：它只影响"别设备显示什么名字"。
 * 写丢了最多是显示名旧一轮，绝不会让谁被误删 —— 这条边界是这个模块敢做小的原因。
 */

/**
 * 队列上限。
 *
 * 200 条 ≈ 一个很勤快的用户改一整天的量；一条只有几十字节。
 * ⚠️ 有上限不是为了省空间，而是为了**不让一份写坏的状态无限膨胀**：
 * 真出了"每次都写失败"的故障，队列会在下一次成功后清空，而不是长成一个巨型对象。
 */
export const BACKLOG_LIMIT = 200;

import type { DeclarationNameBacklog, DeclarationNameEntry } from "../types";

export type { DeclarationNameBacklog, DeclarationNameEntry };

/** 合法的内容哈希形状（与 `object-key.ts` 的判据同源，但不 import 它 —— 这里只做形状）。 */
const HASH_SHAPE = /^[0-9a-f]{64}$/;

/**
 * 入队（按键覆盖）。返回**新对象**，不改入参。
 *
 * ⚠️ 超过上限时按 `at` **淘汰最旧的**：留着最近的改名才有意义（用户最后看到的名字）。
 */
export function enqueueName(
	backlog: DeclarationNameBacklog,
	hash: string,
	name: string,
	ext: string,
	at: string
): DeclarationNameBacklog {
	const key = typeof hash === "string" ? hash.trim() : "";
	if (!HASH_SHAPE.test(key)) return backlog;
	const cleanName = typeof name === "string" ? name.trim() : "";
	if (cleanName === "") return backlog;

	const next: Record<string, DeclarationNameEntry> = {
		...backlog,
		[key]: { name: cleanName, ext: typeof ext === "string" ? ext.trim().toLowerCase() : "", at },
	};

	const keys = Object.keys(next);
	if (keys.length <= BACKLOG_LIMIT) return next;

	// 淘汰最旧的若干条（`at` 是 ISO 字符串，字典序即时间序）
	keys
		.sort((a, b) => (next[a].at < next[b].at ? -1 : next[a].at > next[b].at ? 1 : 0))
		.slice(0, keys.length - BACKLOG_LIMIT)
		.forEach((old) => {
			delete next[old];
		});
	return next;
}

/**
 * 结清一批（补写成功的那些）。返回**新对象**。
 *
 * ⚠️ 只删点名的那些：整份清空会在"这一轮只补了一半"时把没补的也丢掉 ——
 * 而那几条正是下次该补的。
 */
export function settleNames(backlog: DeclarationNameBacklog, hashes: Iterable<string>): DeclarationNameBacklog {
	const drop = new Set<string>();
	for (const hash of hashes) {
		const key = typeof hash === "string" ? hash.trim() : "";
		if (key) drop.add(key);
	}
	if (drop.size === 0) return backlog;

	const next: Record<string, DeclarationNameEntry> = {};
	for (const key of Object.keys(backlog)) {
		if (!drop.has(key)) next[key] = backlog[key];
	}
	return next;
}

/** 待补的条数（0 ⇒ 什么都不用做，调用方可以先看这个数省一次读盘）。 */
export function backlogCount(backlog: DeclarationNameBacklog): number {
	return Object.keys(backlog).length;
}

/**
 * 摊平成"要写进声明的引用"。
 *
 * 顺序按 `at` 升序（最旧先补）：万一只能补一部分，先补的是"用户最早改的那个名字"。
 */
export function backlogRefs(backlog: DeclarationNameBacklog): { hash: string; name: string; ext: string }[] {
	return Object.keys(backlog)
		.sort((a, b) => (backlog[a].at < backlog[b].at ? -1 : backlog[a].at > backlog[b].at ? 1 : 0))
		.map((hash) => ({ hash, name: backlog[hash].name, ext: backlog[hash].ext }));
}

/**
 * 一个路径（vault 相对）的文件名与扩展名。
 *
 * 改名的"新名字"就是它。取最后一段：目录里带点（`v1.2/`）不参与扩展名判断。
 */
export function nameOfPath(path: string): { name: string; ext: string } {
	const segment = String(path ?? "")
		.split(/[\\/]/)
		.pop() ?? "";
	const dot = segment.lastIndexOf(".");
	const ext = dot > 0 ? segment.slice(dot + 1).toLowerCase() : "";
	return { name: segment, ext };
}
