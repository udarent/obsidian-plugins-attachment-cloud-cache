/**
 * 设置：默认值、类型守卫、合并。
 *
 * ## 为什么合并必须逐字段做，不能写 `{ ...defaults, ...loaded }`
 *
 * 两种常见写法都是错的：
 *
 * 1. `{ ...defaults, ...loaded }` → **脏数据会被带进来**。
 *    用户删过的字段、旧版本遗留的键会一直留在 `data.json` 里，
 *    而且 `loaded` 里类型不对的值（如 `enabled: "yes"`）会直接生效。
 * 2. `{ ...defaults, <逐个枚举的字段> }` → **静默丢字段**。
 *    凡没被枚举到的字段一律拿到默认值。这个更危险：类型系统抓不到
 *    （`...defaults` 提供了全部键，编译通过），也不报错，
 *    用户在界面上改了、存进了文件，重启后却被重置 ——
 *    表现为"设置存得进、读不出"。
 *
 * 所以这里**逐字段显式取值 + 逐字段类型校验**：
 * 类型不符就回落默认值，未知字段一律丢弃。
 * 代价是新增字段必须记得在此处加一行 —— 这条由 `test-settings.mjs` 的动态
 * 往返测试兜住（它从 `DEFAULT_SETTINGS` 推导字段，漏掉就会红）。
 *
 * ## 一条硬约束：凭据不在这里
 *
 * Access Key / Secret Key **不进 settings**，而是存宿主的 SecretStorage
 * （交给操作系统钥匙串），这里只保存引用名。所以下面的合并逻辑里
 * 完全看不到密钥字段 —— 这是刻意的。
 */

import { PluginSettings, S3Config, isCacheLayout, isLocalFileAction } from "./types";

// 枚举类型守卫定义在 types.ts（与枚举本身同处一地，避免两个模块各存一份）。
// 这里转出去，让"读设置的模块"同时就是"拿守卫的模块"。
export { isCacheLayout, isLocalFileAction };

/** 默认启用的图片格式。 */
const DEFAULT_IMAGE_EXTENSIONS = [
	"avif",
	"bmp",
	"gif",
	"heic",
	"jpeg",
	"jpg",
	"png",
	"svg",
	"tiff",
	"webp",
];

export const DEFAULT_S3: S3Config = {
	endpoint: "",
	region: "auto",
	bucket: "",
	publicUrlBase: "",
	accessKeyIdRef: "attachment-cloud-cache-access-key-id",
	secretAccessKeyRef: "attachment-cloud-cache-secret-access-key",
	// 内容寻址的单段模板：同一张图只存一份，且缓存路径与桶内结构一一对应
	objectKeyTemplate: "{hash}.{ext}",
};

export const DEFAULT_SETTINGS: PluginSettings = {
	enabled: true,
	s3: { ...DEFAULT_S3 },
	enabledExtensions: [...DEFAULT_IMAGE_EXTENSIONS],
	attachmentFolder: "",
	cacheEnabled: true,
	cacheFolder: "_attachment-cache",
	cacheLayout: "mirror",
	// 默认"移入缓存"而不是删除 —— 本地副本就是离线可用的前提
	localFileAction: "cache",
	pasteUpload: true,
	dropUpload: true,
	fallbackDownload: true,
	cacheDelaySeconds: 0,
};

/** 缓存目录名不得与常见附件目录冲突，也不该太深（移动端小文件代价明显）。 */
// ─────────────────────────── 逐字段取值助手 ───────────────────────────
//
// 每个都遵循同一约定：**类型不符就回落默认值**，绝不把可疑值透传下去。

function pickBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** 非空字符串（用于不能为空的字段，如目录名）。 */
function pickNonEmptyString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

/** 有限数字，且不小于 min。 */
function pickNumber(value: unknown, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value < min ? fallback : value;
}

function pickEnum<T extends string>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T {
	return guard(value) ? value : fallback;
}

/** 字符串数组：过滤掉非字符串与空串，并统一小写去重。 */
function pickStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const cleaned = value
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim().toLowerCase())
		.filter((v) => v !== "");
	if (cleaned.length === 0) return [...fallback];
	return [...new Set(cleaned)];
}

/** 合并 s3 子对象：逐字段校验，未知字段丢弃。 */
function mergeS3(loaded: unknown): S3Config {
	const data = isObject(loaded) ? loaded : {};
	return {
		endpoint: pickString(data.endpoint, DEFAULT_S3.endpoint),
		region: pickNonEmptyString(data.region, DEFAULT_S3.region),
		bucket: pickString(data.bucket, DEFAULT_S3.bucket),
		publicUrlBase: pickString(data.publicUrlBase, DEFAULT_S3.publicUrlBase),
		accessKeyIdRef: pickNonEmptyString(data.accessKeyIdRef, DEFAULT_S3.accessKeyIdRef),
		secretAccessKeyRef: pickNonEmptyString(data.secretAccessKeyRef, DEFAULT_S3.secretAccessKeyRef),
		objectKeyTemplate: pickNonEmptyString(data.objectKeyTemplate, DEFAULT_S3.objectKeyTemplate),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 `data.json` 里读到的任意内容合并成一份**必定合法**的设置。
 *
 * 输入可能是任何东西（手改过的 JSON、旧版本格式、被别的工具写坏），
 * 所以这里对每个字段都做类型校验，而不是相信它。
 */
export function mergeSettings(defaults: PluginSettings, loaded: unknown): PluginSettings {
	const data = isObject(loaded) ? loaded : {};

	return {
		enabled: pickBoolean(data.enabled, defaults.enabled),

		s3: mergeS3(data.s3),

		enabledExtensions: pickStringArray(data.enabledExtensions, defaults.enabledExtensions),
		attachmentFolder: pickString(data.attachmentFolder, defaults.attachmentFolder),

		cacheEnabled: pickBoolean(data.cacheEnabled, defaults.cacheEnabled),
		cacheFolder: pickNonEmptyString(data.cacheFolder, defaults.cacheFolder),
		cacheLayout: pickEnum(data.cacheLayout, isCacheLayout, defaults.cacheLayout),
		localFileAction: pickEnum(data.localFileAction, isLocalFileAction, defaults.localFileAction),

		pasteUpload: pickBoolean(data.pasteUpload, defaults.pasteUpload),
		dropUpload: pickBoolean(data.dropUpload, defaults.dropUpload),
		fallbackDownload: pickBoolean(data.fallbackDownload, defaults.fallbackDownload),
		cacheDelaySeconds: pickNumber(data.cacheDelaySeconds, defaults.cacheDelaySeconds, 0),
	};
}

/** 该扩展名是否参与处理（大小写不敏感，去点）。 */
export function isExtensionEnabled(ext: unknown, settings: PluginSettings): boolean {
	if (typeof ext !== "string") return false;
	const normalized = ext.trim().toLowerCase().replace(/^\./, "");
	if (!normalized) return false;
	return settings.enabledExtensions.includes(normalized);
}
