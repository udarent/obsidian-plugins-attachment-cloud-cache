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
 *   ⚠️ 唯一的例外是 1.2.0 取消的 `objectKeyTemplate`：设置同样不需要迁移，
 *   但**用户需要被告知**（他的 key 形状固定成 `名字-哈希.扩展名` 了），
 *   而且遗留值该从文件里清掉 ⇒ 见 `hasLegacyObjectKeyTemplate` 与 `main.ts` 的载入流程。
 */

import { EXTERNAL_SITE_MODES, LOCAL_COPY_ACTIONS, MIGRATION_STATES, isExternalSiteMode, isLocalCopyAction } from "./types";
import type { ExternalSiteMode, LocalCopyAction, MigrationState, PluginSettings, S3Config } from "./types";
import { CACHE_LIMIT_MB_MAX } from "./types";
import { isPlainRecord } from "./records";
import { isSafeId } from "./s3/declaration";

// 枚举类型守卫定义在 types.ts（与枚举本身同处一地，避免两个模块各存一份）。
// 这里转出去，让"读设置的模块"同时就是"拿守卫的模块"。
export { isExternalSiteMode, isLocalCopyAction };

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
 * - `accessKeyId` 空 = 尚未填写访问密钥 ID；
 * - `secretAccessKeyRef` 空 = 尚未在钥匙串里选密钥。
 * 后者尤其不能回落成某个写死的名字 —— 那会指向一个不存在的密钥，
 * 表现为"提示密钥无效"却查不出原因。
 */
function textValue(): FieldReader<string> {
	return (raw, fallback) => (typeof raw === "string" ? raw : fallback);
}

/**
 * 字符串数组：只接受**元素全是字符串**的数组，其余一律回退。
 *
 * ⚠️ 返回的永远是**新数组**。`fallback` 是出厂表里那一个（被 `SETTINGS_DEFAULTS` 展开后
 * 仍与它共用引用），直接把它返回出去就等于"用户设置"和"出厂值"是同一个数组 ——
 * 之后任何一次 `list.push(...)` 都会改到出厂值本身，于是**后续所有新实例**都带着
 * 被改过的名单。与 `SETTINGS_DEFAULTS` 必须单独复制 `s3` 是同一条理由。
 *
 * ⚠️ 元素只做"去首尾空白 + 丢掉空条目"：**怎么解读**（后缀匹配、端口、去重）
 * 是纯函数的事（`render/external-decide.ts`）。这里只保证"设置里存的是字符串数组"。
 */
function stringListValue(): FieldReader<string[]> {
	return (raw, fallback) => {
		if (!Array.isArray(raw)) return [...fallback];
		// `Array.isArray` 只把类型收窄到 `any[]`，元素仍是 `any` —— 显式收成 `unknown[]`
		// 再过类型判断，别让 `any` 顺着 `.trim()` 漏下去（lint 会拦，也确实该拦）。
		const items = raw as unknown[];
		if (!items.every((item) => typeof item === "string")) return [...fallback];
		return (items as string[]).map((item) => item.trim()).filter((item) => item !== "");
	};
}

/** 非空字符串：用于**为空会直接导致功能不可用**的字段（如目录名、区域）。 */
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

/** 1.2.0（D-17）之前 `localCopy` 的第三个取值（"移入缓存目录"）。 */
const LEGACY_LOCAL_COPY = "cache";

/**
 * `localCopy` 的读取器：把**遗留值** `"cache"` 静默折成 `"keep"`（⭐ 1.2.0 / D-17）。
 *
 * 为什么不直接靠 `oneOfValue` 的"非法值回落默认"：那条路今天恰好也得到 `"keep"`，
 * 但它**跟着默认值走** —— 哪天默认值改成别的档，老用户存着的 `"cache"` 就会被静默搬到
 * 另一个档位去。这个字段决定"上传后本地文件还在不在"，搬错档是会让人丢文件的
 * ⇒ 显式写死"`"cache"` 就是 `"keep"`"，不依赖默认值。
 */
function localCopyValue(): FieldReader<LocalCopyAction> {
	return (raw, fallback) => {
		if (raw === LEGACY_LOCAL_COPY) return "keep";
		return (LOCAL_COPY_ACTIONS as readonly string[]).includes(raw as string)
			? (raw as LocalCopyAction)
			: fallback;
	};
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
 * 身份串（`vaultId` / `deviceId`）：只认声明层那套形状。
 *
 * 不合法的值**回退到默认值（空串）**，由载入流程重新生成 —— 这一点比"原样保留"重要：
 * 一个带 `/` 或 `..` 的 id 会被拼进对象 key（声明前缀），保留它等于允许写到别的前缀去。
 */
function idValue(): FieldReader<string> {
	return (raw, fallback) => (isSafeId(raw) ? raw : fallback);
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
	// ⚠️ 默认「留在附件目录」：本地副本是"离线可用"这个主承诺的前提，而 1.2.0（D-17）起
	// 那份副本**就是附件本身**（不再有"搬进缓存目录"这一步）⇒ 这是唯一不牺牲离线的档。
	// ⚠️ 1.2.0 之前这里写的是 `"cache"`；老用户存着的值由 `localCopyValue` 折成同一个结果。
	localCopy: "keep" as LocalCopyAction,
	fallbackDownload: true,
	// ⚠️ 默认**关**。打开它意味着渲染时遇到站外文件就会对外发 GET + PUT
	// 并**改写用户的笔记** —— 这类动作必须由用户**事前、显式**决定；
	// 出厂就开着等于替他做了决定（他多半还不知道这个功能存在）。
	externalImageCache: false,
	// ⚠️ 出厂「不过滤」：名单是一项**收窄**，默认不该替用户排除掉任何站点。
	externalSiteMode: "off" as ExternalSiteMode,
	// ⚠️ 空名单。注意 `allowlist` + 空名单 = **一个站点都不自动处理**（见 `types.ts`）。
	externalSiteList: [] as string[],
	// ⚠️ 默认**关**，与 `externalImageCache` 同一条理由（而且更重）：
	// 打开它意味着按笔记里写的 `file:///D:/…` 去读**库外**的绝对路径 —— 那些路径
	// 不受库里任何约束，常常还是临时目录。用户没要求就不该去翻。
	uploadLocalFiles: false,
	// ⚠️ 默认**不限制**（0）。上限默认关着有两层理由：
	// ① 自动淘汰是"后台删文件"，用户没要求就不该发生；
	// ② 它默认关着，"离线可用"这个主承诺就不会被悄悄打折。
	cacheLimitMb: 0,
	// ⚠️ 默认**关**：它只写控制台，但"默认就在打日志"会让排障时无法区分
	// "这条是本次的"还是"上次留下的"，也会让支持者收到无关的粘贴。
	debugLogging: false,
	// ⚠️ 默认**关**：打开它要给密钥加 `ListBucket` 权限，而且"保护成立"要求所有在用设备
	// 都升级并打开（旧版不写声明）⇒ 出厂就开着等于给了半个承诺。
	sharedBucket: false,
	// 空串 = 还没生成（`loadSettings` 会补一次随机值并落盘）。空串**不能**当成身份用：
	// 那会让所有设备写出同一个前缀，声明互相覆盖。
	vaultId: "",
	deviceId: "",
	// ⚠️ 持久化的是**闸门**不是进度：崩溃时它留在 `running`，于是重启后改名仍被拒，
	// 直到用户明确选「继续」或「放弃」（见 `types.ts::MigrationState`）。
	migrationState: "idle" as MigrationState,
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
	localCopy: localCopyValue(),
	fallbackDownload: boolValue(),
	externalImageCache: boolValue(),
	externalSiteMode: oneOfValue(EXTERNAL_SITE_MODES),
	externalSiteList: stringListValue(),
	uploadLocalFiles: boolValue(),
	cacheLimitMb: numberValue({ min: 0, max: CACHE_LIMIT_MB_MAX }),
	debugLogging: boolValue(),
	sharedBucket: boolValue(),
	vaultId: idValue(),
	deviceId: idValue(),
	migrationState: oneOfValue(MIGRATION_STATES),
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
	// ⚠️ 1.2.0 起这里**没有** key 模板字段了：形状不可配置（理由见 `object-key.ts` 文件头 ——
	// 不含完整 `{hash}` 的模板会静默串内容/覆盖对象）。老 `data.json` 里那个遗留键
	// 由字段表自动丢弃（见下面的 `hasLegacyObjectKeyTemplate` 与文件头第 2 条约束）。
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
};

export const S3_DEFAULTS: S3Config = { ...S3_FALLBACKS };

/**
 * 老 `data.json` 里有没有**已被取消的 key 模板**字段（1.2.0）。
 *
 * ## 为什么要单独问一句，而不是"反正字段表会丢掉"
 *
 * 字段表确实会丢掉它（合并结果里不可能带上未知键），所以**设置本身不需要迁移**。
 * 但有两件事它也做不到：
 *
 * 1. **告诉用户**：他的 key 形状要从"自定义/纯哈希"变成固定的 `名字-哈希.扩展名`。
 *    这不需要他做任何事，但**必须让他知道** —— 否则某天他会发现桶里对象的命名变了。
 * 2. **把文件本身弄干净**：遗留值会一直躺在 `data.json` 里，直到用户碰巧保存了一次设置。
 *
 * ⚠️ 刻意只看**这一个**键：更早版本砍掉的字段（`cacheEnabled`、明文凭据……）
 * 一直没有迁移代码、也不需要有 —— 为它们写一次全量重写会把"顺手清理未知键"
 * 变成一条隐式行为，那不是这一次要解决的问题。
 */
/**
 * 从原始设置里取出 `s3` 段（不是对象就当空对象）。
 *
 * ⚠️ 抽出来只有一个理由：**"怎么读这一块"必须只有一处定义**。
 * 合并逻辑与遗留键识别都要读它；两处各写一遍的话，"其中一处读错"不会有任何报错 ——
 * 而它的表现是"整块配置读不出来"或"升级不触发"，都属于最难查的那一类（不报错的静默失效）。
 */
function s3BlockOf(raw: Record<string, unknown>): Record<string, unknown> {
	return isPlainRecord(raw.s3) ? raw.s3 : {};
}

export function hasLegacyObjectKeyTemplate(loaded: unknown): boolean {
	const raw = isPlainRecord(loaded) ? loaded : {};
	const rawS3 = s3BlockOf(raw);
	return Object.prototype.hasOwnProperty.call(rawS3, "objectKeyTemplate");
}

/**
 * 老 `data.json` 里还有没有**已被取消的**「遇到站外文件链接时」那一档（1.2.0）。
 *
 * 与 `hasLegacyObjectKeyTemplate` 同一个用途：**识别**（决定要不要跑一次迁移）、
 * **清理**（把遗留值从文件里写掉）、**告知**（旧的两档并成了一个开关，得说一声）。
 * ⚠️ 同样只看这一个键，不顺手清理更早版本砍掉的东西。
 */
export function hasLegacyExternalImageDefault(loaded: unknown): boolean {
	const raw = isPlainRecord(loaded) ? loaded : {};
	return Object.prototype.hasOwnProperty.call(raw, "externalImageDefault");
}

/**
 * 把旧的两档折算成新的**一个开关**（1.2.0）。
 *
 * ⭐ 判据只有一条：**旧数据里有没有一次真正的"同意自动搬"**。
 * 只有当 `externalImageCache === true` **且** `externalImageDefault === "cache"` 时才算——
 * 也就是用户当年明确选了「直接缓存」。
 *
 * ## ⚠️ 为什么不能简单地"沿用 `externalImageCache` 那个布尔值"
 *
 * 那样会让一批 `externalImageCache: true` + `externalImageDefault: "skip"` 的用户
 * **被动地**开始自动下载别人的图、并改写自己的笔记 —— 而他们当年那个组合的含义
 * 恰恰是"开着功能，但什么都别自动做"（多半是为了用「手动选择要上传的文件」）。
 *
 * ⚠️ 判据不是"怕踩某条红线"，而是**不擅自改变用户已经表达过的配置**：
 * 他选过"别自动做"，迁移就不能把它变成"自动做"。这与"站外图一律不许自动下载"
 * 无关 —— 那句话在 1.2.0 之后**不再是规则**：要不要自动处理，现在由用户在设置里
 * **事前显式**决定（默认关）。
 *
 * 这类用户升级后开关是**关**的，但「手动选择要上传的文件」已经**独立于开关**
 *（见 `render/external-decide.ts` 的 `purpose`），所以他们照样能手动挑 —— 一件都没少。
 */
export function legacyAutoCacheEnabled(loaded: unknown): boolean {
	const raw = isPlainRecord(loaded) ? loaded : {};
	return raw.externalImageCache === true && raw.externalImageDefault === "cache";
}

/**
 * 出厂默认设置。
 *
 * 用展开而不是直接导出内部表，是为了给调用方一份**可安全改动**的副本：
 * 直接导出的话，任何一处 `settings.foo = x` 都会改到"出厂值"本身，
 * 于是后续所有新建的插件实例都带着被改过的默认值 —— 那种污染极难追查。
 */
export const SETTINGS_DEFAULTS: PluginSettings = {
	...FACTORY_SETTINGS,
	// ⚠️ 嵌套对象必须**单独复制**：浅展开只会复制引用，`s3`
	// 会与出厂表共用同一个对象，改一处就等于改出厂值。
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
	const rawS3 = s3BlockOf(raw);

	const { s3: _ignoredS3, ...rest } = defaults;
	void _ignoredS3;

	return {
		...readFields(SETTINGS_SPEC, raw, rest as Omit<PluginSettings, "s3">),
		s3: readFields(S3_SPEC, rawS3, defaults.s3),
	};
}
