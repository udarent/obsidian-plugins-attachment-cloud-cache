import { runMutations } from "./lib/mutate.mjs";
import { runSigv4Suite } from "./lib/sigv4-suite.mjs";

/**
 * 变异验证：SigV4。
 *
 * 守住三类东西：
 * 1. **AWS 公布过的向量**（去掉任何一处规范化，签名都会变味）；
 * 2. **编码的边界** —— `! ' ( ) * $ ~` 这几个平台编码器处理得与 AWS 不一致的字符；
 * 3. ⭐ **"同一段路径只能编码一次"** —— 这是真出过的缺陷（双重编码），
 *    症状是上传成功但链接打不开。
 *
 * ## 关于片段选取
 *
 * 每条 `from` 都是**单行且不含前导缩进**的子串（缩进写进字符串容易与实际不符，
 * 而"变异点未找到"会被 runner 当成失败）。所有片段都已核对过全文唯一。
 *
 * ## 关于 `expect`
 *
 * 断言套件里，**具体的规则**排在**汇总的签名比对**之前 ——
 * 否则任何一处出错都先在"签名不对"上失败，而那句话指不出原因，
 * "每个变异必须因自己的原因失败"就无从检验。
 */
await runMutations({
	source: "src/s3/sigv4.ts",
	suite: runSigv4Suite,
	mutations: [
		{
			name: "unreserved 集合放宽（把 encodeURIComponent 的行为当规范：$ ! * 不编码）",
			from: "code === 0x7e // ~",
			to: "code === 0x7e ||\n\t\tcode === 0x24 || // $ 不编码\n\t\tcode === 0x21 || // ! 不编码\n\t\tcode === 0x2a // * 不编码",
			expect: "不符合规则",
		},
		{
			name: "非 ASCII 按 UTF-16 码元编码（而不是 UTF-8 字节）",
			from: "const bytes = utf8Bytes(value);",
			to: "const bytes = Uint8Array.from(value, (c) => c.charCodeAt(0) & 0xff);",
			expect: "必须先 UTF-8 再编码",
		},
		{
			name: "十六进制不再大写（%e4 而不是 %E4）",
			from: ': `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;',
			to: ': `%${byte.toString(16).padStart(2, "0")}`;',
			expect: "不符合规则",
		},
		{
			name: "查询串在编码**前**排序（官方用例正是为这条而设）",
			from: "\tpairs.sort((a, b) => compareAscii(a[0], b[0]) || compareAscii(a[1], b[1]));",
			to: "// 变异：去掉排序",
			expect: "查询参数必须按名字排序",
		},
		{
			name: "规范化头不再折叠连续空白",
			from: 'return String(value).trim().replace(/\\s+/g, " ");',
			to: "return String(value).trim();",
			expect: "把连续空白折成一个空格",
		},
		{
			name: "规范化头尾部少了那个换行（整串形状就变了）",
			from: '.map((name) => `${name}:${normalizeHeaderValue(lowered.get(name) ?? "")}\\n`)',
			to: '.map((name) => `${name}:${normalizeHeaderValue(lowered.get(name) ?? "")}`)',
			expect: "canonical request 的形状",
		},
		{
			name: "时间戳的日期切片错位（月份只取到一位）",
			from: "iso.slice(5, 7)",
			to: "iso.slice(6, 7)",
			expect: "时间格式必须是 YYYYMMDDTHHmmssZ",
		},
		{
			name: "签名密钥少推一步（去掉 aws4_request 那一层）",
			from:
				'const kService = await hmacSha256(kRegion, utf8Bytes(service));\n\treturn hmacSha256(kService, utf8Bytes("aws4_request"));',
			to: "return hmacSha256(kRegion, utf8Bytes(service));",
			expect: "get-vanilla 的签名应与 AWS 测试套件公布值一致",
		},
		{
			name: "服务名写死成 service（S3 场景下签名必然不匹配）",
			from: "const service = request.service ?? S3_SERVICE;",
			to: 'const service = "service";',
			expect: "作用域必须是",
		},
		{
			name: "规范化 URI 又编码了一次（双重编码回归）",
			from: "\t\tcanonicalUriFrom(request.path),",
			to: "\t\tencodePath(request.path),",
			expect: "不得出现 %25",
		},
		{
			name: "未编码的路径被静默接受（'编码一次'的闸门失效）",
			from: "\tif (!CANONICAL_URI_PATTERN.test(withSlash)) {",
			to: "\tif (false) {",
			expect: "未编码的路径必须被拒绝",
		},
		{
			name: "SignedHeaders 与实际签的头名不一致（列表被反转）",
			from: '\treturn { canonical, signedHeaders: names.join(";") };',
			to: '\treturn { canonical, signedHeaders: [...names].reverse().join(";") };',
			expect: "canonical request 的形状",
		},
		{
			name: "Authorization 头里的 SignedHeaders 与签的头对不上",
			from: "SignedHeaders=${signedHeaders}, Signature=${signature}",
			to: "SignedHeaders=host, Signature=${signature}",
			expect: "Authorization 头必须严格是这个形状",
		},
	],
});
