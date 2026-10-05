/**
 * 缓存路径的推导。
 *
 * ## 两条硬要求
 *
 * 1. **确定性** —— 同一个 key 永远推出同一个路径。索引里记的是路径，渲染时按路径取文件；
 *    不确定就等于缓存永远命中不了，而且"有时命中有时不命中"极难排查。
 * 2. **单射** —— 不同 key 不能推出同一路径，否则两张图互相覆盖。
 *    这个风险是"平铺布局"特有的：`a/photo.png` 与 `b/photo.png` 的 basename 相同。
 *    覆盖是**静默**的（图能显示，只是内容错了），所以必须在生成时消解。
 *
 * 三种布局的取舍：
 * - `mirror`（默认）：`缓存相对路径 === 对象 key`，严格一一对应，不需要额外心智模型。
 *   这也是默认对象 key 模板取单段（`{hash}.{ext}`）的原因 —— 缓存目录不会变深。
 * - `flat`：全平铺。只在单段 key 时干净；多段 key 需要消解撞名（见下）。
 * - `byExt`：按扩展名分目录，便于按类型浏览；同样需要消解撞名。
 *
 * ## 为什么这些函数是纯的
 *
 * 它们产出的路径会直接写进 vault，且「清理未使用缓存」会按这些判据删文件。
 * 纯函数才能穷举敌意输入（穿越、空段、绝对路径），而 I/O 里的 if 很难穷举，
 * 判错一次的代价是不可逆的。
 */

import { CacheLayout, CACHE_LAYOUTS, isCacheLayout } from "./types";

// 布局清单定义在 types.ts（与类型同处一地）。这里转出，
// 让"做路径推导的模块"同时也是"拿布局清单的模块"。
export { CACHE_LAYOUTS };

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
 * 短摘要（FNV-1a 32 位 → 8 位十六进制）。
 *
 * 用途单一：为"平铺/按扩展名"布局消解撞名。
 * 选它是因为**无依赖且确定性**：不需要 crypto（移动端可用性更好），
 * 也不需要与内容哈希保持一致（这里的目的是区分 key，不是校验内容）。
 */
function shortDigest(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** 取路径最后一段。 */
function baseName(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? "";
}

/** 取扩展名（不含点，小写）。 */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return "";
	return name.slice(dot + 1).toLowerCase();
}

/** 拆成 `[主干, 扩展名（含点，可能为空）]`。 */
function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return [name, ""];
	return [name.slice(0, dot), name.slice(dot)];
}

/**
 * 把 key 压成单段文件名，供 flat / byExt 使用。
 *
 * - **单段 key 原样返回**（默认模板走这条，结果就是干净的文件名）。
 * - 多段 key 在原文件名后加一段 key 的短摘要：`a/photo.png` → `photo-1a2b3c4d.png`。
 *   摘要取的是**整个 key**，所以不同 key 必然得到不同结果 —— 这正是单射的来源。
 */
export function flattenKeyForLayout(key: unknown): string {
	const clean = cleanVaultPath(key);
	if (!clean) return "";
	if (!clean.includes("/")) return baseName(clean);

	const name = baseName(clean);
	const [stem, ext] = splitExtension(name);
	return `${stem}-${shortDigest(clean)}${ext}`;
}

/**
 * 推导某个对象 key 对应的缓存路径。
 *
 * @param key         对象 key（会被清洗）
 * @param cacheFolder 缓存目录（vault 相对路径）
 * @param layout      布局；非法值回落到 mirror（配置被写坏时不该让插件崩）
 * @returns vault 相对路径；无法推导时返回 `null`
 *          （空 key / 空目录 / 含穿越 —— 由调用方判定为"不属于本存储"）
 */
export function cachePathFor(key: unknown, cacheFolder: unknown, layout: unknown): string | null {
	const root = cleanVaultPath(cacheFolder);
	if (!root || hasTraversal(root)) return null;

	const cleanKey = cleanVaultPath(key);
	// 空 key 或含穿越的 key → 不推导。
	// 返回 null 而不是"修正后继续"：这类 key 说明上游算错了，
	// 静默修正会让问题藏起来，而缓存索引会记下一条永远对不上的路径。
	if (!cleanKey || hasTraversal(cleanKey)) return null;

	const resolved: CacheLayout = isCacheLayout(layout) ? layout : "mirror";

	if (resolved === "mirror") return `${root}/${cleanKey}`;

	const flatName = flattenKeyForLayout(cleanKey);
	if (!flatName) return null;

	if (resolved === "flat") return `${root}/${flatName}`;

	// byExt：按扩展名分目录。无扩展名时用 misc —— 绝不产生空段（`root//name`）
	const ext = extensionOf(baseName(cleanKey)) || "misc";
	return `${root}/${ext}/${flatName}`;
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
