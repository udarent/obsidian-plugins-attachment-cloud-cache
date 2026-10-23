/**
 * vault 里的文件命名与落盘助手（纯函数 + 一个注入 `exists` 的唯一化函数）。
 *
 * ## 为什么单独一层，而且必须是**共用**的
 *
 * 同一张图会被两条不同的路径写进 vault：
 * - **粘贴/拖拽**：我们先把字节落到附件目录 —— ⚠️ 1.2.0（D-17）起那份字节**原地就是**本地
 *   副本，没有"上传成功后再搬进缓存"这一步了；
 * - **上传附件**：文件本来就在附件目录里，我们改的是笔记与索引。
 *
 * 两条路如果各自实现"扩展名怎么推""重名怎么办"，就会**分叉**：
 * 同一张图的副本落在两个不同路径，索引只认得其中一个，另一个永远清不掉。
 * 上一轮的教训正是"两条路要用同一个路径推导函数"，所以这里集中一次。
 *
 * ## 为什么不复用 Obsidian 的 `getAvailablePathForAttachment`
 *
 * 那个 API 好用，但它**不保证返回值未被占用**（官方文档明说可能已存在），
 * 而且不同版本/移动端上行为有差异。我们已经必须自己判唯一性，那就两条路都用
 * 同一套判据，别一半靠宿主一半靠自己。
 *
 * ⚠️ 附件目录的**位置**也不再问那个 API 了：真机实测它返回 Promise，
 * 而且目标目录已存在时会抛 `Folder already exists.` —— 详见**本模块**的
 * `hostAttachmentFolder`（现在读的是宿主自己的 `attachmentFolderPath` 配置）。
 * 这里只负责"文件名唯一化"这一步。
 */

/**
 * ## 模块地图（四组，各答一个问题）
 *
 * 1. **类型元数据**：扩展名 → `Content-Type`（{@link CONTENT_TYPE_BY_EXTENSION}），
 *    以及"宿主能不能直接预览"（{@link EMBED_KIND_BY_EXTENSION}）。
 *    ⚠️ 两张表**刻意不合并**：一张答"我该声明成什么"，一张答"宿主渲染得出来吗"，
 *    后者的每一行都要宿主侧证据（见它自己的说明）。反向表由前者派生。
 * 2. **判据**（这算不算附件）：笔记类 {@link isNoteLikeExtension}、程序分发
 *    {@link isProgramExtension}、网页 {@link isWebPageExtension} —— 三个**黑名单**，
 *    共同点是"语义上不是笔记要托管的资料"，与"像不像一个文件"是两个问题。
 * 3. **扩展名解析**：从文件名 / MIME / URL 里取扩展名，以及"像不像一个扩展名"的形状判据。
 * 4. **库内路径与命名**：路径归一、父目录、唯一化、宿主的附件目录。
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
 * 来源：`Obsidian 1.14.4` 的 `app.asar` 载荷复核（2026-10-09）
 * 复核时注意**认载荷**：宿主自更新会把新 asar 放进
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
 * 扩展名的**唯一**归一化入口：去首尾空白、统一小写、去掉可能带着的那个点。
 *
 * ⭐ 收在一处是刻意的：调用方给的"扩展名"写法从来不统一 ——
 * 可能来自 `file.extension`（无点）、`extensionOfName`（无点）、用户手写的 `.PNG`
 * （大写带点）、或设置界面里那一串。这个文件里已经有 **4 个**消费者
 *（{@link embedKindFor} / {@link isNoteLikeExtension} / {@link isWebPageExtension} /
 * {@link contentTypeForExtension}），此前**各写一遍**同一行、靠注释人肉保持一致 ——
 * 而分叉的症状是"某条入口偏偏漏了这一类"，**不报错**。
 *
 * ⚠️ 非字符串给**空串**（不是抛出、也不是 `String(ext)`）：空串在所有消费者那里
 * 都落到"未知"那一档，这正是我们要的答案。
 */
function normalizeExtension(extension: unknown): string {
	if (typeof extension !== "string") return "";
	return extension.trim().toLowerCase().replace(/^\./, "");
}

/**
 * 这个扩展名能不能被宿主**直接预览**；不能则返回 `null`（调用方走普通链接）。
 *
 * 输入容错（去点、小写、去空白）交给 {@link normalizeExtension}：
 * 非字符串 / 空串 / 未知一律 `null` —— **未知类型走普通链接**是原则④的落法。
 */
export function embedKindFor(ext: unknown): EmbedKind | null {
	if (typeof ext !== "string") return null;
	const key = normalizeExtension(ext);
	return EMBED_KIND_BY_EXTENSION[key] ?? null;
}

/** 便利判据：能不能嵌入（供链接生成与渲染层共用，避免各处自己写 `!== null`）。 */
export function isEmbeddable(ext: unknown): boolean {
	return embedKindFor(ext) !== null;
}

/**
 * 这些扩展名是**宿主自己的文本文件**，不是用户的附件。
 *
 * ## 两个入口，同一条理由
 *
 * - **库内**（`selectUploadCandidates`）：一个 `.md` 被当附件上传，它**正文里的链接会被
 *   改写成远端地址**（那条命令的本职），而宿主仍按后缀把它当笔记索引 ⇒ 结果是一篇笔记
 *   被当成图片对象，笔记之间的 wikilink 也跟着断掉。`.canvas` 同理（它引用别的文件），
 *   `.base` 是数据库。
 * - **站外**（`decideExternalCache`）：把远程的 `.md` 搬下来，那份会**落进库里**变成一篇
 *   笔记（同一个后缀判据）—— 用户要的只是"收藏那个文件"，而他的库里凭空多出一篇笔记。
 *   2026-10-16 用户实测报的正是这一条：笔记里链接的远程 `.md` 出现在
 *   「上传附件」的清单里。
 *
 * 用**扩展名**而不是 MIME/内容判断：这一步是纯判定（不读文件字节），
 * 而这三类后缀是宿主的约定（宿主自己也按后缀识别它们）。
 */
const NOTE_LIKE_EXTENSIONS = new Set(["md", "canvas", "base"]);

/**
 * 这个扩展名是不是"宿主自己的文本文件"（笔记 / 画布 / 数据库）—— 见上面的说明。
 *
 * 输入容错（去点、小写、去空白）交给 {@link normalizeExtension}：调用方给的"扩展名"
 * 可能来自 `file.extension`（无点）、`extensionOfName`（无点）或别处的原始写法，
 * 几个兄弟判据对同一种输入该有同样的答案 —— 一个容忍、一个不容忍，
 * 症状是"某条入口偏偏漏了这一类"，且不报错。
 */
export function isNoteLikeExtension(extension: unknown): boolean {
	return NOTE_LIKE_EXTENSIONS.has(normalizeExtension(extension));
}

/**
 * 上面那条判据的**唯一文案**（诊断用，进各层的 `skipped` 统计）。
 *
 * ⚠️ 两个调用点（库内候选 / 站外判定）**共用同一个字符串**：同一件事不该有两种说法 ——
 * 两份文案漂开之后，"为什么它没被处理"就要看好几处才答得上，而且没人会发现它们不一致。
 */
export const NOTE_LIKE_REASON = "是笔记/画布/数据库文件，不是附件";

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
 * `maintenance/eviction.ts` 与当时那个本地副本审计模块（`audit.ts`，2026-10-22 / D-75 已删）原本各有一个
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
	apng: "image/apng",
	avif: "image/avif",
	bmp: "image/bmp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	ico: "image/x-icon",
	jfif: "image/jpeg",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	jxl: "image/jxl",
	png: "image/png",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	webp: "image/webp",
	// 音频
	"3gp": "audio/3gpp",
	aac: "audio/aac",
	aiff: "audio/aiff",
	amr: "audio/amr",
	flac: "audio/flac",
	m4a: "audio/mp4",
	m4b: "audio/mp4",
	mid: "audio/midi",
	midi: "audio/midi",
	mp3: "audio/mpeg",
	oga: "audio/ogg",
	ogg: "audio/ogg",
	opus: "audio/opus",
	wav: "audio/wav",
	wma: "audio/x-ms-wma",
	// 视频
	avi: "video/x-msvideo",
	flv: "video/x-flv",
	m4v: "video/x-m4v",
	mkv: "video/x-matroska",
	mov: "video/quicktime",
	mp4: "video/mp4",
	mpeg: "video/mpeg",
	mpg: "video/mpeg",
	ogv: "video/ogg",
	webm: "video/webm",
	wmv: "video/x-ms-wmv",
	// 文档（常见办公格式 + 两种 ODF）
	doc: "application/msword",
	docm: "application/vnd.ms-word.document.macroEnabled.12",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
	key: "application/vnd.apple.keynote",
	numbers: "application/vnd.apple.numbers",
	odg: "application/vnd.oasis.opendocument.graphics",
	odp: "application/vnd.oasis.opendocument.presentation",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odt: "application/vnd.oasis.opendocument.text",
	pages: "application/vnd.apple.pages",
	pdf: "application/pdf",
	potx: "application/vnd.openxmlformats-officedocument.presentationml.template",
	ppt: "application/vnd.ms-powerpoint",
	pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	rtf: "application/rtf",
	xls: "application/vnd.ms-excel",
	xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
	xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	// 电子书 / 漫画
	azw3: "application/vnd.amazon.ebook",
	cbr: "application/vnd.comicbook-rar",
	cbz: "application/vnd.comicbook+zip",
	djvu: "image/vnd.djvu",
	epub: "application/epub+zip",
	fb2: "application/x-fictionbook+xml",
	mobi: "application/x-mobipocket-ebook",
	// 压缩包
	"7z": "application/x-7z-compressed",
	bz2: "application/x-bzip2",
	cab: "application/vnd.ms-cab-compressed",
	gz: "application/gzip",
	rar: "application/vnd.rar",
	tar: "application/x-tar",
	tgz: "application/gzip",
	xz: "application/x-xz",
	zip: "application/zip",
	zst: "application/zstd",
	// 文本与源码
	//
	// ⚠️ 源码一律 **`text/plain`**，**不**映射成 `text/javascript` 之类可执行的类型：
	// 桶可能是公开读的，`text/javascript` 会让浏览器**执行**那份用户上传的文件。
	// 声明成纯文本，行为正好是我们要的（点开直接看到代码）。
	bat: "text/plain",
	bib: "text/plain",
	c: "text/plain",
	conf: "text/plain",
	cpp: "text/plain",
	cs: "text/plain",
	css: "text/css",
	csv: "text/csv",
	go: "text/plain",
	h: "text/plain",
	htm: "text/html",
	html: "text/html",
	ini: "text/plain",
	java: "text/plain",
	js: "text/plain",
	jsx: "text/plain",
	json: "application/json",
	log: "text/plain",
	markdown: "text/markdown",
	md: "text/markdown",
	org: "text/plain",
	pl: "text/plain",
	ps1: "text/plain",
	py: "text/plain",
	rb: "text/plain",
	rs: "text/plain",
	rst: "text/plain",
	sh: "text/plain",
	sql: "text/plain",
	tex: "text/plain",
	toml: "application/toml",
	tsv: "text/tab-separated-values",
	tsx: "text/plain",
	txt: "text/plain",
	xml: "application/xml",
	yaml: "application/yaml",
	yml: "application/yaml",
	// 字幕 / 日历 / 名片
	ass: "text/plain",
	ics: "text/calendar",
	lrc: "text/plain",
	srt: "text/plain",
	ssa: "text/plain",
	vcf: "text/vcard",
	vtt: "text/vtt",
	// 数据与笔记本
	geojson: "application/geo+json",
	gpx: "application/gpx+xml",
	ipynb: "application/x-ipynb+json",
	kml: "application/vnd.google-earth.kml+xml",
	parquet: "application/vnd.apache.parquet",
	sqlite: "application/vnd.sqlite3",
	// 字体
	otf: "font/otf",
	ttf: "font/ttf",
	woff: "font/woff",
	woff2: "font/woff2",
	// 设计 / CAD / 3D
	"3mf": "model/3mf",
	blend: "application/x-blender",
	dwg: "image/vnd.dwg",
	dxf: "image/vnd.dxf",
	glb: "model/gltf-binary",
	gltf: "model/gltf+json",
	obj: "model/obj",
	step: "model/step",
	stl: "model/stl",
	stp: "model/step",
	// 程序分发（只有**库内 / 本机**这两条路会传它们，见 `PROGRAM_EXTENSIONS`）
	apk: "application/vnd.android.package-archive",
	deb: "application/vnd.debian.binary-package",
	dmg: "application/x-apple-diskimage",
	exe: "application/vnd.microsoft.portable-executable",
	iso: "application/x-iso9660-image",
	msi: "application/x-msi",
	rpm: "application/x-rpm",
};

/**
 * ⚠️ **刻意不补**的那些后缀（各有理由，别顺手加）：
 * - `ts` —— **有歧义**：既是 TypeScript 源码，也是 MPEG-TS 视频。声明成任一种都会把另一半说错，
 *   所以留在 {@link DEFAULT_CONTENT_TYPE}（通用二进制）；
 * - `bin` / `dat` / `z01` / `db` / `jar` / `rmvb` / `fbx` / `xmind` / `fig` / `sketch` / `xd` /
 *   `wps` / `et` / `dps` —— 没有公认的 MIME（或各家自造），猜一个不如老实说"这是二进制"；
 * - `php` / `jsp` / `asp` / `aspx` / `cgi` / `do` / `action` —— 它们是**服务端页面**的后缀
 *   （见 `PAGE_EXTENSIONS`）。库里那份是源码，但同一个后缀在站外被判成页面，
 *   这里再声明一个文本类型只会让两个判断看起来矛盾。
 */

/** 上传不认识的后缀时的兜底类型（对象存储要求这个头）。 */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * 这些后缀指向的是**可执行程序 / 安装包 / 系统镜像** —— 不是笔记要托管的"资料"。
 *
 * ## 为什么要有这一张表（D-58，2026-10-21 用户实测报的）
 *
 * 他在一篇笔记里写了 `[下载地址](https://…/Cherry-Studio-0.9.19-setup.exe)`，
 * 而「上传附件」的清单把这条 **84.6 MB 的安装包**列了出来（真机 HEAD 实测：
 * `application/octet-stream` + `Content-Disposition: attachment`）。确认之后会：
 * 下载 84 MB → 传进桶 → 库里留一份 84 MB 副本 → 把「下载地址」改成桶地址。
 * 他要的是"笔记里的资料跟着笔记走"，不是"把我的桶变成软件分发站"。
 *
 * ## ⚠️ 这是**黑名单**，不是白名单 —— 方向必须记清楚
 *
 * ⚠️⚠️ 这里的判据**不是**"我们认不认识这个后缀"。类型表外的**真实资料**
 *（`.psd` / `.dwg` / `.sketch` / `.mobi` / `.bin`…）照旧进清单 —— 白名单式的判据
 * 会**静默少列**（用户既看不到也不报错），本项目的既有纪律见 `external-decide.ts` 那段。
 * 这张表只收一类东西：**程序分发**（安装包与镜像）。它们不是"形状可疑"，而是
 * **语义上就不是笔记资料**（与"像不像一个文件"是两个问题）。
 *
 * ⚠️ `.bin` **刻意不在表里**：它同时是固件 / 裸数据（这个仓库的用户就在做 FPGA），
 * 拦掉会让真实资料静默消失。同理 `.jar`（既可能是程序，也可能是别人给的库）。
 */
const PROGRAM_EXTENSIONS = new Set([
	// 可执行程序与安装包
	"appimage",
	"appx",
	"appxbundle",
	"dmg",
	"deb",
	"exe",
	"ipa",
	"mpkg",
	"msi",
	"msp",
	"msix",
	"msixbundle",
	"pkg",
	"rpm",
	"snap",
	"apk",
	"aab",
	// 磁盘 / 系统镜像
	"esd",
	"img",
	"iso",
	"vhd",
	"vhdx",
	"vmdk",
	"wim",
]);

/**
 * 这个后缀是不是**程序分发**（安装包 / 可执行程序 / 系统镜像）—— 见 {@link PROGRAM_EXTENSIONS}。
 *
 * 输入容错（去点、小写、去空白）交给 {@link normalizeExtension}，与兄弟判据一致 ——
 * 一个容忍、一个不容忍的症状是"某条入口偏偏漏了这一类"，且不报错。
 */
export function isProgramExtension(extension: unknown): boolean {
	return PROGRAM_EXTENSIONS.has(normalizeExtension(extension));
}

/**
 * 上面那条判据的**唯一文案**（诊断用，进 `skipped` 统计）。
 *
 * ⚠️ "安装包/镜像"这两个词要留着：文案是用户唯一能看到"为什么我的链接没被处理"的线索。
 */
export const PROGRAM_REASON = "地址是安装包或系统镜像（不是笔记里的资料）";

/**
 * 这些后缀指向的是一张**网页**，而不是一个可供下载的文件。
 *
 * 判据分两半，合起来回答同一个问题（"这条地址指向的是页面，还是文件"）：
 *
 * 1. **静态页面** —— `html` / `htm` 就是类型表里那两条（`text/html`），
 *    所以这里**不重复列**它们（见 {@link isWebPageExtension}）；
 *    `xhtml` / `shtml` 是同类写法的补齐。
 * 2. **服务端页面** —— 后缀只是**脚本语言 / 框架**的名字：`php` / `asp` / `jsp` /
 *    `do`（Struts）/ `action`（Struts2）/ `cgi` / `cfm` / `phtml`。这类地址后面常跟着
 *    查询串（`…/pd.jsp?id=172`），它到底给回一张页面还是一段字节流，**只有请求了才知道**
 *    —— 而那个"文件"形状是假象：内容是**现算**出来的。
 *
 * ⭐ 为什么要有第 2 半（2026-10-16 用户**第三次**实测报的）：他笔记里
 * `[原文链接](https://www.pmbj.com.cn/pd.jsp?id=172#:~:text=…)` —— 尾巴有点、
 * 能过"像个文件名"那条（`urlLooksLikeFileName`），于是进了「上传附件」的清单，
 * 而它**永远搬不成**（下载端拿到的是 `text/html`，必拒）。用户的原话：
 * 「**实际上这是一个网页地址**」。同一次他还补了界限：
 * 「**如果是外部网站的文件下载链接，应该看做是附件才对**」——
 * ⇒ 这道闸门只拦"页面"，**绝不**碰真实的文件后缀。
 *
 * ⚠️ 边界（两个方向都有反向断言守着）：`txt` / `csv` / `json` / `xml` / `md` 这类
 * **真实文件后缀**照旧放行（能不能缓存由服务端的真实 Content-Type 说了算）；
 * `py` / `rb` / `pl` 也**不在**这一批里 —— 那是**脚本文件**（源码是可以下载的），
 * 与"页面程序"是两回事。
 */
const PAGE_EXTENSIONS = new Set([
	// 静态页面的同类写法（`html` / `htm` 由 `text/html` 那一条覆盖，见下面的函数）
	"shtml",
	"xhtml",
	// 服务端页面：后缀是脚本语言 / 框架的名字
	"action",
	"asp",
	"aspx",
	"cgi",
	"cfm",
	"do",
	"jsp",
	"jspx",
	"php",
	"php3",
	"php4",
	"php5",
	"phtml",
]);

/**
 * 这个后缀指向的是不是一张**网页**（判据见 {@link PAGE_EXTENSIONS}）。
 *
 * 静态页面那一半与**下载端**拒收网页那句（`external-cache.ts::isAttachmentResponse`
 * 里的 `text/html`）**同源**：都用 {@link CONTENT_TYPE_BY_EXTENSION} 问
 * "这个后缀的类型是不是 `text/html`" —— 于是"哪些后缀是网页"里，
 * 能被类型表回答的那部分全库仍然只有一处定义。
 */
export function isWebPageExtension(extension: unknown): boolean {
	const ext = normalizeExtension(extension);
	if (!ext) return false;
	return CONTENT_TYPE_BY_EXTENSION[ext] === "text/html" || PAGE_EXTENSIONS.has(ext);
}

/**
 * MIME → 扩展名：**从上面那张表派生**，不再手写第二份（D-65，2026-10-22）。
 *
 * ## 为什么改成派生
 *
 * 原来是**两张手写的表**（扩展名→类型、MIME→扩展名），靠注释里一句"成对维护"约束。
 * 结果是补一侧忘另一侧：2026-10-22 那次复量（D-64）一口气补了几十个类型，
 * 两张表要分别加一遍；漏了任何一边，症状都是"站外抓下来的文件存成 `<哈希>.bin`，
 * 宿主不认识那个后缀、于是**根本不显示**"—— 而且不报错。
 * 现在只有上面一张 `CONTENT_TYPE_BY_EXTENSION`，反向表在模块加载时**算出来**。
 *
 * ## 三个概念要分清（都不是"第二张表"）
 *
 * - **规范扩展名**（{@link CANONICAL_EXTENSION_BY_MIME}）：同一个 MIME 有几个候选写法时，
 *   落盘名字用哪个（`image/jpeg` → `jpg` 而不是 `jfif`）。没列出的取**正向表里第一个**。
 * - **别名**（{@link MIME_ALIASES}）：同一个东西的另一种 MIME 拼法
 *   （`image/jpg`、`text/xml`、`audio/x-wav`）—— 它们不在正向表里，只在这一侧出现。
 * - 参数部分（`image/png; charset=binary`）在 {@link extensionFromMime} 里切掉。
 */
const CANONICAL_EXTENSION_BY_MIME: Record<string, string> = {
	// 同类里有多个"像扩展名"的写法时，用户看到的那个（其余按正向表顺序取第一个）
	"audio/ogg": "ogg",
	"image/jpeg": "jpg",
	"image/tiff": "tiff",
	"text/markdown": "md",
	"text/plain": "txt",
	"video/mpeg": "mpg",
};

/**
 * 同一个 MIME 的**别名写法**（同一个东西的另一种拼法）。
 *
 * ⚠️ 这里也是"落盘扩展名"的**覆盖位**：`image/heif` 在正向表里有自己的 `heif`，
 * 但落盘要归一到 `heic`（同一种格式的两种写法，宿主的识别面以 `heic` 为准 ——
 * 有断言钉着）。写在派生结果之上，顺序见 {@link buildExtensionByMime}。
 */
const MIME_ALIASES: Record<string, string> = {
	"audio/x-wav": "wav",
	"image/heif": "heic",
	"image/jpg": "jpg",
	"image/vnd.microsoft.icon": "ico",
	"text/xml": "xml",
};

/**
 * 由正向表 + 上面两个小表算出反向表（模块加载时一次）。
 *
 * ⚠️ 顺序**有意义**：`Object.entries` 保持插入顺序，所以"第一个列出的扩展名"是稳定的
 * （`image/png` 只有 `png`，`application/gzip` 先列 `gz` 后列 `tgz` ⇒ 取 `gz`）。
 * 靠顺序而不是再写一遍映射，正是这张表能少一份的原因。
 */
function buildExtensionByMime(): Record<string, string> {
	const derived: Record<string, string> = {};
	for (const [extension, mime] of Object.entries(CONTENT_TYPE_BY_EXTENSION)) {
		if (!(mime in derived)) derived[mime] = extension;
	}
	return { ...derived, ...CANONICAL_EXTENSION_BY_MIME, ...MIME_ALIASES };
}

const EXTENSION_BY_MIME: Record<string, string> = buildExtensionByMime();

/** 由扩展名给 Content-Type。空扩展名 / 未知扩展名 → 兜底类型。 */
export function contentTypeForExtension(ext: unknown): string {
	if (typeof ext !== "string") return DEFAULT_CONTENT_TYPE;
	const key = normalizeExtension(ext);
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
	const base = baseNameOf(name);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	const candidate = base.slice(dot + 1).toLowerCase();
	return PLAUSIBLE_EXTENSION.test(candidate) ? candidate : "";
}

/**
 * 取路径的**末尾那一段**（文件名部分）—— `extensionOfName` 与 {@link looksLikeFileName} 共用。
 *
 * ⚠️ 收在一处是刻意的：这两条判据问的是同一个"末尾那段"，
 * 各写一遍 `split(/[\\/]/)` 迟早分叉成"一个认 `a\b`、一个不认"。
 * 非字符串返回空串（两条判据的输入都可能来自外部数据）。
 */
function baseNameOf(name: unknown): string {
	if (typeof name !== "string") return "";
	return name.trim().split(/[\\/]/).pop() ?? "";
}

/**
 * 路径的末尾那一段**像不像个文件名**：只要求那里有 `.`（`名字.后缀` 的形状），
 * **不要求后缀可信**。
 *
 * ⚠️ 与 `extensionOfName` 的差别是**刻意的**，因为两者回答的问题不同：
 * 后者决定**落盘的文件名与 Content-Type**，所以必须过 `PLAUSIBLE_EXTENSION`
 *（不像扩展名就当取不到，退到 MIME）；这里只回答"**这条地址看起来是不是一个文件**"。
 * 令牌形状的 URL（Bing CDN 那种 `OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208`
 * —— 点后面是一串令牌而不是类型）**后缀不可信，但它仍然是个文件**，
 * 用 `extensionOfName` 判会把它误伤成"不是文件"，而它恰恰是有专门落盘命名判据的一类。
 */
export function looksLikeFileName(name: unknown): boolean {
	const base = baseNameOf(name);
	return base.lastIndexOf(".") > 0;
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

/**
 * 从 URL 的**路径部分**取扩展名（不含点，小写）。取不到返回空串。
 *
 * ⚠️ 它管的是**地址**（站外文件），与库内文件名那条（`extensionOfName`）共用同一个形状判据，
 * 差别只有一处：查询串与锚点必须先切掉 —— `a.png?v=1` 的扩展名是 `png`，
 * 不是 `png?v=1`。两个消费者（下载端的形状判据 `isAttachmentResponse`、
 * 站外判定的"这是不是宿主的笔记文件"）因此看到的是**同一个**扩展名。
 *
 * 2026-10-16 从 `core/external-cache.ts` 挪来这里：`decideExternalCache` 也要用它，
 * 而 external-cache 已经 import 了 external-decide（反向 import 会成环）。
 * 归到这里之后，"扩展名怎么取"全库仍然只有一份（`extensionOfName` / `resolveExtension` / 本函数）。
 */
export function extensionFromUrl(url: unknown): string {
	if (typeof url !== "string") return "";
	return resolveExtension(urlPathOf(url), "");
}

/**
 * URL → 它的**路径部分**（切掉查询串与锚点）：`a.png?v=1` 的路径是 `a.png`。
 *
 * ⚠️ 收在一处：{@link extensionFromUrl} 与 {@link urlLooksLikeFileName} 都要它 ——
 * 各写一遍 `split("#")[0].split("?")[0]` 就会分叉成"一个切了、一个没切"
 *（症状是 `…/page?v=1` 这类地址在一个判据眼里有后缀、在另一个眼里没有）。
 */
function urlPathOf(url: string): string {
	return url.split("#")[0].split("?")[0];
}

/**
 * URL 的尾巴像不像个文件名（见 {@link looksLikeFileName}）—— 先切掉查询串与锚点。
 *
 * 用途：站外候选的**第一道形状判据** —— 从**正文文本**里读出来的地址必须像文件，
 * 否则它多半是个网页 / 目录 / 接口（如企业 wiki 的 `…/wiki/资料归档管理规定?cfw=…`）。
 *
 * ⚠️ 它只要求"尾巴里有点"，**不问那个后缀是什么**（那是 {@link urlHasFileTypeSuffix} 的事，
 * 两道合起来才够 —— 见那里的说明）。
 */
export function urlLooksLikeFileName(url: unknown): boolean {
	if (typeof url !== "string") return false;
	return looksLikeFileName(urlPathOf(url));
}

/**
 * 地址的**后缀像不像一个文件类型** —— 站外候选的**第二道**形状判据。
 *
 * ⚠️ 为什么"尾巴有点"还不够（2026-10-16 用户第五次实测报的）：
 * `https://github.com/…/redmine_translation_terms/tree/5.1-translation_terms` ——
 * 尾巴 `5.1-translation_terms` **有点**（过得了第一道），可是那个点后面是
 * `1-translation_terms`（含 `-`、十七个字符），**取不出扩展名** ⇒ 它不是文件，是**分支名**。
 * 同类：`…/tree/v1.2.3`（点后面是 `3` —— **纯数字**是版本号 / 编号的形状）、
 * `…/releases/1.0`。真实文件类型不会只由数字组成（`.7z` / `.3gp` 都带字母）。
 *
 * ⚠️⚠️ 它**不是**"这个后缀我们认不认识"（那是个**白名单**，会把类型表里没有的**真实文件**
 * —— `.exe` / `.iso` / `.bin` —— **静默**拦在清单外，用户既看不到也不报错）。
 * 2026-10-16 差一点就按白名单去修，是用户那句「如果是外部网站的文件下载链接，
 * 应该看做是附件才对」把方向掰回来的。⇒ 这里只问"**像不像**文件类型"，不问"认不认识"。
 */
export function urlHasFileTypeSuffix(url: unknown): boolean {
	const ext = extensionFromUrl(url);
	if (!ext) return false;
	return !/^[0-9]+$/.test(ext);
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

/**
 * `uniqueVaultPath` / 宿主撞名那条约定（`名字 1.ext`）的**读法**。
 *
 * 传进来的是"带序号的那一份"时，返回它对应的**原始名字**（`照片 1.png` → `照片.png`）；
 * 认不出来返回空串。纯字符串判定，**不做任何 I/O**。
 *
 * ## 为什么需要它（2026-10-14，Android 直报）
 *
 * 同一张图插第二次时，**宿主自己**会把新文件叫 `照片 1.png`（它的唯一化规矩，
 * 与 {@link uniqueVaultPath} 同一形状），于是文件名不同 ⇒ key 不同 ⇒
 * 云端多存一份完全相同的内容，笔记里两处引用还指着两个不同对象。
 *
 * ⚠️ 名字形状只是**必要条件**：`照片 1.png` 完全可能是用户自己的命名。
 * 所以调用方还必须确认"同目录下 `照片.png` 真的在、且内容一致"才做归一 ——
 * 与 `download-target.ts` 的"先比内容，再加序号"是同一条纪律的两个方向。
 */
export function baseNameForDuplicate(name: unknown): string {
	if (typeof name !== "string") return "";
	const base = name.trim().split(/[\\/]/).pop() ?? "";
	const [stem, ext] = splitExtension(base);
	// 只认"空格 + 数字"这一种（与 `uniqueVaultPath` 的写法逐字一致）：
	// `照片-2.png`、`照片(1).png` 是别人的约定，不该被我们改写。
	const match = /^(.*) (\d+)$/.exec(stem);
	if (!match) return "";
	const original = match[1];
	// ` 1.png` 这种"没有主干"的名字不算（`. trim()` 之后什么都不剩 ⇒ 归一没有意义）
	if (!/[^\s._]/.test(original)) return "";
	return `${original}${ext}`;
}

/**
 * 归一一个目录设置：统一分隔符、去掉首尾斜杠。空串 = **没填**（而不是"根目录"）。
 *
 * ⚠️ 非字符串一律当"没填"：`data.json` 是被逐字段校验过的，但这条函数也会被
 * 别处复用，而 `String(某个对象)` 会得到 `[object Object]` ——
 * 那会变成一个真实存在（却毫无意义）的目录名，且**不报错**。
 */
export function cleanFolderPath(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

/**
 * 本次落盘的**目录**（vault 相对）：宿主自己的附件位置 → vault 根目录。
 *
 * ⭐ 上传（粘贴近场文件）与回退下载（补齐缺的副本）**共用这一处**，理由与模块头
 * 那条一样：两条路各自实现"落在哪"，就会分叉成"下载的副本在上传时不再被认出来"，
 * 而索引只认得其中一条路径。
 *
 * ⚠️ 1.2.0 之前这里还有一层"用户的覆盖值"（设置项「附件目录覆盖」）。那个设置项是
 * 围着已取消的缓存目录设的，已随它一并删除 —— 落点从此只有"跟随宿主"这一个答案。
 *
 * ## ⚠️ 这里换过一次实现，理由必须留着
 *
 * 早先问的是 `fileManager.getAvailablePathForAttachment`，而且是**按同步调用**的
 * （`typeof 返回值 === "string"` 才采用）。在真机上实测，那两件事都是错的：
 *
 * 1. 它返回的是 **Promise**（实测 `[object Promise]` / `thenable=true`）
 *    ⇒ 那个类型检查**永远为假**，宿主给的值从来没被采用过；
 * 2. 就算 `await` 它，只要目标目录已经存在，它就抛 `Folder already exists.`
 *    （真机复现，带不带 `sourcePath` 都一样）。
 *
 * 于是这条路上「跟随 Obsidian 的附件设置」**从未生效** —— 中转文件一直落在
 * vault 根目录。而用户看到的现象正是"上传图片时根目录不停冒出新的图片文件"。
 * 这个缺陷之所以能活这么久，是因为它**不报错、不丢数据**，只是落点与预期不符。
 *
 * ## 读取（`Vault.getConfig`）为什么走鸭子类型
 *
 * ⚠️ `Vault.getConfig` **不在钉住的公开类型里**（`obsidian.d.ts` 搜不到它），
 * 但真机实测它存在且可用：`getConfig("attachmentFolderPath")` 返回的就是
 * Obsidian 设置界面里那一栏的值。所以这里走鸭子类型 + 可选调用；
 * 拿不到就如实退回根目录 —— 文件照样处理，只是落点普通，绝不因此让流程失败。
 *
 * 三种形态（Obsidian 自己就是这么存的）：
 * - 空串 / `"/"` → vault 根目录（两个值表示同一件事）；
 * - `"./"` → **与当前笔记同目录**：这是个相对写法，得用触发这次的笔记路径反推；
 * - 其余 → 相对 vault 的目录（不存在时，调用方的建目录那一步会建出来）。
 */
export function hostAttachmentFolder(app: unknown, sourcePath?: string): string {
	const vault = (app as { vault?: { getConfig?: (key: string) => unknown } } | null | undefined)?.vault;
	if (typeof vault?.getConfig !== "function") return "";

	let configured: unknown;
	try {
		configured = vault.getConfig("attachmentFolderPath");
	} catch {
		// 读配置失败不该让落盘失败：退回根目录，字节照样留下
		return "";
	}
	if (typeof configured !== "string") return "";

	// ⚠️ `"./"` 经 cleanFolderPath 会变成 `"."`（它剥掉尾部斜杠），所以判这个就够
	const cleaned = cleanFolderPath(configured);
	if (cleaned === ".") {
		// "与笔记同目录"：拿不到笔记路径时退回根目录 —— 那正是"没有笔记"时的合理落点
		return parentFolderOf(normalizeVaultPath(sourcePath));
	}
	return cleaned;
}
