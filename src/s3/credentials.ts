/**
 * 凭据的解析：把设置里存的**密钥名字**换成**密钥值**。
 *
 * ## 两项凭据的性质不同，处理也不同
 *
 * | | 存哪 | 状态 | 为什么 |
 * |---|---|---|---|
 * | 访问密钥 ID | 设置里（明文）| 只有"填了 / 没填" | 它是标识符；且钥匙串的 ID 不允许大写，装不下它 |
 * | 秘密访问密钥 | 钥匙串（设置里只存名字）| 多一种"名字还在、密钥没了" | 它是秘密；且名字可能过期 |
 *
 * 所以**不是两项都需要"换名字"**：访问密钥 ID 直接从设置读，秘密才需要
 * `getSecret(name)` 去换。这一层仍然值得存在，因为它把"两种失效"分清楚了。
 *
 * ## 这个模块还有第二件事：解析**外来的凭据文件**
 *
 * 存储服务商往往会给你一个 json（MinIO 控制台的「下载凭据」就是
 * `{url, accessKey, secretKey, api, path}`），让用户照着往下抄三项是纯粹的浪费。
 * `parseCredentialFile` 把它读成「要写进设置的字段 + 一个**秘密**」——
 * 秘密单独一个字段，**绝不混进要写设置的 `patch` 里**，这条由套件钉住。
 *
 * ## 为什么绕这一层
 *
 * Obsidian 1.11.4 起的密钥模型是「**中心化的具名密钥**」：
 * 用户在钥匙串里创建一条密钥（带个名字），插件只保存那个**名字**，
 * 取用时用 `app.secretStorage.getSecret(name)` 换出值。
 * 官方指南原话："your plugin settings contain the name of the secret,
 * not the actual secret value."
 *
 * 这样做的好处在"密钥会变"这件事上最明显：同一个 R2 密钥可以同时被
 * 好几个插件引用，用户改一次（或换一次）就全部生效，
 * 而不是逐个插件粘贴一遍。
 *
 * ## 秘密访问密钥的三种状态必须分清楚（否则用户没法定位）
 *
 * | 状态 | 现象 | 用户该做什么 |
 * |---|---|---|
 * | 名字为空 | 从未选过 | 去钥匙串里**选或新建**一条 |
 * | 名字非空、但取不到值 | 名字指向的密钥**已不存在** | 名字过期了 —— 重新选一条；或那条密钥被删了 |
 * | 名字非空、且取得到值 | 正常 | — |
 *
 * 把前两种都报成"凭据未配置"是不合格的：第二种的修法是**重新选**，
 * 不是"去配置"，而用户已经配过了 —— 他会以为自己填的东西丢了。
 *
 * ## 为什么 `reader` 是参数而不是直接用 `app`
 *
 * 只依赖 `getSecret` 这一个方法（`SecretReader`），于是这个模块**不需要真实 App**
 * 就能穷举测试各种状态 —— 包括"名字指向不存在的密钥"这种平时很难造出来的情况。
 * `app.secretStorage` 天然满足这个接口。
 */

import type { PluginSettings, S3Config } from "../types";
import type { S3ClientConfig } from "./client";

/** 只需要这一个能力 —— 于是测试里给个假对象就够，不必造整个 App。 */
export interface SecretReader {
	getSecret(id: string): string | null;
}

/** 秘密访问密钥（钥匙串条目）的**存在性**状态，供设置界面显示。 */
export type CredentialState =
	/** 名字为空 —— 从未选择过。 */
	| "unset"
	/** 名字非空，但钥匙串里取不到值 —— 那条密钥已不存在（被删或改了名）。 */
	| "missing"
	/** 名字非空且能取到值。 */
	| "ok";

/** 钥匙串条目的状态。 */
export interface CredentialSlot {
	/** 设置里存的名字（可能为空）。 */
	name: string;
	state: CredentialState;
}

export interface CredentialStatus {
	/**
	 * 访问密钥 ID 是否已填。
	 *
	 * ⚠️ 它是**明文标识符**，所以只有"填了/没填"两种状态 ——
	 * 没有"已丢失"可言（那种状态只属于钥匙串条目）。
	 * 别为了对称把它做成 `CredentialSlot`：那会暗示它有一个可以失效的引用。
	 */
	accessKeyIdPresent: boolean;
	/** 秘密访问密钥（钥匙串条目）：要区分"没选"与"选了但已不存在"。 */
	secretAccessKey: CredentialSlot;
	/** 两项都齐 —— 此时才可能连得上。 */
	complete: boolean;
}

/**
 * 判断一条具名密钥的状态。
 *
 * ⚠️ 判断"取不到值"时把**空串**也算作无效：`getSecret` 在键不存在时返回 `null`，
 * 但一条被清空的密钥可能返回 `""`。两者对签名而言同样不可用，
 * 而 `if (value)` 这种写法恰好能把它们一起挡住 —— 这里显式说明，
 * 免得读代码的人以为空串是合法密钥。
 */
function slotState(reader: SecretReader, name: string): CredentialSlot {
	const trimmed = String(name ?? "").trim();
	if (trimmed === "") return { name: "", state: "unset" };

	let value: string | null = null;
	try {
		value = reader.getSecret(trimmed);
	} catch {
		// 钥匙串读取失败（宿主实现差异、锁定等）按"取不到"处理，
		// 而不是让整个设置界面崩掉 —— 界面要能显示"读不到"，用户才有线索。
		value = null;
	}

	return { name: trimmed, state: value ? "ok" : "missing" };
}

/** 汇总两项凭据的状态。 */
export function credentialStatus(reader: SecretReader, s3: S3Config): CredentialStatus {
	const accessKeyIdPresent = String(s3.accessKeyId ?? "").trim() !== "";
	const secretAccessKey = slotState(reader, s3.secretAccessKeyRef);
	return {
		accessKeyIdPresent,
		secretAccessKey,
		complete: accessKeyIdPresent && secretAccessKey.state === "ok",
	};
}

/** 连通性检查的结果 —— 供"测试连接"按钮判断，也能直接展示给用户。 */
export type Readiness =
	| { ready: true; config: S3ClientConfig }
	| { ready: false; problem: string; fixIn: "connection" | "credentials" };

/**
 * 组装客户端配置；配置不全时给出**能照着修**的原因。
 *
 * 分 `fixIn` 是为了让界面能把用户**送到该去的那一栏** —— "桶名没填"和
 * "密钥没选"在设置页的两个不同区域，只说"配置不完整"等于让用户自己找。
 *
 * ⚠️⚠️ **这里返回的 `config` 是入口、粘贴钩子、设置页"测试连接"三条路唯一的客户端来源**，
 * 所以它必须**带全** `S3ClientConfig` 声明的字段。漏一个不会有任何报错 ——
 * 只会让那条功能**静默**失效。实测踩到：`publicUrlBase` 曾漏在这里，于是用户配的公开前缀
 * **从未生效**，笔记里的链接一直退回对象地址（私有桶上那些链接对别人就是 404），
 * 而类型系统看不出来（当时 `S3ClientConfig` 里根本没有这个字段，所以"少传"不算错）。
 * ⇒ 给客户端加字段时，先问一句："它要不要从设置流到这里？"
 */
export function connectionReadiness(reader: SecretReader, settings: PluginSettings): Readiness {
	const s3 = settings.s3;

	if (String(s3.endpoint ?? "").trim() === "") {
		return { ready: false, problem: "服务地址未填写", fixIn: "connection" };
	}
	if (String(s3.bucket ?? "").trim() === "") {
		return { ready: false, problem: "存储桶名未填写", fixIn: "connection" };
	}

	const status = credentialStatus(reader, s3);
	if (!status.accessKeyIdPresent || status.secretAccessKey.state === "unset") {
		return { ready: false, problem: "尚未填写访问密钥", fixIn: "credentials" };
	}
	if (status.secretAccessKey.state === "missing") {
		// ⚠️ 与上一分支分开：这两种情况的修法不同（这里要**重新选**那条钥匙串密钥，
		// 而不是"去配置"—— 用户已经配过了，笼统报"未配置"会让他以为填的东西丢了）。
		return {
			ready: false,
			problem: "所选密钥在钥匙串里已不存在，请重新选择",
			fixIn: "credentials",
		};
	}

	// 访问密钥 ID 直接取设置里的值（明文标识符，不需要去钥匙串换）；
	// 只有秘密访问密钥需要换出真正的值。
	const accessKeyId = String(s3.accessKeyId ?? "").trim();
	const secretAccessKey = reader.getSecret(status.secretAccessKey.name) ?? "";

	return {
		ready: true,
		config: {
			endpoint: s3.endpoint,
			bucket: s3.bucket,
			region: s3.region,
			forcePathStyle: s3.forcePathStyle,
			// ⚠️ 别删这一行：它决定笔记里写什么链接。原样传（归一化由 URL 组装层做一次）。
			publicUrlBase: s3.publicUrlBase,
			accessKeyId,
			secretAccessKey,
		},
	};
}

// ═══════════════════════ 外来的凭据文件 ═══════════════════════
//
// ## 为什么值得做
//
// 存储服务商会给你一个 json。MinIO 控制台建完访问密钥后的「下载凭据」给的正是：
//
// ```json
// { "url": "https://minio.example.com:9000",
//   "accessKey": "…", "secretKey": "…", "api": "s3v4", "path": "auto" }
// ```
//
// 没有这个入口时，用户要照着它**手抄三项**（服务地址、访问密钥 ID、秘密）——
// 而其中那一项是 32 位随机串，手抄一遍的出错的概率不低，且抄错的症状是
// "凭据被拒"，看不出是抄错了哪一位。
//
// ## ⚠️ 这里的硬约束：秘密**只走 `secret` 一个出口**
//
// 解析结果被拆成两半，这不是风格问题而是**安全边界**：
//
// | 出口 | 内容 | 去向 |
// |---|---|---|
// | `patch` | 服务地址 / 访问密钥 ID / 寻址方式 | 设置（`data.json`，明文） |
// | `secret` | 秘密访问密钥的**值** | 钥匙串（`SecretStorage`），**绝不进设置** |
//
// 两半混在一起（比如把 `secretKey` 也放进 `patch`）不会有任何报错，
// 只会让秘密悄悄落进 `data.json` —— 而那个文件会随 vault 同步、备份、分享出去。
// 所以套件里有一条断言专门核"`patch` 里不含秘密值"。
//
// ## 为什么容忍多种拼写
//
// 各家给自己的字段名不一样（`url`/`endpoint`、`accessKey`/`accessKeyId`、
// `secretKey`/`secretAccessKey`），用户也可能自己写一份。**认得多一种拼写，
// 就少一次"文件明明是对的，插件却说认不出来"** —— 而这里没有歧义风险：
// 这些名字都只可能指同一个东西。反过来，一个都不认识时**如实说认不出来**
// （`noCredentials`），而不是猜一个近似的字段填进去。

/**
 * 认不出这份文件时的原因码。
 *
 * 返回**码**而不是句子：文案由界面那一层取（`s3ImportProblem_*`），
 * 于是这个模块不依赖 i18n，能在没有真实 App 的地方穷举各种输入。
 */
export type CredentialFileProblem =
	/** 不是合法 JSON（空文件、复制时截断、复制成了别的格式）。 */
	| "notJson"
	/** 是 JSON，但顶层不是对象（数组、字符串、数字）。 */
	| "notObject"
	/** 是对象，但里面没有任何能认出来的凭据字段。 */
	| "noCredentials";

/**
 * 解析成功时要**写进设置**的字段。
 *
 * ⚠️ 每个字段都是可选的，而且只有文件里**真的有**才会出现 —— 一份只有秘密的
 * 文件不该顺手把服务地址清空。界面据此报告"这次改了哪几项"。
 */
export interface CredentialFilePatch {
	endpoint?: string;
	accessKeyId?: string;
	forcePathStyle?: boolean;
}

export type CredentialFileResult =
	| {
			ok: true;
			/** 要写进设置的字段（**绝不含秘密**）。 */
			patch: CredentialFilePatch;
			/**
			 * 秘密访问密钥的值，调用方**必须**把它写进钥匙串。
			 * `null` = 文件里没有这一项（此时只导入别的字段，不动已存的秘密）。
			 */
			secret: string | null;
			/**
			 * 文件里有、但我们**用不上**的键（如 `api`）—— 如实回报，
			 * 界面才能说清"文件认出来了，只是其中有几项与这里无关"，
			 * 而不是让用户对着一个"部分生效"的结果猜。
			 */
			ignored: string[];
	  }
	| { ok: false; problem: CredentialFileProblem };

/** 服务地址：`url` 是 MinIO 的写法，其余是各家 SDK / 手写的常见写法。 */
const ENDPOINT_KEYS = ["url", "endpoint", "s3Endpoint", "s3EndpointUrl", "s3_endpoint"];
/** 访问密钥 ID（标识符，可以含大写）。 */
const ACCESS_KEY_KEYS = ["accessKey", "accessKeyId", "access_key_id", "access_key"];
/** 秘密访问密钥（⚠️ 唯一的秘密来源，只走 `secret` 出口）。 */
const SECRET_KEY_KEYS = ["secretKey", "secretAccessKey", "secret_key", "secret"];
/** 寻址方式（MinIO 的 `path`）。 */
const PATH_KEYS = ["path", "pathStyle", "forcePathStyle"];

/** 取第一个**非空字符串**，都取不到返回 `null`（空串 = 这一项没填，不是"填了个空的"）。 */
function firstText(record: Record<string, unknown>, keys: readonly string[]): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed !== "") return trimmed;
	}
	return null;
}

/**
 * 取第一个**出现过**的键的原始值。
 *
 * 与 `firstText` 的区别：不要求它是非空字符串。给"要看原始类型才能判断"的字段用
 * （寻址方式要区分 `on` / `off` / `auto`，而 `auto` 与"没写"是**不同**的结论 ——
 * 前者是"由客户端判断"，后者是"文件里没提这件事"，虽然两者最终都不覆盖用户设置，
 * 但混用会让以后想区分它们的人无从下手）。
 */
function firstRaw(record: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (key in record) return record[key];
	}
	return undefined;
}

/**
 * MinIO 的 `path` 取值 → 寻址方式。`auto` 返回 `undefined` = **不要覆盖**用户的设置。
 *
 * 三种取值的含义（`mc` 的口径）：`on` 强制 path-style，`off` 强制 virtual-host，
 * `auto` = "由客户端自己判断"。`auto` 恰恰是**最常见**的那个值（也是 MinIO 的默认），
 * 此时我们没有理由去动用户已有的选择 —— 而把它当 `true` 处理就会**静默改写**
 * 一个用户可能刻意设成 `false` 的字段。
 */
function pathStyleFrom(raw: unknown): boolean | undefined {
	if (typeof raw !== "string") return undefined;
	switch (raw.trim().toLowerCase()) {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return undefined;
	}
}

/**
 * 解析一份外来的凭据文件（MinIO 控制台的「下载凭据」是它的典型形状）。
 *
 * 纯函数：只读文本，不碰设置、不碰钥匙串、不碰文件系统。写进去的动作在 `main.ts`。
 */
export function parseCredentialFile(text: unknown): CredentialFileResult {
	if (typeof text !== "string" || text.trim() === "") return { ok: false, problem: "notJson" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, problem: "notJson" };
	}
	// 数组也是 `typeof "object"` —— 单独挡掉，否则 `["a"]` 会走到"没有任何凭据字段"，
	// 报出的原因与实情不符（用户会以为文件内容不对，其实是文件结构形式不对）。
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, problem: "notObject" };
	}

	const record = parsed as Record<string, unknown>;
	const patch: CredentialFilePatch = {};

	const endpoint = firstText(record, ENDPOINT_KEYS);
	if (endpoint !== null) patch.endpoint = endpoint;

	const accessKeyId = firstText(record, ACCESS_KEY_KEYS);
	if (accessKeyId !== null) patch.accessKeyId = accessKeyId;

	const pathStyle = pathStyleFrom(firstRaw(record, PATH_KEYS));
	if (pathStyle !== undefined) patch.forcePathStyle = pathStyle;

	const secret = firstText(record, SECRET_KEY_KEYS);

	// 一项都没认出来 ⇒ 如实说。此时**不**返回空 patch 的"成功"：
	// 那会让界面显示"已导入"，而实际上什么都没变 —— 最难查的那种结局。
	if (Object.keys(patch).length === 0 && secret === null) {
		return { ok: false, problem: "noCredentials" };
	}

	const consumed = new Set([...ENDPOINT_KEYS, ...ACCESS_KEY_KEYS, ...SECRET_KEY_KEYS, ...PATH_KEYS]);
	const ignored = Object.keys(record).filter((key) => !consumed.has(key));

	return { ok: true, patch, secret, ignored };
}
