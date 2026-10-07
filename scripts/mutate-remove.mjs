import { runMutations } from "./lib/mutate.mjs";
import { runRemoveSuite } from "./lib/remove-suite.mjs";

/**
 * 变异验证：删除原语的唯一实现（`src/maintenance/remove.ts`）。
 *
 * 这一层是**全库唯一**真的会删文件的地方，两条调用路径都从这里过。
 * 每条变异对应的都是"不报错、但后果具体"的失效：
 *
 * - 改用回收站 ⇒ 用户设了上限，磁盘空间却一直不释放（而那正是他设上限的原因）；
 * - 删失败被吞掉 ⇒ 上层把"没删掉"记成"已删掉、腾出 N MB"，汇报是假的，
 *   而且索引记录已被摘掉（于是又去重新下载一个其实还在的文件）；
 * - 不 await ⇒ 记录先被摘而文件还在磁盘上，同样的后果。
 *
 * ⚠️ 套件里"不许走回收站"那条**排在最前**，正是为了让第一条变异因**自己的原因**失败，
 * 而不是先撞上"没调用 delete"。
 */
await runMutations({
	source: "src/maintenance/remove.ts",
	entries: ["src/maintenance/remove", "src/types"],
	suite: runRemoveSuite,
	mutations: [
		{
			// 后果：走了回收站 ⇒ 文件离开 vault、物理空间却还占着，
			// 于是"设了缓存上限，磁盘还是满的"—— 而这正是那个备选被去掉的原因。
			name: "★ 改用回收站（空间不释放，上限形同虚设）",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.fileManager.trashFile(file);",
			expect: "不许走回收站",
		},
		{
			// 后果：同一份文件被删两次。本身大多无害，但它说明调用点重复了 ——
			// 而在一个"删文件"的地方，重复调用是最不该出现的不确定性。
			name: "重复删除（调用点重复的迹象）",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.vault.delete(file);\n\tawait app.vault.delete(file);",
			expect: "恰好一次",
		},
		{
			// 后果：`force` 的语义是"文件夹里有隐藏子项时也照删"，对单个文件没有意义。
			// 传了会让后来的人把这行误读成"强制永久删除"。
			name: "把 `Vault.delete` 的第二个参数当「强制删除」传进去",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.vault.delete(file, true);",
			expect: "第二个参数",
		},
		{
			// 后果：不等删除完成就返回 ⇒ 调用方紧接着摘掉索引记录，而文件还在磁盘上，
			// 渲染层会以为本地没有副本、又去下载一个**其实还在**的文件。
			name: "★ 不等删除完成就返回（记录先被摘，文件还在）",
			from: "\tawait app.vault.delete(file);",
			to: "\tvoid app.vault.delete(file);",
			expect: "必须已经完成",
		},
		{
			// 后果：删失败被吞掉 ⇒ 上层把"没删掉"记成"已删掉 N 个、腾出 M MB"，
			// 并把索引记录摘掉 —— 汇报是假的。
			name: "★ 删失败被吞掉（汇报腾出了空间，其实文件还在）",
			from: "\tawait app.vault.delete(file);",
			to: "\tawait app.vault.delete(file).catch(() => undefined);",
			expect: "如实抛给调用方",
		},
	],
});
