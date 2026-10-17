import { runMutations } from "./lib/mutate.mjs";
import { runVaultFilesSuite } from "./lib/vault-files-suite.mjs";

/**
 * 变异验证：vault 文件命名助手。
 *
 * 守的核心只有三条，但它们各自对应一种**不可逆或整类失效**的后果：
 * - 「绝不覆盖」—— 覆盖掉的是用户可能没有别处的副本的文件；
 * - 「扩展名两个来源都要看」—— 只看一个会整类漏掉截图粘贴或下载器拖拽；
 * - 「宿主撞名的序号要认得出、且只认这一种」—— 认不出 ⇒ 同一份内容在云端存两份、
 *   笔记里多一个地址（2026-10-14 Android 直报）；认太宽 ⇒ 用户自己起的名字被我们改写。
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
			// 后果：`.PNG` 与 `.png` 会被当成两种类型 —— 同一个文件粘贴两次会得到两个 key；
			// 加上形状检查只认小写，这个变异的**实际表现**是"大小写混写时取不到扩展名"，
			// 于是 `resolveExtension` 退到 MIME（或让调用方兜底成 `bin`）。
			name: "扩展名不再统一小写（.PNG 与 .png 会被当成两种类型）",
			from: "const candidate = base.slice(dot + 1).toLowerCase();",
			to: "const candidate = base.slice(dot + 1);",
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
			// 后果：Bing 那类 URL 的最后一段（`OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA`）
			// 会把点后的 23 字符令牌当成扩展名 ⇒ 缓存副本叫 `<哈希>.spb8lvtxu-zleqgemugctwaaaa`，
			// 而 Obsidian 默认不显示它认不出的扩展名 —— 用户在缓存目录里"看不到这张图被缓存了"。
			name: "★ 扩展名的形状检查被去掉（令牌被当成扩展名，缓存副本的名字没人认得出来）",
			from: 'return PLAUSIBLE_EXTENSION.test(candidate) ? candidate : "";',
			to: "return candidate;",
			expect: "长令牌",
		},
		{
			// 后果：长度上限名存实亡 ⇒ 那串令牌照样通过。
			name: "★ 扩展名的长度上限被放大到没意义（超长令牌照样当扩展名）",
			from: "const PLAUSIBLE_EXTENSION = /^[a-z0-9]{1,8}$/;",
			to: "const PLAUSIBLE_EXTENSION = /^[a-z0-9]{1,99}$/;",
			expect: "32 个字符的十六进制串",
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

		{
			// 后果：宿主撞名另落的那一份（`照片 1.png`）**认不出来** ⇒ key 里带着序号 ⇒
			// 同一份内容在云端多存一个对象、笔记里多出一个地址。
			// 用户 2026-10-14 在 Android 上报的就是这个现场。
			name: "★ 宿主撞名的序号认不出来（同一份内容被当成两个对象）",
			from: "const match = /^(.*) (\\d+)$/.exec(stem);",
			to: "const match = null;",
			expect: "空格 + 序号要认出来",
		},
		{
			// 后果：把**别人的**约定也当成我们的 —— `照片-1.png`、`照片(1).png` 这类
			// 用户自己起的名会被剥掉一段，于是云端对象的名字与用户文件对不上。
			// 这类错不报错、只改名，所以必须由断言把它钉住。
			name: "★ 撞名解析放宽到别的约定（用户自己的 `-1` 也被剥掉）",
			from: "const match = /^(.*) (\\d+)$/.exec(stem);",
			to: "const match = /^(.*?)[\\s\\-_()]*(\\d+)$/.exec(stem);",
			expect: "不是我们的约定",
		},

		// ── ⭐ 落点目录的解析（1.2.0 起从 ingest 搬到这一层）──
		//
		// 这几条守的是"文件落在哪"。⚠️ 原本还有一条守"用户的覆盖值优先"（顺序曾经写反过，
		// 而桌面版那个 API 一直存在 ⇒ 用户填的覆盖目录**永远轮不到**）—— 那层随
		// 「附件目录覆盖」设置项一起取消（D-20），现在只有"跟随宿主"一个答案。
		{
			name: "宿主自己的附件位置被忽略（用户在 Obsidian 里设的那一栏白设了）",
			from: "	return cleaned;",
			to: '	return "";',
			expect: "应跟随宿主的附件设置",
		},
		{
			name: "宿主的「与笔记同目录」被当成字面目录名（文件落进一个叫 `.` 的目录）",
			from: '	if (cleaned === ".") {',
			to: '	if (cleaned === "___never___") {',
			expect: "`./` 应落在笔记旁边",
		},
		{
			name: "目录不再归一（首尾斜杠留在路径里，`/` 被当成一个真目录）",
			from: '		.replace(/\\\\/g, "/")\n		.replace(/^\\/+|\\/+$/g, "");',
			to: '		.replace(/\\\\/g, "/");',
			expect: "宿主填 `/` = 没指定目录",
		},
		{
			// ⚠️ 2026-10-16：这条判据原来住在 `maintenance/batch.ts`，现在搬来这里
			//（站外判定层 `decideExternalCache` 也要用它，而那边不能反向 import batch）。
			// 后果：**两个入口同时失守** —— 库内那一路会把用户的笔记当附件上传并改写它
			// 正文里的链接；站外那一路会把远程的 `.md` 搬进库，于是清单上多一行
			// "看起来像附件"的东西、用户库里凭空多出一篇笔记（他实测报的正是后者）。
			name: "★ 认不出「宿主自己的文本文件」（笔记/画布/数据库被当附件）",
			from: 'const NOTE_LIKE_EXTENSIONS = new Set(["md", "canvas", "base"]);',
			to: "const NOTE_LIKE_EXTENSIONS = new Set([]);",
			expect: "笔记（.md）要认出来",
		},
		{
			// 后果：**归一化退化**（不容忍带点的写法 / 不去空白 / 不统一小写）⇒ 用它当入口的
			// 那 4 个判据（可嵌入 / 笔记类 / 网页 / Content-Type）对同一种输入给出不同答案 ——
			// 症状是"某条入口偏偏漏了这一类"，**不报错**。
			// ⚠️ 这条锚点只有一条，是因为归一化本身**只有一份**（`normalizeExtension`）；
			// 从前它是 4 处各写一遍、靠注释人肉保持一致（2026-10-16 收成一处时顺手补上）。
			name: "★ 扩展名归一化退化（带点 / 大写的写法判不出来）",
			from: '\treturn extension.trim().toLowerCase().replace(/^\\./, "");',
			to: "\treturn String(extension);",
			expect: "调用方可能带着点",
		},
		{
			// 后果：**只剩静态页面那一半** ⇒ 后缀是脚本语言名字的地址（`…/pd.jsp?id=172`、
			// `…/product.do?id=7`）又被当成"文件"，重新出现在「上传附件」的清单里，
			// 而它们**永远搬不成**（下载端拿到的是现算出来的 `text/html`，必拒）。
			// 2026-10-16 用户第三次实测报的正是这一类，他的原话：「实际上这是一个网页地址」。
			name: "★★ 网页判据漏掉服务端页面（`…/pd.jsp?id=172` 又进清单）",
			from: '\treturn CONTENT_TYPE_BY_EXTENSION[ext] === "text/html" || PAGE_EXTENSIONS.has(ext);',
			to: '\treturn CONTENT_TYPE_BY_EXTENSION[ext] === "text/html";',
			expect: "服务端页面（后缀是脚本语言 / 框架的名字）同样不算附件",
		},
		{
			// 后果：**"后缀得像文件类型"这道退化成"有点就行"** ⇒ GitHub 分支名
			//（`…/tree/5.1-translation_terms` —— 点在 `5` 与 `1` 之间）、版本号
			//（`…/tree/v1.2.3` —— 点后面是纯数字）这类地址又被当成文件，
			// 重新出现在「上传附件」的清单里 —— 而它们永远搬不成（那是一条页面）。
			// 2026-10-16 用户第五次实测报的正是这一类。
			name: "★★ 后缀类型判据退化成「有点就行」（分支名 / 版本号又进清单）",
			from: "\treturn !/^[0-9]+$/.test(ext);",
			to: "\treturn true;",
			expect: "后缀不像文件类型（分支名 / 版本号 / 无后缀）",
		},
	],
});
