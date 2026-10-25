/**
 * 对象 key 的生成与清洗。
 *
 * ## 为什么这一层要特别小心
 *
 * key 由**用户数据**（文件名）拼出来，然后进两个地方：桶里对象的身份，以及
 * 索引/去重的键。所以这里的缺陷不是"名字难看"，而是：
 *
 * - **路径穿越**：文件名里的 `../` 一旦进 key，桶里会出现越界段；
 * - **空段与多余斜杠**：`a//b.png` 与 `a/b.png` 在任何对象存储里都是不同 key；
 * - **非 ASCII**：中文/空格在对象存储里是合法的，**不应编码**（编码会让链接 404，
 *   且与索引里记录的 key 对不上）；
 * - **超长名**：对象存储 key 有长度上限（长名在移动端也明显更贵）。
 *
 * 全是纯函数、无 I/O —— 正因为能穷举，才值得把这些判定集中在这一层。
 *
 * ## ⭐ 1.2.0：key 的形状**不可配置**了（「对象 key 模板」设置已取消）
 *
 * 曾经这里支持 `{hash} {hash2} {ext} {filename} {name} {date}` 让用户自由拼模板。
 * 那是一个**能拼出静默数据事故的开关**：
 *
 * - 不含**完整** `{hash}` 的模板（`{filename}.{ext}`、`{date}`、`{hash2}.{ext}`…）会让
 *   **同名但内容不同**的文件得到同一个 key。而上传路径的"命中缓存即复用"判定是
 *   `索引里有这条 key` + 远端地址一致 + 本地副本还在，**不比内容** ⇒ 第二个文件直接
 *   复用第一个（用户贴了 B，笔记里却是 A）；若第一个的本地副本不在，更糟：PUT 会
 *   **覆盖桶里那个对象**，所有引用它的旧笔记一起变成新图 —— 不可逆。
 * - 占位符拼错（`{hsah}`）不会被拒绝，会**原样留在 key 里** ⇒ 每次上传都得到同一个 key。
 *
 * 于是模板整个取消，形状固定为 {@link objectKeyFor} 那**一种**：
 * `<名字>-<完整哈希>[.<扩展名>]`。两个分量各承担一件事，谁也省不掉：
 * **名字**给人看（桶里按前缀能搜到、确认框能显示原始文件名），
 * **完整哈希**给机器判**身份**（同内容必同 key ⇒ 去重与跨设备幂等；
 * 不同内容必不同 key ⇒ 永不互相覆盖）。
 *
 * ⚠️ 配套纪律：key 里既然有了名字，就能反推名字 —— 但解析结果
 * **只用于展示**（{@link displayNameForKey}），**绝不参与判定**；
 * 判"是不是我们上传的"永远查上传台账。同理 {@link hashFromKey} 只回答
 * "这份内容是否已知"这类**事实比较**，不用于反推归属。
 */

/** key 的生成口径。目前只有一档开关：是不是**共享桶**（决定 key 里有没有名字）。 */
export interface ObjectKeyOptions {
	/**
	 * 走**纯内容寻址**（`<sha256>.<ext>`，key 里没有名字）。
	 *
	 * 打开它等于接受两件事：① 桶里按名字搜不到文件（名字在声明里）；
	 * ② 同内容换名字不会再产生第二个对象 —— 这正是共享桶要的。
	 */
	readonly contentAddressed?: boolean;
}

export interface ObjectKeyParts {
	/** 内容哈希（sha256，十六进制）。 */
	hash: string;
	/** 扩展名，不含点（会被转小写）。 */
	ext: string;
	/** 原始文件名（会被清洗）。 */
	filename: string;
}

/**
 * 「一个完整内容哈希」的形状：**恰好** 64 位小写十六进制。
 *
 * ⚠️ 三处的判据从此同源（生成时的校验、`displayNameForKey` 的哈希尾、
 * `hashFromKey` 的两代形状）—— 它们必须永远一致，否则会出现
 * "生成得出、却解析不回来"的 key，而那类缺陷不报错、只表现为
 * "确认框里突然只剩下哈希名"或"同步到达的文件判不出来"。
 */
const HASH_PATTERN = "[0-9a-f]{64}";

const FULL_HASH_PATTERN = new RegExp(`^${HASH_PATTERN}$`);

/** 默认形状：`<名字>-<完整哈希>[.<扩展名>]`（与 {@link displayNameForKey} 同一判据）。 */
const HASH_TAIL_PATTERN = new RegExp(`^(.+)-(${HASH_PATTERN})(\\.[^./\\\\]{1,16})?$`);

/** 老格式（纯内容寻址）key 的形状：`<完整哈希>[.<扩展名>]`。 */
const PURE_HASH_PATTERN = new RegExp(`^(${HASH_PATTERN})(\\.[^./\\\\]{1,16})?$`);

/**
 * 生成对象 key —— **唯一**的命名规则（1.2.0 起没有模板了）。
 *
 * 返回**空串**表示"拿不到可用的身份"（传入的哈希不是 sha256 的形状）。
 * 调用方必须把它当失败处理（`ingest` 于是退回"不接管"，字节留在原地）：
 * 宁可这一次不传，也绝不能生成一个"所有文件共用"的 key ——
 * 那正是模板时代最坏的那类事故。
 *
 * ⚠️ 刻意**不猜**扩展名：`ext` 由调用方按内容类型解析后传进来（见 `resolveKeyExtension`），
 * 与"文件名里那个扩展名"未必相同（站外图片的 URL 尾巴常常没有真扩展名）。
 */
export function objectKeyFor(parts: ObjectKeyParts, options: ObjectKeyOptions = {}): string {
	const hash = typeof parts.hash === "string" ? parts.hash.trim() : "";
	if (!FULL_HASH_PATTERN.test(hash)) return "";

	const ext = typeof parts.ext === "string" ? parts.ext.toLowerCase().replace(/^\./, "") : "";

	// ⭐ R25 / CR-14：共享桶档用**纯内容寻址** —— key 里没有名字。
	// 于是"同内容必同 key"由 key 本身保证，跨设备/跨库去重不必依赖本机台账；
	// 名字改由**引用声明**（`refs[hash].name`）承载，所以改名不影响 key、也不用搬对象。
	// ⚠️ 只在共享桶打开时走这条：单桶档保持"名字在前"，因为那是桶里按名字认文件的唯一线索。
	if (options.contentAddressed) return sanitizeKey(ext ? `${hash}.${ext}` : hash);

	// 名字一定非空：`sanitizeFilename` 对"没有实在内容"的名字会给 `file` 兜底。
	const stem = stripExtension(sanitizeFilename(parts.filename));
	return sanitizeKey(ext ? `${stem}-${hash}.${ext}` : `${stem}-${hash}`);
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

	// 截断时必须**保留扩展名** —— 否则文件名失去类型信息，
	// 而扩展名正是判定"这是什么资源"的依据之一（本地落盘名也用它）。
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
 * 这是**最后一道闸门**。固定形状之后它已不必再防"模板写歪"（那种输入没了），
 * 但**仍然必须留着**：文件名里的分隔符虽然已被 `sanitizeFilename` 换掉，
 * 这一层是"即使上游哪一步漏了，也产不出危险 key"的那道兜底 ——
 * key 是桶里的身份，不值得把安全押在上游每一步都对。
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

/**
 * 去掉最后一个扩展名（`存档.v2.pdf` → `存档.v2`）。
 *
 * 点在**开头**不算扩展名（`.gitignore` 整体就是名字）—— 与 `sanitizeFilename`
 * 的截断逻辑同一条判据（`dot > 0`），两处对"什么是扩展名"不能有分歧。
 */
function stripExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * 从对象 key（或路径）反推**显示用**文件名；推不出来返回空串（调用方退化显示 key 本身）。
 *
 * - 只吃 {@link objectKeyFor} 产出的形状；**老格式纯哈希 key 安全返回空** ——
 *   两代命名在桶里长期共存（1.2.0 之前上传的对象保持旧 key，链接不受影响），
 *   这条解析对老 key 绝不能"硬猜"。
 * - 从右往左只剥**一段**哈希尾：文件名自己以 `-<64 位十六进制>` 结尾时，
 *   key 是 `…-<那一段>-<真哈希>.<ext>`，剥完恰好还原。
 * - 入参可以是路径（Windows 反斜杠也认）—— 只取最后一段。
 */
export function displayNameForKey(key: unknown): string {
	const raw = typeof key === "string" ? key.trim() : "";
	if (!raw) return "";
	const segment = raw.split(/[\\/]/).pop() ?? "";
	const match = HASH_TAIL_PATTERN.exec(segment);
	if (!match) return "";
	return `${match[1]}${match[3] ?? ""}`;
}

/**
 * 从对象 key 里取出**内容哈希**（两代命名都能取）；取不到返回 `null`。
 *
 * 存在的理由：key 是"同一份内容"在云端的身份，而按内容判"这个文件是不是我们
 * 已经传过的"必须能**从 key 反推出哈希** —— 但名字进了 key 之后哈希不再独占整个 key
 * （`报告-<哈希>.pdf`），于是这件事需要一处明确定义，而不是各处自己 slice。
 *
 * - 默认形状（`<名字>-<完整哈希>[.<扩展名>]`）⇒ 取哈希段；
 * - 老形状（`<完整哈希>[.<扩展名>]`）⇒ 整个基名就是哈希；
 * - 都不是（1.2.0 之前用户自定义过模板、且 key 与内容无可推导关系）⇒ `null`。
 *   ⚠️ **这是刻意的"取不到"**：调用方必须按"无法判断"处理（不能猜、不能拿名字当哈希）。
 */
export function hashFromKey(key: unknown): string | null {
	const raw = typeof key === "string" ? key.trim() : "";
	if (!raw) return null;
	const segment = raw.split(/[\\/]/).pop() ?? "";
	const named = HASH_TAIL_PATTERN.exec(segment);
	if (named) return named[2];
	const pure = PURE_HASH_PATTERN.exec(segment);
	if (pure) return pure[1];
	return null;
}
