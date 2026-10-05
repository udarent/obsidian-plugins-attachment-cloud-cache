/**
 * 本地 S3 替身：**真实 HTTP 服务** + **独立重算签名**。
 *
 * ## 为什么要有它，而不是 mock 掉 `S3Client`
 *
 * 因为要证明的东西恰好是"网络这一层发生了什么"：
 * - 上传的字节与本地文件**逐字节一致**（不能因为 `text`/`arrayBuffer` 用错而变味）；
 * - 凭据错时**只发一次**请求（不重试）；
 * - 5xx 时**重试了但不超过上限**；
 * - 渲染时**一次远端请求都没有**（离线可达性）。
 *
 * 这些断言必须落在"真的发了几条 HTTP 请求"上。把 `S3Client` 整个 mock 掉之后，
 * 能断言的只剩"某个函数被调用过"，而那与真实行为可以完全脱节。
 *
 * ## 为什么签名要在服务端**重算**
 *
 * 被测代码自己算的签名，自己当然认为是对的 —— 拿它自我比对等于什么都没证明。
 * 所以这里按规范**独立再实现一遍**（并且刻意用不同的写法：签名密钥用循环折叠，
 * 而不是 `src/` 里那四个具名中间量），再拿收到的请求重算。
 * 两边独立写出同一个值，才说明签名是对着**规范**写的，而不是对着自己写的。
 *
 * ⚠️ 另外三处也一并校验，因为它们是"签名对但请求还是坏"的常见来源：
 * - `x-amz-content-sha256` 必须等于**收到字节**的 SHA-256（防传输层改动载荷）；
 * - `SignedHeaders` 列出的每个头都必须真的在请求里（防"签了但没发"）；
 * - **请求行里的路径**必须就是签名时用的规范化 URI（防 URL 规范化改路径）。
 */

import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";

// ─────────────────────────── 独立的 SigV4 实现 ───────────────────────────

const sha256 = (data) => createHash("sha256").update(data).digest();
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** 与 `src/s3/sigv4.ts` 同规则、**不同写法**：按字节判定 unreserved。 */
function uriEncode(value) {
	const bytes = Buffer.from(String(value), "utf8");
	let out = "";
	for (const byte of bytes) {
		const unreserved =
			(byte >= 0x41 && byte <= 0x5a) ||
			(byte >= 0x61 && byte <= 0x7a) ||
			(byte >= 0x30 && byte <= 0x39) ||
			byte === 0x2d ||
			byte === 0x5f ||
			byte === 0x2e ||
			byte === 0x7e;
		out += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** 签名密钥：用**循环折叠**推出，而不是四个具名中间量。 */
function signingKey(secretAccessKey, dateStamp, region, service) {
	const steps = [`AWS4${secretAccessKey}`, dateStamp, region, service, "aws4_request"];
	let key = steps[0];
	for (const step of steps.slice(1)) {
		key = hmac(key, step);
	}
	return key;
}

function canonicalizeQuery(rawQuery) {
	if (!rawQuery) return "";
	const pairs = [];
	for (const part of rawQuery.split("&")) {
		if (part === "") continue;
		const eq = part.indexOf("=");
		const name = eq === -1 ? part : part.slice(0, eq);
		const value = eq === -1 ? "" : part.slice(eq + 1);
		// 收到的已经是编码后的形态；再编码一次会变成双重编码，
		// 所以这里**按原样**收（这正是 AWS 服务端做的事：用收到的字节串）。
		pairs.push([name, value]);
	}
	pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
	return pairs.map(([n, v]) => `${n}=${v}`).join("&");
}

/**
 * 重算签名并返回比对结果。
 *
 * @returns {{ ok: boolean, reason?: string, detail?: Record<string, string> }}
 */
export function verifySignature({ request, credentials, bodyBuffer }) {
	const authHeader = request.headers["authorization"] ?? "";
	const match = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-fA-F]{64})\s*$/.exec(
		authHeader
	);
	if (!match) {
		return { ok: false, reason: "Authorization 头缺失或格式不对" };
	}
	const [, credential, signedHeadersList, providedSignature] = match;
	const credentialParts = credential.split("/");
	if (credentialParts.length !== 5) {
		return { ok: false, reason: `Credential 段数不对：${credential}` };
	}
	const [accessKeyId, dateStamp, region, service, terminator] = credentialParts;

	if (accessKeyId !== credentials.accessKeyId) {
		return { ok: false, reason: `Access Key ID 不匹配（收到 ${accessKeyId}）` };
	}
	if (terminator !== "aws4_request") return { ok: false, reason: "凭据作用域结尾不是 aws4_request" };
	if (region !== credentials.region) return { ok: false, reason: `region 不匹配（收到 ${region}）` };
	if (service !== credentials.service) return { ok: false, reason: `service 不匹配（收到 ${service}）` };

	const amzDate = request.headers["x-amz-date"] ?? "";
	if (!amzDate) return { ok: false, reason: "缺少 x-amz-date" };
	if (amzDate.slice(0, 8) !== dateStamp) {
		return { ok: false, reason: `x-amz-date(${amzDate}) 与凭据日期(${dateStamp}) 不一致` };
	}

	// ⭐ 载荷完整性：头里声明的摘要必须等于**实际收到字节**的摘要
	const declaredPayloadHash = request.headers["x-amz-content-sha256"] ?? "";
	const actualPayloadHash = sha256(bodyBuffer).toString("hex");
	if (!declaredPayloadHash) return { ok: false, reason: "缺少 x-amz-content-sha256" };
	if (declaredPayloadHash !== actualPayloadHash) {
		return {
			ok: false,
			reason: "x-amz-content-sha256 与收到的载荷不符（传输过程中内容被改动）",
			detail: { declared: declaredPayloadHash, actual: actualPayloadHash },
		};
	}

	// ⭐ 签了哪些头，就必须真的发了哪些头
	const signedHeaderNames = signedHeadersList.split(";").filter(Boolean);
	const canonicalHeaderLines = [];
	for (const name of signedHeaderNames) {
		const value = request.headers[name];
		if (value === undefined) {
			return { ok: false, reason: `SignedHeaders 里声明了 ${name}，但请求里没有这个头` };
		}
		canonicalHeaderLines.push(`${name}:${String(value).trim().replace(/\s+/g, " ")}`);
	}

	// ⭐ 规范化 URI 用**收到的请求行**，而不是"调用方声称的路径" ——
	// 这样才能抓住"签的路径与实际请求路径不一致"（URL 规范化是最常见成因）
	const [rawPath, rawQuery] = splitRequestTarget(request.rawUrl);
	const canonicalRequest = [
		request.method.toUpperCase(),
		rawPath,
		canonicalizeQuery(rawQuery),
		`${canonicalHeaderLines.join("\n")}\n`,
		signedHeaderNames.join(";"),
		declaredPayloadHash,
	].join("\n");

	const scope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256(canonicalRequest).toString("hex"),
	].join("\n");

	const expected = createHmac("sha256", signingKey(credentials.secretAccessKey, dateStamp, region, service))
		.update(stringToSign)
		.digest("hex");

	if (expected !== providedSignature.toLowerCase()) {
		return {
			ok: false,
			reason: "签名不匹配",
			detail: { expected, provided: providedSignature.toLowerCase(), stringToSign, canonicalRequest },
		};
	}

	return { ok: true, detail: { canonicalRequest, stringToSign, signature: expected } };
}

function splitRequestTarget(rawUrl) {
	const index = rawUrl.indexOf("?");
	if (index === -1) return [rawUrl, ""];
	return [rawUrl.slice(0, index), rawUrl.slice(index + 1)];
}

// ─────────────────────────── S3 风格的响应 ───────────────────────────

function xmlEscape(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorXml(code, message, extra = {}) {
	const extras = Object.entries(extra)
		.map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${xmlEscape(code)}</Code><Message>${xmlEscape(
		message
	)}</Message>${extras}<RequestId>mock-request-id</RequestId><HostId>mock-host-id</HostId></Error>`;
}

/** S3 对**单段** PUT 给的 ETag 就是内容的 MD5（带引号）。 */
function etagOf(buffer) {
	return `"${createHash("md5").update(buffer).digest("hex")}"`;
}

// ─────────────────────────── 服务本体 ───────────────────────────

/**
 * 起一个本地 S3 替身。
 *
 * @param {{
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   region?: string,
 *   service?: string,
 *   bucket?: string,
 *   delayMs?: number,
 *   intercept?: (request: object) => null | { status: number, code: string, message?: string } | "drop",
 * }} options
 */
export function createMockS3(options) {
	const credentials = {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		region: options.region ?? "auto",
		service: options.service ?? "s3",
	};
	const bucket = options.bucket ?? "test-bucket";
	const delayMs = options.delayMs ?? 0;
	const intercept = options.intercept ?? (() => null);

	/** key → { body: Buffer, contentType: string } */
	const objects = new Map();
	/** 收到的每一条请求（含校验结论），供"恰好 1 次 PUT"这类断言使用。 */
	const requests = [];
	let active = 0;
	let maxConcurrent = 0;

	const server = createServer((req, res) => {
		active += 1;
		if (active > maxConcurrent) maxConcurrent = active;

		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			void handle(req, res, Buffer.concat(chunks)).finally(() => {
				active -= 1;
			});
		});
	});
	// 注入断连时会有半截请求，吞掉客户端的 socket 错误，
	// 免得替身服务因为"被测代码遇到的故障"而自己抛未捕获异常
	server.on("clientError", () => {});

	async function handle(req, res, bodyBuffer) {
		const headers = {};
		for (const name of Object.keys(req.headers)) headers[name.toLowerCase()] = req.headers[name];

		const [rawPath, rawQuery] = splitRequestTarget(req.url ?? "/");
		// 路径按 `/` 拆开后再逐段解码 —— 这样含 `%2F` 的 key 不会被误当成层级分隔。
		// 解码失败（畸形转义）时保留原样，绝不因此让服务崩掉：
		// 一个替身服务因为被测代码发了个畸形 URL 就挂掉，会掩盖真正的失败原因。
		const segments = rawPath
			.replace(/^\/+/, "")
			.split("/")
			.map((segment) => {
				try {
					return decodeURIComponent(segment);
				} catch {
					return segment;
				}
			});
		const requestBucket = segments[0] ?? "";
		const key = segments.slice(1).join("/");

		const record = {
			method: req.method ?? "",
			rawUrl: req.url ?? "",
			path: rawPath,
			query: rawQuery,
			bucket: requestBucket,
			key,
			headers,
			bodyLength: bodyBuffer.length,
			bodyHash: sha256(bodyBuffer).toString("hex"),
			signatureOk: false,
			signatureReason: "",
			respondedStatus: 0,
		};
		requests.push(record);

		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

		// 故障注入（在鉴权之前）—— 用它来构造 5xx / 断连等场景
		const injected = intercept({ ...record, attempt: requests.length });
		if (injected === "drop") {
			record.signatureReason = "（被注入的断连）";
			record.respondedStatus = 0;
			req.socket.destroy();
			return;
		}
		if (injected) {
			const xml = errorXml(injected.code, injected.message ?? "injected failure");
			record.respondedStatus = injected.status;
			res.writeHead(injected.status, {
				"content-type": "application/xml",
				"content-length": Buffer.byteLength(xml),
				"x-amz-request-id": "mock-request-id",
			});
			res.end(xml);
			return;
		}

		// 鉴权
		const verdict = verifySignature({ request: { ...record, headers }, credentials, bodyBuffer });
		record.signatureOk = verdict.ok;
		record.signatureReason = verdict.reason ?? "";
		// 把服务端**独立算出**的中间产物留在记录里：签名失败时唯一能定位差异的东西
		record.canonicalRequest = verdict.detail?.canonicalRequest ?? "";
		record.expectedSignature = verdict.detail?.expected ?? "";
		record.providedSignature = verdict.detail?.signature ?? verdict.detail?.provided ?? "";
		if (!verdict.ok) {
			const xml = errorXml("SignatureDoesNotMatch", `The request signature we calculated does not match the signature you provided. ${verdict.reason ?? ""}`, {
				StringToSign: verdict.detail?.stringToSign ?? "",
				SignatureProvided: verdict.detail?.provided ?? "",
			});
			record.respondedStatus = 403;
			res.writeHead(403, {
				"content-type": "application/xml",
				"content-length": Buffer.byteLength(xml),
				"x-amz-request-id": "mock-request-id",
			});
			res.end(xml);
			return;
		}

		if (requestBucket !== bucket) {
			const xml = errorXml("NoSuchBucket", "The specified bucket does not exist");
			record.respondedStatus = 404;
			res.writeHead(404, {
				"content-type": "application/xml",
				"content-length": Buffer.byteLength(xml),
				"x-amz-request-id": "mock-request-id",
			});
			res.end(xml);
			return;
		}

		const method = (req.method ?? "").toUpperCase();
		if (method === "PUT") {
			objects.set(key, { body: bodyBuffer, contentType: headers["content-type"] ?? "" });
			record.respondedStatus = 200;
			res.writeHead(200, { etag: etagOf(bodyBuffer), "x-amz-request-id": "mock-request-id" });
			res.end();
			return;
		}

		const stored = objects.get(key);

		if (method === "GET") {
			if (!stored) return respondMissing(res, record);
			record.respondedStatus = 200;
			res.writeHead(200, {
				"content-type": stored.contentType || "application/octet-stream",
				"content-length": stored.body.length,
				etag: etagOf(stored.body),
				"x-amz-request-id": "mock-request-id",
			});
			res.end(stored.body);
			return;
		}

		if (method === "HEAD") {
			if (!stored) return respondMissing(res, record, true);
			record.respondedStatus = 200;
			res.writeHead(200, {
				"content-type": stored.contentType || "application/octet-stream",
				"content-length": stored.body.length,
				etag: etagOf(stored.body),
				"x-amz-request-id": "mock-request-id",
			});
			res.end();
			return;
		}

		if (method === "DELETE") {
			if (!stored) return respondMissing(res, record);
			objects.delete(key);
			record.respondedStatus = 204;
			res.writeHead(204, { "x-amz-request-id": "mock-request-id" });
			res.end();
			return;
		}

		const xml = errorXml("MethodNotAllowed", `不支持的方法 ${method}`);
		record.respondedStatus = 405;
		res.writeHead(405, {
			"content-type": "application/xml",
			"content-length": Buffer.byteLength(xml),
		});
		res.end(xml);
	}

	function respondMissing(res, record, head = false) {
		const xml = errorXml("NoSuchKey", "The specified key does not exist.");
		record.respondedStatus = 404;
		const headers = {
			"content-type": "application/xml",
			"x-amz-request-id": "mock-request-id",
		};
		// HEAD 不能带 body
		if (!head) headers["content-length"] = Buffer.byteLength(xml);
		res.writeHead(404, headers);
		res.end(head ? undefined : xml);
	}

	async function listen() {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		return `http://127.0.0.1:${address.port}`;
	}

	return {
		/** 等服务真正起来后再取（要先 `await listen()`）。 */
		listen,
		async start() {
			this.endpoint = await listen();
			return this.endpoint;
		},
		endpoint: "",
		credentials,
		bucket,
		objects,
		requests,
		get maxConcurrent() {
			return maxConcurrent;
		},
		requestCount() {
			return requests.length;
		},
		countByMethod(method) {
			return requests.filter((r) => r.method === method.toUpperCase()).length;
		},
		stored(key) {
			const found = objects.get(key);
			return found ? found.body : null;
		},
		close() {
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * 基于 Node 全局 `fetch` 的传输实现。
 *
 * `redirect: "manual"` 是刻意的：本项目把 3xx 视为失败（见 `errors.ts`），
 * 而 fetch 默认会跟随重定向 —— 跟随之后签名就失效了，
 * 会得到一串难以解释的错误，而不是"端点配错了"这句真话。
 */
export function nodeTransport() {
	return async ({ url, method, headers, body }) => {
		const response = await fetch(url, {
			method,
			headers,
			body: body ? Buffer.from(body) : undefined,
			redirect: "manual",
		});
		const buffer = Buffer.from(await response.arrayBuffer());
		const out = {};
		response.headers.forEach((value, name) => {
			out[name.toLowerCase()] = value;
		});
		return { status: response.status, headers: out, body: new Uint8Array(buffer) };
	};
}
