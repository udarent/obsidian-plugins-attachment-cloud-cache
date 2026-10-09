/**
 * 把**站外**图片搬进用户自己的对象存储（下载 → 上传 → 落本地副本 → 改写链接）。
 *
 * ## ⚠️ 这是全库唯一会下载"别人的图"的地方
 *
 * `core/download.ts` 里那条红线是「**未经用户同意，绝不把站外字节写进 vault**」。
 * 本模块**不碰那条守卫**，而是给"同意"提供一个**独立入口**：
 * 调用它的前提是用户在询问里选了「缓存」，而入口内部还会**再复核一次**
 * （开关仍开、主机未被拦、不是本存储的 URL、客户端可用）。
 * 于是红线从"永不"精确化为"未获同意前永不"，而"写站外字节进 vault"的路径
 * 在全库仍然只有这一条 —— 可审计、可测试。
 *
 * ## 一条纪律：**先拿到原文，再下载**
 *
 * 链接改写的顺序只能是"先上传后改写"（改写需要新的 URL）。但**读原文**可以
 * 提前到下载之前，而且必须提前：读不到笔记就说明"上传了也没法改写"，
 * 那时再下载就是白花带宽 + 在存储里留下一个没人引用的对象。
 * 这不是理论问题 —— `vault.modify` 是**整文件覆盖**，读不到就绝不能写。
 *
 * ## ⚠️ 为什么改写用**字面替换**，而不是复用 `planLinkRewrites`
 *
 * 那个函数（`maintenance/references.ts`）的 `from` 匹配是**宽松**的：除完整路径外
 * 还会退回"短名"（`baseNameOf` = 路径最后一段）。对库内附件这是必要的
 * （wikilink 可能只写 `![[photo.png]]`），但对 URL 是**危险**的：
 * `https://a.com/x.png` 与 `https://b.com/x.png` 的短名都是 `x`，
 * 于是给前者一条规则，会把**另一个站点**那张图的链接一起改掉 ——
 * 笔记静默指向了错误的图。而 URL 在笔记里**总是字面出现的**
 * （`![](...)`、`![[...]]`、`<img src="...">` 里都是那串原文），
 * 所以精确的字面替换既够用又安全，还顺带覆盖了行内 HTML 那种写法。
 *
 * 代价如实写在这里：若笔记里的 URL 被 HTML 转义过（`&amp;` 之类）或
 * 带了额外的查询串，字面就匹配不上 —— 那时如实报 `cached-no-rewrite`，
 * 而不是谎报成功。
 */

import type { App, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { TFile, requestUrl } from "obsidian";

import type { PluginSettings, LocalCopyAction } from "../types";
import type { S3Client } from "../s3/client";
import type { CacheIndex } from "../cache/index";
import { ingestAttachment } from "./ingest";
import { keyFromUrl } from "../render/render-target";
import { hostOf, isBlockedHost } from "../render/external-decide";
import { resolveExtension } from "../vault-files";
import { describeError } from "../error-text";

/**
 * 单张站外图的大小上限。
 *
 * ⚠️ 刻意**不做成设置项**：它是安全阀（防止一条笔记里挂一个几 GB 的文件把内存打满），
 * 不是用户偏好。做成设置项只会多一个"该填多少"的问题。
 */
export const MAX_EXTERNAL_BYTES = 32 * 1024 * 1024;

/**
 * 下载超时（毫秒）。
 *
 * ⚠️ `RequestUrlParam` **没有** `timeout`，也没有 `signal`，所以超时只能用
 * `Promise.race` 兜。兜住的后果是"我们不等了"，**请求本身仍在飞** ——
 * 它可能还在占用连接与内存。这一点没有更好的办法，写在这里以免被误解成"已取消"。
 */
export const DEFAULT_EXTERNAL_TIMEOUT_MS = 20_000;

/** 下载阶段的结局。 */
export type ExternalFetchStatus =
	/** 401/403 —— 多半是防盗链。 */
	| "forbidden"
	/** 404/410 —— 图已经不在了。 */
	| "missing"
	/** 超时。 */
	| "timeout"
	/** DNS / TLS / 断网。 */
	| "network"
	/** 其它非 2xx（含 3xx：`requestUrl` 是否跟随重定向没有文档保证，一律当失败）。 */
	| "failed"
	/** 200 但内容**不是附件**（防盗链常回一个 HTML 页）—— 见 `isAttachmentResponse`。 */
	| "not-attachment"
	/** 超过 {@link MAX_EXTERNAL_BYTES}。 */
	| "too-large";

export type ExternalFetchResult =
	| { status: "ok"; bytes: Uint8Array; contentType: string }
	| { status: ExternalFetchStatus; detail: string };

/** 整条链路的结局。 */
export type ExternalCacheStatus =
	/** 下载 + 上传 + 改写 全部成功。 */
	| "cached"
	/** 图已进存储，但**笔记里的链接没能改** —— 半成品，必须如实报出来。 */
	| "cached-no-rewrite"
	/** 拿不到（或读不到）这张图所在的笔记 → **什么都没做**（不下载）。 */
	| "no-note"
	/** 未获同意 / 功能已关 / 主机被拦 / 是本存储的 URL —— **一个请求都不发**。 */
	| "refused"
	/** 拿不到客户端（还没配好）—— 静默。 */
	| "unavailable"
	| "fetch-forbidden"
	| "fetch-missing"
	| "fetch-timeout"
	| "fetch-network"
	| "fetch-failed"
	| "not-attachment"
	| "too-large"
	/** 下载成功但上传失败（字节已留在本地，绝不丢图）。 */
	| "upload-failed";

export interface ExternalCacheOutcome {
	status: ExternalCacheStatus;
	url: string;
	host: string;
	/** 新对象的 key；没走到上传时为空串。 */
	key: string;
	/** 写进笔记的新 URL；没走到上传时为空串。 */
	remoteUrl: string;
	/** 本地副本的 vault 路径；没有副本时为空串。 */
	localPath: string;
	error?: unknown;
}

// ─────────────────────────── 纯函数（可穷举） ───────────────────────────

/**
 * 该不该把这次失败说给用户听（**纯函数**）。
 *
 * 分界线是"用户此刻能不能做点什么"：
 * - 超时 / 断网 → 那就是**离线**本身，不是故障。断网时刷屏是最糟的体验；
 * - 未获同意 / 未配置 → 这些不是"失败"，是"我们没做"，而原因用户已经知道
 *   （是他自己没开、或设置页里已经说过）；
 * - 其余（防盗链、图失效、不是图片、超大、上传失败、只改写了一半）
 *   → 用户能采取行动，或需要知道"事情只做了一半"。
 */
export function shouldReportExternalFailure(status: ExternalCacheStatus): boolean {
	switch (status) {
		case "fetch-timeout":
		case "fetch-network":
		case "fetch-failed":
		case "refused":
		case "unavailable":
		case "cached":
			return false;
		default:
			return true;
	}
}

/**
 * 这条路线上本地副本怎么处置（**纯函数**）。
 *
 * ⚠️ `trash`（不留本地副本）在这里被改成 `cache`。理由：那个选项的语义是
 * "上传后把本地文件移入回收站"，用户选它时想的是"vault 保持干净"；
 * 但用户在**这一次**里明确点的是「缓存这张图」 —— 而"没有本地副本"
 * 会让这条路径的全部意义（离线可见）消失，且**症状完全不可见**
 * （图在该显示的地方显示不出来，只在断网时才发现）。
 *
 * `keep`（留在附件目录原地）不动：它同样有本地副本，离线可见，没有矛盾。
 */
export function localCopyForExternal(action: LocalCopyAction): LocalCopyAction {
	return action === "trash" ? "cache" : action;
}

/**
 * 从响应头里按**大小写不敏感**取值。
 *
 * ⚠️ `requestUrl` 的 `headers` 是普通对象（不像 `Headers` 那样自带大小写归一），
 * 而不同服务端给的写法五花八门（`Content-Type` / `content-type`）。
 * 只查小写会让"防盗链回 HTML"这类判断**静默失效** —— 于是 HTML 被当图片上传。
 */
export function headerOf(headers: unknown, name: string): string {
	if (!headers || typeof headers !== "object") return "";
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
		if (key.toLowerCase() === target && typeof value === "string") return value.trim();
	}
	return "";
}

/** 去掉 MIME 的参数部分（`image/png; charset=x` → `image/png`）。 */
export function mimeFromContentType(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.split(";")[0].trim().toLowerCase();
}

/**
 * 响应内容是不是一个**可以搬走的附件**（**纯函数**）。
 *
 * 1.1.0 起不再只服务图片（需求 R15）—— 音频、视频、PDF、压缩包、文档同样可以缓存。
 * 但有一条底线**没有放宽**，而且必须写死在一处：
 *
 * ## ⭐ 绝不把网页当附件搬走
 *
 * `text/html` 是防盗链/登录墙的典型回包 —— 一个"图片"地址实际返回的是网页。
 * 把它当附件上传，用户会得到一个**能下载下来的网页源码**，而笔记里那张图
 * 依旧不显示。`text/*`（`text/plain` 的 robots.txt、`text/css`…）同理：
 * 它们是一段文本，不是用户想收藏的那个文件（原则④：宁可不做，也不做一个错的）。
 *
 * ## 类型头缺失时退回 URL 扩展名
 *
 * 有些图床确实不给 `Content-Type`。那时**不能**当成"不是附件"（会整类漏掉），
 * 也不能当成"是附件"（会把任何 HTML 页收下来）—— 判据是**URL 最后一段带扩展名**：
 * `…/photo.png` 收，`…/page.php`、`…/`（目录）不收。
 * 这是"形状"判据，不依赖我们认不认识那个后缀 —— 认不认识由 MIME 表决定，
 * 这里的价值只有"它看起来是个文件"。
 */
export function isAttachmentResponse(input: { contentType: unknown; url: unknown }): boolean {
	const type = mimeFromContentType(input.contentType);
	if (!type) return Boolean(extensionFromUrl(input.url));
	// ⭐ 网页与纯文本一律拒收（见上）
	if (type === "text/html" || type.startsWith("text/")) return false;
	return true;
}

/** 从 URL 的路径部分取扩展名（不含点，小写）。取不到返回空串。 */
export function extensionFromUrl(url: unknown): string {
	if (typeof url !== "string") return "";
	// 先切掉查询串与锚点：`a.png?v=1` 的扩展名是 `png`，不是 `png?v=1`
	const path = url.split("#")[0].split("?")[0];
	return resolveExtension(path, "");
}

/**
 * 从 URL 里取一个用得上文件名（给对象 key 模板的 `{filename}` 用）。
 *
 * 取不到就返回 `undefined`，让 `ingestAttachment` 按 MIME 自己造一个 ——
 * 硬凑一个假名字会让 key 变得难以辨认。
 */
export function fileNameFromUrl(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	try {
		const parsed = new URL(url);
		// ⚠️ 以 `/` 结尾说明最后一段是**目录**，不是文件 —— 把它当文件名会让 key 里
		// 出现一个目录名（`{filename}` 模板下尤其明显），而且它一定没有扩展名。
		if (parsed.pathname.endsWith("/")) return undefined;
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		if (!last) return undefined;
		const decoded = decodeURIComponent(last);
		return decoded || undefined;
	} catch {
		// 畸形百分号编码 / 不是 URL → 让调用方兜底
		return undefined;
	}
}

// ─────────────────────────── 下载 ───────────────────────────

export interface FetchExternalImageDeps {
	/** 传输实现。默认用宿主的 `requestUrl`（CORS 豁免）。 */
	request?: (options: RequestUrlParam) => Promise<RequestUrlResponse>;
	timeoutMs?: number;
	maxBytes?: number;
}

class TimeoutError extends Error {
	constructor() {
		super("下载超时");
		this.name = "TimeoutError";
	}
}

/**
 * 给一个没有超时能力的 promise 套上超时（⚠️ 只是"我们不等了"，请求仍在飞）。
 *
 * 用 `window.setTimeout` 而不是裸 `setTimeout`：弹出窗口（popout window）里
 * 两者不是同一个东西 —— 裸的那个是主窗口的，弹窗关闭后定时器仍在主窗口上跑。
 * 这条纪律在 `s3/client.ts` 里已经有过一次（lint 也会拦）。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new TimeoutError()), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				window.clearTimeout(timer);
				// 规整成 Error 再往下传：下游要靠 `instanceof` 区分超时与网络错误，
				// 裸值（字符串、对象）会让那个判断失效，从而把两种情况混成一种。
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

function toBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return new Uint8Array(0);
}


/**
 * 下载一张站外图。**这一步之前必须已经拿到用户同意**（调用方负责，见模块头注释）。
 *
 * 顺序刻意如此：先看 HTTP 状态（最确定的信息），再看类型，最后才看大小。
 * 于是"404"永远报成"图不在了"，不会被后面的判断掩盖成别的样子。
 */
export async function fetchExternalImage(
	url: string,
	deps: FetchExternalImageDeps = {}
): Promise<ExternalFetchResult> {
	const request = deps.request ?? requestUrl;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
	const maxBytes = deps.maxBytes ?? MAX_EXTERNAL_BYTES;

	let response: RequestUrlResponse;
	try {
		// `throw: false` 很关键：4xx/5xx 都要能**读到状态码**再分类
		// （抛异常的话，"防盗链"与"断网"会变成同一种错误，而它们的处理完全不同）。
		response = await withTimeout(request({ url, method: "GET", throw: false }), timeoutMs);
	} catch (error) {
		if (error instanceof TimeoutError) return { status: "timeout", detail: `超过 ${timeoutMs}ms` };
		// 4xx/5xx 不抛（见上）⇒ 能抛出来的基本都在网络层（DNS / TLS / 断网）
		return { status: "network", detail: describeError(error) };
	}

	const status = typeof response?.status === "number" ? response.status : 0;
	if (status === 401 || status === 403) return { status: "forbidden", detail: `HTTP ${status}` };
	if (status === 404 || status === 410) return { status: "missing", detail: `HTTP ${status}` };
	if (status < 200 || status >= 300) return { status: "failed", detail: `HTTP ${status}` };

	const contentType = headerOf(response?.headers, "content-type");
	const bytes = toBytes(response?.arrayBuffer);

	// ⚠️ 大小只能在**下完之后**判断：`requestUrl` 一次性返回整个 body，
	// 没有"边下边中止"的能力。所以这里拒绝的是"上传"，带宽已经花掉了。
	if (bytes.byteLength > maxBytes) {
		return { status: "too-large", detail: String(bytes.byteLength) };
	}

	if (!isAttachmentResponse({ contentType, url })) {
		return { status: "not-attachment", detail: mimeFromContentType(contentType) || "(没有类型头)" };
	}

	return { status: "ok", bytes, contentType: mimeFromContentType(contentType) };
}

// ─────────────────────────── 执行 ───────────────────────────

export interface ExternalCacherDeps {
	app: App;
	/** 现取设置（用户可能在询问与执行之间改了）。 */
	settings: () => PluginSettings;
	/** 现取客户端；拿不到（未配置）时返回 null。 */
	client: () => S3Client | null;
	index: () => CacheIndex;
	persistIndex: () => Promise<void>;
	notify?: (message: string) => void;
	t?: (key: string, params?: Record<string, unknown>) => string;
	request?: (options: RequestUrlParam) => Promise<RequestUrlResponse>;
	/**
	 * 安全拦截（回环 / 链路本地）。默认 {@link isBlockedHost}。
	 *
	 * 留成可替换只为一件事：**测试要能指向本地起的假图床**。
	 * 生产路径上**必须**用默认值 —— 这条检查的意义就是"绝不请求那些地址"，
	 * 把它换掉就等于把它关掉。
	 */
	blockedHost?: (host: string) => boolean;
	timeoutMs?: number;
	maxBytes?: number;
	now?: () => Date;
	hashBytes?: (bytes: Uint8Array) => Promise<string>;
}

/** 下载阶段的状态 → 链路状态。 */
function cacheStatusFor(status: ExternalFetchStatus): ExternalCacheStatus {
	switch (status) {
		case "forbidden":
			return "fetch-forbidden";
		case "missing":
			return "fetch-missing";
		case "timeout":
			return "fetch-timeout";
		case "network":
			return "fetch-network";
		case "not-attachment":
			return "not-attachment";
		case "too-large":
			return "too-large";
		default:
			return "fetch-failed";
	}
}

/** 状态 → i18n 键。不提示的状态不在表里（返回空串）。 */
function messageKeyFor(status: ExternalCacheStatus): string {
	switch (status) {
		case "cached":
			return "externalCached";
		case "cached-no-rewrite":
			return "externalCachedNoRewrite";
		case "no-note":
			return "externalNoNote";
		case "fetch-forbidden":
			return "externalFetchForbidden";
		case "fetch-missing":
			return "externalFetchMissing";
		case "not-attachment":
			return "externalNotAttachment";
		case "too-large":
			return "externalTooLarge";
		case "upload-failed":
			return "externalUploadFailed";
		default:
			return "";
	}
}

export type ExternalCacher = (url: string, notePath: string | undefined) => Promise<ExternalCacheOutcome>;

/**
 * 造一个"把站外图搬进自己存储"的执行器。
 *
 * 返回的函数是 **fire-and-forget 友好**的：不抛错，所有失败都以 `status` 表达 ——
 * 它被渲染路径调用，而渲染路径上一次未捕获的异常会毁掉整篇笔记的渲染。
 */
export function createExternalCacher(deps: ExternalCacherDeps): ExternalCacher {
	return async function cacheExternalImage(url, notePath) {
		const settings = deps.settings();
		const host = hostOf(url);
		const base = { url, host, key: "", remoteUrl: "", localPath: "" };

		const say = (status: ExternalCacheStatus, params: Record<string, unknown> = {}): void => {
			const key = messageKeyFor(status);
			if (!key || !deps.notify) return;
			if (!deps.t) {
				deps.notify(key);
				return;
			}
			deps.notify(deps.t(key, params));
		};

		// ── 1. 复核同意（防线不止一道；用户可能在询问与执行之间关掉了功能） ──
		if (!settings.externalImageCache) return { ...base, status: "refused" };
		if (!host) return { ...base, status: "refused" };
		if ((deps.blockedHost ?? isBlockedHost)(host)) return { ...base, status: "refused" };
		// 本存储的 URL 不该走这条路（那是回退下载的活；走到这里说明调用方搞错了）
		if (keyFromUrl(url, settings.s3)) return { ...base, status: "refused" };

		const client = deps.client();
		if (!client) return { ...base, status: "unavailable" };

		// ── 2. 先拿到原文（读不到就不下载 —— 避免"上传了才发现没法改写"） ──
		const file = notePath ? deps.app.vault.getAbstractFileByPath(notePath) : null;
		if (!(file instanceof TFile)) {
			say("no-note", { host });
			return { ...base, status: "no-note" };
		}

		let original: string;
		try {
			original = await deps.app.vault.read(file);
		} catch (error) {
			say("no-note", { host });
			return { ...base, status: "no-note", error };
		}

		// ── 3. 下载 ──
		const fetched = await fetchExternalImage(url, {
			request: deps.request,
			timeoutMs: deps.timeoutMs,
			maxBytes: deps.maxBytes,
		});

		if (fetched.status !== "ok") {
			const status = cacheStatusFor(fetched.status);
			const params: Record<string, unknown> =
				status === "fetch-missing"
					? { status: fetched.detail }
					: status === "not-attachment"
						? { contentType: fetched.detail }
						: status === "too-large"
							? { mb: Math.round((deps.maxBytes ?? MAX_EXTERNAL_BYTES) / (1024 * 1024)) }
							: { host };
			if (shouldReportExternalFailure(status)) say(status, params);
			return { ...base, status, error: fetched.detail };
		}

		// ── 4. 上传 + 落本地副本 + 登记索引（复用现成零件，一次调用完成） ──
		// ⚠️ `localCopy` 在这里被改写一次：见 `localCopyForExternal` 的说明。
		const ingestSettings: PluginSettings = {
			...settings,
			localCopy: localCopyForExternal(settings.localCopy),
		};

		const ingested = await ingestAttachment(
			{
				app: deps.app,
				settings: ingestSettings,
				client,
				index: deps.index(),
				persistIndex: deps.persistIndex,
				notify: deps.notify,
				hashBytes: deps.hashBytes,
				now: deps.now,
			},
			{
				bytes: fetched.bytes,
				name: fileNameFromUrl(url),
				mime: fetched.contentType,
				// 让宿主的"附件目录"设置生效（含"与笔记同目录"这类模式）
				sourcePath: notePath,
			}
		);

		if (ingested.status === "fallback" || !ingested.remoteUrl) {
			say("upload-failed", { error: describeError(ingested.error) });
			return {
				...base,
				status: "upload-failed",
				key: ingested.key,
				localPath: ingested.localPath,
				error: ingested.error,
			};
		}

		const { key, remoteUrl, localPath } = ingested;
		const uploaded = { ...base, key, remoteUrl, localPath };

		// ── 5. 改写笔记里的链接（**字面替换**，理由见模块头注释） ──
		const occurrences = original.split(url).length - 1;
		if (occurrences === 0) {
			// 图已经进存储了，但这篇笔记里没有那串链接（可能来自嵌入的别的笔记）
			say("cached-no-rewrite", { error: "本篇笔记里没有这串链接" });
			return { ...uploaded, status: "cached-no-rewrite" };
		}

		try {
			await deps.app.vault.modify(file, original.split(url).join(remoteUrl));
		} catch (error) {
			// 上传成功了但没改成 —— 半成品。绝不能谎报 `cached`
			say("cached-no-rewrite", { error: describeError(error) });
			return { ...uploaded, status: "cached-no-rewrite", error };
		}

		say("cached", { host });
		return { ...uploaded, status: "cached" };
	};
}
