/**
 * 缓存路径的推导。
 *
 * ## 两条硬要求
 *
 * 1. **确定性** —— 同一个 key 永远推出同一个路径。索引里记的是路径，渲染时按路径取文件；
 *    不确定就等于缓存永远命中不了，而且"有时命中有时不命中"极难排查。
 * 2. **单射** —— 不同 key 不能推出同一路径，否则两张图互相覆盖。
 *    覆盖是**静默**的（图能显示，只是内容错了）。
 *
 * ## 为什么只有一种布局（`缓存相对路径 === 对象 key`）
 *
 * 这里原来支持三种布局（`mirror` / `flat` / `byExt`）。它们被删掉了，理由有两条：
 *
 * - **那个选项大多时候什么也没改变。** 默认 key 模板是内容寻址的单段形式
 *   （`{hash}.{ext}`），此时 `mirror` 与 `flat` 推出的路径**完全相同**。
 *   提供一个不产生差异的开关，比不提供更糟 —— 用户以为自己在做选择。
 * - **非默认那两条分支是安全风险。** 它们需要为多段 key 消解撞名，
 *   而本模块的产出会直接喂给"清理未使用缓存"（一个会移文件的破坏性命令）。
 *   在破坏性路径上保留**没有任何调用方**的分支，是纯粹的负债。
 *
 * `mirror` 同时满足"缓存目录只放一层"这条移动端约束 —— 因为默认 key 是单段的。
 * 如果将来真的需要更好浏览的布局，正解是**由 hash 前缀自动分片**（像 git 的 objects），
 * 而不是再让用户选一次。
 *
 * ## 为什么这些函数是纯的
 *
 * 它们产出的路径会直接写进 vault，且「清理未使用缓存」会按这些判据删文件。
 * 纯函数才能穷举敌意输入（穿越、空段、绝对路径），而 I/O 里的 if 很难穷举，
 * 判错一次的代价是不可逆的。
 */

/** 缓存目录路径的归一化（去掉首尾斜杠、收敛分隔符、丢弃空段与 `.`）。 */
function cleanVaultPath(input: unknown): string {
	const raw = typeof input === "string" ? input : "";
	return raw
		.replace(/\\/g, "/")
		.split("/")
		.filter((s) => s !== "" && s !== ".")
		.join("/");
}

/** 路径里是否含 `..` 段（穿越）。含则一律拒绝，不做"修正后再判断"。 */
function hasTraversal(path: string): boolean {
	return path.replace(/\\/g, "/").split("/").includes("..");
}

/**
 * 推导某个对象 key 对应的缓存路径。
 *
 * @param key         对象 key（会被清洗）
 * @param cacheFolder 缓存目录（vault 相对路径）
 * @returns vault 相对路径；无法推导时返回 `null`
 *          （空 key / 空目录 / 含穿越 —— 由调用方判定为"不属于本存储"）
 */
export function cachePathFor(key: unknown, cacheFolder: unknown): string | null {
	const root = cleanVaultPath(cacheFolder);
	if (!root || hasTraversal(root)) return null;

	const cleanKey = cleanVaultPath(key);
	// 空 key 或含穿越的 key → 不推导。
	// 返回 null 而不是"修正后继续"：这类 key 说明上游算错了，
	// 静默修正会让问题藏起来，而缓存索引会记下一条永远对不上的路径。
	if (!cleanKey || hasTraversal(cleanKey)) return null;

	return `${root}/${cleanKey}`;
}

/**
 * 该路径是否位于缓存目录内 —— **清理类命令的安全闸门**。
 *
 * 它会决定哪些文件可被移入回收站，所以判据必须严格：
 * - 按**路径段**判断，而不是字符串前缀：
 *   `_attachment-cache-other/x.png` 以 `_attachment-cache` 开头，但它不是缓存文件。
 * - 缓存目录**本身**不算（它是目录，不是文件）。
 * - 含 `..` 一律拒绝，不做"归一后再判"。
 */
export function isUnderCacheFolder(path: unknown, cacheFolder: unknown): boolean {
	const root = cleanVaultPath(cacheFolder);
	if (!root) return false;

	const raw = typeof path === "string" ? path : "";
	if (hasTraversal(raw)) return false;

	const clean = cleanVaultPath(raw);
	if (!clean) return false;

	// 按段判断：`root/x` 才算在内，`root` 与 `rootX/...` 都不算
	return clean.startsWith(`${root}/`);
}
