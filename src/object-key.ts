/**
 * 对象 key 的生成与清洗。
 *
 * ## 为什么这一层要特别小心
 *
 * key 由**用户数据**（文件名、扩展名）拼出来，然后变成两个地方的实际路径：
 * 对象存储里的 key，以及本地缓存文件的路径。所以这里的缺陷不是"名字难看"，而是：
 *
 * - **路径穿越**：文件名里的 `../../` 能把缓存写到 vault 之外（越出用户预期范围）；
 * - **空段与多余斜杠**：`a//b.png` 与 `a/b.png` 在任何对象存储里都是不同 key，
 *   而缓存目录里 `//` 会让路径解析出现差异 —— 必须在生成时就收敛；
 * - **非 ASCII**：中文/空格在对象存储里是合法的，**不应编码**（编码会让链接 404，
 *   且与缓存索引里记录的 key 对不上）；
 * - **超长名**：对象存储 key 有长度上限，长名也会撑爆缓存路径（移动端小文件代价明显）。
 *
 * 全是纯函数、无 I/O —— 正因为能穷举，才值得把这些判定集中在这一层，
 * 而不是散在上传与缓存的 I/O 代码里（那样很难穷举，出错又不易发现）。
 */

/** 模板支持的占位符。设置页的说明由它生成，避免文档与实现脱节。 */
export const DEFAULT_KEY_TOKENS = ["hash", "hash2", "ext", "filename", "date"] as const;

export interface ObjectKeyContext {
	/** 内容哈希（十六进制）。 */
	hash: string;
	/** 扩展名，不含点，小写。 */
	ext: string;
	/** 原始文件名（会被清洗）。 */
	filename: string;
	/** 用于 `{date}` 的时间，默认当前时间。 */
	date?: Date;
}

/** 文件名里**必须**替换掉的字符：URL 里有特殊含义的、路径分隔符。 */
// 说明：空格与中文**不在其中** —— 它们在对象存储里合法，编码反而会引发问题。
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*#%&=]/g;

/**
 * 把控制字符替换为空格。
 *
 * 用 codepoint 判断而不是正则里的 `\x00-\x1f`：后者会触发 `no-control-regex`，
 * 而那条规则反对的是"无意中写进控制字符"，与本处"有意清洗"的意图相反 ——
 * 但压规则不如换个更直白的写法。顺带覆盖 C1 控制区（0x80–0x9f）。
 */
function replaceControlChars(input: string): string {
	let out = "";
	for (const ch of input) {
		const code = ch.codePointAt(0) ?? 0;
		const isControl = code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		out += isControl ? " " : ch;
	}
	return out;
}

/** 文件名最大长度（按字符计）。留出余量给 key 里的其它段。 */
const MAX_FILENAME_LENGTH = 120;

/**
 * 清洗文件名的单个段。
 *
 * 输出保证：不含路径分隔符、不含 `..`、非空、长度受限、保留扩展名。
 */
export function sanitizeFilename(input: unknown): string {
	let name = typeof input === "string" ? input : "";
	name = replaceControlChars(name).replace(UNSAFE_FILENAME_CHARS, "_");

	// 去掉所有 `..` 序列 —— 这是路径穿越的唯一入口。
	// 放在分隔符替换**之后**：`../..` 此时已变成 `.._..`，正好被这一步清掉。
	name = name.replace(/\.\./g, "_");

	// 合并连续空白（控制字符替换后可能产生）
	name = name.replace(/\s{2,}/g, " ").trim();

	// 兜底：清理后没有任何"实在内容"时（空、纯点、纯下划线/空白）→ 用固定名。
	//
	// ⚠️ 判据必须覆盖"纯下划线"：`..` 在上一行被替换成 `_`，
	// 若只判 `^\.+$`，则 `.` → "file" 而 `..` → "_" —— 两个相似输入走了不同分支。
	// 这种不一致本身是缺陷（用户看到莫名其妙的 `_` 文件名，且无法预测行为）。
	if (!/[^\s._]/.test(name)) return "file";

	if (name.length <= MAX_FILENAME_LENGTH) return name;

	// 截断时必须**保留扩展名** —— 否则缓存文件失去类型信息，
	// 而扩展名正是渲染时判断"这是什么资源"的依据之一。
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 ? name.slice(dot) : "";
	// 扩展名本身异常长时（可能是名字里带点的畸形输入）就不保留了
	const safeExt = ext.length <= 16 ? ext : "";
	const room = MAX_FILENAME_LENGTH - safeExt.length;
	const head = safeExt ? name.slice(0, dot) : name;
	return head.slice(0, room) + safeExt;
}

/**
 * 清洗整个 key：统一分隔符、去掉空段与 `.` / `..`、去掉首尾斜杠。
 *
 * 这是**最后一道闸门** —— 即使模板本身写得不规范（如 `../{hash}`），
 * 输出仍是一个安全的相对 key。
 */
export function sanitizeKey(input: unknown): string {
	const raw = typeof input === "string" ? input : "";
	return raw
		.replace(/\\/g, "/")
		.split("/")
		// 丢空段（含 `//` 造成的空串）、`.`（当前目录）、`..`（穿越）
		.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
		.join("/");
}

function formatDate(date: Date): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	const d = String(date.getUTCDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * 按模板渲染对象 key。
 *
 * - 已知占位符被替换；**未知占位符保留原样**（`{nope}` 仍是 `{nope}`）——
 *   让它"看得见"。静默替换成空串会让 `{hash}.{unknown}.{ext}` 塌成 `hash..png`，
 *   那种 key 在桶里很难看出是配置写错了。
 * - 结果统一过 {@link sanitizeKey}，所以模板写得不规范也不会产生危险 key。
 */
export function renderObjectKey(template: unknown, context: ObjectKeyContext): string {
	const tpl = typeof template === "string" && template.trim() !== "" ? template : "{hash}.{ext}";

	const values: Record<string, string> = {
		hash: typeof context.hash === "string" ? context.hash : "",
		hash2: typeof context.hash === "string" ? context.hash.slice(0, 2) : "",
		ext: typeof context.ext === "string" ? context.ext.toLowerCase().replace(/^\./, "") : "",
		filename: sanitizeFilename(context.filename),
		date: formatDate(context.date ?? new Date()),
	};

	const rendered = tpl.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
	);

	return sanitizeKey(rendered);
}
