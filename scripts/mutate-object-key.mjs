import { runMutations } from "./lib/mutate.mjs";
import { runObjectKeySuite } from "./lib/object-key-suite.mjs";

/**
 * 变异验证：对象 key 模块。
 *
 * 这是**安全关键**模块：它的输出是桶里对象的**身份**。所以逐条确认每道防线都在起作用 ——
 * 尤其是两件事：① 路径穿越进不了 key；② 名字与哈希两个分量都真的进了 key
 * （少了哈希 = 同名不同内容互相覆盖；少了名字 = C2 的意义没了）。
 *
 * ⚠️ 1.2.0 起模板设置取消，与模板渲染相关的变异（未知占位符、默认模板回落、`{date}`…）
 * 随代码一起删掉了 —— 死代码的锚点留着，只会让"全都抓住了"这句话不可信。
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
			// 后果：共享桶档又变回"带名字的 key" ⇒ 同内容换名字多出一个对象，
			// 而跨设备去重靠本机台账（换设备就失效）。这正是 CR-14 要消除的那个洞。
			name: "★★ 共享桶档忘了走纯内容寻址（跨设备去重失效）",
			from: "\tif (options.contentAddressed) return sanitizeKey(ext ? `${hash}.${ext}` : hash);",
			to: "\tif (false) return sanitizeKey(ext ? `${hash}.${ext}` : hash);",
			expect: "纯内容寻址只留哈希与扩展名",
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
			name: "空/纯符号文件名不再兜底（名字段变空）",
			from: 'if (!/[^\\s._]/.test(name)) return "file";',
			to: "// 变异：去掉兜底",
			expect: "应有兜底",
		},
		{
			// ⚠️ 红的会是 §1 那条**整体形状**断言（它最先看到"名字里带着扩展名"这件事），
			// 而不是 §7 专门讲多扩展名的那条 —— `expect` 必须照实跑的报错写。
			name: "名字不再去扩展名（key 里出现 `报告.pdf-<hash>.pdf` 双扩展名）",
			from: "\tconst dot = name.lastIndexOf(\".\");\n\treturn dot > 0 ? name.slice(0, dot) : name;",
			to: "\treturn name;",
			expect: "key 应带原始文件名与完整哈希",
		},
		{
			// ⚠️ 同上：大写/缺点的扩展名会先撞上 §1 的整体形状断言。
			name: "扩展名不再归一（大写/带点的扩展名原样进 key）",
			from: 'parts.ext.toLowerCase().replace(/^\\./, "")',
			to: "parts.ext",
			expect: "扩展名应小写且去掉前导点",
		},
		{
			// 后果：**名字不再进 key** ⇒ 桶里按名字搜不到、确认框只能显示哈希 ——
			// C2 的产品诉求整个失效（这正是 1.2.0 把它固定成不可配置的原因）。
			name: "★ 名字不再进 key（退回纯内容寻址，C2 失效）",
			from: "\treturn sanitizeKey(ext ? `${stem}-${hash}.${ext}` : `${stem}-${hash}`);",
			to: "\treturn sanitizeKey(hash);",
			expect: "key 应带原始文件名与完整哈希",
		},
		{
			// 后果：同名不同内容会撞成**同一个 key** ⇒ 上传路径的复用判定不比内容，
			// 于是静默复用错文件；本地副本不在时 PUT 直接覆盖桶里的对象（不可逆）。
			name: "★ 不再校验哈希形状（拿不到身份也照传 ⇒ 所有文件可能共用一个 key）",
			from: "\tif (!FULL_HASH_PATTERN.test(hash)) return \"\";\n",
			to: "\t// 变异：不校验身份\n",
			expect: "非法哈希必须返回空串",
		},
		{
			// 后果同上，但走的是"判据放宽"这条路：短哈希被当成合法身份。
			// ⚠️ 生成器与解析器共用这一处判据，所以红的是 §3（生成侧最先受影响）。
			name: "哈希长度判据放宽（短十六进制被当成合法身份）",
			from: 'const HASH_PATTERN = "[0-9a-f]{64}";',
			to: 'const HASH_PATTERN = "[0-9a-f]{1,64}";',
			expect: "非法哈希必须返回空串",
		},
		{
			// 后果："这份内容我们传过吗"永远答不出来 ⇒ 同步到达的副本判不出来（白等退避窗口），
			// 下载撞名时也比不了内容（只能一路加序号）。
			// ⚠️ 先红的是 §2 那条（"改名只应改名字段，哈希段必须仍在"）—— 它比 §15 更早看到
			// "哈希段取不出来"这件事；两条讲的是同一条规则，位置不同而已。
			name: "★ 只认老形状（名字在前的 key 取不出哈希）",
			from: "\tif (named) return named[2];\n",
			to: "\t// 变异：不认名字在前的形状\n",
			expect: "改名只应改名字段，哈希段必须仍在",
		},
		{
			name: "老格式 key 也硬猜名字（纯哈希 key 被错误解析）",
			from: '\tif (!match) return "";\n\treturn `${match[1]}${match[3] ?? ""}`;',
			to: '\tif (!match) return segment;\n\treturn `${match[1]}${match[3] ?? ""}`;',
			expect: "老格式纯哈希 key 应解析为空",
		},
		{
			// ⚠️ 同一条规则在 `displayNameForKey` 与 `hashFromKey` 里**各写了一遍**，
			// 所以锚点也要**各来一条**（带上下文区分）。从前只有一条、`from` 又是纯字面片段：
			// `replace` 只改第一处 ⇒ 它一直只盖着 `displayNameForKey`，
			// 而 `hashFromKey` 那一处**从来没被变过**（2026-10-15 由"锚点唯一"检查查出来）。
			name: "Windows 路径不按分隔符取末段（displayNameForKey 侧解析失败）",
			from: 'export function displayNameForKey(key: unknown): string {\n\tconst raw = typeof key === "string" ? key.trim() : "";\n\tif (!raw) return "";\n\tconst segment = raw.split(/[\\\\/]/).pop() ?? "";',
			// ⚠️ `to` 必须把 `from` 覆盖的**每一行**都还回去（只在那一行上做改动）：
			// 漏掉函数签名或 `if (!raw)` 那一行 ⇒ 变异出来的文件**语法错**，
			// 报出来的是"Build failed"，而不是这条规则该有的那句断言（实测踩到）。
			to: 'export function displayNameForKey(key: unknown): string {\n\tconst raw = typeof key === "string" ? key.trim() : "";\n\tif (!raw) return "";\n\tconst segment = raw.split("/").pop() ?? "";',
			expect: "Windows 路径应按分隔符取末段再解析",
		},
		{
			// 同上，这是 `hashFromKey` 那一条（此前没人守着）。
			name: "Windows 路径不按分隔符取末段（hashFromKey 侧：整条路径被当成基名 ⇒ 取不到哈希）",
			from: '\tconst segment = raw.split(/[\\\\/]/).pop() ?? "";\n\tconst named = HASH_TAIL_PATTERN.exec(segment);',
			to: '\tconst segment = raw.split("/").pop() ?? "";\n\tconst named = HASH_TAIL_PATTERN.exec(segment);',
			expect: "反斜杠路径（Windows）也要取末段再解析",
		},
	],
});
