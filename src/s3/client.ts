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
 * 与"渲染时偷偷联网"正是本项目最需要防的两件事（见 SCOPE 的 P0 验收标准）。
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
import { S3Error, isSuccess, networkError, responseError } from "./errors";
import { S3_SERVICE, encodePath, formatAmzDate, payloadHashOf, signRequest, uriEncode } from "./sigv4";

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

// ─────────────────────────── 客户端 ───────────────────────────

export interface S3ClientConfig extends ObjectAddress {
	region: string;
	/** 凭据。调用方负责从宿主的 SecretStorage 取出，本模块只**用**不存。 */
	accessKeyId: string;
	secretAccessKey: string;
	service?: string;
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

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
	// 用 `window.setTimeout` 而不是裸 `setTimeout`：弹出窗口（popout window）里
	// 两者的定时器不同源，用裸的会在 popout 场景下行为不一致（Obsidian 官方 lint 也这么要求）。
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class S3Client {
	private readonly config: S3ClientConfig;
	private readonly transport: S3Transport;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;

	constructor(config: S3ClientConfig, deps: S3ClientDeps = {}) {
		this.config = config;
		this.transport = deps.transport ?? obsidianTransport;
		this.now = deps.now ?? (() => new Date());
		this.sleep = deps.sleep ?? defaultSleep;
		this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
		this.baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
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
			return {
				key: target.path,
				url: publicUrl,
				etag: etagOf(response.headers),
				size: data.length,
				attempts: attempt,
			};
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

	/** 对象在桶里的实际地址（与笔记里写的地址可能不同，见 `publicUrlFor`）。 */
	objectUrl(key: string): string {
		return requestTargetFor(this.config, key).url;
	}

	/** 笔记里写的地址。 */
	publicUrl(key: string): string {
		return publicUrlFor(this.config, key);
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
		contentType?: string
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

		const { authorization } = await signRequest({
			method,
			path: target.path,
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
		try {
			return await this.transport(request);
		} catch (error) {
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
