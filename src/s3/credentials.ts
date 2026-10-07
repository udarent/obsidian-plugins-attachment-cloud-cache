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
			accessKeyId,
			secretAccessKey,
		},
	};
}
