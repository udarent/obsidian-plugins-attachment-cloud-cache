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
			// 后果：一次粘贴多张图、凭据错 ⇒ 连弹 N 条几乎一样的通知（与自动接管那条路不一致）。
			name: "多文件失败逐条提醒（不合并成一条）",
			from: "\tif (keepLocalFailures.length === 1) {",
			to: "\tif (keepLocalFailures.length >= 1) {",
			expect: "多文件失败应走合并文案",
		},
		{
			name: "失败提示不再给建议（用户看到的是原始 S3 响应体）",
			from: "\t\t\t\tconst hint = hintTextFor(result.error, deps.t) ?? describeError(result.error ?? \"unknown\");",
			to: "\t\t\t\tconst hint = describeError(result.error ?? \"unknown\");",
			expect: "s3HintAccessDenied",
		},
		{
			name: "降级时不插入任何内容（⭐ 图保住了，但笔记里什么都没有）",
			from: "\t\t\tif (result.localPath) {\n\t\t\t\t// 降级链接：形态交回宿主（按用户的「新链接格式」设置），`!` 由我们按类型表加。\n\t\t\t\tconst generated = deps.generatedLocalLink ? deps.generatedLocalLink(result.localPath) : null;\n\t\t\t\tpushPart(buildLocalLink(generated, result.localPath, result.ext), file);",
			to: "\t\t\tif (false) {\n\t\t\t\tconst generated = deps.generatedLocalLink ? deps.generatedLocalLink(result.localPath) : null;\n\t\t\t\tpushPart(buildLocalLink(generated, result.localPath, result.ext), file);",
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
			from: "\t\t\toutcome.lost += 1;\n\t\t\tdeps.notify(deps.t(\"hookLocalFallbackFailed\", { error: describeError(error) }));\n\t\t\tcontinue;\n\t\t}\n\n\t\tlet result: IngestResult;",
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
			// ⚠️ 这条原本打的是 `const displayName = displayNameOf(file);`。2026-10-14 起
			// 显示名的**首选**是 `result.displayName`（= key 里的名字），那一步坏掉会被它兜住
			// ⇒ 变异**不再产生任何后果**（实测报"漏过：测试无牙"）。
			// ⇒ 锚点挪到三层回退的**最终表达式**上，守的东西没变：名字取不到时链接文字会变成
			// 别的东西（乱码 / 类型串），用户认不出这是哪个文件。
			name: "链接的显示名取不到（用户认不出这是哪个文件）",
			from: "result.displayName || displayName || result.name",
			to: 'String(file.type ?? "")',
			expect: "插入的应是远端嵌入链接",
		},
		{
			name: "没有可插内容时也调用插入（在笔记里留下一个空行）",
			from: "\tif (text) insertText(editor, text, insertPoint);",
			to: "\tinsertText(editor, text, insertPoint);",
			expect: "不该插入任何东西",
		},
		{
			// 后果：同一次粘贴里同一张图被插两条（或更多）链接 —— 用户看到的是
			// "粘了一张图，出现两张一样的图"（实测报过）。剪贴板把同一张图给成多份
			// 是常态（files 一份 + items 一份，包装对象不同、元数据也可能不同）。
			// ⚠️ 2026-10-14：判据从"产出的文本"换成了"**输入**的文件身份"（见 `pushPart`
			// 注释：D-24 之后同内容异名的两份文件会产出**逐字相同**的链接，拿文本判会把
			// 第二份吞掉）—— 锚点跟着换到新判据那一行，**否则它会静默失效**
			//（`from` 找不到就不再变异，输出还是一片绿）。
			name: "★ 插入不再去重（同一张图被插成两条链接）",
			from: "\t\tif (inserted.has(id)) return;",
			to: "\t\tif (false) return;",
			// ⚠️ 实际先说话的是**既有**那条用例（"★ 同一张图重复出现时只该插一条链接"，它在
			// 7f-3 之前）—— 那一条的 message 带插值（报出实际文本），所以 expect 只取它前面的静态片段。
			expect: "★ 同一张图重复出现时只该插一条链接",
		},
		// ⚠️ 2026-10-29（CR-18）：原先这里还有一条「插入按产出文本去重（同内容异名的第二份
		// 被吞掉）」—— 现在**删掉了**，因为那个缺陷在新形状下**不可能发生**：
		// 同内容异名（`a.png` / `a-copy.png`）改完之后产出文本**不同**（各自保留自己的显示名），
		// 于是"按文本去重"根本不会把它们并到一起 ⇒ 那条变异改完什么都不变（全量跑出"漏过"）。
		// ⭐ 去重本身仍有守护者：上面 7f-3 那条（同一个文件的两个包装只插一条）守的是
		// `pushPart` 按**输入身份**去重，与"产出文本"是两件事 —— 别再为了"补一条变异"把它改回去。
	],
});
