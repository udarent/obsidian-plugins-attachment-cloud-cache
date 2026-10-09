import { runMutations } from "./lib/mutate.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 变异验证：凭据的解析与连通性前置检查（`src/s3/credentials.ts`）。
 *
 * 这一层最容易出的是**提示指错方向**：
 * 把"从未选择密钥"和"所选密钥已经不存在了"报成同一句话，
 * 会让一个明明配过密钥的用户以为自己的填写丢了 ——
 * 而两者的修法完全不同（一个去选，一个要重新选）。
 * 另外，拿空凭据去发请求会得到 403，那会把"没配"伪装成"配错了"。
 *
 * 后半段守**外来凭据文件的解析**（MinIO 控制台「下载凭据」那种 json）。
 * 那里有一条是**安全边界**而不是体验问题：秘密只能从 `secret` 一个出口出去，
 * 混进 `patch` 就会落进明文的 `data.json`（随 vault 同步、备份、分享）。
 * 那条退化不会有任何报错，只能靠断言 + 这条变异钉住。
 */
await runMutations({
	source: "src/s3/credentials.ts",
	entries: ["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"],
	suite: runSettingsUiSuite,
	mutations: [
		{
			name: "未选择密钥被当成正常（会带着空凭据去请求，报出来的却是 403）",
			from: '\tif (trimmed === "") return { name: "", state: "unset" };',
			to: '\tif (trimmed === "") return { name: "", state: "ok" };',
			expect: "不能报成 ok",
		},
		{
			name: "取不到值也报成正常（所选密钥已失效却显示一切正常）",
			from: '\treturn { name: trimmed, state: value ? "ok" : "missing" };',
			to: '\treturn { name: trimmed, state: "ok" };',
			expect: "名字非空但取不到值",
		},
		{
			name: "密钥名不再去空白（粘进来带空格的就不认识了）",
			from: '\tconst trimmed = String(name ?? "").trim();',
			to: '\tconst trimmed = String(name ?? "");',
			// ⚠️ 期望记的是**实测先红的那条**：套件里"读取到的名字要去空白"排在
			// "去空白后能查到值"之前，所以先炸的是前者。写后者会报"原因不符"——
			// 而那条断言其实也在守同一件事，只是排在后面。
			expect: "名字要去空白后再查",
		},
		{
			name: "空串的密钥值被当成有效（被清空的密钥照样拿去签名，只会得到 403）",
			from: '\treturn { name: trimmed, state: value ? "ok" : "missing" };',
			to: '\treturn { name: trimmed, state: value === null ? "missing" : "ok" };',
			expect: "空串值不算有效密钥",
		},
		{
			name: "访问密钥 ID 只判空而不去空白（一串空格被当成填了）",
			from: '\tconst accessKeyIdPresent = String(s3.accessKeyId ?? "").trim() !== "";',
			to: '\tconst accessKeyIdPresent = String(s3.accessKeyId ?? "") !== "";',
			expect: "纯空白的访问密钥 ID 不算填了",
		},
		{
			name: "纯空白的桶名被当成填了（带着一个假桶名去请求）",
			from: '\tif (String(s3.bucket ?? "").trim() === "") {',
			to: '\tif (String(s3.bucket ?? "") === "") {',
			expect: "纯空白的桶名也不算填了",
		},
		{
			name: "★「密钥已失效」与「没选」被合并成一类（提示指错方向）",
			from: '\tif (status.secretAccessKey.state === "missing") {',
			to: "\tif (false) {",
			expect: "秘密密钥已不存在时必须判定为未就绪",
		},
		{
			// 后果：公开访问前缀**从未生效**，笔记里的链接一直退回对象地址 ——
			// 私有桶上那些链接对别人就是 404，而**没有任何报错**。
			// 实测踩到过（真 bug，不是假想）：这个 config 是三条构造路径唯一的来源，
			// 漏一个字段只有"链接悄悄不对"这一种表现，端到端夹具若把前缀设成回退值就查不出来。
			name: "★ 组装客户端配置时漏掉公开访问前缀（配了也不生效，链接退回对象地址）",
			from: "\t\t\tpublicUrlBase: s3.publicUrlBase,\n",
			to: "",
			expect: "就绪配置必须带上公开访问前缀",
		},

		// ── 外来凭据文件的解析 ──
		//
		// 每一条对应一种**真实会犯**的退化：认少一种拼写、少清一个空白、
		// 把一个该分开的结论合并掉 —— 而最严重的那条（秘密进 patch）
		// 在行为上看不出任何异常，只有"秘密已经写进明文文件"这一个后果。
		{
			name: "服务地址只认 endpoint（MinIO 的 url 认不出来，用户会说\"我的文件明明是对的\"）",
			from: 'const ENDPOINT_KEYS = ["url", "endpoint", "s3Endpoint", "s3EndpointUrl", "s3_endpoint"];',
			to: 'const ENDPOINT_KEYS = ["endpoint", "s3Endpoint", "s3EndpointUrl", "s3_endpoint"];',
			expect: "url → 服务地址",
		},
		{
			name: "秘密只认 secretAccessKey（MinIO 的 secretKey 认不出来）",
			from: 'const SECRET_KEY_KEYS = ["secretKey", "secretAccessKey", "secret_key", "secret"];',
			to: 'const SECRET_KEY_KEYS = ["secretAccessKey", "secret_key", "secret"];',
			expect: "secretKey → 秘密",
		},
		{
			// ⚠️⚠️ 最严重的一条：不会有任何报错，只会让明文秘密落进 `data.json`，
			// 而那个文件随 vault 同步/备份/分享出去。
			name: "★★ 把秘密也塞进要写设置的 patch（明文秘密落进 data.json）",
			from: "\treturn { ok: true, patch, secret, ignored };",
			to: "\treturn { ok: true, patch: { ...patch, secretKey: secret }, secret, ignored };",
			expect: "秘密值绝不能出现在 patch 里",
		},
		{
			name: "path=auto 被当成强制 path-style（静默改写用户刻意设成 false 的寻址方式）",
			from: "\t\tdefault:\n\t\t\treturn undefined;",
			to: "\t\tdefault:\n\t\t\treturn true;",
			expect: "path=auto",
		},
		{
			name: "空串被当成\"填了个空的\"收下（一份全是空白的文件会显示导入成功）",
			from: '\t\tif (trimmed !== "") return trimmed;',
			to: "\t\treturn trimmed;",
			expect: "全是空白等于没有凭据",
		},
		{
			name: "值不再去两端空白（从浏览器复制带的换行被一起收下，表现为凭据被拒）",
			from: "\t\tconst trimmed = value.trim();",
			to: "\t\tconst trimmed = value;",
			expect: "两端的空白要清掉",
		},
		{
			name: "数组被放行（`[1,2,3]` 报成\"里面没有凭据字段\"，把用户引去怀疑文件内容）",
			from: '\tif (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {',
			to: '\tif (typeof parsed !== "object" || parsed === null) {',
			expect: "数组是 JSON 但不是对象",
		},
		{
			name: "只有秘密的文件被当成\"里面没有凭据\"（用户拿一份只存了密钥的文件来导入会被直接拒绝）",
			from: "\tif (Object.keys(patch).length === 0 && secret === null) {",
			to: "\tif (Object.keys(patch).length === 0) {",
			expect: "只有秘密也算一份有用的文件",
		},
		{
			name: "认不出的键被静默丢弃（用户会去琢磨\"我给了 api，怎么没反应\"）",
			from: "\tconst ignored = Object.keys(record).filter((key) => !consumed.has(key));",
			to: "\tconst ignored = Object.keys(record);",
			expect: "用不上的键如实回报",
		},
	],
});
