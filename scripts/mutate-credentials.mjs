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
			expect: "名字为空 = 从未选择",
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
			name: "纯空白的桶名被当成填了（带着一个假桶名去请求）",
			from: '\tif (String(s3.bucket ?? "").trim() === "") {',
			to: '\tif (String(s3.bucket ?? "") === "") {',
			expect: "纯空白的桶名也不算填了",
		},
		{
			name: "★「密钥已失效」与「从未选择」被合并成一类（提示指错方向）",
			from: '\tif (status.accessKeyId.state === "missing" || status.secretAccessKey.state === "missing") {',
			to: "\tif (false) {",
			expect: "所选密钥已不存在时必须判定为未就绪",
		},
	],
});
