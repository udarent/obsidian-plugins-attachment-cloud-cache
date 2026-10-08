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

/** 扩展名 → 默认 Content-Type。只需覆盖默认启用的图片格式。 */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
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
};

/** 上传不认识的后缀时的兜底类型（对象存储要求这个头）。 */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** MIME → 扩展名。只覆盖图片：本插件的钩子只处理启用的附件类型。 */
const EXTENSION_BY_MIME: Record<string, string> = {
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
};

/** 由扩展名给 Content-Type。空扩展名 / 未知扩展名 → 兜底类型。 */
export function contentTypeForExtension(ext: unknown): string {
	if (typeof ext !== "string") return DEFAULT_CONTENT_TYPE;
	const key = ext.trim().toLowerCase().replace(/^\./, "");
	return CONTENT_TYPE_BY_EXTENSION[key] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * 取文件名的扩展名（小写、不含点）。
 *
 * ⚠️ 前导点是"隐藏文件"而不是扩展名：`.gitignore` 的扩展名是**空**，
 * 不是 `gitignore`。否则一个隐藏文件会被当成 `gitignore` 类型，
 * 拼出的 key 与缓存文件名都会莫名其妙。
 */
export function extensionOfName(name: unknown): string {
	if (typeof name !== "string") return "";
	const base = name.trim().split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
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
