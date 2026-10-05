/**
 * S3 客户端模块的断言套件（正式测试与变异验证共用）。
 *
 * ## 这套断言全部落在"网络上真的发生了什么"上
 *
 * 对本地**真实 HTTP 服务**发请求，然后断言：
 * - 服务端收到的字节与本地**逐字节一致**；
 * - 服务端用**独立重算**的签名验过了（不是拿我们的实现自我比对）；
 * - 凭据错时**恰好 1 条请求**（不重试）；
 * - 5xx 时**重试了，且不超过上限**；
 * - 上传过程里 **PUT=1、GET=0**（SCOPE 的 P0 验收标准就是照这个写的）。
 *
 * 把 `S3Client` mock 掉只能断言"某个函数被调用过"，而"上传失败时反复重试"
 * 与"渲染时偷偷联网"恰恰是这两件必须防住的事 —— 它们只在真实请求计数上可见。
 *
 * ## ⭐ 小节顺序是刻意的：纯函数在前，联网在后
 *
 * 变异验证要求"每个变异因**自己的**原因失败"。而一旦前面有联网断言，
 * 任何配置类缺陷都会先在网络请求上炸掉，报出来的是一个 HTTP 错误 ——
 * 于是"路径少写了桶名"这类缺陷看上去像"请求失败了"，根因被掩盖。
 * 所以：地址推导 → 上传/下载 → 重试策略 → 脱敏 → 配置闸门。
 *
 * ## 另一条纪律：凡是"应当返回 null / false 而不是抛错"的断言，
 * 必须先 `.catch()` 收敛再断言
 *
 * 否则实现抛错时，异常会直接从 `await` 冒出去，测试以"未处理的拒绝"失败，
 * 报出来的是那个错误的消息 —— 而我们要检验的恰恰是"它不该抛错"。
 * 断言必须能**说清自己为什么红**。
 *
 * ## 覆盖不到的
 *
 * 真机 / 真实存储的差异（TLS、代理、R2 与 MinIO 的细节差异）这里测不了，
 * 只能靠 README 如实标注验证范围。本套件证明的是**协议实现正确**，
 * 不是"对所有服务商都能用"。
 */

import assert from "node:assert/strict";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const CREDENTIALS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const FIXED_NOW = new Date("2026-10-05T11:39:41Z");

/** 起一个替身服务并在结束后收掉它（异常路径也要收，否则套件会挂住进程）。 */
async function withServer(options, fn) {
	const server = createMockS3({ ...CREDENTIALS, ...options });
	try {
		const endpoint = await server.start();
		return await fn(server, endpoint);
	} finally {
		await server.close();
	}
}

/** 包一层传输，用来记录"真正发出去的头"（Host 有没有被手填就看这个）。 */
function recordingTransport(inner) {
	const sent = [];
	return {
		sent,
		transport: async (request) => {
			sent.push(request);
			return inner(request);
		},
	};
}

function makeClient(mod, endpoint, overrides = {}, deps = {}) {
	return new mod.S3Client(
		{
			endpoint,
			region: "auto",
			bucket: "test-bucket",
			...CREDENTIALS,
			...overrides,
		},
		{ transport: nodeTransport(), now: () => FIXED_NOW, sleep: async () => {}, ...deps }
	);
}

export async function runS3ClientSuite(mod) {
	const { S3Client, S3Error, requestTargetFor, publicUrlFor, objectUrl, normalizeEndpoint } = mod;

	// ============================================================
	// 0. 端点规范化（纯函数，先把输入的口子堵上）
	// ============================================================
	assert.equal(normalizeEndpoint("https://abc.r2.cloudflarestorage.com/"), "https://abc.r2.cloudflarestorage.com");
	assert.equal(
		normalizeEndpoint("  abc.r2.cloudflarestorage.com  "),
		"https://abc.r2.cloudflarestorage.com",
		"没写 scheme 时应补上 https（用户复制粘贴时常忘）"
	);
	assert.equal(normalizeEndpoint(""), "", "空端点应原样返回空串，由上层判定为未配置");
	assert.equal(normalizeEndpoint("http://minio.local:9000///"), "http://minio.local:9000", "应去掉多余尾斜杠");

	// ============================================================
	// 1. ⭐ 寻址方式（纯函数；放在联网之前，失败信息才指得准）
	// ============================================================
	const address = { endpoint: "https://abc.r2.cloudflarestorage.com", bucket: "my-bucket" };

	// 先钉**默认**行为：不传 forcePathStyle 时必须是 path-style。
	// 放在最前，是为了让"判定反了"这类缺陷在这里就报出"必须走 path-style"，
	// 而不是在后面某个 HTTP 404（桶不存在）上表现为"上传失败"。
	assert.equal(
		requestTargetFor(address, "a.png").url,
		"https://abc.r2.cloudflarestorage.com/my-bucket/a.png",
		"不指定时必须走 path-style（这是四类存储都成立的那一侧：R2 的 S3 端点不支持 virtual-host）"
	);

	// 逻辑 key 的归一化：同一个逻辑 key 必须永远推出同一个对象地址，
	// 否则"同一张图"会变成桶里两个对象，缓存与索引也随之分叉。
	assert.equal(
		objectUrl({ ...address, forcePathStyle: true }, "//a/b.png"),
		`${address.endpoint}/my-bucket/a/b.png`,
		"重复的前导斜杠不应产生空路径段（空段会让同一个 key 对应到另一个对象）"
	);
	for (const variant of ["a/b.png", "/a/b.png", "///a/b.png", "  a/b.png  "]) {
		assert.equal(
			objectUrl({ ...address, forcePathStyle: true }, variant),
			`${address.endpoint}/my-bucket/a/b.png`,
			`逻辑 key 的各种写法（${JSON.stringify(variant)}）必须归一到同一个地址`
		);
	}

	const pathStyle = requestTargetFor({ ...address, forcePathStyle: true }, "dir/中文 名.png");
	assert.equal(
		pathStyle.path,
		"/my-bucket/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png",
		"⭐ path-style 的**签名路径必须含桶名** —— 请求真的就是打到 /桶/键"
	);
	assert.equal(
		pathStyle.url,
		"https://abc.r2.cloudflarestorage.com/my-bucket/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png",
		"path-style 的地址形状"
	);

	const virtualHost = requestTargetFor({ ...address, forcePathStyle: false }, "dir/中文 名.png");
	assert.equal(
		virtualHost.url,
		"https://my-bucket.abc.r2.cloudflarestorage.com/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png",
		"virtual-host 的地址形状（桶名进子域）"
	);
	assert.equal(virtualHost.path, "/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png", "virtual-host 的签名路径不含桶名");

	// ⭐ 公开 URL 只编码一次（双重编码的链接"能生成但打不开"）
	const publicUrlCases = [
		{ base: "https://img.example.com", key: "dir/中文 名.png", expected: "https://img.example.com/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png" },
		{ base: "https://img.example.com/", key: "a$b.png", expected: "https://img.example.com/a%24b.png" },
		{ base: "https://img.example.com", key: "plain.png", expected: "https://img.example.com/plain.png" },
	];
	for (const testCase of publicUrlCases) {
		const url = publicUrlFor({ ...CREDENTIALS, endpoint: address.endpoint, bucket: "b", publicUrlBase: testCase.base }, testCase.key);
		// 先查"有没有二次编码的痕迹"，再查逐字节相等：前者直接点出原因
		assert.ok(!url.includes("%25"), `公开 URL 不得出现二次编码：${testCase.key} → ${url}`);
		assert.equal(url, testCase.expected, `公开 URL 形状（base=${testCase.base}）`);
	}
	assert.equal(
		publicUrlFor({ ...CREDENTIALS, endpoint: address.endpoint, bucket: "b" }, "dir/中文 名.png"),
		`${address.endpoint}/b/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png`,
		"没配 publicUrlBase 时应退回对象地址"
	);

	// ============================================================
	// 2. ⭐ 上传：字节一致 + 服务端独立验签
	// ============================================================
	await withServer({}, async (server, endpoint) => {
		const client = makeClient(mod, endpoint);

		// 刻意包含 0x00 / 0xFF / 非法 UTF-8 序列 —— 若用"文本"通道传载荷，
		// 这些字节会被替换或截断，而普通 PNG 的测试数据看不出来。
		const payload = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f, 0xed,
			0xa0, 0x80,
		]);
		const key = "img/中文 名$1.png";

		const result = await client.putObject(key, payload, "image/png");
		assert.equal(result.attempts, 1, "一次成功就不该有第二次尝试");
		assert.equal(result.size, payload.length, "返回值里的 size 应是真实字节数");
		assert.equal(server.countByMethod("PUT"), 1, "上传应当**恰好** 1 次 PUT");
		assert.equal(server.countByMethod("GET"), 0, "上传过程里不得有任何 GET");

		const stored = server.stored(key);
		assert.ok(stored, `服务端应存下对象 ${key}`);
		assert.equal(
			Buffer.compare(Buffer.from(payload), stored),
			0,
			"服务端存下的字节必须与本地逐字节一致（含 0x00/0xFF/非法 UTF-8）"
		);

		const record = server.requests[0];
		assert.equal(record.signatureOk, true, `服务端独立重算的签名必须通过：${record.signatureReason}`);
		assert.equal(record.key, key, "服务端解出的 key 应与上传时一致");
		assert.ok(!record.path.includes("%25"), `请求路径里不得出现二次编码：${record.path}`);
		assert.ok(
			record.path.includes("%E4%B8%AD%E6%96%87%20%E5%90%8D%24"),
			`非 ASCII 与空格与 $ 都必须正确编码，实际路径：${record.path}`
		);
		// 载荷摘要：服务端已经比对过，这里再钉一次"它确实来自收到的那串字节"
		assert.equal(record.headers["x-amz-content-sha256"], record.bodyHash, "声明的载荷摘要必须等于收到字节的摘要");
		// 凭据不能出现在 URL 里（历史上不少插件把 key 拼在查询串里）
		assert.ok(!record.rawUrl.includes("?"), "请求不应带查询串");
		assert.ok(!record.rawUrl.includes(CREDENTIALS.accessKeyId), "Access Key ID 不得出现在 URL 里");

		// ⛔ 绝不签 content-length：它由传输层自己算，签了会在分块/编码时对不上
		assert.ok(
			!/content-length/i.test(record.headers.authorization),
			"SignedHeaders 里不得包含 content-length"
		);
		// 但它确实存在于请求里 —— 说明我们"看到了却没签"，而不是"它不存在"
		assert.ok(record.headers["content-length"], "传输层会自动带上 content-length（这正是不能签它的原因）");

		// ETag 去掉引号
		assert.match(result.etag, /^[0-9a-f]{32}$/, "ETag 应是去掉引号后的十六进制");

		// host 必须被签名（不签服务端会拒），但不能手填
		const signedHeaders = /SignedHeaders=([^,]+),/.exec(record.headers.authorization)[1];
		assert.ok(signedHeaders.split(";").includes("host"), "host 必须在 SignedHeaders 里");
		assert.ok(signedHeaders.split(";").includes("x-amz-date"), "x-amz-date 必须在 SignedHeaders 里");
		assert.ok(signedHeaders.split(";").includes("x-amz-content-sha256"), "S3 要求 x-amz-content-sha256 必须被签名");
		assert.ok(signedHeaders.split(";").includes("content-type"), "给了 content-type 就应当把它签进去");

		// ---- 下载往返 ----
		const got = await client.getObject(key);
		assert.equal(Buffer.compare(Buffer.from(got.data), Buffer.from(payload)), 0, "下载回来的字节必须与上传的一致");
		assert.equal(got.contentType, "image/png", "应带回 content-type");
		assert.equal(got.etag, result.etag, "ETag 应一致");

		// ---- HEAD：存在 / 不存在 ----
		const head = await client.headObject(key);
		assert.ok(head, "已存在的对象 HEAD 应返回信息");
		assert.equal(head.size, payload.length, "HEAD 的 size 应来自 content-length");
		assert.equal(head.etag, result.etag, "HEAD 的 ETag 应一致");

		const before = server.requestCount();
		// ⚠️ 先 `.catch()` 收敛：实现若抛错，异常会直接冒出 await，
		// 测试以那个错误失败 —— 而这里要检验的正是"它不该抛错"。
		const missingHead = await client.headObject("does/not/exist.png").catch((error) => error);
		assert.equal(missingHead, null, `HEAD 不存在应返回 null 而不是抛错（实际：${missingHead}`.concat("）"));
		assert.equal(server.requestCount() - before, 1, "HEAD 不存在只应发 1 次请求（404 不该被重试）");

		// ---- DELETE：存在 → true，不存在 → false ----
		assert.equal(await client.deleteObject(key), true, "删除存在的对象应返回 true");
		assert.equal(server.stored(key), null, "删除后服务端不应再有该对象");
		const missingDelete = await client.deleteObject(key).catch((error) => error);
		assert.equal(
			missingDelete,
			false,
			`DELETE 不存在的对象应返回 false 而不是抛错（实际：${missingDelete}）`
		);

		// ---- describe() 不得泄露密钥 ----
		const described = client.describe();
		assert.ok(!described.includes(CREDENTIALS.secretAccessKey), "describe() 里不得出现 Secret Access Key");
		assert.ok(
			!described.includes(CREDENTIALS.accessKeyId),
			"describe() 里不得出现完整的 Access Key ID（日志会被贴到 issue 里）"
		);
		assert.ok(described.includes("AKID"), "describe() 应保留足以辨认身份的前缀");
		assert.ok(described.includes("pathStyle=true"), "describe() 应体现寻址方式");
	});

	// ============================================================
	// 3. ⭐ 凭据错误：只发 1 次，不重试
	// ============================================================
	await withServer({}, async (server, endpoint) => {
		const delays = [];
		const client = makeClient(
			mod,
			endpoint,
			{ secretAccessKey: "WRONG-SECRET-KEY" },
			{ sleep: async (ms) => delays.push(ms) }
		);

		await assert.rejects(
			() => client.putObject("x.png", new Uint8Array([1, 2, 3])),
			(error) => {
				assert.equal(error.name, "S3Error", "应抛出 S3Error");
				assert.ok(error instanceof S3Error, "S3Error 应能被 instanceof 认出");
				assert.equal(error.kind, "auth", "403 应归类为鉴权问题");
				assert.equal(error.status, 403, "状态码应保留");
				assert.equal(error.code, "SignatureDoesNotMatch", "应解析出 S3 的错误码");
				assert.equal(error.hintKey, "s3HintSignature", "应给出针对签名不匹配的建议");
				assert.ok(error.requestId, "应带上服务端给的 requestId");
				return true;
			}
		);
		assert.equal(server.countByMethod("PUT"), 1, "凭据错误应**只**发 1 次请求（重试毫无意义）");
		assert.deepEqual(delays, [], "不应发生任何退避等待");
		assert.ok(!server.requests[0].signatureReason.includes("载荷"), "这一次失败应确实是签名不匹配");
	});

	// ============================================================
	// 4. ⭐ 5xx：重试，但不超过上限；退避指数增长并封顶
	// ============================================================
	await withServer({ intercept: () => ({ status: 503, code: "ServiceUnavailable" }) }, async (server, endpoint) => {
		const delays = [];
		const client = makeClient(mod, endpoint, {}, { maxAttempts: 3, baseDelayMs: 250, sleep: async (ms) => delays.push(ms) });

		await assert.rejects(
			() => client.putObject("x.png", new Uint8Array([1])),
			(error) => {
				assert.equal(error.retryable, true, "503 应被标为可重试（上层可据此给出不同建议）");
				assert.equal(error.attempts, 3, "应记录实际尝试次数");
				assert.equal(error.status, 503, "应保留最终状态码");
				assert.ok(error.message.includes("after 3 attempts"), `消息里应体现重试过：${error.message}`);
				return true;
			}
		);
		assert.equal(server.countByMethod("PUT"), 3, "重试总次数不得超过上限（1 次首试 + 2 次重试）");
		assert.deepEqual(delays, [250, 500], "退避应按指数增长：250ms → 500ms");
	});

	// 4b. maxAttempts = 1 → 完全不重试
	//
	// ⚠️ 这一块必须排在"退避封顶"**之前**：两处都用同一套重试循环，
	// 若封顶那块的参数更大（6 次尝试），一旦 maxAttempts 被忽略，
	// 先炸的会是封顶那块的 delays 断言 —— 报出来的是"退避没封顶"，
	// 而真因是"次数上限被忽略"。顺序一换，每个缺陷就各报各的原因。
	await withServer({ intercept: () => ({ status: 500, code: "InternalError" }) }, async (server, endpoint) => {
		const client = makeClient(mod, endpoint, {}, { maxAttempts: 1 });
		await assert.rejects(() => client.putObject("x.png", new Uint8Array([1])));
		assert.equal(server.countByMethod("PUT"), 1, "maxAttempts=1 时应当连重试都不试");
	});

	// 4c. 重试后成功：把"偶发故障"与"硬失败"区分开
	await withServer(
		{ intercept: ({ attempt }) => (attempt <= 2 ? { status: 500, code: "InternalError" } : null) },
		async (server, endpoint) => {
			const client = makeClient(mod, endpoint, {}, { maxAttempts: 3 });
			const result = await client.putObject("retry.png", new Uint8Array([7, 7, 7]));
			assert.equal(result.attempts, 3, "第 3 次才成功，attempts 应为 3");
			assert.equal(server.countByMethod("PUT"), 3, "应恰好发出 3 次 PUT");
			assert.ok(server.stored("retry.png"), "重试成功后对象应当真的在服务端");
			assert.equal(server.requests[2].signatureOk, true, "重试也必须带**新鲜**的签名（时间不能复用）");
		}
	);

	// 4d. ⭐ 退避**封顶**：只测指数增长是测不到这条的 ——
	// 默认参数下 3 次尝试的最长等待只有 500ms，远低于 2000ms 的上限，
	// 于是"封顶"这段代码根本不会被执行到（变异验证正是这样抓出这个缺口的）。
	await withServer({ intercept: () => ({ status: 500, code: "InternalError" }) }, async (server, endpoint) => {
		const delays = [];
		const client = makeClient(
			mod,
			endpoint,
			{},
			{ maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 2_000, sleep: async (ms) => delays.push(ms) }
		);
		await assert.rejects(() => client.putObject("x.png", new Uint8Array([1])));
		assert.deepEqual(
			delays,
			[1_000, 2_000, 2_000, 2_000, 2_000],
			"退避应指数增长到上限后**保持在上限**，而不是无限翻倍"
		);
		assert.equal(server.countByMethod("PUT"), 6, "6 次尝试对应 6 条请求");
	});

	// ============================================================
	// 5. 网络层失败（断连）：可重试
	// ============================================================
	await withServer({ intercept: () => "drop" }, async (server, endpoint) => {
		const client = makeClient(mod, endpoint, {}, { maxAttempts: 2 });
		await assert.rejects(
			() => client.putObject("x.png", new Uint8Array([1])),
			(error) => {
				assert.equal(error.kind, "network", "连接被断开应归为网络层失败");
				assert.equal(error.status, 0, "没有响应时 status 应为 0");
				assert.equal(error.retryable, true, "网络层失败应可重试");
				return true;
			}
		);
		assert.equal(server.countByMethod("PUT"), 2, "网络层失败应重试到上限");
	});

	// ============================================================
	// 6. GET 404 不重试
	// ============================================================
	await withServer({}, async (server, endpoint) => {
		const client = makeClient(mod, endpoint);
		await assert.rejects(
			() => client.getObject("missing.png"),
			(error) => {
				assert.equal(error.kind, "notFound", "404 NoSuchKey 应归为 notFound");
				assert.equal(error.retryable, false, "404 不可重试");
				assert.equal(error.attempts, 1, "404 应只试一次");
				return true;
			}
		);
		assert.equal(server.countByMethod("GET"), 1, "404 只应发 1 次请求");
	});

	// ============================================================
	// 7. ⭐ 错误文案脱敏（用真实请求路径走一遍）
	// ============================================================
	await withServer(
		{
			// 模拟"服务端把请求回显回来"这种最坏情况
			intercept: () => ({
				status: 403,
				code: "AccessDenied",
				message: `request with secret ${CREDENTIALS.secretAccessKey} was denied`,
			}),
		},
		async (server, endpoint) => {
			const client = makeClient(mod, endpoint);
			await assert.rejects(
				() => client.putObject("x.png", new Uint8Array([1])),
				(error) => {
					assert.ok(!error.message.includes(CREDENTIALS.secretAccessKey), "错误消息里绝不能出现密钥");
					assert.ok(!error.body.includes(CREDENTIALS.secretAccessKey), "错误体里绝不能出现密钥");
					assert.ok(error.message.includes("«redacted»"), "被抹掉的位置应有可见占位符");
					assert.equal(error.hintKey, "s3HintAccessDenied", "AccessDenied 应有专属建议");
					return true;
				}
			);
		}
	);

	// ============================================================
	// 8. 传输层契约：Host 绝不手填
	// ============================================================
	await withServer({}, async (server, endpoint) => {
		const recorder = recordingTransport(nodeTransport());
		const client = makeClient(mod, endpoint, {}, { transport: recorder.transport });
		await client.putObject("host-check.png", new Uint8Array([1]));

		const outgoing = recorder.sent[0];
		assert.ok(outgoing, "应记录到一次外发请求");
		assert.ok(
			!("host" in outgoing.headers) && !("Host" in outgoing.headers),
			"⭐ 绝不能手填 Host 头：它是签名的一部分，但由 HTTP 客户端自己产生 —— 手填会与服务端实际收到的不一致"
		);
		assert.ok(outgoing.headers.authorization, "外发请求应带 Authorization");
		assert.equal(outgoing.headers["x-amz-content-sha256"]?.length, 64, "应带 64 位十六进制的载荷摘要");
		assert.equal(server.requests[0].signatureOk, true, "不手填 Host 也必须能通过验签（说明用的是 URL 里的 host）");
	});

	// ============================================================
	// 9. ⭐ 配置错误：不进重试循环，也不发请求
	// ============================================================
	{
		const sent = [];
		const transport = async (request) => {
			sent.push(request);
			throw new Error("不该走到这里：配置错误必须在发出请求之前就被拦下");
		};
		const cases = [
			{ name: "端点未配置", config: { endpoint: "" }, key: "a.png" },
			{ name: "桶名未配置", config: { bucket: "" }, key: "a.png" },
			{ name: "Access Key 未配置", config: { accessKeyId: "" }, key: "a.png" },
			{ name: "Secret 未配置", config: { secretAccessKey: "" }, key: "a.png" },
			{ name: "区域未配置", config: { region: "" }, key: "a.png" },
			{ name: "key 含穿越", config: {}, key: "../outside.png" },
			{ name: "key 为空", config: {}, key: "   " },
		];
		for (const testCase of cases) {
			const client = makeClient(mod, "http://127.0.0.1:1", testCase.config, { transport, maxAttempts: 3 });
			await assert.rejects(
				() => client.putObject(testCase.key, new Uint8Array([1])),
				(error) => {
					assert.equal(error.name, "S3Error", `${testCase.name}：应抛 S3Error`);
					assert.equal(error.kind, "client", `${testCase.name}：应归为配置问题`);
					assert.equal(error.code, "InvalidConfig", `${testCase.name}：应有可辨认的错误码`);
					assert.equal(error.retryable, false, `${testCase.name}：配置问题不可重试`);
					assert.equal(error.attempts, 1, `${testCase.name}：不应有第二次尝试`);
					return true;
				},
				testCase.name
			);
		}
		assert.equal(sent.length, 0, "配置错误时**一条请求都不该发出去**");
	}

	// ============================================================
	// 10. ⭐ "签的路径必须等于发出去的路径"这道闸门
	//
	// 单独成节、且**先断言消息**，是因为它是一道独立的防线，报错必须点明原因。
	// 为什么需要这样一条：`. ` 段不会被穿越检查拦下（它不含 `..`），
	// 却会被 URL 解析器吃掉 —— `new URL("http://h/a/./b").pathname` 是 `/a/b`。
	// 于是"签的路径"与"实际请求路径"分叉，真实症状只是 SignatureDoesNotMatch，
	// 光看报错完全想不出是 `.` 干的。
	//
	// 若这道闸门失效，故障会退化成"发出一条请求然后网络失败"，
	// 于是报错变成 `kind = network` —— 这条断言正是要抓住这种退化。
	// ============================================================
	{
		const sent = [];
		const client = makeClient(
			mod,
			"http://127.0.0.1:1",
			{},
			{
				maxAttempts: 3,
				transport: async (request) => {
					sent.push(request);
					throw new Error("不该走到这里：路径不一致必须在发出请求之前就被拦下");
				},
			}
		);
		await assert.rejects(
			() => client.putObject("a/./b.png", new Uint8Array([1])),
			(error) => {
				// ⭐ 先断言"根本没发请求"，再断言消息。
				// 这道闸门一旦失效，故障会**退化成"发出一条请求然后失败"**，
				// 于是报错变成 kind=network —— 先查请求数正好抓住这种退化，
				// 而且报出来的是一句能看懂的话（"一条请求都不该发出去"），
				// 不是"某个网络错误"。
				assert.equal(sent.length, 0, "路径不一致时一条请求都不该发出去");
				assert.ok(
					error.message.includes("路径被规范化"),
					`路径不一致时必须直接点明原因（而非退化成网络错误），实际：${error.message}`
				);
				assert.equal(error.code, "InvalidConfig", "应归为配置问题，而不是网络故障");
				assert.equal(error.retryable, false, "配置问题不可重试");
				return true;
			}
		);
		assert.equal(sent.length, 0, "路径不一致时一条请求都不该发出去");
	}

	// ============================================================
	// 11. 并发：两次上传都能成功，且服务端确实观察到并发
	// ============================================================
	await withServer({ delayMs: 60 }, async (server, endpoint) => {
		const client = makeClient(mod, endpoint);
		const [a, b] = await Promise.all([
			client.putObject("p1.png", new Uint8Array([1, 1])),
			client.putObject("p2.png", new Uint8Array([2, 2])),
		]);
		assert.equal(a.key, "/test-bucket/p1.png", "并发上传的返回值不应串台");
		assert.equal(b.key, "/test-bucket/p2.png", "并发上传的返回值不应串台");
		assert.equal(server.countByMethod("PUT"), 2, "两次上传应发出两条 PUT");
		assert.ok(server.maxConcurrent >= 2, "服务端应观察到并发（否则说明被意外串行化了）");
		assert.ok(server.stored("p1.png") && server.stored("p2.png"), "两个对象都应落库");
	});

	return { scenarios: 11 };
}
