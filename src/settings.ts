import { normalizePath } from "obsidian";

/**
 * 设置：默认值、类型守卫、合并。
 *
 * ## 为什么用"字段表"而不是逐个字段手写
 *
 * 两种更常见、也更容易出错的手写方式：
 *
 * 1. `{ ...defaults, ...loaded }` → **脏数据会被带进来**。用户删过的字段、旧版本遗留的键
 *    会一直留在 `data.json` 里，而且 `loaded` 里类型不对的值（如 `autoUpload: "yes"`）直接生效。
 * 2. `{ ...defaults, <逐个枚举的字段> }` → **静默丢字段**。凡没被枚举到的一律拿默认值。
 *    这个更危险：类型系统抓不到（`...defaults` 提供了全部键，编译通过），也不报错，
 *    用户在界面上改了、存进了文件，重启后却被重置 —— 表现为"设置存得进、读不出"。
 *
 * 手写的根因是"**默认值表**、**校验规则**、**合并逻辑**"是三份各自维护的清单，
 * 加一个字段要改三处，漏一处不报错。所以这里让它们只有**一份**：
 * 一张 `SETTINGS_SPEC` 字段表同时描述默认值与校验方式，合并时按表遍历。
 * 加字段只需加一行 —— 而且**漏了会编译不过**（见下面的映射类型断言）。
 *
 * ## 两条硬约束
 *
 * - **秘密的值不在这里。** 秘密访问密钥只保存 SecretStorage 里那条密钥的**名字**
 *   （`secretAccessKeyRef`），值在操作系统钥匙串里。
 *   由 `test-settings.mjs` 钉住"不存在明文**秘密**字段"。
 *   ⚠️ 注意这条**不含**访问密钥 ID：那是标识符、不是秘密，明文存在这里
 *   （理由见 `types.ts` 的文件头 —— 简单说：Obsidian 的密钥 ID 不允许大写，
 *   而访问密钥 ID 常规就带大写，装不进钥匙串）。
 * - **未知字段一律丢弃。** 因为只写字段表里列出的键，旧版本遗留的键
 *   （包括历史版本曾存过的明文凭据、或被砍掉的参数）**不可能**被带进合并结果。
 *   这正是这一版砍掉 5 个参数后**不需要写迁移代码**的原因：旧键自动消失，
 *   新字段拿默认值，而 `localCopy` 这个新字段的默认值（`cache`）恰好等于
 *   旧组合 `cacheEnabled: true + localFileAction: "cache"` 的效果。
 */

import { EXTERNAL_IMAGE_DEFAULTS, LOCAL_COPY_ACTIONS, isExternalImageDefault, isLocalCopyAction } from "./types";
import type { ExternalImageDefault, LocalCopyAction, PluginSettings, S3Config } from "./types";
import { CACHE_LIMIT_MB_MAX } from "./types";
import { isPlainRecord } from "./records";

// 枚举类型守卫定义在 types.ts（与枚举本身同处一地，避免两个模块各存一份）。
// 这里转出去，让"读设置的模块"同时就是"拿守卫的模块"。
export { isExternalImageDefault, isLocalCopyAction };

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

/**
 * 字符串：**允许空串**。
 *
 * 空串在本插件里是有意义的值，不是"没填"：
 * - `attachmentFolder` 空 = 跟随宿主的附件设置；
 * - `accessKeyId` 空 = 尚未填写访问密钥 ID；
 * - `secretAccessKeyRef` 空 = 尚未在钥匙串里选密钥。
 * 后者尤其不能回落成某个写死的名字 —— 那会指向一个不存在的密钥，
 * 表现为"提示密钥无效"却查不出原因。
 */
function textValue(): FieldReader<string> {
	return (raw, fallback) => (typeof raw === "string" ? raw : fallback);
}

/**
 * vault 路径：**读进来那一刻就归一**，并区分「必填」与「可空」两档。
 *
 * ⚠️ 官方 guideline 要求：接受用户给的 vault 路径时必须过 normalizePath()。
 * 不归一的后果很具体：用户从别处粘一个反斜杠分隔或带双斜杠的路径（Windows 上很自然），
 * 会被**逐字**拼进缓存路径 ⇒ 生成 vault 里根本不存在的层级，
 * 而症状是「缓存目录里没有文件」「清理命令找不到东西」，看不出与那次粘贴有关。
 *
 * 两个调用点的「空」含义不同，所以保留与 textValue / requiredTextValue 一致的两档：
 * - cacheFolder **必填**：归一后为空（用户只敲了斜杠）就回落默认目录；
 * - attachmentFolder **可空**：空 = 跟随宿主的附件设置，是**有意义**的状态。
 */
function pathValue(options: { required?: boolean } = {}): FieldReader<string> {
	const required = options.required ?? false;
	return (raw, fallback) => {
		if (typeof raw !== "string") return fallback;
		const normalized = normalizePath(raw.trim());
		if (normalized !== "") return normalized;
		return required ? fallback : "";
	};
}

/** 非空字符串：用于**为空会直接导致功能不可用**的字段（如目录名、key 模板）。 */
function requiredTextValue(): FieldReader<string> {
	return (raw, fallback) => (typeof raw === "string" && raw.trim() !== "" ? raw : fallback);
}

/**
 * 枚举值：必须落在允许集合里。
 *
 * 用「是否在集合里」而不是逐个 `===`：这样"合法取值"只有一处定义（`types.ts` 的清单），
 * 新增一个选项时不会漏掉某个分支。
 */
function oneOfValue<T extends string>(allowed: readonly T[]): FieldReader<T> {
	return (raw, fallback) => (allowed.includes(raw as T) ? (raw as T) : fallback);
}

/**
 * 数值：只认**有限数**，非数 / `NaN` / `Infinity` 一律回退；并按范围夹紧、取整。
 *
 * ⚠️ 这里是**夹紧**而不是拒绝：这个字段表示"上限"，一个负数或天文数字都不代表
 * 任何真实意图，而"回退/夹到边界"至少是一个安全且可解释的状态。
 * 真正需要区分"输错了"的地方在界面那一层（`parseCacheLimitMb` 返回 `null`，
 * 于是**不写**、保留原值 —— 见 `settings-bindings.ts`）。
 */
function numberValue(options: { min?: number; max?: number } = {}): FieldReader<number> {
	const min = options.min ?? 0;
	const max = options.max ?? Number.MAX_SAFE_INTEGER;
	return (raw, fallback) => {
		if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
		return Math.min(max, Math.max(min, Math.trunc(raw)));
	};
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
	autoUpload: true,
	enabledExtensions: DEFAULT_IMAGE_EXTENSIONS,
	attachmentFolder: "",
	// 默认"移入缓存"：本地副本就是离线可用的前提，且缓存目录可整体清理
	localCopy: "cache" as LocalCopyAction,
	cacheFolder: "_attachment-cache",
	fallbackDownload: true,
	// ⚠️ 默认**关**。打开它意味着插件会对外发 PUT 并**改写用户的笔记**，
	// 而这种动作的同意应当显式；何况默认开会让已有 vault 里所有站外图站点
	// 在首次渲染时集体弹常驻通知 —— 一次更新就满屏弹窗。
	externalImageCache: false,
	// ⚠️ 出厂「什么都不做」。打开上面那个开关**不等于**同意去下载别人的图 ——
	// 那件事靠用户把这个值改成 `cache`、或者在「选择要缓存的外链图片」里逐张勾选来显式表达。
	externalImageDefault: "skip" as ExternalImageDefault,
	// ⚠️ 默认**不限制**（0）。上限默认关着有两层理由：
	// ① 自动淘汰是"后台删文件"，用户没要求就不该发生；
	// ② 它默认关着，"离线可用"这个主承诺就不会被悄悄打折。
	cacheLimitMb: 0,
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
	autoUpload: boolValue(),
	enabledExtensions: textListValue(),
	attachmentFolder: pathValue(),
	localCopy: oneOfValue(LOCAL_COPY_ACTIONS),
	// ⚠️ 用 requiredTextValue 而不是 textValue：缓存目录为空会让缓存**静默失效**
	// （路径推不出来 → 永远不命中），比"回落到默认目录"糟得多。
	cacheFolder: pathValue({ required: true }),
	fallbackDownload: boolValue(),
	externalImageCache: boolValue(),
	externalImageDefault: oneOfValue(EXTERNAL_IMAGE_DEFAULTS),
	cacheLimitMb: numberValue({ min: 0, max: CACHE_LIMIT_MB_MAX }),
};

const S3_FALLBACKS: S3Config = {
	endpoint: "",
	region: "auto",
	bucket: "",
	publicUrlBase: "",
	// 空 = 尚未填写 / 尚未选。**不给写死的默认值** —— 见 textValue 的说明。
	// ⚠️ 前者是明文标识符（可以含大写），后者才是钥匙串里的名字。
	accessKeyId: "",
	secretAccessKeyRef: "",
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
	accessKeyId: textValue(),
	secretAccessKeyRef: textValue(),
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
