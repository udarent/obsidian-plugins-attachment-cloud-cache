/**
 * S3 客户端：URL 组装 + 签名 + 传输 + 重试。
 *
 * ## 三层分离，各自可测
 *
 * 1. **URL 组装**（纯函数）：决定请求打到哪个地址、以及笔记里写什么地址。
 * 2. **签名**（`sigv4.ts`，纯函数）。
 * 3. **传输**（可注入）：真实环境走 Obsidian 的 `requestUrl`，测试里注入一个
 *    指向本地真实 HTTP 服务的实现。
 *
 * 这样做不是为了好看，是因为**只有把传输做成可注入的，才能断言"真的只发了 1 次 PUT、
 * 0 次 GET"**。用 mock 断言"函数被调用过"证明不了这个 —— 而"上传失败时反复重试"
 * 与"渲染时偷偷联网"正是本项目最需要防的两件事（P0 验收标准就是照这两条写的）。
 *
 * ## 三条容易踩、且踩了很难查的规矩
 *
 * - **`host` 必须签名，但绝不能真的当请求头发出去。** 它是签名的一部分，
 *   而 HTTP 客户端会自己填 Host；手填会和客户端打架（被忽略或被拒）。
 *   于是：签名时用 `new URL(url).host`，发送时把它从头部里剔掉。
 * - **绝不签 `content-length`。** 它是传输层自己算的，签名里写死了就会
 *   在客户端分块发送或做编码时对不上，表现为莫名其妙的 `SignatureDoesNotMatch`。
 * - **path-style 的签名路径要带桶名。** 请求真的是打到 `/桶/键`，
 *   所以规范化 URI 必须是 `/桶/键`；只签 `/键` 是"本地测试全绿、上云全 403"的经典成因。
 *
 * ## 一条自检：签的路径必须等于真正发出去的路径
 *
 * URL 解析器会**规范化 `..`**：`https://h/a/../b.png` 会被解析成 `/b.png`。
 * 而签名用的是未规范化的路径 → 两者不一致 → `SignatureDoesNotMatch`，
 * 且报错完全指不出原因。所以这里在发出前**主动核对一次**，
 * 不一致就直接抛配置错误，把"玄学签名失败"变成一句能看懂的话。
 *
 * ## 配置错误不进重试循环
 *
 * URL 组装（端点没填、桶名没填、key 含 `..`）在重试**之外**先做完。
 * 否则"端点没配置"会被当成网络故障连试三次、每次还等一等，
 * 用户看到的是"卡了 1 秒多然后报一个含糊的错"。
 */

import { requestUrl } from "obsidian";
import { toArrayBuffer } from "./hash";
import { S3Error, isSuccess, networkError, responseError, timeoutError } from "./errors";
import { S3_SERVICE, encodePath, formatAmzDate, payloadHashOf, presignUrl, signRequest, uriEncode } from "./sigv4";

// 上层（上传链路、渲染钩子）要按性质决定怎么办（重试 / 提示 / 降级），
// 所以把错误类型从本模块转出去，省得它们再 import 一次内部路径。
export { S3Error };

// ─────────────────────────── 传输抽象 ───────────────────────────

export interface S3TransportRequest {
	url: string;
	method: string;
	/** 真正要发出去的头（**不含 `host`**）。 */
	headers: Record<string, string>;
	body?: Uint8Array;
}

export interface S3TransportResponse {
	status: number;
	/** 头名统一小写，免去调用方到处大小写兼容。 */
	headers: Record<string, string>;
	body: Uint8Array;
}

export type S3Transport = (request: S3TransportRequest) => Promise<S3TransportResponse>;

/** 把头名统一小写（HTTP 头名本来就大小写不敏感，但取值时容易忘）。 */
function lowercaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of Object.keys(headers ?? {})) {
		out[name.toLowerCase()] = headers?.[name] ?? "";
	}
	return out;
}

/**
 * 默认传输：Obsidian 的 `requestUrl`。
 *
 * 选它而不是 `fetch` 是有原因的：`requestUrl` 走宿主网络栈，**不受 CORS 限制** ——
 * 移动端尤其重要（WebView 里直接 `fetch` 会被跨域策略拦掉）。
 */
export const obsidianTransport: S3Transport = async (request) => {
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body ? toArrayBuffer(request.body) : undefined,
		// 不要因为 4xx/5xx 就抛错 —— 分类与重试由我们自己决定
		throw: false,
	});
	return {
		status: response.status,
		headers: lowercaseHeaders(response.headers),
		body: new Uint8Array(response.arrayBuffer ?? new ArrayBuffer(0)),
	};
};

// ─────────────────────────── URL 组装 ───────────────────────────

/** 端点规范化：补 scheme、去尾斜杠。空串原样返回（由调用方判为未配置）。 */
export function normalizeEndpoint(endpoint: string): string {
	const trimmed = String(endpoint ?? "")
		.trim()
		.replace(/\/+$/, "");
	if (!trimmed) return "";
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 键规范化：去掉前导斜杠与空白。 */
export function normalizeKey(key: string): string {
	return String(key ?? "")
		.trim()
		.replace(/^\/+/, "");
}

/** 键里是否有 `..` 段 —— URL 解析器会把它们规范化掉，从而与签名不一致。 */
function hasDotDotSegment(key: string): boolean {
	return key.replace(/\\/g, "/").split("/").includes("..");
}

/** 配置类错误：**不可重试**，且信息要能直接指导用户去改哪个设置。 */
export function configError(message: string): S3Error {
	return new S3Error({
		kind: "client",
		status: 0,
		code: "InvalidConfig",
		message,
		requestId: "",
		operation: "config",
		key: "",
		attempts: 1,
	});
}

export interface ObjectAddress {
	endpoint: string;
	bucket: string;
	/**
	 * 是否强制 path-style（`端点/桶/键`）。
	 *
	 * 默认 `true`：R2、MinIO、B2、Wasabi 与 AWS S3 都接受 path-style，
	 * 而 virtual-host 需要桶名能当子域（含 `.` 的桶名会让 TLS 通配证书失配），
	 * 且 **R2 的 S3 端点并不支持 virtual-host**。默认走最不容易出错的那条。
	 */
	forcePathStyle?: boolean;
}

/** 一个对象的请求地址：`url` 是发出去的目标，`path` 是签名要用的规范化 URI。 */
export interface RequestTarget {
	url: string;
	/** 规范化 URI（**含桶名**，因为请求路径本来就含它）。 */
	path: string;
}

function assertKeyUsable(key: string): void {
	if (!key) throw configError("对象 key 为空 —— 不会发起请求");
	if (hasDotDotSegment(key)) {
		throw configError(`对象 key 含 ../ 段（${key}），会产生不一致的路径，拒绝请求`);
	}
}

/**
 * 组装对象请求地址。
 *
 * `key` 必须是**未编码**的原始键：本项目里它由 `object-key.ts` 产出，
 * 已经把 `%` 换成了 `_`，所以不存在"二次编码"的输入。
 */
export function requestTargetFor(address: ObjectAddress, key: string): RequestTarget {
	const endpoint = normalizeEndpoint(address.endpoint);
	if (!endpoint) throw configError("S3 端点未配置，请先在设置里填写");

	const bucket = String(address.bucket ?? "").trim();
	if (!bucket) throw configError("S3 桶名未配置，请先在设置里填写");

	const cleanKey = normalizeKey(key);
	assertKeyUsable(cleanKey);

	const encodedKey = encodePath(cleanKey).slice(1);

	if (address.forcePathStyle === false) {
		const parsed = new URL(endpoint);
		parsed.host = `${bucket}.${parsed.host}`;
		parsed.pathname = `/${encodedKey}`;
		parsed.search = "";
		parsed.hash = "";
		const target = { url: parsed.toString(), path: `/${encodedKey}` };
		assertPathPreserved(target);
		return target;
	}

	const encodedBucket = uriEncode(bucket);
	const target = {
		url: `${endpoint}/${encodedBucket}/${encodedKey}`,
		// ⚠️ 桶名在路径里 —— 少写它会得到 SignatureDoesNotMatch，而且在本地 mock 上
		// 反而可能"通过"（如果 mock 不校验路径的话）。所以这里和 URL 同源生成。
		path: `/${encodedBucket}/${encodedKey}`,
	};
	assertPathPreserved(target);
	return target;
}

/**
 * 组装**桶本身**的探测地址（S3 的 `HEAD /桶`）。
 *
 * ⚠️ 为什么需要它，而不是拿一个随机 key 做 `headObject`：
 * 探测对象时，"对象不存在"与"桶不存在"**都是 404**，无法区分 ——
 * 而这两者的修法完全不同（一个属正常，一个要回去改桶名）。
 * 所以"测试连接"必须能直接问桶本身在不在。
 */
export function bucketTargetFor(address: ObjectAddress): RequestTarget {
	const endpoint = normalizeEndpoint(address.endpoint);
	if (!endpoint) throw configError("S3 端点未配置，请先在设置里填写");

	const bucket = String(address.bucket ?? "").trim();
	if (!bucket) throw configError("S3 桶名未配置，请先在设置里填写");

	if (address.forcePathStyle === false) {
		const parsed = new URL(endpoint);
		parsed.host = `${bucket}.${parsed.host}`;
		parsed.pathname = "/";
		parsed.search = "";
		parsed.hash = "";
		const target = { url: parsed.toString(), path: "/" };
		assertPathPreserved(target);
		return target;
	}

	const encodedBucket = uriEncode(bucket);
	const target = {
		url: `${endpoint}/${encodedBucket}`,
		path: `/${encodedBucket}`,
	};
	assertPathPreserved(target);
	return target;
}

/**
 * 组装 `x-amz-copy-source` 的值（`/<桶>/<编码后的 key>`）。
 *
 * ⚠️ 与 {@link requestTargetFor} 的区别：那里在 virtual-host 风格下**不带桶名**
 *（桶在域名里），而 copy-source 这个头**任何时候都要带桶** —— 少了它服务端只会回
 * `InvalidArgument`，而错误文本不会提示"漏了桶名"。所以这里独立拼一份，不去复用
 * 那个已经按风格分叉的路径。
 */
export function copySourceFor(address: ObjectAddress, key: string): string {
	const bucket = String(address.bucket ?? "").trim();
	if (!bucket) throw configError("S3 桶名未配置，请先在设置里填写");
	const cleanKey = normalizeKey(key);
	assertKeyUsable(cleanKey);
	return `/${uriEncode(bucket)}/${encodePath(cleanKey).slice(1)}`;
}

/** 只要 URL 的便捷入口。 */
export function objectUrl(address: ObjectAddress, key: string): string {
	return requestTargetFor(address, key).url;
}

/**
 * 核对"签的路径"与"真正发出去的路径"一致。
 *
 * 主要防的是 URL 规范化（`..`、以及某些客户端对 `//` 的处理）导致的微妙错位。
 * 这类错位最终只表现为 `SignatureDoesNotMatch`，从错误信息里完全看不出根因。
 *
 * 放在 `requestTargetFor` 里（而不是各个方法里）是刻意的：这样**任何**拿到
 * 请求地址的调用方都自动受保护，且这一层在重试循环之外 ——
 * 路径不一致是配置问题，重试没有意义。
 */
function assertPathPreserved(target: RequestTarget): void {
	let actual: string;
	try {
		actual = new URL(target.url).pathname;
	} catch {
		throw configError(`对象 URL 无法解析：${target.url}`);
	}
	if (actual !== target.path) {
		throw configError(
			`对象 URL 的路径被规范化了，与要签名的路径不一致：签名用 ${target.path}，实际发出 ${actual}`
		);
	}
}

/**
 * 笔记里写什么 URL。
 *
 * `publicUrlBase` 是给"桶开了公开访问 / 挂了自定义域名"用的 ——
 * 那时图片地址与 API 端点不同，必须分开配置。
 * 没配就退回对象 URL（要求桶本身可公开读）。
 */
export function publicUrlFor(address: ObjectAddress & { publicUrlBase?: string }, key: string): string {
	const cleanKey = normalizeKey(key);
	assertKeyUsable(cleanKey);

	const base = normalizeEndpoint(address.publicUrlBase ?? "");
	if (!base) return requestTargetFor(address, cleanKey).url;
	// ⚠️ 只编码一次。key 本身是原始串，这里不做任何"先编再拼"的处理，
	// 否则会得到 %25E4 这种双重编码 —— 链接能生成但打不开。
	return `${base}/${encodePath(cleanKey).slice(1)}`;
}

/**
 * 省略 `publicUrlBase` 时，链接的**前缀**是什么（path-style 是 `端点/桶`，virtual-host 是 `桶.主机`）。
 *
 * 用途只有一处：设置页拿它当输入框的 **placeholder**，让用户**看见**"留空会用哪个地址"，
 * 而不是从说明文字里去猜。所以它只用于**展示** —— 真正的地址仍由 `publicUrlFor` 生成
 *（它的回退分支就是 `requestTargetFor`）。
 *
 * ⚠️ 两者必须**同源**：这里少一个字符、多一个斜杠，用户就会以为留空是安全的，
 * 而笔记里写进去的是另一个地址 —— 那种分叉只会在**别人打开图片时**才暴露，事后极难改。
 * `test-s3-client` 里有一条断言把"展示的前缀"与"真实请求地址"钉在一起。
 *
 * 端点/桶没填（或端点无法解析）时返回空串：**宁可什么都不显示**，也不给一个半截地址 ——
 * 那会被当成"系统建议你用这个"。
 */
export function objectBaseFor(address: ObjectAddress): string {
	const endpoint = normalizeEndpoint(address.endpoint);
	const bucket = String(address.bucket ?? "").trim();
	if (!endpoint || !bucket) return "";

	if (address.forcePathStyle === false) {
		try {
			const parsed = new URL(endpoint);
			parsed.host = `${bucket}.${parsed.host}`;
			parsed.pathname = "";
			parsed.search = "";
			parsed.hash = "";
			return parsed.toString().replace(/\/+$/, "");
		} catch {
			return "";
		}
	}

	return `${endpoint}/${uriEncode(bucket)}`;
}

/** 匿名探测的结果。 */
export interface PublicLinkProbe {
	/** HTTP 状态码；网络层失败（DNS 错、连不上、超时）为 `null`。 */
	status: number | null;
	/**
	 * 响应头里的 `content-type`（拿不到为 `null`）。
	 *
	 * ⭐ 为什么连类型一起带回来：**2xx 不等于"打开的是你的对象"**。
	 * 网关 / WAF / 身份校验页 / 反向代理会在路径不存在或请求被拦时回一个 **200 的网页**，
	 * 于是"匿名请求成功了"被读成"桶是公开的" —— 而用户笔记里那条链接照样打不开。
	 * 判定层用这一格把「回的是网页」从「取到了对象」里分开（见 `link-access.ts::classifyPublicReach`）。
	 *
	 * ⚠️ 只读头，不读 body：点一次"测试"不该把一张大图拉一遍。
	 */
	contentType?: string | null;
}

/**
 * 匿名探测**必须带的请求头：禁止使用缓存**。
 *
 * ## ⚠️ 2026-10-18 真机实锤（同一个对象、同一条 URL，连续四次）
 *
 * ```
 * ① PUT 之后（还没带凭据读过）      匿名 GET → 403
 * ② **签名 GET 之后**              匿名 GET → **200**（字节还是我们写的那 39 个）
 * ③ 签名 GET 之后，带 no-cache     匿名 GET → 403
 * ④ 再问一次 no-cache              匿名 GET → 403
 * ```
 *
 * ② 就是宿主（Electron）的 **HTTP 缓存**：回路的设计是「先带凭据读回核对字节，再匿名读
 * 同一条 URL」，第二次命中的是**刚才那次带凭据请求的响应**。于是一个私有桶被报成
 * 「公开访问」，而且时有时无（缓存条目有时命中、有时回源）—— 这正是用户 2026-10-18 报的
 * 「公开访问和私有访问交替出现」。
 *
 * ⇒ 匿名探测一律带 no-cache：它要回答的是「**别人第一次打开**这条链接会不会成功」，
 * 而"我们刚才自己取回来的那份"什么也证明不了。
 */
export const ANONYMOUS_PROBE_HEADERS: Record<string, string> = {
	"Cache-Control": "no-cache",
	Pragma: "no-cache",
};

/**
 * 匿名**按内容**验证一个地址：先 HEAD 看长度，长度对得上才 GET 取回字节。
 *
 * ## 为什么 HEAD 的状态码不够（2026-10-18 真机复现）
 *
 * 对**同一个桶、同一时刻**：对固定 key 的匿名 HEAD 偶发回 **200**，而对内容哈希 key 的
 * 请求稳定回 403。也就是说"2xx"可能来自中间层（代理 / 缓存 / 网关兜底页），
 * **不代表"别人能读到你那份字节"**。用户看到的「公开 / 私有交替出现」就是它。
 *
 * ⇒ 唯一可信的证据是**取回来的字节写进去的一致**。探针对象只有几十字节，代价可忽略。
 *
 * ⚠️ 先 HEAD 再 GET 是刻意的：若长度不符（缓存里是别的东西，可能是几 MB 的图），
 * 就**不去 GET** —— 点一次"测试"不该顺带下载一个陌生对象。
 */
export interface PublicContentProbe {
	status: number | null;
	contentType: string | null;
	/** 取回的字节；没取（非 2xx / 长度不符 / 出错）时为 `null`。 */
	bytes: Uint8Array | null;
	/** 2xx 但 `content-length` 与期望不一致 ⇒ 这个地址上放的不是我们的对象。 */
	lengthMismatch?: { expected: number; got: number };
}

export async function probePublicContent(
	url: string,
	expectedBytes: number,
	deps: S3ClientDeps = {}
): Promise<PublicContentProbe> {
	const transport = deps.transport ?? obsidianTransport;
	try {
		// ⚠️ 两次都必须 no-cache：HEAD 若命中缓存会给出 200 + 正确的 content-length，
		// 于是我们连"该不该 GET"都判错（见 {@link ANONYMOUS_PROBE_HEADERS}）。
		const head = await transport({ url, method: "HEAD", headers: ANONYMOUS_PROBE_HEADERS });
		const contentType = head.headers?.["content-type"] ?? null;
		if (head.status === null || head.status < 200 || head.status >= 300) {
			return { status: head.status, contentType, bytes: null };
		}
		const rawLength = head.headers?.["content-length"];
		const got = rawLength === undefined ? null : Number(rawLength);
		if (got !== null && Number.isFinite(got) && got !== expectedBytes) {
			return { status: head.status, contentType, bytes: null, lengthMismatch: { expected: expectedBytes, got } };
		}
		const get = await transport({ url, method: "GET", headers: ANONYMOUS_PROBE_HEADERS });
		return { status: get.status, contentType, bytes: get.body ?? new Uint8Array(0) };
	} catch {
		return { status: null, contentType: null, bytes: null };
	}
}

/**
 * **匿名**请求一个公开地址，只回答一个问题：「别人能不能打开这条链接？」
 *
 * ——这是本模块里唯一**不带签名**的请求，而"不带签名"正是它的全部价值：
 * 带凭据去请求等于拿「我自己能打开」冒充「别人能打开」，那条检查会永远绿、
 * 什么都证明不了（`test-s3-client` 有一条断言专门钉住"请求里没有 Authorization"）。
 *
 * 用 `HEAD`：只要状态码，不下载图片本体（点一次"测试"不该把一张大图拉一遍）。
 *
 * ⚠️ 网络层失败**收敛成 `status: null`，不抛错**：调用方是设置页，一个冒出来的异常
 * 会把整页的反馈吞掉，而这里恰恰要给出「前缀可能写错了」这种可操作的结论。
 */
export async function probePublicLink(url: string, deps: S3ClientDeps = {}): Promise<PublicLinkProbe> {
	const transport = deps.transport ?? obsidianTransport;
	try {
		// ⚠️ headers 必须带 no-cache：否则会命中"我们刚才带凭据读过一次"的宿主缓存（见上）。
		const response = await transport({ url, method: "HEAD", headers: ANONYMOUS_PROBE_HEADERS });
		// ⚠️ 头名大小写各实现不一致 ⇒ 统一小写后再取（transport 已经小写过，这里只是兜底）
		const contentType = response.headers?.["content-type"] ?? null;
		return { status: response.status, contentType };
	} catch {
		return { status: null, contentType: null };
	}
}

// ─────────────────────────── 客户端 ───────────────────────────

export interface S3ClientConfig extends ObjectAddress {
	region: string;
	/** 凭据。调用方负责从宿主的 SecretStorage 取出，本模块只**用**不存。 */
	accessKeyId: string;
	secretAccessKey: string;
	service?: string;
	/**
	 * 笔记里写的链接前缀（桶开了公开访问、或挂了自定义域名时用）。
	 * 留空则退回**对象地址**（`requestTargetFor`）—— 那要求桶本身可公开读。
	 *
	 * ⚠️ 它刻意不在 `ObjectAddress` 里：那个接口回答的是"请求发到哪"，
	 * 而这一项回答的是"**笔记里写什么**"，两者可以不同（CDN 域名 ≠ API 端点）。
	 * 但它**必须**在这里声明 —— `connectionReadiness` 组装的 config 是入口、粘贴钩子、
	 * 设置页三条构造路径唯一的来源；字段没声明就没人为它负责，
	 * 结果是漏传且**没有任何报错**（见 `credentials.ts` 里 `connectionReadiness` 的说明）。
	 */
	publicUrlBase?: string;
}

export interface S3ClientDeps {
	transport?: S3Transport;
	/** 取当前时间。注入它是为了让签名的日期在测试里可确定。 */
	now?: () => Date;
	/** 退避等待。测试注入一个不真等的实现，否则每次重试都要真睡。 */
	sleep?: (ms: number) => Promise<void>;
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	/**
	 * 传输超时（毫秒，按 HTTP 方法）。不传用 `DEFAULT_TRANSPORT_TIMEOUTS`。
	 *
	 * ⭐ 2026-10-22（D-78）：`requestUrl` **没有中断能力**，所以超时只能"不再等"
	 *（见 `raceWithTimeout`）。这一项是**测试注入点**：套件用几十毫秒验证"卡住的那次
	 * 会失败、而且下次还能重试"，真机用默认值。
	 */
	timeouts?: Partial<Record<TransportMethod, number>>;
}

/**
 * 复制结果。
 *
 * ⚠️ **没有 `size`**：CopyObject 不返回目标对象的字节数（只有 ETag）。
 * 迁移要核对长度，只能复制完再 HEAD 一次 —— 这不是省事与否的问题，
 * 而是"复制成功"与"字节真的到了"在这条 API 里本来就是两件事。
 */
export interface CopyResult {
	key: string;
	url: string;
	etag: string;
	attempts: number;
}

export interface PutResult {
	key: string;
	/** 对象 URL（`publicUrlBase` 已配置时是公开地址）。 */
	url: string;
	etag: string;
	size: number;
	/** 实际尝试次数（含首次）——"重试了一次才成功"是值得记录的信息。 */
	attempts: number;
}

export interface GetResult {
	key: string;
	data: Uint8Array;
	contentType: string;
	etag: string;
}

export interface HeadResult {
	key: string;
	url: string;
	size: number;
	contentType: string;
	etag: string;
}

/** 列举参数（`maxKeys` 会被夹到 S3 允许的上限）。 */
export interface ListObjectsOptions {
	prefix?: string;
	continuationToken?: string;
	maxKeys?: number;
}

/**
 * 列举结果。`nextToken` 为空表示已经到底。
 *
 * ⚠️ `lastModified` 是**服务端时间**，只用于"声明集合指纹"（批量删除期间判断
 * "有没有人在我数的时候写过声明"）。取不到时给空串 —— 指纹于是只靠"数量 + key 摘要"
 * 也仍能发现变化，只是少一维。
 */
export interface ListObjectsResult {
	objects: { key: string; size: number; etag: string; lastModified: string }[];
	nextToken: string | null;
}

/**
 * 按 SigV4 的规则拼查询串（**与签名用的是同一套编码**）。
 *
 * ⚠️ 不用 `URLSearchParams`：它把空格编成 `+`，而 canonical query 要求 `%20` ——
 * 两处不一致的后果是 `SignatureDoesNotMatch`，而报错完全不提编码差异。
 * 这里与 `canonicalQueryString` 共用 `uriEncode`，所以"发出去的"与"签的"必然同源。
 */
function queryStringFor(query: Record<string, string>): string {
	return Object.keys(query)
		.sort()
		.map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? "")}`)
		.join("&");
}

/**
 * 解析 ListObjectsV2 的响应（**纯函数**，不依赖 XML 解析器）。
 *
 * 只取我们真正要用的三项：`Key`、`Size`、`ETag`（外加 `IsTruncated` 与
 * `NextContinuationToken`）。用正则而不是完整 XML 解析器：这段响应形状是
 * AWS 定死的、且我们只要平坦的一层 —— 引一个 XML 依赖进一个零依赖的插件不值得。
 *
 * ⚠️ 解析不出来**返回 `null`**（而不是空列表）：调用方据此报错。
 * "把解析失败当成桶是空的"是这里最危险的失败方式 —— 清理命令会显得
 * "一切正常、没有可清理的"，而真相是我们根本没读到清单。
 */
export function parseListObjects(xml: unknown): ListObjectsResult | null {
	if (typeof xml !== "string" || xml === "") return null;
	if (!/<ListBucketResult[\s>]/i.test(xml)) return null;

	const objects: { key: string; size: number; etag: string; lastModified: string }[] = [];
	for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gi)) {
		const body = match[1];
		const key = xmlTextOf(body, "Key");
		if (key === null || key === "") continue;
		objects.push({
			key,
			size: Number(xmlTextOf(body, "Size") ?? "0") || 0,
			etag: (xmlTextOf(body, "ETag") ?? "").replace(/^"|"$/g, ""),
			lastModified: xmlTextOf(body, "LastModified") ?? "",
		});
	}

	const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
	const token = xmlTextOf(xml, "NextContinuationToken");
	return { objects, nextToken: truncated && token ? token : null };
}

/** 取一个 XML 标签的文本内容，并做最基本的实体解码；标签不存在时返回 `null`。 */
function xmlTextOf(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	if (!match) return null;
	return decodeXmlEntities(match[1]);
}

/** 解码 S3 会在 key 里用到的实体（`&amp;` 这类 —— 不解码会把 key 弄错）。 */
function decodeXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * 预签名 URL 的默认有效期：30 分钟。
 *
 * 为什么不是更短：一张笔记可能开着很久，滚动/切视图都可能让浏览器重新请求同一个地址；
 * 太短会让"看着好好的图突然坏了"。为什么不更长：那条 URL 在内存里（DevTools 里可见），
 * 有效期就是它的暴露窗口 —— 30 分钟够用，且不会变成一条长期通行证。
 */
const DEFAULT_PRESIGN_EXPIRES = 1800;

/** 参与超时判定的方法（就用这几个；大写与 `request.method` 同一套写法）。 */
export type TransportMethod = "GET" | "HEAD" | "PUT" | "POST" | "DELETE";

/**
 * 一次请求最多等多久（毫秒）。
 *
 * ## 为什么不是一个数
 *
 * 三种请求的"正常耗时"差两个数量级：
 * - `HEAD` 只回几个头 ⇒ 30 秒还没响应基本就是死了（它还被"批量预检"串行调用，
 *   一个卡住会让整批停在那儿）；
 * - `GET` 要真把对象传下来 ⇒ 给 60 秒（一个 10 MB 的图在 2 Mbps 上约 40 秒）；
 * - `PUT` 要**上传**整份字节 ⇒ 给 5 分钟，否则大附件在慢网络上会被自己的超时掐掉
 *   （那会变成"上传永远失败"这种更糟的形态）。
 *
 * ⚠️ 这几个数字是**判据**，不是配置项：它们决定"卡住"与"慢"的分界。用户侧没有开关 ——
 * 多一个开关就多一种"我调了它所以它坏了"的排查方向。
 */
export const DEFAULT_TRANSPORT_TIMEOUTS: Record<TransportMethod, number> = {
	GET: 60_000,
	HEAD: 30_000,
	PUT: 300_000,
	POST: 60_000,
	DELETE: 60_000,
};

/**
 * 超时信号：`raceWithTimeout` 内部用它区分"等到点了"与"传输自己抛错"。
 *
 * ⚠️ 单独一个类型而不是 `new Error("timeout")`：靠**消息**判断会误伤 ——
 * 传输层自己也可能抛"timeout"字样的错误（`requestUrl` 在某些平台上就会），
 * 那样一次真实的网络错误会被报成"我们主动放弃"，排查方向就错了。
 */
class TransportTimeout extends Error {}

/**
 * 让一个 promise 最多活 `ms` 毫秒。
 *
 * ⚠️ **不是取消**：底层请求还在跑（`requestUrl` 没有 abort），我们只是不再等它。
 * 后果要记住：这次判定为失败之后，宿主的网络栈里可能还有一个请求在慢慢收尾 ——
 * 它不会写盘（回调已经没人接了），但"服务端收到了这次 GET"是可能的。
 * 所以文案说的是"已放弃等待"，不是"请求没有发出"。
 */
function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	if (!(ms > 0)) return work;
	let timer: number | undefined;
	const limit = new Promise<never>((_, reject) => {
		// ⚠️ 用 `window.setTimeout`（与 `defaultSleep` 同一条理由）：弹窗里裸的
		// `setTimeout` 属于另一个定时器源，行为会不一致（官方 lint 也这么要求）。
		timer = window.setTimeout(() => reject(new TransportTimeout(`${ms}ms`)), ms);
	});
	return Promise.race([work, limit]).finally(() => {
		if (timer !== undefined) window.clearTimeout(timer);
	});
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
	// 用 `window.setTimeout` 而不是裸 `setTimeout`：弹出窗口（popout window）里
	// 两者的定时器不同源，用裸的会在 popout 场景下行为不一致（Obsidian 官方 lint 也这么要求）。
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

export class S3Client {
	private readonly config: S3ClientConfig;
	private readonly transport: S3Transport;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly timeouts: Partial<Record<TransportMethod, number>>;

	constructor(config: S3ClientConfig, deps: S3ClientDeps = {}) {
		this.config = config;
		this.transport = deps.transport ?? obsidianTransport;
		this.now = deps.now ?? (() => new Date());
		this.sleep = deps.sleep ?? defaultSleep;
		this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
		this.timeouts = deps.timeouts ?? {};
	}

	/** 脱敏摘要，专供日志 —— 里面**没有**密钥，`test-s3-client.mjs` 钉住这一点。 */
	describe(): string {
		const access = this.config.accessKeyId;
		return [
			`endpoint=${normalizeEndpoint(this.config.endpoint) || "(未配置)"}`,
			`bucket=${this.config.bucket || "(未配置)"}`,
			`region=${this.config.region || "(未配置)"}`,
			`pathStyle=${this.config.forcePathStyle !== false}`,
			`accessKeyId=${access ? `${access.slice(0, 4)}***` : "(未配置)"}`,
		].join(" ");
	}

	/** 上传。PUT 是幂等的，所以重试安全。 */
	async putObject(key: string, data: Uint8Array, contentType?: string): Promise<PutResult> {
		const target = requestTargetFor(this.config, key);
		// 路径自检放在重试之外：路径不对是配置问题，重试没有意义

		const publicUrl = publicUrlFor(this.config, key);
		const payloadHash = await payloadHashOf(data);

		return this.withRetry("putObject", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "PUT", payloadHash, contentType);
			const response = await this.send({ url: target.url, method: "PUT", headers, body: data }, {
				operation: "PUT",
				key: target.path,
				attempt,
			});
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "PUT", key: target.path, attempt });
			}

			// ⭐ **传后校验**（对应 LFS 的 verify）：PUT 成功不代表服务端存对了 ——
			// 代理截断、连接半途复位、服务端磁盘写满，都可能回 200 却只落了一半字节，
			// 而用户看到的是"上传成功"、笔记里却是半张图。这是本项目最警惕的
			// "两侧都不报错的慢失败"，所以宁可多一次往返。
			//
			// ⚠️ 问不动（断网 / 服务端不返回 Content-Length）**不算失败**：
			// 不能因为"没验成"就把一次成功的上传判死。只有**明确不一致**才重试。
			// ⚠️ 重试由 `withRetry` 负责：这里抛可重试的 `ChecksumMismatch`，
			// 它会带着新的一次 PUT 再来，直到次数用尽。
			const stored = await this.headOnce(target.path);
			if (stored && stored.size > 0 && stored.size !== data.length) {
				throw new S3Error({
					kind: "server",
					status: 0,
					code: "ChecksumMismatch",
					message: `上传校验失败：服务端记录 ${stored.size} 字节，本地是 ${data.length} 字节`,
					requestId: "",
					operation: "PUT",
					key: target.path,
					attempts: attempt,
					secrets: this.secrets(),
				});
			}

			return {
				key: target.path,
				url: publicUrl,
				etag: etagOf(response.headers),
				size: data.length,
				attempts: attempt,
			};
		});
	}

	/**
	 * 服务端复制（`PUT` ＋ `x-amz-copy-source`）—— 迁移存量对象名时用（CR-15）。
	 *
	 * ⚠️ **S3 的 CopyObject 会在 200 里报错**：失败时正文是 `<Error><Code>…`，
	 * 而状态码仍是 200。只看状态码就会把它当成成功，紧接着删掉旧 key —— 数据就没了。
	 * 所以这里既看状态码，也看正文里**有没有 `CopyObjectResult`**。
	 *
	 * ⚠️ 不复制元数据以外的任何东西（不设 ACL、不加 `x-amz-metadata-directive`）：
	 * 迁移只换 key，对象的字节与 Content-Type 应当原样保留，由服务端默认行为负责。
	 */
	async copyObject(sourceKey: string, targetKey: string): Promise<CopyResult> {
		const target = requestTargetFor(this.config, targetKey);
		const publicUrl = publicUrlFor(this.config, targetKey);
		const payloadHash = await payloadHashOf("");
		const copySource = copySourceFor(this.config, sourceKey);

		return this.withRetry("copyObject", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "PUT", payloadHash, undefined, undefined, {
				"x-amz-copy-source": copySource,
			});
			const response = await this.send({ url: target.url, method: "PUT", headers }, {
				operation: "COPY",
				key: target.path,
				attempt,
			});
			const text = new TextDecoder().decode(response.body);
			if (!isSuccess(response.status) || !/<CopyObjectResult\b/i.test(text)) {
				throw this.fail(response, { operation: "COPY", key: target.path, attempt });
			}
			return { key: target.path, url: publicUrl, etag: etagOf(response.headers), attempts: attempt };
		});
	}

	/** 下载。404 会被当作错误抛出（是否容忍由调用方决定）。 */
	async getObject(key: string): Promise<GetResult> {
		const target = requestTargetFor(this.config, key);
		const payloadHash = await payloadHashOf("");

		return this.withRetry("getObject", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "GET", payloadHash);
			const response = await this.send({ url: target.url, method: "GET", headers }, {
				operation: "GET",
				key: target.path,
				attempt,
			});
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "GET", key: target.path, attempt });
			}
			return {
				key: target.path,
				data: response.body,
				contentType: response.headers["content-type"] ?? "",
				etag: etagOf(response.headers),
			};
		});
	}

	/**
	 * 探测对象是否存在。
	 *
	 * 与 `getObject` 的关键差别：**404 返回 `null` 而不是抛错**。
	 * 因为"远端没有这个对象"是正常答案（决定要不要补传 / 要不要回退下载），
	 * 而不是异常。其它错误照常抛。
	 */
	async headObject(key: string): Promise<HeadResult | null> {
		const target = requestTargetFor(this.config, key);

		const publicUrl = publicUrlFor(this.config, key);
		const payloadHash = await payloadHashOf("");

		return this.withRetry("headObject", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "HEAD", payloadHash);
			const response = await this.send({ url: target.url, method: "HEAD", headers }, {
				operation: "HEAD",
				key: target.path,
				attempt,
			});
			if (response.status === 404) return null;
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "HEAD", key: target.path, attempt });
			}
			return {
				key: target.path,
				url: publicUrl,
				size: Number(response.headers["content-length"] ?? 0) || 0,
				contentType: response.headers["content-type"] ?? "",
				etag: etagOf(response.headers),
			};
		});
	}

	/**
	 * 探测桶本身（`HEAD /桶`）—— 「测试连接」的判据。
	 *
	 * 返回 `{ exists }` 而不是抛错表示"不存在"：桶不存在是**用户配置问题**，
	 * 不是传输故障，两者必须能分开呈现（一个要回去改桶名，一个要检查网络）。
	 * 凭据错误与网络故障仍然抛出（由 `classify` 定级），因为那才是真正需要区分的失败。
	 */
	async headBucket(): Promise<{ exists: boolean }> {
		const target = bucketTargetFor(this.config);
		const payloadHash = await payloadHashOf("");

		return this.withRetry("headBucket", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "HEAD", payloadHash);
			const response = await this.send({ url: target.url, method: "HEAD", headers }, {
				operation: "HEAD",
				key: target.path,
				attempt,
			});
			if (response.status === 404) return { exists: false };
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "HEAD", key: target.path, attempt });
			}
			return { exists: true };
		});
	}

	/** 删除。404 返回 `false`（本来就不存在），其它错误照抛。 */
	async deleteObject(key: string): Promise<boolean> {
		const target = requestTargetFor(this.config, key);
		const payloadHash = await payloadHashOf("");

		return this.withRetry("deleteObject", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "DELETE", payloadHash);
			const response = await this.send({ url: target.url, method: "DELETE", headers }, {
				operation: "DELETE",
				key: target.path,
				attempt,
			});
			if (response.status === 404) return false;
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "DELETE", key: target.path, attempt });
			}
			return true;
		});
	}

	/**
	 * 列举桶里的对象（ListObjectsV2，分页）。
	 *
	 * ## 为什么现在才需要它
	 *
	 * 云端清理（F15）要回答"桶里有哪些对象"，而在此之前插件**从不需要**列举：
	 * 一切都是内容寻址，上传前用 `key` 直接 PUT/HEAD 就够了。
	 *
	 * ## 签名里的查询串必须与服务端看到的**逐字一致**
	 *
	 * 这是这一层唯一容易出错的地方：SigV4 的 canonical query 用 `uriEncode`
	 * （空格 → `%20`），而 `URLSearchParams` 会编成 `+` —— 两者对不上就是
	 * `SignatureDoesNotMatch`，而报错信息**不会**告诉你是编码差异。
	 * 所以这里自己用 `uriEncode` 拼查询串，并把**同一个对象**交给签名：
	 * "发出去的那一串"与"签的那一串"来自同一个来源。
	 *
	 * ⚠️ `nextToken` 为空串/`null` 都表示"没有下一页"（S3 只在被截断时才给
	 * `NextContinuationToken`）。
	 */
	async listObjects(options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
		const query: Record<string, string> = { "list-type": "2" };
		if (typeof options.prefix === "string" && options.prefix !== "") query.prefix = options.prefix;
		if (typeof options.continuationToken === "string" && options.continuationToken !== "") {
			query["continuation-token"] = options.continuationToken;
		}
		if (typeof options.maxKeys === "number" && options.maxKeys > 0) {
			// S3 的上限是 1000；超出会被拒，所以在这里夹紧而不是让服务端报错
			query["max-keys"] = String(Math.min(1000, Math.trunc(options.maxKeys)));
		}

		// ⚠️ 列举是**桶级**请求（路径里没有 key），所以不能走 `requestTargetFor`：
		// 那个函数会（正确地）拒绝空 key —— 它的语义是"给某个对象定位"。
		const target = this.bucketRoot();
		const url = `${target.url}?${queryStringFor(query)}`;
		const payloadHash = await payloadHashOf("");

		return this.withRetry("listObjects", target.path, async (attempt) => {
			const { headers } = await this.sign(target, "GET", payloadHash, undefined, query);
			const response = await this.send({ url, method: "GET", headers }, {
				operation: "GET",
				key: target.path,
				attempt,
			});
			if (!isSuccess(response.status)) {
				throw this.fail(response, { operation: "GET", key: target.path, attempt });
			}
			const parsed = parseListObjects(decodeBody(response.body));
			if (parsed === null) {
				// 解析不出来**不能**当成"桶是空的" —— 那会让清理命令以为没有东西可删
				// （看起来"什么都没发生"），或者更糟：以为清单是全的。
				throw configError("列举对象失败：服务端返回的 XML 无法解析");
			}
			return parsed;
		});
	}

	/**
	 * 桶级请求的地址与**签名路径**（列举对象用）。
	 *
	 * 两种寻址各有一条路径形状，而**签名路径必须与实际请求路径逐字一致**
	 * （`requestTargetFor` 里那道自检就是为此）：
	 * - path-style：`/{桶}`；
	 * - virtual-host：`/`（桶在主机名里）。
	 */
	private bucketRoot(): { url: string; path: string } {
		this.assertConfig();
		const endpoint = normalizeEndpoint(this.config.endpoint);
		const bucket = this.config.bucket;
		if (!endpoint || !bucket) throw configError("存储地址或桶名未配置，无法列举对象");

		if (this.config.forcePathStyle === false) {
			const parsed = new URL(endpoint);
			parsed.hostname = `${bucket}.${parsed.hostname}`;
			parsed.pathname = "/";
			return { url: parsed.toString().replace(/\/+$/, ""), path: "/" };
		}
		const encodedBucket = uriEncode(bucket);
		return { url: `${endpoint}/${encodedBucket}`, path: `/${encodedBucket}` };
	}

	/** 对象在桶里的实际地址（与笔记里写的地址可能不同，见 `publicUrlFor`）。 */
	objectUrl(key: string): string {
		return requestTargetFor(this.config, key).url;
	}

	/** 笔记里写的地址。 */
	publicUrl(key: string): string {
		return publicUrlFor(this.config, key);
	}

	/**
	 * 一条**临时可用**的对象地址（预签名 URL，`X-Amz-Signature` 在查询串里）。
	 *
	 * 用途只有一处：私有存储 + 不留本地副本时，让 `<img>` 能直接取到对象
	 *（判据在 `link-access.ts::usesSignedUrls`）。它**不写进笔记** ——
	 * 写进去就是一批会过期的死链（见 `sigv4.ts::presignUrl` 的说明）。
	 *
	 * ⚠️ 用**对象地址**（`requestTargetFor`）而不是 `publicUrlFor`：后者可能是 CDN /
	 * 自定义域名，而签名要由 S3 自己验 —— 打到 CDN 上的签名 URL 多半直接 404。
	 *
	 * 失败（凭据没配、地址不合法）会**抛错**：调用方是渲染路径，那里必须自己接住
	 * 并降级（保持远端地址），不能让它冒到渲染器上。
	 */
	async presignedGetUrl(key: string, options: { expiresIn?: number } = {}): Promise<string> {
		this.assertConfig();
		const target = requestTargetFor(this.config, key);
		return presignUrl({
			method: "GET",
			url: target.url,
			path: target.path,
			accessKeyId: this.config.accessKeyId,
			secretAccessKey: this.config.secretAccessKey,
			region: this.config.region,
			...(this.config.service ? { service: this.config.service } : {}),
			now: this.now(),
			expiresIn: options.expiresIn ?? DEFAULT_PRESIGN_EXPIRES,
		});
	}

	// ── 内部 ──

	private assertConfig(): void {
		if (!this.config.accessKeyId) throw configError("S3 Access Key ID 未配置，请先在设置里填写");
		if (!this.config.secretAccessKey) throw configError("S3 Secret Access Key 未配置，请先在设置里填写");
		if (!this.config.region) throw configError("S3 区域未配置（R2 填 auto）");
	}

	/** 用一次已算好的时间戳签发请求。重试时会重新调用（时间必须新鲜）。 */
	private async sign(
		target: RequestTarget,
		method: string,
		payloadHash: string,
		contentType?: string,
		query?: Record<string, string>,
		/**
		 * 额外要签的头（目前只有 COPY 的 `x-amz-copy-source`）。
		 *
		 * ⚠️ 必须**进签名**：SigV4 要求所有 `x-amz-*` 头参与签名。拼进请求却不签，
		 * 服务端回的是 `SignatureDoesNotMatch` —— 而那种错误看起来像"密钥填错了"，
		 * 排查方向会被彻底带偏。
		 */
		extraHeaders?: Record<string, string>
	): Promise<{ headers: Record<string, string> }> {
		this.assertConfig();
		const { amzDate } = formatAmzDate(this.now());

		// host 只是签名的一部分，不进真正发出去的头（理由见文件头）
		const host = new URL(target.url).host;
		const toSign: Record<string, string> = {
			host,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
		};
		if (contentType) toSign["content-type"] = contentType;
		for (const name of Object.keys(extraHeaders ?? {})) toSign[name.toLowerCase()] = extraHeaders?.[name] ?? "";

		const { authorization } = await signRequest({
			method,
			path: target.path,
			query,
			headers: toSign,
			payloadHash,
			accessKeyId: this.config.accessKeyId,
			secretAccessKey: this.config.secretAccessKey,
			region: this.config.region,
			service: this.config.service ?? S3_SERVICE,
			amzDate,
		});

		const outgoing: Record<string, string> = { authorization };
		for (const name of Object.keys(toSign)) {
			if (name === "host") continue; // 绝不手填 Host
			outgoing[name] = toSign[name];
		}
		return { headers: outgoing };
	}

	private async send(
		request: S3TransportRequest,
		context: { operation: string; key: string; attempt: number }
	): Promise<S3TransportResponse> {
		// ⭐⭐ 2026-10-22（D-78）：**每一次传输都有上限**。
		//
		// 没有它的时候，`requestUrl` 卡住就是永久卡住 —— 而 `createLocalCopyEnsurer`
		// 用 `inflight` 去重（同 key 的第二次调用直接复用那条 Promise）⇒ 一次卡死
		// 会让这个对象**本次会话内再也不会重试**，用户看到的是"图一直空着，重启才好"。
		// 这正是 §25.3 那条「某次下载永不完成」的机制来源。
		const limit = this.timeouts[request.method as TransportMethod] ?? DEFAULT_TRANSPORT_TIMEOUTS[request.method as TransportMethod] ?? DEFAULT_TRANSPORT_TIMEOUTS.GET;
		try {
			return await raceWithTimeout(this.transport(request), limit);
		} catch (error) {
			// ⚠️ 超时要**自己成形**（不可重试、code=Timeout），不能被下面那条兜底吞掉：
			// 一旦被包成普通 `network`，`withRetry` 会照着"网络错误可重试"再等两轮，
			// 一次 60 秒的失败变成 3 分钟 —— 而结论不会变。
			if (error instanceof TransportTimeout) {
				throw timeoutError({
					operation: context.operation,
					key: context.key,
					timeoutMs: limit,
					attempts: context.attempt,
					secrets: this.secrets(),
				});
			}
			// 已经是 `S3Error` 的（理论上不会再走到，传输层只抛底层异常）原样抛，
			// 别包第二层 —— 包了就会丢掉 `kind` / `code` / `retryable`。
			if (error instanceof S3Error) throw error;
			// 传输层抛错 = 没拿到响应。归类为可重试的网络错误。
			throw networkError({
				error,
				operation: context.operation,
				key: context.key,
				attempts: context.attempt,
				secrets: this.secrets(),
			});
		}
	}

	private fail(
		response: S3TransportResponse,
		context: { operation: string; key: string; attempt: number }
	): S3Error {
		return responseError({
			status: response.status,
			body: decodeBody(response.body),
			operation: context.operation,
			key: context.key,
			attempts: context.attempt,
			secrets: this.secrets(),
		});
	}

	private secrets(): string[] {
		return [this.config.secretAccessKey, this.config.accessKeyId];
	}

	/**
	 * 单次 HEAD，**只为"传后校验"服务**。
	 *
	 * 与 `headObject()` 的区别：那个带重试、抛错，是给业务判据用的；
	 * 这个只问一次、任何异常都返回 `null`（"验不了"），因为它的调用方
	 * 不该因为"校验本身没做成"而把一次成功的上传判成失败。
	 */
	private async headOnce(key: string): Promise<{ size: number } | null> {
		try {
			const target = requestTargetFor(this.config, key);
			const { headers } = await this.sign(target, "HEAD", await payloadHashOf(""));
			const response = await this.send(
				{ url: target.url, method: "HEAD", headers },
				{ operation: "HEAD", key: target.path, attempt: 1 }
			);
			if (!isSuccess(response.status)) return null;
			return { size: Number(response.headers["content-length"] ?? 0) || 0 };
		} catch {
			return null;
		}
	}

	private async withRetry<T>(
		operation: string,
		key: string,
		run: (attempt: number) => Promise<T>
	): Promise<T> {
		let attempt = 0;
		for (;;) {
			attempt += 1;
			try {
				return await run(attempt);
			} catch (error) {
				const s3Error = asS3Error(error, operation, key, attempt, this.secrets());
				if (!s3Error.retryable || attempt >= this.maxAttempts) throw s3Error;
				await this.sleep(this.delayFor(attempt));
			}
		}
	}

	/**
	 * 退避时长：指数增长并封顶。
	 *
	 * 刻意**不引入随机抖动**：抖动在服务端视角更友好，但会让测试变成概率性的，
	 * 而"断言"要能可靠复现才值得写。这里的重试预算本来就很小（默认 3 次、最长 2 秒），
	 * 不足以造成惊群。
	 */
	private delayFor(attempt: number): number {
		return Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
	}
}

/** 把任意异常收敛成 `S3Error`（已经是的就原样返回，避免包裹两层）。 */
function asS3Error(
	error: unknown,
	operation: string,
	key: string,
	attempt: number,
	secrets: string[]
): S3Error {
	if (error instanceof S3Error) return error;
	return networkError({ error, operation, key, attempts: attempt, secrets });
}

/** 响应体解码成文本（S3 的错误体是 UTF-8 XML）。 */
function decodeBody(body: Uint8Array | undefined): string {
	if (!body || body.length === 0) return "";
	try {
		return new TextDecoder().decode(body);
	} catch {
		return "";
	}
}

/** ETag 去掉包裹的双引号（S3 返回 `"abc"`，写进索引时不带引号更好用）。 */
function etagOf(headers: Record<string, string>): string {
	const raw = headers["etag"] ?? "";
	return raw.replace(/^"|"$/g, "");
}

/** 便捷工厂。 */
export function createS3Client(config: S3ClientConfig, deps: S3ClientDeps = {}): S3Client {
	return new S3Client(config, deps);
}
