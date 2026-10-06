/**
 * 设置：默认值、类型守卫、合并。
 *
 * ## 为什么用"字段表"而不是逐个字段手写
 *
 * 两种更常见、也更容易出错的手写方式：
 *
 * 1. `{ ...defaults, ...loaded }` → **脏数据会被带进来**。用户删过的字段、旧版本遗留的键
 *    会一直留在 `data.json` 里，而且 `loaded` 里类型不对的值（如 `enabled: "yes"`）直接生效。
 * 2. `{ ...defaults, <逐个枚举的字段> }` → **静默丢字段**。凡没被枚举到的一律拿默认值。
 *    这个更危险：类型系统抓不到（`...defaults` 提供了全部键，编译通过），也不报错，
 *    用户在界面上改了、存进了文件，重启后却被重置 —— 表现为"设置存得进、读不出"。
 *
 * 手写的根因是"**默认值表**、**校验规则**、**合并逻辑**"是三份各自维护的清单，
 * 加一个字段要改三处，漏一处不报错。所以这里让它们只有**一份**：
 * 一张 `SETTINGS_SPEC` 字段表同时描述默认值与校验方式，合并时按表遍历。
 * 加字段只需加一行 —— 而且**漏了会编译不过**（见下面的映射类型标注）。
 *
 * ## 两条硬约束
 *
 * - **凭据不在这里。** Access Key / Secret Key 走宿主的 SecretStorage
 *   （操作系统钥匙串），这里只保存**引用名**。所以下面的字段表里
 *   完全看不到密钥字段 —— 这是刻意的，且由 `test-settings.mjs` 钉住。
 * - **未知字段一律丢弃。** 因为只写字段表里列出的键，旧版本遗留的键
 *   （包括历史版本可能存过的明文凭据）**不可能**被带进合并结果。
 */

import { CACHE_LAYOUTS, LOCAL_FILE_ACTIONS, isCacheLayout, isLocalFileAction } from "./types";
import type { PluginSettings, S3Config } from "./types";
import { isPlainRecord } from "./records";

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

// ─────────────────────────── 字段表 ───────────────────────────
//
// 每个字段 = 「一个把任意输入变成合法值的函数」。约定统一：
// **类型不符就取传入的 fallback**，绝不把可疑值透传下去。

/** 一个字段的读法：拿到原始值与回退值，给出确定合法的结果。 */
type FieldReader<T> = (raw: unknown, fallback: T) => T;

/** 布尔：只认真正的布尔，`"yes"` / `1` 这类一律回退。 */
function boolValue(): FieldReader<boolean> {
	return (raw, fallback) => (typeof raw === "boolean" ? raw : fallback);
}

/** 字符串：允许空串（空串对 `attachmentFolder` 是有意义的值 = 跟随宿主设置）。 */
function textValue(): FieldReader<string> {
	return (raw, fallback) => (typeof raw === "string" ? raw : fallback);
}

/** 非空字符串：用于不能为空的字段（如目录名、引用名）。 */
function requiredTextValue(): FieldReader<string> {
	return (raw, fallback) => (typeof raw === "string" && raw.trim() !== "" ? raw : fallback);
}

/** 有限数字，且不小于 `min`。 */
function countValue(min: number): FieldReader<number> {
	return (raw, fallback) => {
		if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
		return raw < min ? fallback : raw;
	};
}

/**
 * 枚举值：必须落在允许集合里。
 *
 * 用「是否在集合里」而不是逐个 `===`：这样"合法取值"只有一处定义（`types.ts` 的清单），
 * 新增一个布局时不会漏掉某个分支。
 */
function oneOfValue<T extends string>(allowed: readonly T[]): FieldReader<T> {
	return (raw, fallback) => (allowed.includes(raw as T) ? (raw as T) : fallback);
}

/**
 * 扩展名列表：过滤非字符串与空串，统一小写并按出现顺序去重。
 *
 * 空数组视为"没填"而回退 —— 一个都没勾等于没配置，此时应当用默认清单，
 * 否则用户会得到一个"看起来开了插件但什么都不处理"的状态。
 */
function textListValue(): FieldReader<string[]> {
	return (raw, fallback) => {
		if (!Array.isArray(raw)) return [...fallback];
		const cleaned: string[] = [];
		for (const item of raw) {
			if (typeof item !== "string") continue;
			const normalized = item.trim().toLowerCase();
			if (normalized === "") continue;
			if (!cleaned.includes(normalized)) cleaned.push(normalized);
		}
		return cleaned.length === 0 ? [...fallback] : cleaned;
	};
}

/**
 * 出厂默认值（**内部**表，名字与导出的 `SETTINGS_DEFAULTS` 区分开）。
 *
 * 与字段阅读器分开，是为了让"字段表只描述**怎么读**"，默认值只有一处定义：
 * 导出的 `SETTINGS_DEFAULTS` 由它构造，`mergePluginSettings` 的调用方
 * 把它作为 fallback 传进来 —— 于是"改默认值"只需改这里一处。
 */
const FACTORY_SETTINGS = {
	enabled: true,
	enabledExtensions: DEFAULT_IMAGE_EXTENSIONS,
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
} as const;

/**
 * 字段表：键必须**恰好**覆盖 `PluginSettings` 中除 `s3` 之外的全部字段。
 *
 * ⚠️ 这条映射类型标注是本模块最重要的防线：往 `PluginSettings` 加字段却忘了加进这里，
 * **编译就不过**（`Property 'x' is missing`）。手写合并逻辑时这类遗漏是静默的，
 * 只有在用户"改了设置重启就丢"时才暴露。
 */
const SETTINGS_SPEC: {
	[K in keyof Omit<PluginSettings, "s3">]: FieldReader<Omit<PluginSettings, "s3">[K]>;
} = {
	enabled: boolValue(),
	enabledExtensions: textListValue(),
	attachmentFolder: textValue(),
	cacheEnabled: boolValue(),
	cacheFolder: requiredTextValue(),
	cacheLayout: oneOfValue(CACHE_LAYOUTS),
	localFileAction: oneOfValue(LOCAL_FILE_ACTIONS),
	pasteUpload: boolValue(),
	dropUpload: boolValue(),
	fallbackDownload: boolValue(),
	cacheDelaySeconds: countValue(0),
};

const S3_FALLBACKS: S3Config = {
	endpoint: "",
	region: "auto",
	bucket: "",
	publicUrlBase: "",
	accessKeyIdRef: "attachment-cloud-cache-access-key-id",
	secretAccessKeyRef: "attachment-cloud-cache-secret-access-key",
	// path-style 默认开：R2 的 S3 端点不支持 virtual-host，而其余各家都接受 path-style
	forcePathStyle: true,
	// 内容寻址的单段模板：同一张图只存一份，且缓存路径与桶内结构一一对应
	objectKeyTemplate: "{hash}.{ext}",
};

/** s3 子对象的字段表（同样由映射类型保证不漏字段）。 */
const S3_SPEC: { [K in keyof S3Config]: FieldReader<S3Config[K]> } = {
	endpoint: textValue(),
	region: requiredTextValue(),
	bucket: textValue(),
	publicUrlBase: textValue(),
	accessKeyIdRef: requiredTextValue(),
	secretAccessKeyRef: requiredTextValue(),
	forcePathStyle: boolValue(),
	objectKeyTemplate: requiredTextValue(),
};

export const S3_DEFAULTS: S3Config = { ...S3_FALLBACKS };

/**
 * 出厂默认设置。
 *
 * 用展开而不是直接导出内部表，是为了给调用方一份**可安全改动**的副本：
 * 直接导出的话，任何一处 `settings.foo = x` 都会改到"出厂值"本身，
 * 于是后续所有新建的插件实例都带着被改过的默认值 —— 那种污染极难追查。
 */
export const SETTINGS_DEFAULTS: PluginSettings = {
	...FACTORY_SETTINGS,
	// ⚠️ 数组必须**单独复制**：浅展开只会复制引用，`enabledExtensions`
	// 会与出厂表共用同一个数组，改一处就等于改出厂值。
	enabledExtensions: [...DEFAULT_IMAGE_EXTENSIONS],
	s3: { ...S3_FALLBACKS },
};

/** 按字段表取值。只写入表里列出的键 —— 未知字段因此**不可能**被带进来。 */
function readFields<T extends object>(
	spec: { [K in keyof T]: FieldReader<T[K]> },
	raw: Record<string, unknown>,
	fallback: T
): T {
	const out = {} as T;
	for (const key of Object.keys(spec) as (keyof T)[]) {
		out[key] = spec[key](raw[key as string], fallback[key]);
	}
	return out;
}

/**
 * 把 `data.json` 里读到的任意内容合并成一份**必定合法**的设置。
 *
 * 输入可能是任何东西（手改过的 JSON、旧版本格式、被别的工具写坏），
 * 所以每个字段都过一遍类型校验，而不是相信它。
 */
export function mergePluginSettings(defaults: PluginSettings, loaded: unknown): PluginSettings {
	const raw = isPlainRecord(loaded) ? loaded : {};
	const rawS3 = isPlainRecord(raw.s3) ? raw.s3 : {};

	const { s3: _ignoredS3, ...rest } = defaults;
	void _ignoredS3;

	return {
		...readFields(SETTINGS_SPEC, raw, rest as Omit<PluginSettings, "s3">),
		s3: readFields(S3_SPEC, rawS3, defaults.s3),
	};
}

/** 该扩展名是否参与处理（大小写不敏感，去点）。 */
export function isExtensionEnabled(ext: unknown, settings: PluginSettings): boolean {
	if (typeof ext !== "string") return false;
	const normalized = ext.trim().toLowerCase().replace(/^\./, "");
	if (!normalized) return false;
	return settings.enabledExtensions.includes(normalized);
}
