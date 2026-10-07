import { runMutations } from "./lib/mutate.mjs";
import { runRemoveSuite } from "./lib/remove-suite.mjs";

/**
 * 变异验证：「缓存文件怎么删」这一处的判断（`src/maintenance/remove.ts`）。
 *
 * 这一层是**全库唯一**真的会删文件的地方，两条调用路径都从这里过。
 * 每条变异对应的都是"不报错、但后果具体"的失效：
 *
 * - 该走回收站的走了直接删除 ⇒ 用户以为能还原，回收站里却什么都没有；
 * - 该直接删除的走了回收站 ⇒ 用户设了上限，磁盘空间却一直不释放（而这正是他设上限的原因）；
 * - 删失败被吞掉 ⇒ 上层把"没删掉"记成"已淘汰、腾出 N MB"，汇报是假的，
 *   而且索引记录已被摘掉（于是又去重新下载一个其实还在的文件）。
 */
await runMutations({
	source: "src/maintenance/remove.ts",
	entries: ["src/maintenance/remove", "src/types"],
	suite: runRemoveSuite,
	mutations: [
		{
			// 后果：认不出的值走回收站 ⇒ 与设置层的回落方向**分叉**：
			// 设置页显示"直接删除"，实际却送进了回收站，于是"空间没释放"查不出原因。
			name: "★ 认不出的取值当回收站（与设置层的回落方向分叉）",
			from: '\treturn mode === "trash";',
			to: '\treturn mode !== "permanent";',
			expect: "认不出的取值",
		},
		{
			// 后果：用户选了「移入系统回收站」（他看重可还原），实际却被直接删掉 ——
			// 提示还说"已移入回收站"，他会去回收站里找一个不在那儿的文件。
			name: "★ 选了回收站却走直接删除（用户以为可还原，其实已抹除）",
			from: "\tif (usesSystemTrash(mode)) {",
			to: "\tif (!usesSystemTrash(mode)) {",
			expect: "选了回收站就该走宿主",
		},
		{
			// 后果：**双删** —— 先进回收站、再从回收站里被彻底删掉。
			// 于是"删错了还能找回来"这句话不再成立（这正是那个选项唯一的卖点）。
			name: "★ 回收站删完又直接删（双删：可还原的那个选项失去意义）",
			from: "\t\tawait app.fileManager.trashFile(file);\n\t\treturn;\n",
			to: "\t\tawait app.fileManager.trashFile(file);\n",
			expect: "双删",
		},
		{
			// 后果：用户选了「直接删除」想立刻腾出空间，实际却走了回收站 ——
			// 文件离开 vault、空间还占着，于是"设了上限，磁盘还是满的"。
			name: "★ 选了直接删除却走回收站（空间永远不释放，而这正是他设上限的原因）",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.fileManager.trashFile(file);",
			expect: "选了直接删除就该走",
		},
		{
			// 后果：删失败被吞掉 ⇒ 上层把"没删掉"记成"已淘汰 N 个、腾出 M MB"，
			// 并把索引记录摘掉 —— 汇报是假的，渲染层还会去重新下载一个**其实还在**的文件。
			name: "★ 删失败被吞掉（汇报腾出了空间，其实文件还在）",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.vault.delete(file).catch(() => undefined);",
			expect: "直接删除失败同样要抛给调用方",
		},
		{
			// 后果：把 `force` 当成"强制永久删除"传进去。它真正的语义是
			// "文件夹里有隐藏子项时也照删"，传了会让后来的人读错这行代码的意思。
			name: "把 `Vault.delete` 的第二个参数当「强制删除」传进去",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.vault.delete(file, true);",
			expect: "第二个参数",
		},
		{
			// 后果：文案与行为分叉 —— 通知说"已移入回收站"，而文件其实已经删了。
			name: "★ 文案后缀与实际行为分叉（说进了回收站，其实已删除）",
			from: '\treturn usesSystemTrash(mode) ? "trash" : "permanent";',
			to: '\treturn usesSystemTrash(mode) ? "permanent" : "trash";',
			expect: "两者必须一致",
		},
	],
});
