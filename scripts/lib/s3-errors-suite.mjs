/**
 * S3 错误模块的断言套件（正式测试与变异验证共用）。
 *
 * 这套断言守两件事，都关系到"用户能不能自己搞定问题"：
 *
 * 1. **重试判据必须是白名单。** 该重试的不重试 → 用户以为插件坏了；
 *    不该重试的重试 → 把"改一下设置"变成"卡几秒然后还是失败"，限流时还火上浇油。
 * 2. **错误文案里绝不能出现密钥。** 错误会进 Notice、日志、issue 截图与
 *    别人的聊天窗口。服务端"正常不含"密钥不足以作依据（自建 MinIO、
 *    中间代理、配置错误都可能把请求回显），所以这里断言的是**无条件脱敏**。
 */

import assert from "node:assert/strict";

export function runS3ErrorsSuite(mod) {
	const {
		S3Error,
		classify,
		isRetryable,
		isSuccess,
		parseS3ErrorBody,
		redactSecrets,
		networkError,
		responseError,
	} = mod;

	// ============================================================
	// 1. 成功判定：只有 2xx
	// ============================================================
	for (const status of [200, 201, 204, 206, 299]) {
		assert.equal(isSuccess(status), true, `${status} 应算成功`);
	}
	for (const status of [199, 300, 301, 302, 304, 307, 400, 403, 404, 500]) {
		assert.equal(isSuccess(status), false, `${status} 不得算成功`);
	}
	// 3xx 单独再钉一条：S3 的 3xx 通常意味着端点配错（区域不对、桶名该放子域），
	// 拿它当成功会让上层记下一条**指向错误位置**的 URL —— 比直接报错难查得多。
	assert.equal(isSuccess(301), false, "3xx 不得算成功（跟随重定向会让签名失效）");

	// ============================================================
	// 2. 性质分类
	// ============================================================
	assert.equal(classify(0, ""), "network", "没有响应就是网络层失败");
	assert.equal(classify(401, ""), "auth", "401 应归类为 auth");
	assert.equal(classify(403, ""), "auth", "403 应归类为 auth");
	assert.equal(classify(404, ""), "notFound", "404 应归类为 notFound");
	assert.equal(classify(403, "NoSuchKey"), "notFound", "NoSuchKey 即使带 403 也是 notFound");
	assert.equal(classify(404, "NoSuchBucket"), "notFound", "NoSuchBucket 是 notFound");
	assert.equal(classify(429, ""), "throttled", "429 应归类为限流");
	assert.equal(classify(503, "SlowDown"), "throttled", "SlowDown 应按限流处理");
	assert.equal(classify(500, ""), "server", "500 应归类为服务端故障");
	assert.equal(classify(503, ""), "server", "503 应归类为服务端故障");
	assert.equal(classify(400, ""), "client", "400 应归类为请求本身有问题");
	assert.equal(classify(409, ""), "client", "409 同样");
	assert.equal(classify(200, ""), "unknown", "非错误状态归入兜底（不该被当错误用）");

	// ============================================================
	// 3. ⭐ 重试判据（白名单）
	// ============================================================
	assert.equal(isRetryable("network", 0, ""), true, "网络层失败应可重试");
	assert.equal(isRetryable("throttled", 429, ""), true, "限流可重试");
	assert.equal(isRetryable("server", 500, ""), true, "服务端故障可重试");
	assert.equal(isRetryable("server", 503, ""), true, "503 可重试");
	assert.equal(isRetryable("client", 408, ""), true, "408 请求超时可重试");
	assert.equal(isRetryable("auth", 429, ""), true, "429 即使被归到别的性质也应可重试");

	// ⭐ 4xx 一律不重试 —— 这条单独钉，因为它是"白名单"承诺的核心
	for (const status of [400, 401, 403, 404, 405, 409, 412, 422]) {
		for (const kind of ["auth", "notFound", "client", "unknown"]) {
			assert.equal(
				isRetryable(kind, status, ""),
				false,
				`4xx（${status}）一律不可重试，无论性质是 ${kind}`
			);
		}
	}
	// 501 NotImplemented 是确定性的：服务端没这个能力，重试多少次都一样
	assert.equal(isRetryable("server", 501, ""), false, "501 不可重试（服务端没实现，重试无意义）");
	assert.equal(isRetryable("server", 500, "NotImplemented"), false, "NotImplemented 不可重试");
	assert.equal(isRetryable("unknown", 200, ""), false, "兜底情况默认**不**重试（偏保守）");

	// ============================================================
	// 4. 错误体解析
	// ============================================================
	const signatureXml =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		"<Error><Code>SignatureDoesNotMatch</Code>" +
		"<Message>The request signature we calculated does not match.</Message>" +
		"<AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId>" +
		"<StringToSign>AWS4-HMAC-SHA256...</StringToSign>" +
		"<RequestId>656c76696e6727732072657175657374</RequestId>" +
		"<HostId>host</HostId></Error>";
	const parsed = parseS3ErrorBody(signatureXml);
	assert.equal(parsed.code, "SignatureDoesNotMatch", "应解析出 Code");
	assert.equal(parsed.message, "The request signature we calculated does not match.", "应解析出 Message");
	assert.equal(parsed.requestId, "656c76696e6727732072657175657374", "应解析出 RequestId");

	// 标签里的 XML 实体要还原，否则文案会显示成 &quot; 之类
	assert.equal(
		parseS3ErrorBody("<Error><Code>X</Code><Message>a &lt;b&gt; &amp; c &quot;d&quot;</Message></Error>").message,
		'a <b> & c "d"',
		"错误文案里的 XML 实体应当被还原"
	);
	assert.equal(
		parseS3ErrorBody("<Error><Code>X</Code><Message>it&apos;s</Message></Error>").message,
		"it's",
		"&apos; 也应还原"
	);

	// 反代返回 HTML 错误页 / 纯文本时不该崩，也不该编造字段
	const html = "<html><body><h1>502 Bad Gateway</h1></body></html>";
	assert.equal(parseS3ErrorBody(html).code, "", "HTML 错误页解析不出 Code，应为空串");
	assert.equal(parseS3ErrorBody("").message, "", "空体应得到空字段");
	assert.equal(parseS3ErrorBody(undefined).code, "", "undefined 也不该抛错");
	// RequestId 的大小写写法两种都要认
	assert.equal(
		parseS3ErrorBody("<Error><RequestID>abc</RequestID></Error>").requestId,
		"abc",
		"RequestID（全大写 D）也要认"
	);

	// ============================================================
	// 5. ⭐ 脱敏
	// ============================================================
	const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
	assert.equal(
		redactSecrets(`Authorization: ... ${secret} ...`, [secret]),
		"Authorization: ... «redacted» ...",
		"密钥应被替换成占位符"
	);
	assert.equal(redactSecrets("nothing to hide", [secret]), "nothing to hide", "没有密钥时不应改动文案");
	assert.equal(redactSecrets(`x ${secret} y ${secret} z`, [secret]), "x «redacted» y «redacted» z", "多处出现应全部替换");
	assert.equal(redactSecrets("abc", [""]), "abc", "空密钥不得参与替换（否则每个位置都会被替掉）");
	assert.equal(redactSecrets("abc", []), "abc", "没有密钥清单时原样返回");
	assert.equal(redactSecrets(`a${secret}b`, [secret, "other"]), "a«redacted»b", "多个密钥都要处理");

	// 端到端：把密钥塞进消息与响应体，出来必须一处都不剩
	const leaky = new S3Error({
		kind: "auth",
		status: 403,
		code: "SignatureDoesNotMatch",
		message: `server echoed ${secret}`,
		requestId: "r1",
		operation: "PUT",
		key: "a.png",
		attempts: 1,
		secrets: [secret],
		body: `<StringToSign>...${secret}...</StringToSign>`,
	});
	assert.ok(!leaky.message.includes(secret), "错误消息里不得出现密钥");
	assert.ok(!leaky.body.includes(secret), "错误体里不得出现密钥");
	assert.ok(leaky.message.includes("«redacted»"), "被抹掉的位置应有可见的占位符");
	assert.ok(leaky.body.includes("«redacted»"), "错误体里的占位符同样要可见");
	// 密钥是长随机串，取前 8 位做子串检查也要过 —— 防"只替换了一部分"
	assert.ok(!leaky.message.includes(secret.slice(0, 8)), "不得残留密钥的前缀");

	// ============================================================
	// 6. S3Error 的字段
	// ============================================================
	assert.ok(leaky instanceof S3Error, "S3Error 必须能被 instanceof 认出（交叉 bundle 时容易失效）");
	assert.equal(leaky.name, "S3Error", "错误名应便于日志检索");
	assert.equal(leaky.kind, "auth", "kind 应来自构造参数");
	assert.equal(leaky.status, 403, "status 应保留");
	assert.equal(leaky.code, "SignatureDoesNotMatch", "code 应保留");
	assert.equal(leaky.requestId, "r1", "requestId 应保留（找云厂商客服时唯一有用的东西）");
	assert.equal(leaky.retryable, false, "403 不可重试");
	assert.equal(leaky.attempts, 1, "attempts 应保留");
	assert.equal(leaky.hintKey, "s3HintSignature", "SignatureDoesNotMatch 应给出针对性的建议键");
	assert.ok(/^PUT \[a\.png\] → HTTP 403/.test(leaky.message), `消息应以 方法 [key] → 状态开头，实际：${leaky.message}`);

	assert.equal(
		new S3Error({ kind: "notFound", status: 404, code: "NoSuchBucket", message: "m", requestId: "", operation: "GET", key: "", attempts: 1 }).hintKey,
		"s3HintNoSuchBucket",
		"NoSuchBucket 应有专属建议键"
	);
	assert.equal(
		new S3Error({ kind: "auth", status: 403, code: "AccessDenied", message: "m", requestId: "", operation: "PUT", key: "", attempts: 1 }).hintKey,
		"s3HintAccessDenied",
		"AccessDenied 应有专属建议键"
	);
	assert.equal(
		new S3Error({ kind: "network", status: 0, code: "", message: "m", requestId: "", operation: "PUT", key: "", attempts: 1 }).hintKey,
		"s3HintNetwork",
		"网络层失败应有专属建议键"
	);
	assert.ok(
		new S3Error({ kind: "client", status: 400, code: "Weird", message: "m", requestId: "", operation: "PUT", key: "", attempts: 1 }).hintKey.startsWith("s3Hint"),
		"任何情况都要给出一个可翻译的建议键（UI 不能拿到空串）"
	);

	// attempts > 1 时消息里要体现重试过
	const retried = new S3Error({
		kind: "server",
		status: 503,
		code: "ServiceUnavailable",
		message: "m",
		requestId: "",
		operation: "PUT",
		key: "a.png",
		attempts: 3,
	});
	assert.ok(retried.message.includes("after 3 attempts"), "重试过要在消息里体现（否则看不出是网络抖动）");
	assert.equal(retried.retryable, true, "503 可重试");

	// 消息应被截断，且截断要**看得见**
	const longBody = "x".repeat(5000);
	const truncated = new S3Error({
		kind: "server",
		status: 500,
		code: "",
		message: longBody,
		requestId: "",
		operation: "PUT",
		key: "a.png",
		attempts: 1,
	});
	assert.ok(truncated.message.length < 600, "过长的消息应被截断，避免刷屏");
	assert.ok(truncated.message.includes("已截断"), "截断必须明确标出，否则会被误读成『响应体就这么长』");

	// ============================================================
	// 7. 两个构造入口
	// ============================================================
	const fromNetwork = networkError({
		error: Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }),
		operation: "PUT",
		key: "a.png",
		attempts: 2,
	});
	assert.equal(fromNetwork.kind, "network", "传输层抛错应归为 network");
	assert.equal(fromNetwork.status, 0, "没有响应时 status 应为 0");
	assert.equal(fromNetwork.code, "ECONNREFUSED", "应保留底层错误码");
	assert.equal(fromNetwork.retryable, true, "网络层失败应可重试");
	assert.ok(fromNetwork.message.includes("no response"), "消息里应标明没有响应");
	assert.ok(fromNetwork.message.includes("ECONNREFUSED"), "消息里应带上底层错误码");

	// 抛出的不是 Error（比如被 reject 了字符串）也不能崩
	const weird = networkError({ error: "boom", operation: "PUT", key: "a.png", attempts: 1 });
	assert.equal(weird.kind, "network", "非 Error 的抛出物同样归为 network");
	assert.ok(weird.message.includes("boom"), "非 Error 的信息应被字符串化后保留");

	// ⭐ 被抛出来的东西可能是**任何值**（`throw {}` 是合法的 JS，某些库也这么干），
	// 而 `String({})` 会得到 `"[object Object]"` —— 那句话进了提示就是纯噪音，
	// 还把真正的原因盖掉。所以这里逐个验证"绝不出现 [object Object]"。
	const thrownCases = [
		{ label: "带 message 的对象", error: { message: "custom failure" }, expect: "custom failure" },
		{ label: "数字", error: 500, expect: "500" },
		{ label: "布尔", error: false, expect: "false" },
		{ label: "bigint", error: 10n, expect: "10" },
		{ label: "Symbol", error: Symbol("sym"), expect: "sym" },
	];
	for (const testCase of thrownCases) {
		const converted = networkError({
			error: testCase.error,
			operation: "PUT",
			key: "a.png",
			attempts: 1,
		});
		// 先查"有没有噪音"，再查"有没有保留信息" —— 前者才是这条规则的要害，
		// 而且报出来的是"出现了 [object Object]"，比"没保留住 custom failure"更点题
		assert.ok(
			!converted.message.includes("[object Object]"),
			`抛出的${testCase.label}不得被兜成 [object Object]：${converted.message}`
		);
		assert.ok(
			converted.message.includes(testCase.expect),
			`抛出的${testCase.label}应被保留（期望含「${testCase.expect}」），实际：${converted.message}`
		);
	}

	// 没有 message 的对象 / 数组 / 循环引用：都不该变成 [object Object]
	const circular = { name: "oops" };
	circular.self = circular;
	for (const [label, value] of [
		["无 message 的对象", { code: 42 }],
		["数组", [1, 2]],
		["循环引用对象", circular],
	]) {
		const converted = networkError({ error: value, operation: "PUT", key: "a.png", attempts: 1 });
		assert.ok(
			!converted.message.includes("[object Object]"),
			`抛出的${label}不得被兜成 [object Object]：${converted.message}`
		);
		assert.ok(
			converted.message.length > "PUT [a.png] → no response : ".length,
			`抛出的${label}应至少给出一点信息，而不是空尾巴：${converted.message}`
		);
	}

	// 无信息的抛出物（null / undefined）应得到一句**明确**的默认文案，而不是空串
	for (const nothing of [null, undefined]) {
		const converted = networkError({ error: nothing, operation: "PUT", key: "a.png", attempts: 1 });
		assert.ok(
			converted.message.includes("请求未能发出或未收到响应"),
			`抛出 ${nothing} 时应给出明确的默认说明，实际：${converted.message}`
		);
	}

	const fromResponse = responseError({
		status: 404,
		body: "<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><RequestId>r2</RequestId></Error>",
		operation: "GET",
		key: "missing.png",
		attempts: 1,
	});
	assert.equal(fromResponse.kind, "notFound", "404 NoSuchKey 应为 notFound");
	assert.equal(fromResponse.code, "NoSuchKey", "应带上错误码");
	assert.equal(fromResponse.requestId, "r2", "应带上 requestId");
	assert.equal(fromResponse.retryable, false, "404 不可重试");
	assert.ok(fromResponse.message.includes("does not exist"), "应使用服务端给的描述");

	// 服务端没给 Message 时，用原文兜底（不能变成空话）
	const noMessage = responseError({
		status: 502,
		body: "<html>Bad Gateway</html>",
		operation: "PUT",
		key: "a.png",
		attempts: 1,
	});
	assert.ok(noMessage.message.includes("Bad Gateway"), "没有 Message 时应把原文带出来");
	assert.equal(noMessage.retryable, true, "502 可重试");

	// 凭据也要能通过构造入口传进来脱敏
	const withSecrets = responseError({
		status: 403,
		body: `<Error><Code>AccessDenied</Code><Message>key ${secret} denied</Message></Error>`,
		operation: "PUT",
		key: "a.png",
		attempts: 1,
		secrets: [secret],
	});
	assert.ok(!withSecrets.message.includes(secret), "responseError 也要脱敏");
	assert.ok(!withSecrets.body.includes(secret), "responseError 的错误体也要脱敏");

	return { retryableCases: 4 + 8 * 4 + 3 };
}
