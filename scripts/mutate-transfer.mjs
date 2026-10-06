import { runMutations } from "./lib/mutate.mjs";
import { runTransferSuite } from "./lib/transfer-suite.mjs";

/**
 * 多个入口进**同一个** bundle：执行部分的用例要真的跑通"写盘 + 上传"，
 * 而 `S3Client` 与 `ingest` 若各打一份，跨模块的 `instanceof` 会恒为 false。
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

/**
 * 变异验证：粘贴/拖拽的**执行**部分（`src/core/transfer.ts`）。
 *
 * ⚠️ 与判定层分成两个文件是**必须的**：`runMutations` 结束时会 `process.exit`，
 * 所以同一个文件里写第二个调用**永远不会执行** —— 而输出看起来仍然像成功了。
 * 第一版就把两层写在同一个文件里，结果执行层的 8 条变异一条都没跑过。
 *
 * 这里守的是"插了什么、插到哪里、丢没丢"：降级时不插入、忽略同步阶段捕获的插入位置、
 * 一个文件失败带走整批、多张图拆成多次插入（撤销要按好几次）。
 */
await runMutations({
	source: "src/core/transfer.ts",
	entries,
	suite: runTransferSuite,
	mutations: [
		{
			name: "降级时不插入任何内容（⭐ 图保住了，但笔记里什么都没有）",
			from: "\t\t\tif (result.localPath) {\n\t\t\t\tparts.push(buildLocalImageEmbed(result.localPath, alt));",
			to: "\t\t\tif (false) {\n\t\t\t\tparts.push(buildLocalImageEmbed(result.localPath, alt));",
			expect: "降级也必须插回内容",
		},
		{
			name: "降级且有本地副本时被记为 lost（把『保住了』误报成『丢了』）",
			from: "\t\t\t\toutcome.fallback += 1;",
			to: "\t\t\t\toutcome.lost += 1;",
			expect: "降级不等于丢图",
		},
		{
			name: "读字节失败被当成成功继续（插一条指向不存在文件的链接）",
			from: "\t\t\toutcome.lost += 1;\n\t\t\tdeps.notify(deps.t(\"hookLocalFallbackFailed\", { error: describe(error) }));\n\t\t\tcontinue;\n\t\t}\n\n\t\tlet result: IngestResult;",
			to: "\t\t\tcontinue;\n\t\t}\n\n\t\tlet result: IngestResult;",
			expect: "必须明确报错",
		},
		{
			name: "编排层抛错时不收住（一个失败让整批文件都不处理）",
			from: "\t\t} catch (error) {\n\t\t\t// 编排层承诺不抛错；真抛了也要收住，否则后面那些文件全都不处理了\n\t\t\toutcome.lost += 1;",
			to: "\t\t} catch (error) {\n\t\t\tthrow error;\n\t\t\toutcome.lost += 1;",
			expect: "收住并继续处理其余文件",
		},
		{
			name: "⭐ 无视同步阶段捕获的插入位置（图被插到用户已经移开的光标处）",
			from: "\tif (insertPoint && typeof editor.replaceRange === \"function\") {\n\t\teditor.replaceRange(text, insertPoint.from, insertPoint.to);\n\t\treturn;\n\t}",
			to: "\tif (false) {\n\t\teditor.replaceRange(text, insertPoint.from, insertPoint.to);\n\t\treturn;\n\t}",
			expect: "使用 replaceRange 插回原位",
		},
		{
			name: "把多张图拆成多次插入（撤销要按 N 次才干净）",
			from: "const text = parts.join(\"\\n\");",
			to: "const text = parts.join(\"\\n\");\n\tfor (const part of parts) editor.replaceSelection(part);",
			expect: "应插入一次文本",
		},
		{
			name: "插入的 alt 用整个文件名而不是主干",
			from: "\t\tconst alt = altTextForFile(file);",
			to: "\t\tconst alt = name ?? \"\";",
			expect: "插入的应是远端图片链接",
		},
		{
			name: "没有可插内容时也调用插入（在笔记里留下一个空行）",
			from: "\tif (text) insertText(editor, text, insertPoint);",
			to: "\tinsertText(editor, text, insertPoint);",
			expect: "不该插入任何东西",
		},
	],
});
