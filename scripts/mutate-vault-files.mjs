import { runMutations } from "./lib/mutate.mjs";
import { runVaultFilesSuite } from "./lib/vault-files-suite.mjs";

/**
 * 变异验证：vault 文件命名助手。
 *
 * 守的核心只有两条，但它们各自对应一种**不可逆或整类失效**的后果：
 * - 「绝不覆盖」—— 覆盖掉的是用户可能没有别处的副本的文件；
 * - 「扩展名两个来源都要看」—— 只看一个会整类漏掉截图粘贴或下载器拖拽。
 */
await runMutations({
	source: "src/vault-files.ts",
	suite: runVaultFilesSuite,
	mutations: [
		{
			name: "只看 MIME、不看文件名（下载器拖出的文件会丢掉真实类型）",
			from: "return extensionOfName(name) || extensionFromMime(mime);",
			to: "return extensionFromMime(mime) || extensionOfName(name);",
			expect: "两者冲突时以**文件名**为准",
		},
		{
			name: "只看文件名、不看 MIME（截图粘贴整类漏掉）",
			from: "return extensionOfName(name) || extensionFromMime(mime);",
			to: "return extensionOfName(name);",
			expect: "没有文件名时靠 MIME",
		},
		{
			name: "前导点被当成扩展名（.gitignore 变成 gitignore 类型）",
			from: "if (dot <= 0) return \"\";",
			to: "if (dot < 0) return \"\";",
			expect: "前导点是隐藏文件而不是扩展名",
		},
		{
			name: "扩展名不再统一小写（.PNG 与 .png 会被当成两种类型）",
			from: "return base.slice(dot + 1).toLowerCase();",
			to: "return base.slice(dot + 1);",
			expect: "统一小写",
		},
		{
			name: "不再忽略 MIME 的参数部分（image/png; charset=x 推不出扩展名）",
			from: 'const bare = mime.split(";")[0].trim().toLowerCase();',
			to: "const bare = mime.trim().toLowerCase();",
			expect: "应忽略 MIME 的参数部分",
		},
		{
			name: "通用 MIME 被当成有效类型（真实类型丢失）",
			from: "if (typeof mime === \"string\" && mime.trim() !== \"\" && mime !== DEFAULT_CONTENT_TYPE) {",
			to: "if (typeof mime === \"string\" && mime.trim() !== \"\") {",
			expect: "通用类型等于没给",
		},
		{
			name: "未知扩展名不再兜底（浏览器会把它当文本渲染）",
			from: "return CONTENT_TYPE_BY_EXTENSION[key] ?? DEFAULT_CONTENT_TYPE;",
			to: "return CONTENT_TYPE_BY_EXTENSION[key];",
			expect: "未知扩展名应兜底",
		},
		{
			name: "父目录不再归一化首尾斜杠（尾斜杠会被当成分隔符切出一段残渣）",
			from: 'const clean = path.replace(/\\\\/g, "/").replace(/^\\/+|\\/+$/g, "");',
			to: 'const clean = path.replace(/\\\\/g, "/");',
			expect: "尾斜杠先清掉",
		},
		{
			name: "uniqueVaultPath 不再检查占用（⭐ 直接覆盖用户同名文件）",
			from: "if (!(await exists(clean))) return clean;",
			to: "return clean;",
			expect: "占用时必须换一个路径",
		},
		{
			name: "唯一化时序号加在扩展名之后（文件类型丢失）",
			from: "const candidate = `${prefix}${stem} ${n}${ext}`;",
			to: "const candidate = `${prefix}${stem}${ext} ${n}`;",
			expect: "序号应加在最后一段扩展名之前",
		},
		{
			name: "唯一化丢掉目录部分（同名文件会被写到 vault 根目录）",
			from: "const prefix = folder ? `${folder}/` : \"\";",
			to: 'const prefix = "";',
			expect: "应保留目录部分",
		},
		{
			// 上限被改小 → 明明有空位（第 7 个）却找不到，于是抛出"无法为…找到可用路径"。
			// 报错正好点出"上限太小"这件事，所以 expect 取那句话。
			name: "唯一化的尝试上限被改小（明明有空位却放弃）",
			from: "for (let n = 1; n <= MAX_UNIQUE_ATTEMPTS; n += 1) {",
			to: "for (let n = 1; n <= 5; n += 1) {",
			expect: "无法为",
		},
		{
			name: "空目标被安静接受（产出空路径，后续写入行为未定义）",
			from: 'if (!clean) throw new Error("uniqueVaultPath 需要一个非空目标路径");',
			to: "if (!clean) return clean;",
			expect: "空路径应报错",
		},
		{
			// 后果：归一退化成"只把反斜杠换掉"（也就是刚被替掉的那份私有实现），
			// 于是 `a//b`、`a/` 这类写法与宿主写进索引的写法对不上 ——
			// 同一个副本会被判成"缺失"或"孤儿"，而审计/淘汰据此给出错误结论。
			name: "★ 路径归一不再走宿主的 normalizePath（重复/末尾斜杠对不上）",
			from: '\treturn typeof path === "string" ? normalizePath(path) : "";',
			to: '\treturn typeof path === "string" ? path.replace(/\\\\/g, "/") : "";',
			expect: "重复斜杠要折叠",
		},
	],
});
