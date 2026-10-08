/**
 * 粘贴 / 拖拽的**判定逻辑**（全是纯函数）。
 *
 * ## 为什么判定必须单独成层、并且能穷举
 *
 * 两种错误的代价**极不对称**：
 *
 * - **漏接管** → 退回宿主原生行为：图被存进附件目录、插入本地链接，只是没上传。
 *   用户可以之后再传，**无害**。
 * - **接管错了** → 我们已经 `preventDefault()` 把宿主的行为挡掉了。
 *   如果没把内容插回去，**用户的内容凭空消失**，而且没有任何痕迹。
 *
 * 所以判定不能散在事件回调里（那种地方没法穷举），必须是一组
 * 显式、可单测、输入输出都清楚的纯函数。
 *
 * ## 一条贯穿始终的保守原则
 *
 * 凡是"用户的意图不明确"的情况，一律**不接管**。理由同上：
 * 不接管的代价是"没上传"，接管的代价可能是"内容没了"。
 * 具体体现为下面三条偏保守的规则：
 * 1. 剪贴板里同时有文本 → 不接管（用户可能在粘文字，抢过来会丢文字）；
 * 2. 拖拽事件里**没有 files** → 是宿主的内部拖动（拖笔记/拖库内附件），必须放行；
 * 3. ⭐ 只要**有一个**文件不认识，就**整批都不接管** —— 若只接管认识的那几个，
 *    剩下那些会被我们一起挡掉、又没人插回去，等于把它们吞了。
 */

import type { PluginSettings } from "../types";
import { resolveExtension } from "../vault-files";

/** 文件的最小形状。用结构化类型而不是 DOM 的 `File`，便于穷举测试。 */
export interface TransferFileLike {
	name?: string;
	size?: number;
	type?: string;
	lastModified?: number;
	/** 读字节。测试里可以给一个返回固定内容的实现。 */
	arrayBuffer?: () => Promise<ArrayBuffer>;
}

/** `DataTransferItem` 的最小形状。 */
export interface TransferItemLike {
	kind?: string;
	type?: string;
	getAsFile?: () => TransferFileLike | null;
}

/** `DataTransfer` 的最小形状。 */
export interface TransferLike {
	files?: ArrayLike<TransferFileLike> | null;
	items?: ArrayLike<TransferItemLike> | null;
	/** 读其它格式的内容，用来判断"用户是不是在粘文字"。 */
	getData?: (format: string) => string;
}

/** 判定结果。`intercept` 为 false 时调用方**不得**调用 `preventDefault`。 */
export interface TransferPlan {
	intercept: boolean;
	/** 被判定为需要上传的文件（`intercept` 为 false 时为空）。 */
	files: TransferFileLike[];
	/** 不接管的原因，用于日志与排查（不进用户界面）。 */
	reason: string;
}

/** 把"类数组"安全地转成数组（`FileList` 不是真的数组）。 */
function toArray<T>(list: ArrayLike<T> | null | undefined): T[] {
	if (!list) return [];
	const out: T[] = [];
	for (let i = 0; i < list.length; i += 1) {
		const item = list[i];
		if (item !== undefined && item !== null) out.push(item);
	}
	return out;
}

/**
 * 去重用的身份串；无法判定身份时返回 `null`（表示"不要参与去重"）。
 *
 * ⚠️ 不能按**对象引用**去重：同一个文件出现在 `files` 与 `items` 两处时，
 * 拿到的是两个不同的包装对象，引用比较会认为它们是两张不同的图 →
 * 重复上传两次、笔记里插入两条链接。
 *
 * ⚠️ 也不能在"什么都没有"时硬凑一个身份串：那样两个都缺字段的文件会被误判成同一个，
 * 于是**少传一张图**。所以没有可用字段时返回 `null`，宁可不合并。
 */
export function fileIdentity(file: TransferFileLike | null | undefined): string | null {
	if (!file || typeof file !== "object") return null;
	const hasName = typeof file.name === "string" && file.name !== "";
	const hasSize = typeof file.size === "number";
	const hasType = typeof file.type === "string" && file.type !== "";
	if (!hasName && !hasSize && !hasType) return null;
	// ⚠️ 刻意**不含** `lastModified`：它不是"这是哪张图"的一部分，而且**同一个剪贴板条目
	// 的两个包装对象拿到的不是同一个时间戳** —— `clipboardData.files[0]` 与
	// `items[i].getAsFile()` 是两个不同的 `File`，后者常常是调用时才新建的（时间戳=此刻）。
	// 把它算进身份串，去重就会在这种**最常见的**场景下失效：一次粘贴插入 2~3 条一模一样的外链
	//（用户实测报过："复制粘贴图片的时候，发现出现了两张相同图片"）。
	return [file.name ?? "", file.size ?? "", file.type ?? ""].join("\u0000");
}

/**
 * 从剪贴板/拖拽载荷里取出文件列表，并**去重**。
 *
 * 两个来源都要看：`files` 是常规路径；而**粘贴**时某些宿主只在 `items` 里给出文件，
 * 只看 `files` 会整体漏掉。反过来只看 `items` 也不行（拖拽时 `items` 可能为空）。
 */
export function filesFromTransfer(transfer: TransferLike | null | undefined): TransferFileLike[] {
	const out: TransferFileLike[] = [];
	const seen = new Set<string>();

	const push = (file: TransferFileLike | null | undefined): void => {
		if (!file || typeof file !== "object") return;
		const identity = fileIdentity(file);
		if (identity !== null) {
			if (seen.has(identity)) return;
			seen.add(identity);
		}
		out.push(file);
	};

	for (const file of toArray(transfer?.files)) push(file);

	for (const item of toArray(transfer?.items)) {
		// `kind` 不是 "file" 的项是字符串（如 text/plain），不是文件
		if (item.kind !== "file") continue;
		if (typeof item.getAsFile !== "function") continue;
		try {
			push(item.getAsFile());
		} catch {
			// 某些环境下 `getAsFile` 会在条目已失效时抛错 —— 跳过它，
			// 而不是让整个粘贴失败（用户看到的是"图没了"）
		}
	}

	return out;
}

/** 该文件是否属于我们负责的类型（按扩展名判断，文件名与 MIME 都看）。 */
export function isHookableFile(file: TransferFileLike | null | undefined, settings: PluginSettings): boolean {
	if (!file || typeof file !== "object") return false;
	const ext = resolveExtension(file.name, file.type);
	if (!ext) return false;
	return settings.enabledExtensions.includes(ext);
}

/** 剪贴板里是否还有**文本**内容（用于判断用户是不是在粘文字）。 */
function hasText(transfer: TransferLike | null | undefined): boolean {
	if (!transfer || typeof transfer.getData !== "function") return false;
	try {
		return String(transfer.getData("text/plain") ?? "") !== "";
	} catch {
		// 读不到就当没有文本 —— 与"能读但为空"同样处理。
		// ⚠️ 这里选择"当作没有"而不是"当作有"：真读不到时（权限/失效条目）
		// 若判成"有文本"就永远不接管，功能会静默失效且极难发现。
		return false;
	}
}

/**
 * 判定粘贴是否要接管。
 *
 * 顺序是刻意的：**先看最便宜、最不可能变的开关**（插件/功能是否启用），
 * 再看载荷。这样"功能被关掉"这类情况永远给出同一个原因，不会被载荷细节掩盖。
 */
export function shouldInterceptPaste(
	transfer: TransferLike | null | undefined,
	settings: PluginSettings
): TransferPlan {
	if (!settings.autoUpload) return refuse("自动上传已关闭");

	const files = filesFromTransfer(transfer);
	if (files.length === 0) return refuse("载荷里没有文件");

	// ⚠️ 保守规则：剪贴板里同时有文本 → 不接管。
	// 用户很可能在粘一段文字（有些应用复制图片时也会带上文本），
	// 抢过来会**丢掉那段文字**；而放行最多是"这张图没上传"，代价小得多。
	if (hasText(transfer)) return refuse("剪贴板里同时有文本，可能是用户在粘文字");

	return accept(files, settings, "有可处理的文件");
}

/**
 * 判定拖拽是否要接管。
 *
 * ⚠️ 关键规则：**没有 `files` 就不是外部文件拖入**。
 * 库内拖动（拖笔记、拖已有附件去移动位置）不带 `files`，
 * 那种拖拽由宿主处理，我们必须放行 —— 否则"移动一个笔记"会变成"什么都没发生"。
 */
export function shouldInterceptDrop(
	transfer: TransferLike | null | undefined,
	settings: PluginSettings
): TransferPlan {
	if (!settings.autoUpload) return refuse("自动上传已关闭");

	const rawFiles = toArray(transfer?.files);
	if (rawFiles.length === 0) {
		return refuse("载荷里没有 files（很可能是库内拖动，应由宿主处理）");
	}

	const files = filesFromTransfer(transfer);
	if (files.length === 0) return refuse("载荷里没有可用文件");

	return accept(files, settings, "有外部拖入的文件");
}

/**
 * 共同收尾：**只要有一个文件不认识，就整批不接管**。
 *
 * 这一条是"绝不吞掉用户内容"的直接体现：若只接管认识的那几个，
 * 我们仍然 `preventDefault()` 了，剩下的文件会被宿主跳过、而我们也不管 →
 * 它们就消失了。宁可整批放行（图没上传），也不能吞。
 */
function accept(files: TransferFileLike[], settings: PluginSettings, okReason: string): TransferPlan {
	const unknown = files.filter((file) => !isHookableFile(file, settings));
	if (unknown.length > 0) {
		const names = unknown.map((file) => file.name ?? "(无名)").join(", ");
		return refuse(`载荷里有 ${unknown.length} 个不处理的文件（${names}），整批放行以免吞掉它们`);
	}
	return { intercept: true, files, reason: okReason };
}

function refuse(reason: string): TransferPlan {
	return { intercept: false, files: [], reason };
}

/**
 * 生成远端图片的 Markdown。
 *
 * 用 `![]()` 而不是 `![[]]`：图在远端，wikilink 只能指向库内文件。
 *
 * 括号不需要转义 —— 我们的 URL 是**逐段百分号编码**过的，
 * `(` `)` 早就变成了 `%28` `%29`（见 `s3/sigv4.ts`）。
 * 这也正是"只编码一次"那条纪律的附带好处：链接天然是 Markdown 安全的。
 */
export function buildRemoteImageMarkdown(url: string, alt: string): string {
	const text = escapeAltText(alt);
	return `![${text}](${String(url ?? "").trim()})`;
}

/**
 * 生成库内文件的嵌入链接（降级路径用）。
 *
 * 降级时图在库内，用 wikilink 嵌入 —— 它由宿主按名字解析，
 * 不受"笔记在哪个目录"影响，也不需要百分号编码（路径里的空格在 wikilink 里是合法的）。
 */
export function buildLocalImageEmbed(vaultPath: string, alt: string): string {
	const path = String(vaultPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
	const text = escapeAltText(alt);
	return text ? `![[${path}|${text}]]` : `![[${path}]]`;
}

/**
 * 清掉会**破坏 Markdown 结构**的字符。
 *
 * 文件名是用户数据，可能含 `]` `[` 或换行：
 * - `]` 会提前闭合 alt，后面的内容变成正文；
 * - 换行会把一条链接拆成两条，整段语法就废了。
 * 这里选择替换而不是转义：alt 只是说明文字，替换成空格完全够用，
 * 而转义的规则（哪些字符可以反斜杠转义）在 Markdown 方言间并不一致。
 *
 * ⚠️ 非字符串一律当空串，**不能** `String(alt)`：那会把一个对象渲染成
 * `[object Object]` 并塞进用户可见的链接文字里。
 */
function escapeAltText(alt: unknown): string {
	if (typeof alt !== "string") return "";
	return alt
		.replace(/[[\]]/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** 从文件名里取一个适合当 alt 的名字（去掉扩展名，够用且更短）。 */
export function altTextForFile(file: TransferFileLike | null | undefined): string {
	const raw = String(file?.name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
	const dot = raw.lastIndexOf(".");
	return dot > 0 ? raw.slice(0, dot) : raw;
}
