import { runMutations } from "./lib/mutate.mjs";
import { runI18nSuite } from "./lib/i18n-suite.mjs";

/**
 * 变异验证：文案表与取文案函数（`src/i18n.ts`）。
 *
 * 这个文件原先**不存在** —— i18n 是 31 个测试入口里唯一没有套件、也没有变异脚本的，
 * 于是它那套断言从来没被验证过"有没有牙齿"。补上之后，`i18n-suite.mjs` 里
 * 每一类断言都有了对应的退化形态。
 *
 * 九条各自对应一种「不报错、只在真实使用中被发现」的退化：
 * 中文表少一条键（中文用户看到键名本身）、英文表少一条键、
 * 占位符名字对不上（提示里少一段信息）、`zh-CN` 被漏掉（中文系统上界面变英文）、
 * 非标量参数被 `String()` 成 `[object Object]`、`0`/`false` 被 truthiness 误判、
 * 未知 key 静默变空串、未知语言回落错表、以及空白文案。
 */
await runMutations({
	source: "src/i18n.ts",
	suite: runI18nSuite,
	mutations: [
		{
			// 后果：中文表少一条 → `translate` 回落到英文表，中文用户在这个位置看到英文。
			// 用户不会报"少了一条文案"，他只会觉得这个插件中文没做全。
			name: "★ 中文表少一条键（中文用户在这个位置看到英文）",
			from: '\t\ttestOk: "连接正常，存储桶可访问。",\n',
			to: "",
			expect: "中文缺少这些 key",
		},
		{
			// 反向：英文表少一条。中文用户看不到，但界面语言是英文的人会看到键名本身。
			name: "★ 英文表少一条键",
			from: '\t\ttestOk: "Connected, and the bucket is reachable.",\n',
			to: "",
			expect: "英文缺少这些 key",
		},
		{
			// 后果：占位符名字与另一张表对不上 ⇒ 替换不上，提示里少一段关键信息
			//（"上传失败：{err}" 会原样显示），而两边都不报错。
			name: "★ 占位符名字对不上（提示里原样显示 {err}）",
			from: '\t\thookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{error}",\n',
			to: '\t\thookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{err}",\n',
			expect: "占位符在两种语言里不一致",
		},
		{
			// 后果：Obsidian 在中文系统上给的是 `zh-CN` / `zh-TW`，用 `=== "zh"` 比较
			// 会让它们**静默回落成英文** —— 界面全英文，而用户只会以为插件不支持中文。
			name: "★ 语言识别写成精确比较（zh-CN 静默变英文界面）",
			from: '\treturn language && language.toLowerCase().startsWith("zh") ? "zh" : "en";',
			to: '\treturn language === "zh" ? "zh" : "en";',
			expect: "zh-CN 必须识别为中文",
		},
		{
			// 后果：对象被 `String()` 成 `[object Object]` 塞进用户可见提示，
			// 既没信息量、又把"调用方传错参数"这件事掩盖掉了。
			name: "★ 非标量参数被 String 化（提示里出现 [object Object]）",
			from: '\t\t\t// 一律不替换 —— 见上面"看得见"的理由\n\t\t\treturn null;',
			to: "\t\t\treturn String(value);",
			expect: "对象参数应保持占位符原样",
		},
		{
			// 后果：把"可格式化"的判定改成 truthiness，于是 `0` 与 `false` 被当成
			// 不可格式化而保持占位符原样 —— 而它们是**正常参数**（计数为 0、开关为否）。
			name: "★ 0 / false 被 truthiness 误判成不可格式化",
			from: '\t\tcase "number":\n\t\tcase "boolean":\n\t\t\treturn String(value);',
			to: '\t\tcase "number":\n\t\tcase "boolean":\n\t\t\treturn value ? String(value) : null;',
			expect: "数字 0 是标量，必须替换",
		},
		{
			// 后果：未知 key 变成空串 ⇒ 界面上那块**什么都没有**，
			// 比显示键名更难定位（键名至少告诉你去哪找）。
			name: "★ 未知 key 静默变空串（界面上那块什么都没有）",
			from: "\tconst template = table[key] ?? I18N.en[key] ?? key;",
			to: '\tconst template = table[key] ?? I18N.en[key] ?? "";',
			expect: "未知 key 应返回 key 本身",
		},
		{
			// 后果：认不出的语言回落**中文**表 —— 一个说法语/德语的人会看到中文界面，
			// 而英文才是这个插件的兜底语言（manifest 里写的也是英文）。
			name: "★ 未知语言回落错表（非中英用户看到中文）",
			from: "\tconst table = I18N[locale] ?? I18N.en;",
			to: "\tconst table = I18N[locale] ?? I18N.zh;",
			expect: "未知语言应回落英文",
		},
		{
			// 后果：文案是纯空白 —— 界面上那块看起来"有东西"，实际什么都没显示。
			// 用纯空白而不是空串：`trim()` 那道判断正是为了挡这种情况。
			name: "★ 文案变成纯空白（界面上像是有、其实什么都没有）",
			from: '\t\ttesting: "测试中…",\n',
			to: '\t\ttesting: "   ",\n',
			expect: "不应为空串",
		},
	],
});
