import { runMutations } from "./lib/mutate.mjs";
import { runObjectKeySuite } from "./lib/object-key-suite.mjs";

/**
 * 变异验证：对象 key 模块。
 *
 * 这是**安全关键**模块（它的输出会变成实际文件路径），
 * 所以这里逐个确认每道防线都是真的在起作用 —— 尤其是路径穿越那几条。
 *
 * 每个变异都要求报错里出现对应的线索（`expect`）：
 * 只要"有报错"是不够的，一条规则坏了可能被另一条规则的报错掩护着。
 */
await runMutations({
	source: "src/object-key.ts",
	suite: runObjectKeySuite,
	mutations: [
		{
			name: "不再替换 URL 特殊字符（问号井号等进入 key）",
			from: 'const UNSAFE_FILENAME_CHARS = /[<>:"/\\\\|?*#%&=]/g;',
			to: "const UNSAFE_FILENAME_CHARS = /[<>]/g;",
			expect: "URL 里有特殊含义的字符应替换",
		},
		{
			name: "不再剥离文件名里的 ..（路径穿越入口）",
			from: 'name = name.replace(/\\.\\./g, "_");',
			to: "// 变异：去掉穿越清理",
			expect: "不应含 ..",
		},
		{
			name: "sanitizeKey 不再过滤空段与 . / ..",
			from: '.filter((segment) => segment !== "" && segment !== "." && segment !== "..")',
			to: ".filter(() => true)",
			expect: "sanitizeKey",
		},
		{
			name: "sanitizeKey 不再归一反斜杠（Windows 分隔符绕过）",
			from: 'return raw\n\t\t.replace(/\\\\/g, "/")',
			to: "return raw",
			expect: "反斜杠应归一化",
		},
		{
			name: "不再截断超长文件名",
			from: "if (name.length <= MAX_FILENAME_LENGTH) return name;",
			to: "return name;",
			expect: "超长文件名应被截断",
		},
		{
			name: "未知占位符被替换成空串（静默变空）",
			from: "\t\tObject.prototype.hasOwnProperty.call(values, name) ? values[name] : match",
			to: '\t\tvalues[name] ?? ""',
			expect: "未知占位符应保留原样",
		},
		{
			name: "空/纯符号文件名不再兜底（会生成空段或怪名）",
			from: 'if (!/[^\\s._]/.test(name)) return "file";',
			to: "// 变异：去掉兜底",
			expect: "应有兜底",
		},
		{
			name: "{name} 不再去扩展名（渲染出 报告.pdf-<hash>.pdf 双扩展名）",
			from: "return dot > 0 ? name.slice(0, dot) : name;",
			to: "return name;",
			expect: "{name} 应去掉扩展名",
		},
		{
			name: "默认模板退回纯哈希（文件名不再进 key）",
			from: 'const tpl = typeof template === "string" && template.trim() !== "" ? template : DEFAULT_OBJECT_KEY_TEMPLATE;',
			to: 'const tpl = typeof template === "string" && template.trim() !== "" ? template : "{hash}.{ext}";',
			expect: "空模板应回落到默认模板",
		},
		{
			name: "哈希尾长度放宽（短十六进制尾被误剥一截）",
			from: "([0-9a-f]{64})",
			to: "([0-9a-f]{1,64})",
			expect: "短十六进制尾不应被当成哈希尾剥掉",
		},
		{
			name: "老格式 key 也硬猜名字（纯哈希 key 被错误解析）",
			from: '\tif (!match) return "";\n\treturn `${match[1]}${match[3] ?? ""}`;',
			to: '\tif (!match) return segment;\n\treturn `${match[1]}${match[3] ?? ""}`;',
			expect: "老格式纯哈希 key 应解析为空",
		},
		{
			name: "Windows 路径不按分隔符取末段（缓存路径解析失败）",
			from: "raw.split(/[\\\\/]/)",
			to: 'raw.split("/")',
			expect: "Windows 路径应按分隔符取末段再解析",
		},
	],
});
