import { runMutations } from "./lib/mutate.mjs";
import { runS3ClientSuite } from "./lib/s3-client-suite.mjs";

/**
 * 变异验证：S3 客户端。
 *
 * 每一条都对应 SCOPE 里写死的一条 P0 验收标准，或一个"踩了很难查"的坑：
 * 逐字节一致、签名路径含桶名、不手填 Host、凭据错不重试、5xx 重试到上限、
 * 配置错不发请求、公开 URL 只编码一次、错误文案不含密钥。
 *
 * ⚠️ 这套会**真的起 HTTP 服务**并跑完整套件，所以比纯逻辑那几套慢。
 * 这是刻意的：只有真实请求计数才能证明"恰好 1 次 PUT"，而那是本套件最主要的产出。
 *
 * ## `expect` 是怎么定的
 *
 * 不是"应该会报那句"，而是把本轮实测**真正先红的那条断言**写进来。
 * 第一版有 8 条原因不符，逐条查清后修正了断言的顺序与位置 ——
 * 其中两条（退避封顶、`.` 段闸门）是真缺口，靠补断言才真正有牙。
 */
await runMutations({
	source: "src/s3/client.ts",
	suite: runS3ClientSuite,
	mutations: [
		{
			// ⚠️ 只改 `path`、不改 `url`：这时"签的路径"与"实际请求路径"分叉，
			// 会被 `assertPathPreserved` 先拦下。所以这一条真正检验的是**那道闸门**，
			// 而不是某个地址形状断言 —— 报错原因也正是"路径被规范化了"。
			name: "签名路径漏掉桶名（url 仍带桶名 → 靠一致性闸门拦下）",
			from: "path: `/${encodedBucket}/${encodedKey}`,",
			to: "path: `/${encodedKey}`,",
			expect: "路径被规范化",
		},
		{
			// 与上一条配对：url 与 path 一起漏掉桶名，一致性闸门就看不出来了
			// （两者自洽），于是由"默认必须是 path-style"这条断言拦下。
			//
			// ⚠️ 它与下面"判定反了"那条**共用同一个失败原因**，这是如实记录、不是偷懒：
			// 在"默认寻址"这个观察点上，"桶名没进路径"这件事对两种缺陷都成立，
			// 无法区分。要点在于两者都被抓住了，且原因确实指向寻址方式。
			name: "url 与签名路径一起去掉桶名（自洽的错误，闸门看不见）",
			from:
				"\tconst target = {\n\t\turl: `${endpoint}/${encodedBucket}/${encodedKey}`,\n\t\t// ⚠️ 桶名在路径里 —— 少写它会得到 SignatureDoesNotMatch，而且在本地 mock 上\n\t\t// 反而可能\"通过\"（如果 mock 不校验路径的话）。所以这里和 URL 同源生成。\n\t\tpath: `/${encodedBucket}/${encodedKey}`,\n\t};",
			to: "\tconst target = {\n\t\turl: `${endpoint}/${encodedKey}`,\n\t\tpath: `/${encodedKey}`,\n\t};",
			expect: "必须走 path-style",
		},
		{
			name: "forcePathStyle 判定反了（默认变成 virtual-host，R2 直接用不了）",
			from: "if (address.forcePathStyle === false) {",
			to: "if (address.forcePathStyle !== false) {",
			expect: "必须走 path-style",
		},
		{
			name: "逻辑 key 不再 trim（同一张图会变成桶里两个对象）",
			from: 'return String(key ?? "")\n\t\t.trim()\n\t\t.replace(/^\\/+/, "");',
			to: 'return String(key ?? "")\n\t\t.replace(/^\\/+/, "");',
			expect: "必须归一到同一个地址",
		},
		{
			name: "逻辑 key 不再归并前导斜杠（空路径段让同一 key 指向另一个对象）",
			from: '.replace(/^\\/+/, "");',
			to: ';',
			expect: "不应产生空路径段",
		},
		{
			name: "公开 URL 双重编码（链接能生成但打不开）",
			from: "return `${base}/${encodePath(cleanKey).slice(1)}`;",
			to: "return `${base}/${encodePath(encodePath(cleanKey)).slice(1)}`;",
			expect: "不得出现二次编码",
		},
		{
			name: "『签的路径 = 发出去的路径』这道闸门失效（. 段会导致分叉）",
			from: "\tif (actual !== target.path) {",
			to: "\tif (false) {",
			expect: "一条请求都不该发出去",
		},
		{
			name: "把手填 Host 加回去（与 HTTP 客户端自己产生的那份打架）",
			from: "\t\t\tif (name === \"host\") continue; // 绝不手填 Host\n",
			to: "",
			expect: "绝不能手填 Host",
		},
		{
			name: "忽略 retryable，凡失败都重试（把『改设置』变成『卡几秒再失败』）",
			from: "if (!s3Error.retryable || attempt >= this.maxAttempts) throw s3Error;",
			to: "if (attempt >= this.maxAttempts) throw s3Error;",
			expect: "只**发 1 次请求",
		},
		{
			name: "把配置错误归成网络故障（于是会白白重试 3 次）",
			from: '\t\tkind: "client",\n\t\tstatus: 0,\n\t\tcode: "InvalidConfig",',
			to: '\t\tkind: "network",\n\t\tstatus: 0,\n\t\tcode: "InvalidConfig",',
			expect: "应归为配置问题",
		},
		{
			name: "maxAttempts 参数被忽略（用户设 1 次也没用）",
			from: "this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);",
			to: "this.maxAttempts = DEFAULT_MAX_ATTEMPTS;",
			expect: "maxAttempts=1 时应当连重试都不试",
		},
		{
			name: "退避不再指数增长（一直用同一个间隔）",
			from: "return Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);",
			to: "return Math.min(this.baseDelayMs, this.maxDelayMs);",
			expect: "退避应按指数增长",
		},
		{
			name: "退避不再封顶（重试等待可以无限长）",
			from: "return Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);",
			to: "return this.baseDelayMs * 2 ** (attempt - 1);",
			expect: "保持在上限",
		},
		{
			name: "ETag 不再去掉引号（索引里会带着一对引号）",
			from: 'return raw.replace(/^"|"$/g, "");',
			to: "return raw;",
			expect: "应是去掉引号后的十六进制",
		},
		{
			name: "密钥不再传给错误对象（脱敏失去依据）",
			from: "return [this.config.secretAccessKey, this.config.accessKeyId];",
			to: "return [];",
			expect: "绝不能出现密钥",
		},
		{
			name: "describe() 把完整 Access Key ID 打出来（日志会被贴到 issue 里）",
			from: "`accessKeyId=${access ? `${access.slice(0, 4)}***` : \"(未配置)\"}`,",
			to: "`accessKeyId=${access || \"(未配置)\"}`,",
			expect: "不得出现完整的 Access Key ID",
		},
		{
			name: "describe() 把密钥也带上",
			from: "`region=${this.config.region || \"(未配置)\"}`,",
			to: "`region=${this.config.region || \"(未配置)\"} secret=${this.config.secretAccessKey}`,",
			expect: "不得出现 Secret Access Key",
		},
		{
			name: "HEAD 的 404 改成抛错（『远端没有』是正常答案，不是异常）",
			from: "\t\t\tif (response.status === 404) return null;",
			to: "\t\t\tif (response.status === 404) throw new Error(\"404\");",
			expect: "HEAD 不存在应返回 null",
		},
		{
			name: "DELETE 的 404 改成抛错（重复清理会变成报错）",
			from: "\t\t\tif (response.status === 404) return false;",
			to: "\t\t\tif (response.status === 404) throw new Error(\"404\");",
			expect: "DELETE 不存在的对象应返回 false",
		},
		{
			name: "载荷摘要改用空串（服务端一比对就知道载荷被换过）",
			from: "const payloadHash = await payloadHashOf(data);",
			to: "const payloadHash = await payloadHashOf(\"\");",
			expect: "载荷",
		},

		// ── 桶探针（「测试连接」的判据）──
		{
			name: "桶探针的签名路径丢掉桶名（签名与请求对不上，必然 403）",
			from: "\t\tpath: `/${encodedBucket}`,",
			to: '\t\tpath: "/",',
			expect: "实际发出 /my-bucket",
		},
		{
			name: "桶探针不再编码桶名（桶名含空格等字符时签名错）",
			from: "\tconst encodedBucket = uriEncode(bucket);\n\tconst target = {\n\t\turl: `${endpoint}/${encodedBucket}`,",
			to: "\tconst encodedBucket = bucket;\n\tconst target = {\n\t\turl: `${endpoint}/${encodedBucket}`,",
			expect: "实际发出 /a%20b",
		},
		{
			name: "桶探针的 virtual-host 分支多出一段路径（地址不再是桶根）",
			from: '\t\tparsed.pathname = "/";',
			to: '\t\tparsed.pathname = "/bucket";',
			expect: "实际发出 /bucket",
		},
		{
			name: "★ 桶不存在被当成存在（用户会以为配置没问题，然后在首次上传时才失败）",
			from: "\t\t\tif (response.status === 404) return { exists: false };",
			to: "\t\t\tif (response.status === 404) return { exists: true };",
			expect: "桶名写错必须回 exists:false",
		},
		{
			name: "★ 凭据被拒被吞成「桶不存在」（排查方向被带偏到桶名上）",
			from: "\t\t\tif (!isSuccess(response.status)) {\n\t\t\t\tthrow this.fail(response, { operation: \"HEAD\", key: target.path, attempt });\n\t\t\t}\n\t\t\treturn { exists: true };",
			to: "\t\t\tif (!isSuccess(response.status)) {\n\t\t\t\treturn { exists: false };\n\t\t\t}\n\t\t\treturn { exists: true };",
			expect: "凭据被拒必须抛出",
		},
	],
});
