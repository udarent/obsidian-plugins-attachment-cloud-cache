/**
 * vault 里的文件命名与落盘助手（纯函数 + 一个注入 `exists` 的唯一化函数）。
 *
 * ## 为什么单独一层，而且必须是**共用**的
 *
 * 同一张图会被两条不同的路径写进 vault：
 * - **粘贴/拖拽**：我们先把字节落到附件目录，上传成功后再搬进缓存；
 * - **上传已有附件**（P1 的批量迁移）：文件本来就在附件目录里，我们改的是笔记与索引。
 *
 * 两条路如果各自实现"扩展名怎么推""重名怎么办"，就会**分叉**：
 * 同一张图的副本落在两个不同路径，索引只认得其中一个，另一个永远清不掉。
 * 上一轮的教训正是"两条路要用同一个路径推导函数"，所以这里集中一次。
 *
 * ## 为什么不复用 Obsidian 的 `getAvailablePathForAttachment`
 *
 * 那个 API 好用，但它**不保证返回值未被占用**（官方文档明说可能已存在），
 * 而且不同版本/移动端上行为有差异。我们已经必须自己判唯一性（因为缓存路径
 * 完全是我们自己算的），那就两条路都用同一套判据，别一半靠宿主一半靠自己。
 *
 * ⚠️ 附件目录的**位置**也不再问那个 API 了：真机实测它返回 Promise，
 * 而且目标目录已存在时会抛 `Folder already exists.` —— 详见 `core/ingest.ts` 的
 * `hostAttachmentFolder`（现在读的是宿主自己的 `attachmentFolderPath` 配置）。
 * 这里只负责"文件名唯一化"这一步。
 */

import { normalizePath } from "obsidian";

/**
 * 宿主**能直接预览（嵌入）**的附件类型分档。
 *
 * ## 为什么这张表必须硬编码，而且必须带出处
 *
 * 宿主内部有一张 `embedRegistry`（决定 `![[x.ext]]` 渲染成什么元素），
 * 但它**没有进公开类型面**（`obsidian.d.ts` 里搜不到）⇒ 只能自己维护一张表。
 * 表一旦与宿主不一致，后果分两类，方向相反：
 * - 表里多写了宿主不认的类型 ⇒ 我们生成 `![]()`，宿主渲染成一个**坏图**（原则④要避免的）；
 * - 表里漏写了宿主认的类型 ⇒ 退化成普通链接，用户要点一下才能看（体验打折但不坏）。
 * 所以这张表**宁可保守**：只列已核实的。
 *
 * ## 证据与重推方法（进维护手册）
 *
 * 来源：`Obsidian 1.14.4` 的 `app.asar` 载荷复核（2026-10-09，见 `dev-notes/maintainer-handbook.md`
 * 的"可嵌入类型表"一节）。复核时注意**认载荷**：宿主自更新会把新 asar 放进
 * `%APPDATA%\obsidian\` 运行时加载，只看 `Program Files` 下那份会得到过期结论。
 *
 * ⚠️ `tiff` / `heic` / `ico` **确认不可嵌入**（在 `1.14.4` 上实测）——
 * 它们在 1.1.0 之前被当成"图片"嵌进笔记，现在必须是**普通链接**：
 * 这是对老用户**可见**的行为变化，发版说明里写明。
 */
export type EmbedKind = "image" | "audio" | "video" | "pdf";

const EMBED_KIND_BY_EXTENSION: Record<string, EmbedKind> = {
	// 图片
	avif: "image",
	bmp: "image",
	gif: "image",
	jpeg: "image",
	jpg: "image",
	png: "image",
	svg: "image",
	webp: "image",
	// 音频
	"3gp": "audio",
	flac: "audio",
	m4a: "audio",
	mp3: "audio",
	oga: "audio",
	ogg: "audio",
	opus: "audio",
	wav: "audio",
	// 视频
	mkv: "video",
	mov: "video",
	mp4: "video",
	ogv: "video",
	webm: "video",
	// 文档
	pdf: "pdf",
};

/**
 * 这个扩展名能不能被宿主**直接预览**；不能则返回 `null`（调用方走普通链接）。
 *
 * 输入容错（去点、小写、去空白）与 `contentTypeForExtension` 一致：
 * 调用方拿到的扩展名可能来自文件名、MIME 反查或用户配置，写法不统一。
 * 非字符串 / 空串 / 未知一律 `null` —— **未知类型走普通链接**是原则④的落法。
 */
export function embedKindFor(ext: unknown): EmbedKind | null {
	if (typeof ext !== "string") return null;
	const key = ext.trim().toLowerCase().replace(/^\./, "");
	return EMBED_KIND_BY_EXTENSION[key] ?? null;
}

/** 便利判据：能不能嵌入（供链接生成与渲染层共用，避免各处自己写 `!== null`）。 */
export function isEmbeddable(ext: unknown): boolean {
	return embedKindFor(ext) !== null;
}

/**
 * 把"可能是路径的东西"归一成宿主认得的写法。
 *
 * ## 为什么必须走宿主的 `normalizePath()`
 *
 * 审计与淘汰都要拿**索引里记的路径**与**磁盘上枚举到的路径**做字符串比较
 *（同一个副本在两边写法不同，就会被判成"孤儿"或"缺失"）。而往索引里写路径的
 * 是宿主自己 —— 所以归一必须用**它用的那套规则**，而不是我们另写一套。
 * 官方 guideline 也正是这么要求的：接受用户提供的 vault 路径时必须过 `normalizePath()`。
 *
 * ## ⚠️ 这里替掉了原来的两份私有实现
 *
 * `maintenance/audit.ts` 与 `maintenance/eviction.ts` 原本各有一个
 * `normalize(path)`，只处理反斜杠与前导斜杠 —— 于是 `a//b`、`a/` 这类写法
 * 与宿主的写法**对不上**。差别是真实存在的（新实现把它们折成 `a/b`、`a`），
 * 而且它顺手把"用户从 Windows 粘过来的反斜杠路径"也一并处理了。
 *
 * 非字符串一律给空串：调用方拿它当"没有路径"用（索引记录里可能缺字段）。
 */
export function normalizeVaultPath(path: unknown): string {
	return typeof path === "string" ? normalizePath(path) : "";
}

/**
 * 扩展名 → 默认 Content-Type。
 *
 * ## 为什么要补齐（原表只有图片）
 *
 * 1.1.0 起所有类型都上传。而对象存储把 `Content-Type` 头原样回给浏览器：
 * 声明成 `application/octet-stream` 时，**浏览器一律下载而不是显示** ——
 * 用户点开一个 PDF 链接却得到一个下载框，会以为插件坏了。
 * 补齐后：PDF/音视频/文本在浏览器里**直接可看**，其余类型仍是下载（那是它们的正常行为）。
 *
 * ⚠️ 仍然覆盖不到的类型落 {@link DEFAULT_CONTENT_TYPE}（安全默认，不变）：
 * 与其猜一个类型（猜错可能让浏览器把二进制当文本渲染），不如老实说"这是二进制"。
 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
	// 图片
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	heic: "image/heic",
	ico: "image/x-icon",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	svg: "image/svg+xml",
	tiff: "image/tiff",
	webp: "image/webp",
	// 音频
	"3gp": "audio/3gpp",
	aac: "audio/aac",
	flac: "audio/flac",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	oga: "audio/ogg",
	ogg: "audio/ogg",
	opus: "audio/opus",
	wav: "audio/wav",
	// 视频
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	mov: "video/quicktime",
	mp4: "video/mp4",
	ogv: "video/ogg",
	webm: "video/webm",
	// 文档与压缩包
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	epub: "application/epub+zip",
	odt: "application/vnd.oasis.opendocument.text",
	pdf: "application/pdf",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	// 压缩包
	"7z": "application/x-7z-compressed",
	gz: "application/gzip",
	rar: "application/vnd.rar",
	tar: "application/x-tar",
	zip: "application/zip",
	// 文本类（浏览器可直接显示）
	csv: "text/csv",
	html: "text/html",
	json: "application/json",
	md: "text/markdown",
	txt: "text/plain",
	xml: "application/xml",
};

/** 上传不认识的后缀时的兜底类型（对象存储要求这个头）。 */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * MIME → 扩展名（与上面那张表**成对**维护：站外抓取时只有 MIME、没有文件名）。
 *
 * 补齐到与 `CONTENT_TYPE_BY_EXTENSION` 同一批类型 —— 理由是同一条：
 * 站外抓一个 PDF/音频时，名字是 URL 的最后一段（常常没有可用扩展名），
 * 只能靠响应头里的 MIME 反推。反推不出来就会存成 `<哈希>.bin`，
 * 于是缓存目录里那个文件在 Obsidian 里**不显示**（它不认识的类型）。
 *
 * 同一 MIME 有多个候选扩展名时取**最常见**的那个（`image/jpeg` → `jpg`），
 * 因为这个名字会被用户看到。
 */
const EXTENSION_BY_MIME: Record<string, string> = {
	// 图片
	"image/avif": "avif",
	"image/bmp": "bmp",
	"image/gif": "gif",
	"image/heic": "heic",
	"image/heif": "heic",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/svg+xml": "svg",
	"image/tiff": "tiff",
	"image/webp": "webp",
	"image/x-icon": "ico",
	"image/vnd.microsoft.icon": "ico",
	// 音频
	"audio/3gpp": "3gp",
	"audio/aac": "aac",
	"audio/flac": "flac",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/ogg": "ogg",
	"audio/opus": "opus",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	// 视频
	"video/mp4": "mp4",
	"video/ogg": "ogv",
	"video/quicktime": "mov",
	"video/webm": "webm",
	"video/x-matroska": "mkv",
	"video/x-msvideo": "avi",
	// 文档与压缩包
	"application/epub+zip": "epub",
	"application/gzip": "gz",
	"application/json": "json",
	"application/msword": "doc",
	"application/pdf": "pdf",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.rar": "rar",
	"application/x-7z-compressed": "7z",
	"application/x-tar": "tar",
	"application/xml": "xml",
	"application/zip": "zip",
	// 文本类
	"text/csv": "csv",
	"text/html": "html",
	"text/markdown": "md",
	"text/plain": "txt",
	"text/xml": "xml",
};

/** 由扩展名给 Content-Type。空扩展名 / 未知扩展名 → 兜底类型。 */
export function contentTypeForExtension(ext: unknown): string {
	if (typeof ext !== "string") return DEFAULT_CONTENT_TYPE;
	const key = ext.trim().toLowerCase().replace(/^\./, "");
	return CONTENT_TYPE_BY_EXTENSION[key] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * "长得像扩展名"的判据：纯字母数字、最多 8 个字符。
 *
 * 上限 8 是为了容纳真实的长扩展名（`.canvas` 6、`.heic`/`.tiff`/`.webp` 4、
 * `.flac`/`.docx`/`.pptx` 4），同时把"点后面那一串令牌"挡在外面。
 */
export const PLAUSIBLE_EXTENSION = /^[a-z0-9]{1,8}$/;

/**
 * 取文件名的扩展名（小写、不含点）。
 *
 * ⚠️ 前导点是"隐藏文件"而不是扩展名：`.gitignore` 的扩展名是**空**，
 * 不是 `gitignore`。否则一个隐藏文件会被当成 `gitignore` 类型，
 * 拼出的 key 与缓存文件名都会莫名其妙。
 *
 * ## ⭐⭐ "最后一个点之后的东西"**不一定是扩展名**
 *
 * 这条是实测报出来的：外站图片的 URL 经常是这种形状（Bing 的图片 CDN 就是）——
 *
 * ```
 * .../th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208&h=169
 * ```
 *
 * 最后一段**自己带一个点**，点后面是一串 23 个字符的令牌，**不是类型**。
 * 按"取最后一个点之后的部分"算出来的"扩展名"于是变成
 * `spb8lvtxu-zleqgemugctwaaaa`，后果一路传下去：
 *
 * - 上传到对象存储的名字成了 `<哈希>.spb8lvtxu-zleqgemugctwaaaa`；
 * - 缓存目录里的本地副本也是这个名字 —— 而 **Obsidian 默认不显示它不认识的扩展名**，
 *   于是用户在缓存目录里**看不到**这张图被缓存了（他会以为功能没生效）；
 * - 由文件名推 Content-Type 时也永远推不出 `image/png`。
 *
 * 所以这里加一道形状检查：**不像扩展名就当"取不到"**，返回空串，
 * 让 {@link resolveExtension} 退到 MIME —— 对图片来说那才是唯一可靠的类型来源。
 *
 * 刻意**不用"必须是我们认识的扩展名"**那种更严的判据：用户可以在设置里加任意扩展名，
 * 拿一张我们内置的表去否决他，会让合法的自定义类型静默变成 `bin`。
 * 形状检查只否决"明显不是扩展名"的东西，不否决"我们没见过"的东西。
 */
export function extensionOfName(name: unknown): string {
	if (typeof name !== "string") return "";
	const base = name.trim().split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	const candidate = base.slice(dot + 1).toLowerCase();
	return PLAUSIBLE_EXTENSION.test(candidate) ? candidate : "";
}

/** 由 MIME 推扩展名；推不出返回空串（由调用方决定兜底）。 */
export function extensionFromMime(mime: unknown): string {
	if (typeof mime !== "string") return "";
	// 去掉参数部分（`image/png; charset=binary`）
	const bare = mime.split(";")[0].trim().toLowerCase();
	return EXTENSION_BY_MIME[bare] ?? "";
}

/**
 * 扩展名的**最终**判定：文件名优先，其次 MIME。
 *
 * 顺序很重要，且理由不是"文件名更可信"：
 * 截图粘贴（macOS 的 Cmd+Shift+4 → 粘贴）在剪贴板里往往**只有 MIME、没有文件名**，
 * 而反向的情况（有名字但 MIME 是 `application/octet-stream`）也很常见
 * ——比如从某些下载器里拖出来。两者都取、先看名字，
 * 才能同时覆盖这两个最常见的场景。只看任一个都会整体漏掉一类。
 */
export function resolveExtension(name: unknown, mime: unknown): string {
	return extensionOfName(name) || extensionFromMime(mime);
}

/** 上传要声明的 Content-Type：优先用浏览器/宿主给的 MIME，否则按扩展名推。 */
export function resolveContentType(name: unknown, mime: unknown): string {
	if (typeof mime === "string" && mime.trim() !== "" && mime !== DEFAULT_CONTENT_TYPE) {
		return mime.split(";")[0].trim();
	}
	return contentTypeForExtension(resolveExtension(name, mime));
}

/** 粘贴时没有文件名，用 MIME 造一个可读的名字（截图粘贴是最常见的场景）。 */
export function fallbackFileName(ext: unknown, at?: Date): string {
	const suffix = typeof ext === "string" && ext.trim() !== "" ? `.${ext.trim().toLowerCase()}` : "";
	const stamp = (at ?? new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
	return `Pasted image ${stamp}${suffix}`;
}

/** 取父目录（vault 相对路径）；顶层则返回空串。 */
export function parentFolderOf(path: unknown): string {
	if (typeof path !== "string") return "";
	const clean = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const slash = clean.lastIndexOf("/");
	return slash === -1 ? "" : clean.slice(0, slash);
}

/** 拆成 `[主干, 扩展名（含点，可能为空）]`。 */
function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return [name, ""];
	return [name.slice(0, dot), name.slice(dot)];
}

/** 尝试次数上限。到这个量级说明用户真的堆了上千个同名文件，不该再无限试下去。 */
const MAX_UNIQUE_ATTEMPTS = 1000;

/**
 * 生成一个**未被占用**的路径，绝不覆盖已有文件。
 *
 * `a.png` → `a 1.png` → `a 2.png` …（与 Obsidian 自己的同名策略一致，
 * 用户看到过的行为就是"加个序号"，我们不要发明新花样）。
 *
 * ⚠️ 为什么必须"绝不覆盖"：粘贴路径下我们是**先落盘再上传**的。
 * 若这里允许覆盖，用户粘贴一张图就可能抹掉一个**同名的、完全无关的**已有文件
 * —— 而那个文件可能没有任何其它副本。这是本项目里少数会造成不可逆数据损失的操作。
 *
 * `exists` 是注入的，且**允许异步** —— 因为真实实现必须同时看两处：
 * 宿主的文件索引（同步）与磁盘（异步）。只看索引会漏掉"磁盘上有、索引里还没有"的文件，
 * 而那正是宿主索引滞后时的常态，恰好也是最危险的情形（会覆盖一个真实存在的文件）。
 *
 * ⚠️ 别把 `exists` 写成"只看磁盘"：Obsidian 刚 `create` 出来但还没落盘的文件
 * 在索引里存在、磁盘上可能还没有，只看磁盘同样会撞名。
 */
export async function uniqueVaultPath(
	desired: string,
	exists: (path: string) => boolean | Promise<boolean>
): Promise<string> {
	const clean = String(desired ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
	if (!clean) throw new Error("uniqueVaultPath 需要一个非空目标路径");

	if (!(await exists(clean))) return clean;

	const folder = parentFolderOf(clean);
	const name = clean.slice(folder ? folder.length + 1 : 0);
	const [stem, ext] = splitExtension(name);
	const prefix = folder ? `${folder}/` : "";

	for (let n = 1; n <= MAX_UNIQUE_ATTEMPTS; n += 1) {
		const candidate = `${prefix}${stem} ${n}${ext}`;
		if (!(await exists(candidate))) return candidate;
	}

	// 到这一步说明上千个同名文件都占着 —— 与其静默覆盖或死循环，
	// 不如明确失败。调用方（粘贴处理器）会把它当成"无法安全落盘"，
	// 从而走"保留本地 + 报错"的分支，而不是丢数据。
	throw new Error(`无法为 ${clean} 找到可用路径（已尝试 ${MAX_UNIQUE_ATTEMPTS} 次）`);
}
