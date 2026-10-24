/**
 * **清单勾选**的纯逻辑（不碰 DOM、不碰宿主的 `Modal`）。
 *
 * ## 为什么必须把它抽出来
 *
 * 弹窗本身在测试里点不了（宿主的 `Modal` 没有可编程的 DOM），而"勾选怎么算"
 * 恰恰是**容易错且不会报错**的那部分：
 *
 * - 勾选的单位写成"地址"→ 同一个地址在两篇笔记里被合成一条 ⇒ **其中一篇没被处理**；
 * - 全选/全不选算错 → 用户以为全勾上了，实际少了几行；
 * - 切换范围后残留上一批的键 → 提交时多出几条**当前清单里根本没有**的条目。
 *
 * 这些症状都只表现为"结果不太对"。所以：**能穷举的都放这里**，
 * 弹窗那一层只剩"把这几行画出来、把点击转成一次状态变更"。
 *
 * ⚠️ 2026-10-22（D-68）：这个文件原来叫 `external-picker-logic.ts` —— 当时只有一个
 * 「挑选外链」弹窗用它。后来**清单壳也用它**（`ui/task-list-shell.ts` 的勾选与全选），
 * 而那条专门挑外链的链已并入「上传全部附件」⇒ 名字跟着内容改，免得下一个人以为这里还有
 * "挑选外链"的功能。
 *
 * ⚠️ 2026-10-24：清单**弹窗容器**（`task-list-modal.ts`）已退役（只剩附件管理一个容器，
 * 它自己把壳挂进 `Modal`）—— 但这两个函数仍被壳用着，别跟着一起删。
 */

/**
 * 勾选的单位 = **笔记 + 地址**（站外 / 本机那两类行用它当 `id`）。
 *
 * ⚠️ 不能用地址单独当键：同一个地址出现在两篇笔记里是**两个**要处理的条目
 * （各自要改各自那篇的链接）。合成一条的后果是其中一篇没被处理，
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
 *
 * ⚠️ 参数按 `{ key }` 收口（不是某个具体行类型）：几条链的行各不相同
 * （`FileCard` 用 `id`，由调用方做一层映射）。判据只有这一份 ——
 * 别在另一处再写一遍"什么算全选"。
 */
export function selectEverything(items: readonly { key: string }[]): Set<string> {
	const next = new Set<string>();
	for (const item of items) next.add(item.key);
	return next;
}
