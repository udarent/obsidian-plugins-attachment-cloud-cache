/**
 * AWS Signature Version 4（`AWS4-HMAC-SHA256`，header 形式）。
 *
 * 目的是**不依赖任何 SDK** 地支持 S3 兼容存储（Cloudflare R2 / MinIO / AWS S3 /
 * Backblaze B2 / Wasabi / 阿里云 OSS / 腾讯 COS）—— 见 `docs/SCOPE.md` 的"不做什么"。
 *
 * ## 为什么值得自己写
 *
 * 官方文档自己就这么说：
 *
 * > The standard UriEncode functions provided by your development platform might not work
 * > because of differences in implementation and related ambiguity in the underlying RFCs.
 * > We recommend that you write your own custom UriEncode function.
 *
 * 而 `encodeURIComponent`（平台上的那种"标准编码"）恰恰**不编码** `!'()*` 与 `$`，
 * 这会让含这些字符的 key 签名对不上 —— 报错是 `SignatureDoesNotMatch`，
 * 但真实原因是文件名，极难往那个方向想。所以这里自写 `uriEncode`。
 *
 * ## 正确性凭什么保证
 *
 * 不靠"看起来对"，靠 AWS **亲自公布过**的向量。`test-sigv4.mjs` 里钉着三条：
 *
 * 1. `aws-sig-v4-test-suite` 的 `get-vanilla`
 *    → `5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`
 * 2. 同套件的 `get-vanilla-query-order-key-case`（查询串编码后排序）
 *    → `b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500`
 * 3. S3 文档的 `GET Object` 示例（含 `Range` 与 `x-amz-content-sha256`）
 *    → `f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`
 *
 * 这三条的价值在于：SHA-256 是抗碰撞的，签名对上就意味着**规范化请求逐字节正确** ——
 * 任何一处空格、排序、编码的偏差都会立刻让签名变味。所以它们同时也在钉住
 * canonical request 的拼装方式，而不只是"又一个十六进制串"。
 */

import { hexEncode, hmacSha256, sha256Hex, toBytes, utf8Bytes } from "./hash";

/** 算法标识（出现在 `Authorization` 与 string-to-sign 首行）。 */
export const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

/** S3 的服务名。用错会得到 `SignatureDoesNotMatch`。 */
export const S3_SERVICE = "s3";

/**
 * RFC 3986 的 unreserved 集合：`A-Z a-z 0-9 - _ . ~`。
 *
 * 这几个**必须原样保留**，其余一律百分号编码。注意与 `encodeURIComponent` 的差别：
 * - `encodeURIComponent` **不编码** `! ' ( ) *`，而 AWS 要求它们编码；
 * - `encodeURIComponent` 会编码 `~`（较老版本），而 AWS 要求保留。
 * 两处都是"签名对不上但看不出原因"的经典来源。
 */
function isUnreserved(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) || // A-Z
		(code >= 0x61 && code <= 0x7a) || // a-z
		(code >= 0x30 && code <= 0x39) || // 0-9
		code === 0x2d || // -
		code === 0x5f || // _
		code === 0x2e || // .
		code === 0x7e // ~
	);
}

/**
 * AWS 的 UriEncode：逐字节判断，非 unreserved 的字节编成 `%XX`（**大写**十六进制）。
 *
 * 逐**字节**而不是逐字符是关键：非 ASCII 要先按 UTF-8 拆成字节再编码，
 * 否则 `中` 会被编成 `%4E2D`（UTF-16 码元）而不是正确的 `%E4%B8%AD`。
 */
export function uriEncode(value: string): string {
	const bytes = utf8Bytes(value);
	let out = "";
	for (let i = 0; i < bytes.length; i += 1) {
		const byte = bytes[i];
		out += isUnreserved(byte)
			? String.fromCharCode(byte)
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/**
 * 规范化 URI 里**允许出现**的字符：unreserved、`/`、以及 `%XX` 三元组。
 *
 * 用它做一次断言，是因为"路径到底是原始的还是已编码的"这个约定
 * 一旦被搞错，症状只是 `SignatureDoesNotMatch` —— 而真正的原因是
 * **编码发生了两次或零次**，二者的表现一模一样。
 *
 * 所以与其写一句注释指望别人遵守，不如把约定变成一道会响的闸门：
 * 传进来一个含空格或中文的路径，会立刻得到"这里要已编码的路径"这句话，
 * 而不是一次玄学签名失败。
 */
const CANONICAL_URI_PATTERN = /^(?:[A-Za-z0-9\-_.~/]|%[0-9A-Fa-f]{2})*$/;

/** 校验并规范化成 `/` 开头（`/` 本身就是合法的"空绝对路径"写法）。 */
function canonicalUriFrom(encodedPath: string): string {
	const path = typeof encodedPath === "string" ? encodedPath : "";
	const withSlash = path.startsWith("/") ? path : `/${path}`;
	if (!CANONICAL_URI_PATTERN.test(withSlash)) {
		throw new Error(
			`path 必须是**已编码**的规范化 URI（用 encodePath 产出），但收到：${withSlash}`
		);
	}
	return withSlash;
}

/**
 * 规范化 URI：把路径按 `/` 拆段，**每段各自编码，分隔符 `/` 保留**。
 *
 * S3 的 key 里 `/` 是有意义的层级分隔，编码它会让对象找不到；
 * 而段落里的其它字符（空格、中文、`$`…）必须编码。
 * 前导 `/` 补上 —— 官方规则里"绝对路径为空则用 `/`"。
 *
 * ⚠️ 传入的必须是**未编码**的原始 key。本项目里 key 由 `object-key.ts` 产出，
 * 它已经把 `%` 换成了 `_`，所以不存在"二次编码"的输入。
 *
 * ⚠️ 全程**只调用一次**：由组装 URL 的那一层（`client.ts` 的 `requestTargetFor`）调用，
 * 结果既拿去拼 URL，也拿去签名。签名层拿到的就是成品，不再编码。
 * 这正是"非 ASCII 文件名被编成 `%25E4%B8%AD`"那类缺陷的根治办法 ——
 * 只留一个能编码的地方，就没有第二次。
 */
export function encodePath(path: string): string {
	// ⚠️ 这里**不做**任何"修正"（不把反斜杠当分隔符、不收敛重复斜杠、不解析 ..）。
	// 它是一台"忠实编码器"：进来的字节出去只是被编码，含义不变。
	// 原因：它产出的串会同时决定"请求打到哪"与"笔记里写什么 URL"，
	// 任何静默改写都会让两者与用户看到的名义 key 悄悄分叉。
	// 归一化（反斜杠、空段、穿越）已在 `object-key.ts` 那一层做完 ——
	// 谁负责清洗，谁负责清洗；编码层只管编码。
	const encoded = (typeof path === "string" ? path : "")
		.split("/")
		.map((segment) => uriEncode(segment))
		.join("/");
	return encoded.startsWith("/") ? encoded : `/${encoded}`;
}

/** 按码点比较（用于规范化查询串的排序）。 */
function compareAscii(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/**
 * 规范化查询串。
 *
 * 三条规则（都来自官方文档，且都有踩坑记录）：
 * 1. name 与 value **各自**编码后再拼接 `name=value`；
 * 2. **排序发生在编码之后** —— 编码会把 `!` 变成 `%21`，从而改变先后关系；
 * 3. 子资源（如 `?acl`）的值是空串，写成 `acl=`，**不能**省略等号。
 *
 * ## 为什么这里的入参是**未编码**的，而 `path` 是已编码的
 *
 * 不是笔误，是因为两者的来源不同：
 * - **路径**必须与请求行里的字节**完全相同**，而请求行由负责组装 URL 的那一层拼出来。
 *   所以编码必须在那一层做一次，签名层只接受成品 —— 见 `SignableRequest.path`。
 * - **查询串**在本模块里从原始键值对现拼，没有第二个产出它的地方，
 *   所以编码权归这里。
 *
 * 一句话：**谁产出那个字符串，谁负责编码**；只有一处能编码，就不会双重编码。
 */
export function canonicalQueryString(query?: Record<string, string>): string {
	if (!query) return "";
	const pairs = Object.keys(query).map(
		(name) => [uriEncode(name), uriEncode(query[name] ?? "")] as [string, string]
	);
	// ⚠️ 用码点比较，**不要**用 `localeCompare`：后者是语言相关排序，
	// 会忽略标点或按语言规则排，而 AWS 要的是编码后字节序。
	// 两边都是 ASCII，所以直接比字符串就等价于比字节。
	pairs.sort((a, b) => compareAscii(a[0], b[0]) || compareAscii(a[1], b[1]));
	return pairs.map(([name, value]) => `${name}=${value}`).join("&");
}

/**
 * 规范化请求头。
 *
 * 规则：名字小写、按名字排序、值去首尾空白并**把连续空白折成一个空格**，
 * 每条写成 `name:value\n`（含结尾换行 —— 换行不能省，
 * 因为 canonical request 靠它来分隔"最后一条头"与紧随其后的空行）。
 */
export function canonicalHeaders(headers: Record<string, string>): {
	canonical: string;
	signedHeaders: string;
} {
	const lowered = new Map<string, string>();
	for (const name of Object.keys(headers ?? {})) {
		const key = name.trim().toLowerCase();
		if (key) lowered.set(key, headers[name] ?? "");
	}

	const names = [...lowered.keys()].sort();
	const canonical = names
		.map((name) => `${name}:${normalizeHeaderValue(lowered.get(name) ?? "")}\n`)
		.join("");

	return { canonical, signedHeaders: names.join(";") };
}

/** 去首尾空白 + 连续空白折成一个空格（官方对 header 值的处理方式）。 */
function normalizeHeaderValue(value: string): string {
	return String(value).trim().replace(/\s+/g, " ");
}

/** 由时间戳推出签名要用的两个日期串（都是 UTC，与本地时区无关）。 */
export function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
	// toISOString() 固定是 `YYYY-MM-DDTHH:mm:ss.sssZ`，按位取即可去掉分隔符
	const iso = date.toISOString();
	const amzDate =
		`${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}` +
		`T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
	return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** 凭据作用域：`YYYYMMDD/region/service/aws4_request`。 */
export function credentialScope(dateStamp: string, region: string, service: string = S3_SERVICE): string {
	return `${dateStamp}/${region}/${service}/aws4_request`;
}

export interface SignableRequest {
	/** HTTP 方法，如 `PUT`。 */
	method: string;
	/**
	 * **已编码**的规范化 URI —— 即 `encodePath(...)` 的结果，且必须与请求行里的字节一致。
	 *
	 * 约定成"已编码"而不是"原始 key"，是为了让编码**只发生一次**：
	 * 组装 URL 的那一层调一次 `encodePath`，同一个串既拿去拼 URL 又拿来签名，
	 * 于是"签的路径"与"发的路径"在源头上就是同一个值，不可能不一致。
	 *
	 * 传原始 key（含空格 / 中文 / `$`）会被 `buildCanonicalRequest` 直接拒绝，
	 * 不会静默地产生一个错签名。
	 */
	path: string;
	/** 查询参数（值会被编码；子资源用空串）。 */
	query?: Record<string, string>;
	/** 参与签名的头（名字大小写不敏感；`host` 必须在这里，但**不必**真的发出去）。 */
	headers: Record<string, string>;
	/** 载荷的 SHA-256 十六进制；无载荷用空串的摘要。 */
	payloadHash: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	service?: string;
	/** `YYYYMMDDTHHmmssZ`。 */
	amzDate: string;
}

/** 拼装 canonical request（签名流程里唯一容易"差一个换行"的地方）。 */
export function buildCanonicalRequest(request: SignableRequest): string {
	const { canonical, signedHeaders } = canonicalHeaders(request.headers);
	return [
		request.method.toUpperCase(),
		canonicalUriFrom(request.path),
		canonicalQueryString(request.query),
		canonical,
		signedHeaders,
		request.payloadHash,
	].join("\n");
}

/** 拼装 string to sign（**不以换行结尾**）。 */
export function buildStringToSign(amzDate: string, scope: string, hashedCanonicalRequest: string): string {
	return [SIGV4_ALGORITHM, amzDate, scope, hashedCanonicalRequest].join("\n");
}

/**
 * 推导签名密钥：`HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`。
 *
 * 分四步而不是一步 `HMAC(secret, scope)` —— 后者是最常见的想当然写法，
 * 结果同样是 `SignatureDoesNotMatch`。
 */
export async function deriveSigningKey(
	secretAccessKey: string,
	dateStamp: string,
	region: string,
	service: string = S3_SERVICE
): Promise<Uint8Array> {
	const kDate = await hmacSha256(utf8Bytes(`AWS4${secretAccessKey}`), utf8Bytes(dateStamp));
	const kRegion = await hmacSha256(kDate, utf8Bytes(region));
	const kService = await hmacSha256(kRegion, utf8Bytes(service));
	return hmacSha256(kService, utf8Bytes("aws4_request"));
}

/** 计算载荷摘要（S3 要求无载荷时用空串的摘要）。 */
export async function payloadHashOf(payload: string | Uint8Array | ArrayBuffer): Promise<string> {
	return sha256Hex(toBytes(payload));
}

export interface SignedRequest {
	/** 可直接放进 `Authorization` 请求头的值。 */
	authorization: string;
	/** 实际参与签名的头名（小写，分号分隔）—— 排查签名问题时的第一手信息。 */
	signedHeaders: string;
	canonicalRequest: string;
	stringToSign: string;
	signature: string;
	scope: string;
	amzDate: string;
	dateStamp: string;
	payloadHash: string;
}

/**
 * 走完整个签名流程，返回 `Authorization` 与各中间产物。
 *
 * 中间产物一并返回，不是因为调用方需要它们，而是因为
 * `SignatureDoesNotMatch` 是**无信息**的错误：服务端只会说"不匹配"。
 * 有了这几个串，出问题时能直接和对方的报错对照，而不必加日志重跑。
 */
export async function signRequest(request: SignableRequest): Promise<SignedRequest> {
	const service = request.service ?? S3_SERVICE;
	const dateStamp = request.amzDate.slice(0, 8);
	const scope = credentialScope(dateStamp, request.region, service);

	const canonicalRequest = buildCanonicalRequest(request);
	const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
	const stringToSign = buildStringToSign(request.amzDate, scope, hashedCanonicalRequest);

	const signingKey = await deriveSigningKey(request.secretAccessKey, dateStamp, request.region, service);
	const signature = hexEncode(await hmacSha256(signingKey, utf8Bytes(stringToSign)));

	const { signedHeaders } = canonicalHeaders(request.headers);
	const authorization =
		`${SIGV4_ALGORITHM} Credential=${request.accessKeyId}/${scope}, ` +
		`SignedHeaders=${signedHeaders}, Signature=${signature}`;

	return {
		authorization,
		signedHeaders,
		canonicalRequest,
		stringToSign,
		signature,
		scope,
		amzDate: request.amzDate,
		dateStamp,
		payloadHash: request.payloadHash,
	};
}
