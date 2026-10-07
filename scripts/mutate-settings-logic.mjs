import { runMutations } from "./lib/mutate.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 变异验证：设置界面的纯逻辑（`src/ui/settings-logic.ts`）。
 *
 * ⚠️ 套件同时覆盖 bindings 与 credentials，所以 `entries` 要把三个模块都带上；
 * 而套件里把 logic 的断言排在**最前**，正是为了让本文件的每个变异
 * 都因 logic 自己的原因失败，而不是先炸在 bindings 上（那会报出与变异点无关的原因）。
 *
 * 这里守的都是"界面显示得对不对"：
 * 用户敲的扩展名有没有被正确理解、不该显示的字段有没有出现、选项里有没有假的、
 * 以及连不上时的提示有没有指向正确的下一步。
 */
await runMutations({
	source: "src/ui/settings-logic.ts",
	entries: ["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"],
	suite: runSettingsUiSuite,
	mutations: [
		// ── 扩展名解析 ──
		{
			name: "扩展名只认逗号（用户用空格/顿号/换行输入就全废了）",
			from: "\tfor (const piece of text.split(/[,，、;；\\s]+/)) {",
			to: '\tfor (const piece of text.split(",")) {',
			expect: "空格分隔（手敲常见）",
		},
		{
			name: "扩展名不再归一化（大写与前导点照原样存进去）",
			from: '\t\tconst normalized = piece.trim().toLowerCase().replace(/^\\./, "");',
			to: "\t\tconst normalized = piece.trim();",
			expect: "带前导点与大写都要归一",
		},
		{
			name: "空段不再丢弃（空串会被当成一个扩展名存进设置）",
			from: '\t\tif (normalized === "") continue;',
			to: "\t\t// 变异：不跳过空段",
			expect: "空串得到空列表",
		},
		{
			name: "格式化不再过滤脏元素（数字与空串混进文本框）",
			from: '\treturn list.filter((x): x is string => typeof x === "string" && x.trim() !== "").join(", ");',
			to: '\treturn list.join(", ");',
			expect: "格式化要过滤脏元素",
		},

		// ── 条件显示 ──
		{
			name: "缓存目录无条件显示（用户以为改它有用，实际不起作用）",
			from: '\treturn action === "cache";',
			to: "\treturn true;",
			expect: "原地保留时缓存目录必须隐藏",
		},

		// ── 选项生成 ──
		{
			name: "选项里混进未实现的 ask（界面上出现一个从不生效的选项）",
			from: "\tfor (const value of LOCAL_COPY_ACTIONS) options[value] = labelOf(value);",
			to: '\tfor (const value of [...LOCAL_COPY_ACTIONS, "ask"]) options[value] = labelOf(value);',
			expect: "选项集合必须与 LOCAL_COPY_ACTIONS 完全一致",
		},

		// ── 失败归类 ──
		{
			name: "404 被归成别的原因（用户会去查网络，而实际是桶名写错了）",
			from: '\t\t\treturn "bucketMissing";',
			to: '\t\t\treturn "network";',
			expect: "404 归为桶不存在",
		},
		{
			name: "未知失败类型被吞掉（该提示的不提示）",
			from: '\t\tdefault:\n\t\t\treturn "other";',
			to: '\t\tdefault:\n\t\t\treturn "auth";',
			expect: "其它 4xx 归入 other",
		},
		{
			name: "文案 key 的前缀被改（界面会显示成 key 本身而不是提示）",
			from: "\treturn `testFail_${kind}`;",
			to: "\treturn `failure_${kind}`;",
			expect: "每类失败都要有文案 key",
		},

		// ── 秘密访问密钥的钥匙串槽位名 ──
		{
			// 后果：槽位名里出现大写/非法字符 ⇒ `setSecret` **直接抛错**，
			// 秘密存不进去，而用户看到的只是"凭据被拒"。
			// 这正是最初那个缺陷的形态（密钥 ID 不允许大写），所以值得钉住。
			name: "★ 槽位名不再净化（非法字符会让 setSecret 直接抛错）",
			from: '\t\t.toLowerCase()\n\t\t.replace(/[^a-z0-9]/g, "");',
			to: "\t\t;",
			expect: "生成的槽位名必须只含小写字母、数字、短横线",
		},
		{
			// 后果：每次保存都换一个新槽位名 ⇒ 旧秘密被孤儿化，
			// 设置页那个框还是满的（从钥匙串读回的），但读取用的名字变了 ——
			// 表现为"凭据被拒"，而一切看起来都配好了。
			name: "★ 已有槽位名被丢弃、每次重新生成（旧秘密被孤儿化）",
			from: '\tconst trimmed = String(existing ?? "").trim();\n\tif (trimmed !== "") return trimmed;',
			to: '\tconst trimmed = String(existing ?? "").trim();\n\tvoid trimmed;',
			expect: "已有槽位名要原样沿用",
		},
		{
			// 后果：纯空白的槽位名被当成有效 ⇒ 拿一个空白名字去 getSecret/setSecret，
			// 秘密永远取不回来（而设置里那个字段看起来"有值"）。
			name: "纯空白的槽位名被当成有效",
			from: '\tconst trimmed = String(existing ?? "").trim();',
			to: '\tconst trimmed = String(existing ?? "");',
			expect: "纯空白的槽位名视同没有",
		},
		{
			// 后果：403（桶私有）被归到"其它"⇒ 用户看到一句含糊的"无法判断"，
			// 而真正该做的是"开公开读或配公开前缀"。提示指错方向。
			name: "★ 403 不再归为「拒绝匿名访问」（提示退化成含糊的「无法判断」）",
			from: '\tif (status === 401 || status === 403) return "forbidden";',
			to: '\tif (status === 401) return "forbidden";',
			expect: "403 是「能连上但拒绝匿名访问」",
		},
		{
			// 后果：桶私有被涂成红色 ⇒ 用户以为"连接坏了"，去改根本没坏的东西。
			name: "★ 桶私有被当成错误而不是提示（语气误导）",
			from: '\t\tcase "forbidden":\n\t\t\treturn "warn";',
			to: '\t\tcase "forbidden":\n\t\t\treturn "error";',
			expect: "桶私有 = 提示，不是错误",
		},
	],
});
