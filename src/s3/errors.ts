/**
 * S3 的错误分类。
 *
 * ## 为什么必须分类，而不是"失败了就重试"
 *
 * 重试的代价是不对称的：
 * - **该重试的不重试** → 用户看到一次偶发的 503 就以为插件坏了。
 * - **不该重试的重试** → 更糟。凭据错（403）时连试 3 次毫无意义，
 *   而且会把一个"配置错误，请改设置"变成"卡住几秒钟然后还是失败"；
 *   在限流（429）时还会火上浇油。
 *
 * 所以判据是**白名单**：只有明确属于"稍后可能成功"的才重试。
 * 4xx 一律不重试 —— 请求本身被拒了，重发同一个请求只会同样被拒。
 *
 * ## 一条硬约束：错误信息里不能出现密钥
 *
 * 错误会被显示在 Notice 里、写进日志、甚至被用户截图发到 issue。
 * 服务端返回的 XML 在 `SignatureDoesNotMatch` 时**会带上 `StringToSign` 等内容**，
 * 虽然正常不含 secret，但"正常不含"不足以作为依据 ——
 * 中间代理、自建 MinIO 或错误配置都可能把请求回显出来。
 * 所以这里对每条外发文案做一次**无条件脱敏**，而不是相信上游。
 */

/** 错误的性质。UI 据此给不同的处置建议。 */
export type S3ErrorKind =
	/** 没拿到 HTTP 响应：断网、DNS、TLS、超时、连接被重置。 */
	| "network"
	/** 凭据 / 签名 / 权限问题（401、403）。 */
	| "auth"
	/** 对象或桶不存在（404）。 */
	| "notFound"
	/** 被限流（429、SlowDown）。 */
	| "throttled"
	/** 服务端故障（5xx）。 */
	| "server"
	/** 其它 4xx：请求本身有问题（400、409……）。 */
	| "client"
	/** 兜底。 */
	| "unknown";

export interface S3ErrorInit {
	kind: S3ErrorKind;
	status: number;
	code: string;
	message: string;
	requestId: string;
	operation: string;
	key: string;
	attempts: number;
	/** 需要从文案里抹掉的字符串（密钥）。 */
	secrets?: string[];
	/** 原始响应体，仅供排查（已脱敏）。 */
	body?: string;
}

export class S3Error extends Error {
	readonly kind: S3ErrorKind;
	/** HTTP 状态码；`0` 表示根本没拿到响应。 */
	readonly status: number;
	/** S3 返回的错误码，如 `SignatureDoesNotMatch`；解析不到则为空串。 */
	readonly code: string;
	/** 服务端给的请求 id —— 找云厂商客服时唯一有用的东西。 */
	readonly requestId: string;
	readonly retryable: boolean;
	readonly operation: string;
	readonly key: string;
	/** 实际尝试了几次（含首次）。 */
	readonly attempts: number;
	/** 给 i18n 用的建议键名，由 UI 翻成人话。 */
	readonly hintKey: string;
	/**
	 * 服务端返回的原始响应体（**已脱敏**）。
	 *
	 * 单独放一个字段，而不是塞进 `message`：`SignatureDoesNotMatch` 的 XML
	 * 会带上规范的请求串，对排查极有价值，但把它拼进用户看到的提示里
	 * 就成了一屏噪音。所以「显示什么」与「记录什么」分开。
	 */
	readonly body: string;

	constructor(init: S3ErrorInit) {
		const secrets = (init.secrets ?? []).filter((s) => typeof s === "string" && s !== "");
		const detail = redactSecrets(init.message, secrets);
		super(buildMessage(init, detail));
		this.name = "S3Error";
		this.kind = init.kind;
		this.status = init.status;
		this.code = init.code;
		this.requestId = init.requestId;
		this.retryable = isRetryable(init.kind, init.status, init.code);
		this.operation = init.operation;
		this.key = init.key;
		this.attempts = init.attempts;
		this.hintKey = hintKeyFor(init.kind, init.code);
		this.body = redactSecrets(init.body ?? "", secrets);
	}
}

/** 把文案里的每一处密钥替换成占位符。用 split/join 而不是正则，免去转义问题。 */
export function redactSecrets(text: string, secrets: string[]): string {
	let out = String(text ?? "");
	for (const secret of secrets) {
		if (!secret) continue;
		out = out.split(secret).join("«redacted»");
	}
	return out;
}

/**
 * 拼出给日志 / 控制台看的一行。
 *
 * 刻意**不写中文**：这条会进开发者控制台与 issue 附件，语言中立才有用。
 * 用户看到的那句话由 UI 依据 `hintKey` + `status` + `code` 翻译。
 */
function buildMessage(init: S3ErrorInit, detail: string): string {
	const where = init.key ? ` [${init.key}]` : "";
	const code = init.code ? ` ${init.code}` : "";
	const status = init.status === 0 ? "no response" : `HTTP ${init.status}`;
	const tries = init.attempts > 1 ? ` (after ${init.attempts} attempts)` : "";
	return `${init.operation.toUpperCase()}${where} → ${status}${code}: ${truncate(detail, 300)}${tries}`;
}

/** 截断时明确标出"被截断了"，避免让人以为响应体就这么短。 */
function truncate(text: string, limit: number): string {
	const clean = String(text ?? "").replace(/\s+/g, " ").trim();
	return clean.length <= limit ? clean : `${clean.slice(0, limit)}…（已截断）`;
}

/**
 * 是否值得重试。
 *
 * 白名单逻辑（而不是"排除 4xx"的写法）—— 这样将来新增状态码时，
 * 默认是**不重试**，偏保守的一侧。
 */
export function isRetryable(kind: S3ErrorKind, status: number, code: string): boolean {
	if (kind === "network") return true;
	if (kind === "throttled") return true;
	// 501 NotImplemented 是确定性的：服务端没实现这个能力，重试多少次都一样
	if (status === 501 || code === "NotImplemented") return false;
	if (status === 408 || status === 425 || status === 429) return true;
	if (kind === "server") return true;
	return false;
}

/** 状态码 + 错误码 → 性质。 */
export function classify(status: number, code: string): S3ErrorKind {
	const normalized = (code ?? "").trim();

	if (status === 0) return "network";

	// ⚠️ **先看错误码，再看状态码** —— 因为错误码更具体，而状态码会撒谎。
	//
	// 最典型的例子：AWS 在调用方没有 `s3:ListBucket` 权限时，
	// 对**不存在的对象**返回 `403 AccessDenied`（而不是 404）。
	// 若按状态码先判成 auth，用户就会去翻凭据设置 —— 而真正要改的是桶策略，
	// 或者那个对象本来就该重新上传。错误信息指错方向比信息少更糟。
	//
	// 反过来的情形不存在：服务端不会用 `NoSuchKey` 表示权限问题。
	if (normalized === "NoSuchKey" || normalized === "NoSuchBucket" || normalized === "NotFound") {
		return "notFound";
	}
	if (normalized === "SlowDown" || normalized === "Throttling" || normalized === "RequestLimitExceeded") {
		return "throttled";
	}

	if (status === 404) return "notFound";
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "throttled";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "unknown";
}

function hintKeyFor(kind: S3ErrorKind, code: string): string {
	// 先看更具体的错误码，再看性质 —— 前者能给更有针对性的建议
	if (code === "NoSuchBucket") return "s3HintNoSuchBucket";
	if (code === "SignatureDoesNotMatch") return "s3HintSignature";
	if (code === "AccessDenied") return "s3HintAccessDenied";
	if (kind === "auth") return "s3HintAuth";
	if (kind === "notFound") return "s3HintNotFound";
	if (kind === "throttled") return "s3HintThrottled";
	if (kind === "network") return "s3HintNetwork";
	if (kind === "server") return "s3HintServer";
	return "s3HintGeneric";
}

/** 解析结果（字段可能缺失，调用方自己决定兜底）。 */
export interface ParsedS3ErrorBody {
	code: string;
	message: string;
	requestId: string;
}

/**
 * 从响应体里抽出 S3 的错误码 / 描述 / 请求 id。
 *
 * 用正则而不是 `DOMParser`：S3 的错误 XML 是**扁平的**，没有嵌套同名元素，
 * 所以按标签取值足够可靠；而 `DOMParser` 在部分环境（以及被中间代理返回
 * HTML 错误页时）反而更难处理。同时正则方案在 Node 里可直接测，不需要 DOM。
 *
 * 体可能是 HTML（反向代理的错误页）或纯文本，那时三个字段都为空 ——
 * 调用方会把原文当 `message` 用，不至于丢掉信息。
 */
export function parseS3ErrorBody(body: string): ParsedS3ErrorBody {
	const text = String(body ?? "");
	return {
		code: extractTag(text, "Code"),
		message: extractTag(text, "Message"),
		requestId: extractTag(text, "RequestId") || extractTag(text, "RequestID"),
	};
}

function extractTag(xml: string, tag: string): string {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	if (!match) return "";
	return decodeXmlEntities(match[1].trim());
}

/** 只解最常见的五个实体 —— 够用，且不引入依赖。 */
function decodeXmlEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/** 是否是"可当对象读属性"的值（排除 null 与数组）。 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把"被抛出来的东西"转成一句能读的话。
 *
 * ⚠️ 不能直接 `String(x)`：`x` 的类型是 `unknown`，可能是对象/数组/符号，
 * `String({})` 会得到 `"[object Object]"` —— 那句话进了提示就是纯噪音，
 * 还把真正的原因盖掉。所以这里按类型分派。
 *
 * 同样**不能用** `Object.prototype.toString.call(x)` 当兜底：那正是
 * `"[object Object]"` 的来源（第一版就是这么写的，被断言当场抓出）。
 * 对象一律列字段名 —— 既不含噪音，又足以让人知道抛出的是什么。
 */
function describeThrown(error: unknown, raw: { message?: unknown } | undefined): string {
	if (typeof raw?.message === "string") return raw.message;
	if (error === null || error === undefined) return "";
	if (typeof error === "string") return error;
	if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
		return String(error);
	}
	if (typeof error === "symbol") return error.toString();
	if (Array.isArray(error)) return `数组（长度 ${error.length}）`;
	if (isObject(error)) {
		const keys = Object.keys(error);
		return keys.length > 0 ? `对象（字段：${keys.slice(0, 8).join(", ")}）` : "空对象";
	}
	return `无法描述的错误（${typeof error}）`;
}

/** 把一次"没拿到响应"的底层异常（fetch / requestUrl 抛出的东西）变成 `S3Error`。 */
export function networkError(init: {
	error: unknown;
	operation: string;
	key: string;
	attempts: number;
	secrets?: string[];
}): S3Error {
	const raw = isObject(init.error) ? (init.error as { message?: unknown; name?: unknown; code?: unknown }) : undefined;
	const name = typeof raw?.name === "string" ? raw.name : "";
	const text = describeThrown(init.error, raw);
	const code = typeof raw?.code === "string" ? raw.code : "";

	return new S3Error({
		kind: "network",
		status: 0,
		code: code || name,
		message: text || "请求未能发出或未收到响应",
		requestId: "",
		operation: init.operation,
		key: init.key,
		attempts: init.attempts,
		secrets: init.secrets,
	});
}

/**
 * 把一次"拿到了响应但不是 2xx"的结果变成 `S3Error`。
 *
 * 只有 2xx 算成功：3xx 也不接受。因为 S3 的 3xx 通常意味着
 * 端点配错了（如区域不对、桶名写进了路径但服务端要求虚拟主机），
 * 拿它当成功会让上层记下一条**指向错误位置**的 URL，比直接报错更难查。
 */
export function responseError(init: {
	status: number;
	body: string;
	operation: string;
	key: string;
	attempts: number;
	secrets?: string[];
}): S3Error {
	const parsed = parseS3ErrorBody(init.body);
	const message = parsed.message || init.body || `服务端返回 ${init.status}`;
	return new S3Error({
		kind: classify(init.status, parsed.code),
		status: init.status,
		code: parsed.code,
		message,
		requestId: parsed.requestId,
		operation: init.operation,
		key: init.key,
		attempts: init.attempts,
		secrets: init.secrets,
		body: parsed.message ? init.body : "",
	});
}

/** 成功判定：只有 2xx。 */
export function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}
