/**
 * SigV4 模块的断言套件（正式测试与变异验证共用）。
 *
 * ## 三条 AWS 公布过的向量是这套断言的骨架
 *
 * 签名校验有个特性：SHA-256 抗碰撞，所以**签名对上 ⇔ 规范化请求逐字节正确**。
 * 于是这三条向量同时钉住了编码、排序、大小写、换行 —— 而不只是"一个十六进制串"。
 * 它们不是"我算出来存下来的"，是 AWS 公开发布过的值。
 *
 * ## 其余断言针对的是"签名对不上但看不出原因"的那些坑
 *
 * - 平台自带的 `encodeURIComponent` 不编码 `! ' ( ) *` 与 `$`（AWS 要求编码）；
 * - 查询串是**编码之后**排序；
 * - 规范化头要折叠连续空格、且每条以换行结尾（少一个换行整串就变了）；
 * - ⭐ **同一段路径只能编码一次** —— 编两次会得到 `%25E4%B8%AD`，
 *   上传能"成功"但链接打不开；这一条单独有回归断言。
 */

import assert from "node:assert/strict";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** 测试套件里的凭据（AWS 官方文档与测试套件里公开的那两组）。 */
const SUITE_CREDENTIALS = {
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
	service: "service",
	amzDate: "20150830T123600Z",
};

const DOCS_CREDENTIALS = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	region: "us-east-1",
	amzDate: "20130524T000000Z",
};

/** 组装一个合法的签名请求，只需覆盖关心的字段。 */
function requestWith(overrides) {
	return {
		method: "GET",
		path: "/",
		headers: { host: "example.amazonaws.com", "x-amz-date": SUITE_CREDENTIALS.amzDate },
		payloadHash: EMPTY_SHA256,
		...SUITE_CREDENTIALS,
		...overrides,
	};
}

export async function runSigv4Suite(mod) {
	const {
		uriEncode,
		encodePath,
		canonicalQueryString,
		canonicalHeaders,
		formatAmzDate,
		credentialScope,
		buildCanonicalRequest,
		buildStringToSign,
		deriveSigningKey,
		signRequest,
		payloadHashOf,
		SIGV4_ALGORITHM,
		S3_SERVICE,
	} = mod;

	// ============================================================
	// 1. ⭐ AWS 公布过的向量
	// ============================================================
	assert.equal(SIGV4_ALGORITHM, "AWS4-HMAC-SHA256", "算法串必须逐字正确");
	assert.equal(S3_SERVICE, "s3", "S3 的服务名必须是 s3");

	// 1a. aws-sig-v4-test-suite 的 get-vanilla
	//
	// ⚠️ 断言顺序是刻意的：先看 canonical request 的**形状**，再看 string to sign，
	// 最后才看签名。反过来的话，任何一处规范化出错都会先在"签名不对"上失败，
	// 而那句话完全不说明哪里错了 —— 变异验证的"原因必须相符"就无从谈起。
	const vanilla = await signRequest(requestWith({}));
	assert.equal(
		vanilla.canonicalRequest,
		["GET", "/", "", "host:example.amazonaws.com", "x-amz-date:20150830T123600Z", "", "host;x-amz-date", EMPTY_SHA256].join("\n"),
		"canonical request 的形状（含空行位置）必须与规范一致"
	);
	assert.equal(
		vanilla.stringToSign,
		[
			"AWS4-HMAC-SHA256",
			"20150830T123600Z",
			"20150830/us-east-1/service/aws4_request",
			"bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
		].join("\n"),
		"string to sign 必须由算法、时间、作用域、规范化请求摘要四行组成"
	);
	assert.equal(
		vanilla.signature,
		"5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
		"get-vanilla 的签名应与 AWS 测试套件公布值一致"
	);

	// 1b. get-vanilla-query-order-key-case —— 查询串编码后排序
	const ordered = await signRequest(requestWith({ query: { Param2: "value2", Param1: "value1" } }));
	assert.ok(
		ordered.canonicalRequest.includes("\nParam1=value1&Param2=value2\n"),
		"查询参数必须按名字排序（这是那条用例的全部意义）"
	);
	assert.equal(
		ordered.signature,
		"b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
		"get-vanilla-query-order-key-case 的签名应与 AWS 测试套件公布值一致"
	);

	// 1c. S3 文档的 GET Object 示例（service=s3、含 Range 与 x-amz-content-sha256）
	const docsGet = await signRequest({
		method: "GET",
		path: "/test.txt",
		headers: {
			host: "examplebucket.s3.amazonaws.com",
			range: "bytes=0-9",
			"x-amz-content-sha256": EMPTY_SHA256,
			"x-amz-date": DOCS_CREDENTIALS.amzDate,
		},
		payloadHash: EMPTY_SHA256,
		...DOCS_CREDENTIALS,
		service: "s3",
	});
	assert.equal(docsGet.scope, "20130524/us-east-1/s3/aws4_request", "作用域必须是 日期/区域/服务/aws4_request");
	assert.equal(
		docsGet.signature,
		"f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		"S3 文档 GET Object 示例的签名应与 AWS 公布值一致"
	);

	// ============================================================
	// 2. uriEncode：按规范**穷举** ASCII
	//
	// 不写"几个例子"，而是从 RFC 3986 的 unreserved 集直接生成整张表。
	// 这样 0x00–0x7F 每一个字节的期望值都是**由规则推出来的**，
	// 而不是从实现里抄出来的。
	// ============================================================
	const isUnreserved = (code) =>
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2d || // -
		code === 0x5f || // _
		code === 0x2e || // .
		code === 0x7e; // ~

	for (let code = 0x00; code <= 0x7f; code += 1) {
		const character = String.fromCharCode(code);
		const expected = isUnreserved(code) ? character : `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
		assert.equal(uriEncode(character), expected, `uriEncode 对字节 0x${code.toString(16)} 的结果不符合规则`);
	}

	// 平台自带编码的那几个偏差，单独点出来（它们的症状是"签名莫名不匹配"）
	assert.equal(uriEncode("!"), "%21", "! 必须编码（encodeURIComponent 不会编）");
	assert.equal(uriEncode("'"), "%27", "' 必须编码");
	assert.equal(uriEncode("("), "%28", "( 必须编码");
	assert.equal(uriEncode(")"), "%29", ") 必须编码");
	assert.equal(uriEncode("*"), "%2A", "* 必须编码");
	assert.equal(uriEncode("$"), "%24", "S3 文档里 $ 必须编成 %24（文件名里很常见）");
	assert.equal(uriEncode("~"), "~", "~ 必须保留（较老的 encodeURIComponent 会编码它）");
	assert.equal(uriEncode(" "), "%20", "空格必须编成 %20，不能编成 +");
	assert.equal(uriEncode("/"), "%2F", "单独调用时 / 也要编码（路径级调用由 encodePath 保留它）");

	// 非 ASCII 必须按 **UTF-8 字节**编码，而不是 UTF-16 码元
	assert.equal(uriEncode("中"), "%E4%B8%AD", "「中」必须先 UTF-8 再编码，结果是 %E4%B8%AD");
	assert.equal(uriEncode("日"), "%E6%97%A5", "「日」应是 %E6%97%A5");
	assert.equal(uriEncode("😀"), "%F0%9F%98%80", "4 字节的 emoji 也必须正确处理");
	assert.equal(uriEncode("a中b"), "a%E4%B8%ADb", "混排时只编码需要编的那些字节");

	// ============================================================
	// 3. encodePath：/ 保留、逐段编码、补前导斜杠
	// ============================================================
	assert.equal(encodePath(""), "/", "空路径按规范应写成 /");
	assert.equal(encodePath("/"), "/", "只有斜杠时保持 /");
	assert.equal(encodePath("a/b.png"), "/a/b.png", "普通 key 补上前导斜杠");
	assert.equal(encodePath("/a/b.png"), "/a/b.png", "已有前导斜杠不应重复补");
	assert.equal(encodePath("a/中文 名.png"), "/a/%E4%B8%AD%E6%96%87%20%E5%90%8D.png", "逐段编码，/ 保留");
	assert.equal(encodePath("test$file.text"), "/test%24file.text", "S3 文档里的文件名用例");
	assert.equal(encodePath("a\nb.png"), "/a%0Ab.png", "换行也必须编码（否则请求行会被截断）");
	assert.equal(encodePath("a\\b.png"), "/a%5Cb.png", "反斜杠是**数据**不是分隔符，应被编码而非改写");

	// ⭐ 忠实编码：编码结果里不允许出现 %25（那是"对已编码串再编一次"的痕迹）
	for (const sample of ["a/b.png", "中文 名.png", "test$file.text", "a\\b.png", "x~y-z_w.v"]) {
		const once = encodePath(sample);
		assert.ok(!once.includes("%25"), `encodePath 不得产生二次编码：${sample} → ${once}`);
		// 把"为什么这是危险的"演示清楚：只要第一次编码产生了 `%`，
		// 再编一次就必然出现 `%25`。所以签名里一旦出现 `%25`，
		// 就等于盖章说明"这段路径被编码了两次"。
		//
		// ⚠️ 这里必须加条件：全部由 unreserved 组成的路径（如 `x~y-z_w.v`）
		// 第一次编码后不含 `%`，再编一次自然也不会出现 `%25` ——
		// 无条件断言会变成一个"其实不成立"的断言。
		if (once.includes("%")) {
			assert.ok(
				encodePath(once).includes("%25"),
				"对含 % 的已编码串再编一次必然出现 %25 —— 这正是双重编码的判别特征"
			);
		}
	}
	assert.equal(encodePath("x~y-z_w.v"), "/x~y-z_w.v", "全部由 unreserved 组成的路径编码后不应变化");

	// ============================================================
	// 4. canonicalQueryString
	// ============================================================
	assert.equal(canonicalQueryString(), "", "没有查询参数时是空串（仍占一行）");
	assert.equal(canonicalQueryString({}), "", "空对象同样");
	assert.equal(canonicalQueryString({ acl: "" }), "acl=", "子资源是 name= 空值，等号不能省");
	assert.equal(canonicalQueryString({ b: "2", a: "1" }), "a=1&b=2", "按名字排序");
	assert.equal(canonicalQueryString({ "max-keys": "2", prefix: "J" }), "max-keys=2&prefix=J", "名字里的连字符保留");
	// 编码发生在排序之前：`!` 编成 `%21` 后要排在字母前
	assert.equal(canonicalQueryString({ A: "1", "!": "2" }), "%21=2&A=1", "排序必须在编码之后进行");
	assert.equal(canonicalQueryString({ "a b": "c d" }), "a%20b=c%20d", "名字与值都要编码");
	assert.equal(canonicalQueryString({ k: "a~b" }), "k=a~b", "~ 在值里也要保留");

	// ============================================================
	// 5. canonicalHeaders
	// ============================================================
	const headers = canonicalHeaders({
		"X-Amz-Date": "20150830T123600Z",
		Host: "example.amazonaws.com",
		"Content-Type": "image/png",
	});
	assert.equal(
		headers.canonical,
		"content-type:image/png\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n",
		"头名要小写、按名排序、每条以换行结尾"
	);
	assert.equal(headers.signedHeaders, "content-type;host;x-amz-date", "SignedHeaders 以分号连接且同序");

	// 值的处理：去首尾空白 + 连续空白折成一个空格
	assert.equal(
		canonicalHeaders({ "x-test": "  a   b\tc  " }).canonical,
		"x-test:a b c\n",
		"头的值要去首尾空白并把连续空白折成一个空格"
	);
	assert.equal(canonicalHeaders({}).canonical, "", "没有头时是空串");
	assert.equal(canonicalHeaders({ "  ": "x" }).canonical, "", "只有空白的头名应被丢弃，不能产生 ':x' 这种行");

	// ============================================================
	// 6. 时间与作用域
	// ============================================================
	assert.deepEqual(
		formatAmzDate(new Date("2015-08-30T12:36:00Z")),
		{ amzDate: "20150830T123600Z", dateStamp: "20150830" },
		"时间格式必须是 YYYYMMDDTHHmmssZ"
	);
	// 必须用 UTC：本地时区若参与，签名会随使用者所在时区漂移。
	//
	// ⚠️ 如实标注这条断言的**验证范围**：它只在"本机时区不是 UTC"时才能
	// 分辨 UTC 与本地时间（本机是 UTC+8，所以这里确实分辨得出）。
	// 若在 TZ=UTC 的环境里跑，两种实现的行为**在数学上不可区分** ——
	// 那时任何断言都抓不住，这是环境限制而不是断言不够强。
	// 所以变异验证里没有放"把 UTC 改成本地时间"这条变异：
	// 它会变成环境相关的假警报。改用与 TZ 无关的"日期切片错位"替代。
	assert.deepEqual(
		formatAmzDate(new Date("2026-01-05T23:59:59Z")),
		{ amzDate: "20260105T235959Z", dateStamp: "20260105" },
		"跨时区/跨月边界必须按 UTC 计算"
	);
	assert.deepEqual(
		formatAmzDate(new Date("2026-10-05T00:00:00Z")),
		{ amzDate: "20261005T000000Z", dateStamp: "20261005" },
		"午夜要补零而不是留空"
	);
	// 格式化结果按 UTC 解析回来必须等于原时刻（秒级），这条与宿主时区无关，
	// 且能抓住"日期字段切片错位"这类错误。
	for (const iso of [
		"1970-01-01T00:00:00Z",
		"2015-08-30T12:36:00Z",
		"2026-01-05T23:59:59Z",
		"2026-06-15T07:08:09Z",
		"2038-01-19T03:14:07Z",
	]) {
		const date = new Date(iso);
		const { amzDate } = formatAmzDate(date);
		const reparsed = Date.UTC(
			Number(amzDate.slice(0, 4)),
			Number(amzDate.slice(4, 6)) - 1,
			Number(amzDate.slice(6, 8)),
			Number(amzDate.slice(9, 11)),
			Number(amzDate.slice(11, 13)),
			Number(amzDate.slice(13, 15))
		);
		assert.equal(reparsed, Math.floor(date.getTime() / 1000) * 1000, `时间戳 ${iso} 的格式化结果应能按 UTC 还原`);
		assert.match(amzDate, /^\d{8}T\d{6}Z$/, `时间戳 ${iso} 的格式应为 8 位日期 + T + 6 位时间 + Z`);
	}
	assert.equal(credentialScope("20150830", "us-east-1", "s3"), "20150830/us-east-1/s3/aws4_request", "作用域格式");
	assert.equal(credentialScope("20150830", "auto"), "20150830/auto/s3/aws4_request", "默认服务名应为 s3");

	// 签名密钥必须是 32 字节（HMAC-SHA256 的输出），且分四步推导
	const signingKey = await deriveSigningKey("secret", "20150830", "us-east-1", "s3");
	assert.equal(signingKey.length, 32, "签名密钥应是 32 字节");
	assert.notEqual(
		Buffer.from(signingKey).toString("hex"),
		Buffer.from(await deriveSigningKey("secret", "20150830", "us-east-1", "service")).toString("hex"),
		"服务名必须参与密钥推导（换成 service 必然得到不同密钥）"
	);
	assert.notEqual(
		Buffer.from(signingKey).toString("hex"),
		Buffer.from(await deriveSigningKey("secret", "20150831", "us-east-1", "s3")).toString("hex"),
		"日期必须参与密钥推导"
	);

	// ============================================================
	// 7. ⭐ 双重编码回归
	//
	// 这是本项目 P0 验收标准里"非 ASCII 文件名不双重编码"那一条的守门人。
	// 触发过一次真实缺陷：客户端传了**已编码**的路径，而签名层又编了一次，
	// 于是链接与签名都成了 %25E4%B8%AD…。
	// ============================================================
	const encodedPath = encodePath("dir/中文 名.png");
	assert.equal(encodedPath, "/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png", "前置条件：encodePath 的结果");

	const signed = await signRequest(
		requestWith({ path: encodedPath, headers: { host: "example.amazonaws.com", "x-amz-date": SUITE_CREDENTIALS.amzDate } })
	);
	// 先查"有没有二次编码的痕迹"，再查逐字节相等：前者的报错更直接点出原因
	assert.ok(
		!signed.canonicalRequest.includes("%25"),
		"canonical request 里不得出现 %25 —— 那是二次编码的痕迹"
	);
	assert.ok(
		!signed.stringToSign.includes("%25"),
		"string to sign 里不得出现 %25（同一段路径只应被编码一次）"
	);
	const pathLine = signed.canonicalRequest.split("\n")[1];
	assert.equal(pathLine, "/dir/%E4%B8%AD%E6%96%87%20%E5%90%8D.png", "规范化 URI 必须与传入的已编码路径逐字节相同");

	// 反过来：传**未编码**的路径必须被拒绝，而不是静默产生一个错签名。
	// 这是把"约定"变成"闸门"的地方：静默错签名的症状只是 SignatureDoesNotMatch，
	// 从错误信息里根本看不出是"少编码了"还是"多编码了"。
	for (const raw of ["/dir/中文 名.png", "/a b.png", "/a$b.png", "/a%zz.png"]) {
		await assert.rejects(
			() => signRequest(requestWith({ path: raw })),
			/path 必须是\*\*已编码\*\*的规范化 URI/,
			`未编码的路径必须被拒绝：${raw}`
		);
	}

	// ============================================================
	// 8. Authorization 头的形状
	// ============================================================
	assert.match(
		vanilla.authorization,
		/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
		"Authorization 头必须严格是这个形状（多一个空格都会被服务端拒）"
	);
	assert.equal(vanilla.signedHeaders, "host;x-amz-date", "SignedHeaders 应与实际签的头一致");
	assert.equal(vanilla.payloadHash, EMPTY_SHA256, "无载荷时载荷摘要应是空串的 SHA-256");
	assert.equal(await payloadHashOf(""), EMPTY_SHA256, "payloadHashOf('') 应是空串摘要");
	assert.equal(
		await payloadHashOf("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		"payloadHashOf 应按 UTF-8 算摘要"
	);

	// 载荷摘要不同 → 签名必然不同（否则 PUT 的内容可以被掉包）
	const otherPayload = await signRequest(requestWith({ payloadHash: await payloadHashOf("x") }));
	assert.notEqual(otherPayload.signature, vanilla.signature, "载荷摘要变了签名必须跟着变");

	// 方法不同 → 签名不同
	const post = await signRequest(requestWith({ method: "POST" }));
	assert.notEqual(post.signature, vanilla.signature, "HTTP 方法参与签名");

	// 头的顺序不影响签名（规范化会排序）
	const shuffled = await signRequest(
		requestWith({ headers: { "x-amz-date": SUITE_CREDENTIALS.amzDate, host: "example.amazonaws.com" } })
	);
	assert.equal(shuffled.signature, vanilla.signature, "头的书写顺序不应影响签名（规范会排序）");

	// 头名大小写不影响签名
	const mixedCase = await signRequest(
		requestWith({ headers: { Host: "example.amazonaws.com", "X-Amz-Date": SUITE_CREDENTIALS.amzDate } })
	);
	assert.equal(mixedCase.signature, vanilla.signature, "头名大小写不应影响签名");

	// buildStringToSign 的参数顺序：算法 / 时间 / 作用域 / 摘要
	assert.equal(
		buildStringToSign("20150830T123600Z", "20150830/us-east-1/s3/aws4_request", "deadbeef"),
		"AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/s3/aws4_request\ndeadbeef",
		"string to sign 的四行顺序必须与规范一致，且不以换行结尾"
	);

	// buildCanonicalRequest 的组成部分应当能被逐行辨认
	const lines = buildCanonicalRequest(
		requestWith({ method: "put", query: { z: "1" }, headers: { host: "h" } })
	).split("\n");
	assert.equal(lines[0], "PUT", "方法应当大写");
	assert.equal(lines[1], "/", "第二行是规范化 URI");
	assert.equal(lines[2], "z=1", "第三行是规范化查询串");
	assert.equal(lines[3], "host:h", "第四行起是规范化头");
	assert.equal(lines[4], "", "规范化头结束后必须有一行空行");
	assert.equal(lines[5], "host", "然后才是 SignedHeaders");
	assert.equal(lines[6], EMPTY_SHA256, "最后一行是载荷摘要");

	return { officialVectors: 3, asciiBytes: 128 };
}
