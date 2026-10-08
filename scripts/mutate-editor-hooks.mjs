import { runMutations } from "./lib/mutate.mjs";
import { runTransferSuite } from "./lib/transfer-suite.mjs";

/**
 * 变异验证：粘贴 / 拖拽判定与执行。
 *
 * ⚠️ 这一层每一条都对应一种**用户内容消失**或**链接坏掉**的后果，
 * 而不是"功能少了一点"：
 * - 接管了纯文字粘贴 → 用户粘的文字没了；
 * - 接管了库内拖动 → "移动笔记"变成什么都没发生；
 * - 只接管认识的文件 → 同批里不认识的那些被吞掉；
 * - 传了 InsertPoint 却不用 → 图插到用户已经移开的光标处；
 * - 降级时不插入 → 图虽然保住了，但笔记里什么都没有。
 *
 * 覆盖两个源文件。`ingest`/`client` 一并进同一个 bundle，因为执行部分的用例
 * 要真的跑通"写盘 + 上传"，分成两次 build 会让 `instanceof` 跨副本失败。
 */
const entries = [
	"src/editor/editor-hooks",
	"src/core/transfer",
	"src/core/ingest",
	"src/s3/client",
	"src/settings",
	"src/cache/index",
	"src/vault-files",
];

// ── 判定层（纯函数）──
await runMutations({
	source: "src/editor/editor-hooks.ts",
	entries,
	suite: runTransferSuite,
	mutations: [
		// ── 自动上传总开关 ──
		//
		// ⚠️ 这里原本有三条变异（`enabled` / `pasteUpload` / `dropUpload` 各一）。
		// 三者已合并成单个 `autoUpload`（`enabled` 名为"启用插件"，实际只被拦截读取），
		// 所以现在只有一条规则要守 —— 但粘贴与拖拽是**两处**调用，各需一条变异。
		//
		// 两条变异的 `from` 都带上了各自的下一行做区分：两个函数里那句检查
		// 逐字相同，而 `String.replace` 只替换**第一处** —— 不带上文的话，
		// 第二条变异的 `from` 会被 `from === ""` 的检查或"只改了粘贴那处"悄悄糊弄过去。
		{
			name: "粘贴开关被忽略（用户关掉自动上传，粘贴仍然被接管）",
			from: '\tif (!settings.autoUpload) return refuse("自动上传已关闭");\n\n\tconst files = filesFromTransfer(transfer);',
			to: '\tconst files = filesFromTransfer(transfer);',
			expect: "关闭自动上传后不该接管粘贴",
		},
		{
			name: "拖拽开关被忽略（用户关掉自动上传，拖拽仍然被接管）",
			from: '\tif (!settings.autoUpload) return refuse("自动上传已关闭");\n\n\tconst rawFiles = toArray(transfer?.files);',
			to: '\tconst rawFiles = toArray(transfer?.files);',
			expect: "关闭自动上传后不该接管拖拽",
		},
		{
			name: "剪贴板有文本时也接管（⭐ 用户粘的文字会消失）",
			from: "if (hasText(transfer)) return refuse(\"剪贴板里同时有文本，可能是用户在粘文字\");",
			to: "if (false) return refuse(\"剪贴板里同时有文本，可能是用户在粘文字\");",
			expect: "同时有文本时不该接管",
		},
		{
			name: "读不到文本时当成『有文本』（功能会静默失效且极难发现）",
			from: "\t\treturn false;\n\t}\n}",
			to: "\t\treturn true;\n\t}\n}",
			expect: "getData 抛错时同样按",
		},
		{
			name: "拖拽不检查 files（⭐ 接管库内拖动，『移动笔记』变成什么都没发生）",
			from: "\tconst rawFiles = toArray(transfer?.files);\n\tif (rawFiles.length === 0) {",
			to: "\tconst rawFiles = toArray(transfer?.files);\n\tif (false) {",
			expect: "原因必须点明是『库内拖动』",
		},
		{
			name: "混合载荷只放行不认识的文件（⭐ 那些文件会被一起吞掉）",
			from: "\tconst unknown = files.filter((file) => !isHookableFile(file, settings));\n\tif (unknown.length > 0) {",
			to: "\tconst unknown = files.filter((file) => !isHookableFile(file, settings));\n\tif (false) {",
			expect: "整批放行",
		},
		{
			name: "不认识的扩展名也被当成可处理（顺手把用户的其它工作流也管了）",
			from: "if (!ext) return false;\n\treturn settings.enabledExtensions.includes(ext);",
			to: "if (!ext) return true;\n\treturn true;",
			expect: "pdf 不在默认启用列表里",
		},
		{
			name: "去重按对象引用（同一文件出现在两处 → 重复上传 + 插两条链接）",
			from: "\t\tconst identity = fileIdentity(file);\n\t\tif (identity !== null) {\n\t\t\tif (seen.has(identity)) return;\n\t\t\tseen.add(identity);\n\t\t}",
			to: "\t\tif (seen.has(JSON.stringify(file))) return;\n\t\tseen.add(JSON.stringify(file));",
			expect: "两个不同的文件都必须保留",
		},
		{
			name: "没有任何字段时也硬凑身份串（⭐ 两张无名字的图被当成同一张 → 少传一张）",
			from: "\tif (!hasName && !hasSize && !hasType) return null;",
			to: "\t// 变异：不再拒绝空描述",
			expect: "没有任何可用字段时不该给出身份",
		},
		{
			name: "只看 files 不看 items（粘贴时整体漏掉文件）",
			from: "\tfor (const item of toArray(transfer?.items)) {",
			to: "\tfor (const item of []) {",
			expect: "只有 items 时也要能取到文件",
		},
		{
			name: "items 里不检查 kind（把 text/plain 也当文件处理）",
			from: '\t\tif (item.kind !== "file") continue;',
			to: "\t\t// 变异：不检查 kind",
			expect: "应跳过",
		},
		{
			name: "getAsFile 抛错时不收住（一次失效条目让整次粘贴失败）",
			from: "\t\ttry {\n\t\t\tpush(item.getAsFile());\n\t\t} catch {",
			to: "\t\t{\n\t\t\tpush(item.getAsFile());\n\t\t} if (false) {",
			expect: "必须**继续处理其余条目**",
		},
		{
			name: "远端链接里的 % 被再编一次（⭐ 链接能生成但打不开）",
			from: "return `![${text}](${String(url ?? \"\").trim()})`;",
			// 刻意用"只把 % 换成 %25"这种**针对性**的二次编码，
			// 而不是 `encodeURIComponent(整个 URL)`：后者会让整串形状都变，
			// 于是先被"链接形状"那条断言拦住，报错就说不到"二次编码"这件事上。
			to: "return `![${text}](${String(url ?? \"\").trim().replace(/%/g, \"%25\")})`;",
			expect: "百分号编码必须原样保留",
		},
		{
			name: "alt 里的方括号不清（⭐ 会提前闭合 alt，整段语法废掉）",
			from: "\treturn alt\n\t\t.replace(/[[\\]]/g, \" \")",
			to: "\treturn alt",
			expect: "方括号必须清掉",
		},
		{
			name: "alt 里的换行不清（一条链接被拆成两条）",
			from: "\t\t.replace(/[\\r\\n]+/g, \" \")",
			to: "\t\t.replace(/[\\r\\n]+/g, \"\\n\")",
			expect: "换行必须清掉",
		},
		{
			name: "非字符串 alt 被字符串化（渲染出 [object Object]）",
			from: '\tif (typeof alt !== "string") return "";',
			to: "\tif (false) return \"\";",
			expect: "必须被当成空串",
		},
		{
			name: "alt 取整个文件名而不是主干（链接被时间戳撑长）",
			from: '\treturn dot > 0 ? raw.slice(0, dot) : raw;',
			to: "\treturn raw;",
			expect: "alt 取主干",
		},
		{
			name: "库内嵌入不归一化反斜杠（Windows 路径原样进链接）",
			from: 'const path = String(vaultPath ?? "").replace(/\\\\/g, "/").replace(/^\\/+/, "").trim();',
			to: 'const path = String(vaultPath ?? "").trim();',
			expect: "反斜杠要归一化",
		},
		{
			// 后果：剪贴板把同一张图给成多份（files 一份 + items 一份）时去重失效 ——
			// 两个包装对象的名字/大小/类型都一样，**只有时间戳不同**，
			// 而后者是宿主新建那个对象时取的"此刻"。一次粘贴就插 2~3 条相同外链（实测报过）。
			name: "★ 去重键含 lastModified（同一张图的两个包装对象被当成两张）",
			from: '\treturn [file.name ?? "", file.size ?? "", file.type ?? ""].join("\\u0000");',
			to: '\treturn [file.name ?? "", file.size ?? "", file.lastModified ?? "", file.type ?? ""].join("\\u0000");',
			expect: "时间戳不是身份的一部分",
		},
	],
});
