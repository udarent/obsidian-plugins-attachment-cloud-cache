import { runMutations } from "./lib/mutate.mjs";
import { runOrphanRemovalSuite } from "./lib/orphan-removal-suite.mjs";

/**
 * 变异验证：删掉孤儿副本（`src/maintenance/orphan-removal.ts`）。
 *
 * 这一层是**自动弹出的询问**背后真正动手删文件的地方，而它删的可能是
 * **用户自己的附件**。三个变异各对应一种"看起来很小、后果不可逆"的退化：
 * - 两类副本走反 ⇒ 绕过回收站永久删掉用户的图；
 * - 删失败也摘记录 ⇒ 索引与磁盘脱节（渲染层以为没副本，又去下回来）；
 * - 先计数后删除 ⇒ 上报"已清理 N 个"而文件还在。
 */
await runMutations({
	source: "src/maintenance/orphan-removal.ts",
	entries: ["src/maintenance/orphan-removal"],
	suite: runOrphanRemovalSuite,
	mutations: [
		{
			// 后果：**用户自己的附件**被当成缓存副本 ⇒ 直接删、绕过回收站 ⇒ 不可恢复。
			// `localCopy: "keep"` 时索引里的 cachePath 就在附件目录里，这是常态而非边角。
			name: "★★ 两类副本走反（用户自己的附件被直接永久删除）",
			from: "\t\t\tif (target.isUserFile) await deps.app.fileManager.trashFile(file);\n\t\t\telse await removeCacheFile(deps.app, file);",
			to: "\t\t\tif (target.isUserFile) await removeCacheFile(deps.app, file);\n\t\t\telse await deps.app.fileManager.trashFile(file);",
			expect: "用户自己的附件必须走回收站",
		},
		{
			// 后果：没删掉却记成删成了 ⇒ 文件还在磁盘上、上报却是"已清理 N 个"；
			// 紧接着索引记录也被摘掉，渲染层于是以为"本地没有副本"，
			// 又去下载一个**其实还在**的文件。
			// ⚠️ 变异只动 `catch` 那一支（不碰成功路径）：两者都会让计数变假，
			// 但只有这一支对应"删失败"这件事 —— 混在一起的话，套件会先在成功路径上红。
			name: "★ 删失败也算删成（计数与索引记录一起说谎）",
			from: "\t\t\tdeps.onDeleteError?.(error, target.path);\n\t\t\tcontinue;",
			to: "\t\t\tdeps.onDeleteError?.(error, target.path);\n\t\t\tremoved += 1;\n\t\t\tif (deps.forget(target.key)) dirty = true;\n\t\t\tcontinue;",
			expect: "删失败不能记成删成功",
		},
		{
			// 后果：宿主文件索引滞后（文件其实还在）时**绕过宿主自己删** ——
			// 留下"看得见、读不到"的幽灵条目，渲染层还会照着它去加载然后失败。
			name: "★ 拿不到删除凭据也照删（绕过宿主的文件索引）",
			from: "\t\tconst file = deps.app.vault.getAbstractFileByPath(target.path);\n\t\t// 纪律 2：拿不到删除凭据 ⇒ 文件与记录都不动\n\t\tif (!file) continue;",
			to: "\t\tconst file = deps.app.vault.getAbstractFileByPath(target.path) || { path: target.path };",
			expect: "拿不到凭据",
		},
		{
			// 后果：每个文件落盘一次 ⇒ 用户一次清掉几个时，把整份索引反复序列化重写。
			name: "★ 每个文件落盘一次（索引被反复整份重写）",
			from: "\t\tremoved += 1;\n\t\tif (deps.forget(target.key)) dirty = true;",
			to: "\t\tremoved += 1;\n\t\tif (deps.forget(target.key)) await deps.persist();",
			expect: "落盘只做一次",
		},
	],
});
