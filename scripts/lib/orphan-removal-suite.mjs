/**
 * 「把孤儿副本删掉」这一步的断言套件（`src/maintenance/orphan-removal.ts`）。
 *
 * ## 这里要钉住什么
 *
 * 这是全库**唯一**会删"用户自己的文件"的自动路径（触发点是**自动弹出的询问**），
 * 而它同时要处理两类完全不同的东西：
 *
 * | 副本在哪 | 走哪条路 | 判错的后果 |
 * |---|---|---|
 * | 缓存目录内（可再生） | `Vault.delete` | 空间没立刻释放 |
 * | 缓存目录外（**用户自己的附件**） | `FileManager.trashFile` | **永久删掉用户的图** |
 *
 * 所以替身**同时**提供 `trashFile` 与 `delete`（不是"少一个 API 所以走不了"，那是假通过），
 * 每条断言都看**调用了哪一个**。
 *
 * 另外两条纪律也在这里钉住，因为它们的后果都是"很久之后才显形"的：
 * ① 拿不到删除凭据（宿主文件索引滞后）时**文件与记录都不动**；
 * ② 删失败不算成功、也不摘记录，每次运行最多落盘一次。
 */

import assert from "node:assert/strict";

/** 一个记账替身：把"调用了哪个宿主 API"记下来。 */
function makeApp(files, options = {}) {
	const calls = { trash: [], delete: [], persisted: 0 };
	const app = {
		fileManager: {
			async trashFile(file) {
				if (options.trashThrows) throw new Error("回收站失败");
				calls.trash.push(file.path);
				delete files[file.path];
			},
		},
		vault: {
			getAbstractFileByPath: (path) => (files[path] ? { path } : null),
			async delete(file, force) {
				if (options.deleteThrows) throw new Error("删除失败");
				calls.delete.push(file.path);
				void force;
				delete files[file.path];
			},
		},
	};
	return { app, calls };
}

const cacheTarget = (key, path) => ({ key, path, isUserFile: false });
const userTarget = (key, path) => ({ key, path, isUserFile: true });

export async function runOrphanRemovalSuite(mod) {
	const { removeOrphanCopies } = mod;

	// ============================================================
	// 1. ⭐⭐ 用户自己的附件：走回收站，**绝不能直接删**
	// ============================================================
	// ⚠️ 这一条**刻意排在最前**：把两类副本走反的那个变异，应当在**这一条**上失败 ——
	// 那是这个模块最不可逆的失效（绕过回收站永久删掉用户的图）。
	// 排到后面的话，同一个变异会先在"缓存副本没走 delete"上红，
	// 报出的原因就与"用户的图被永久删了"这件事错位了。
	{
		const files = { "attachments/mine.png": true };
		const { app, calls } = makeApp(files);
		const removed = await removeOrphanCopies([userTarget("mine.png", "attachments/mine.png")], {
			app,
			forget: () => true,
			persist: async () => {},
			onPersistError: () => {},
		});
		assert.equal(removed, 1, "删掉了一个");
		assert.deepEqual(
			calls.trash,
			["attachments/mine.png"],
			"★★ 用户自己的附件必须走回收站（`localCopy: keep` 时索引里的 cachePath 就在附件目录里）"
		);
		assert.deepEqual(calls.delete, [], "★★ 绝不能直接删用户文件 —— 那是绕过回收站、不可恢复");
	}

	// ============================================================
	// 2. ⭐⭐ 缓存副本：直接删，**绝不碰回收站**
	// ============================================================
	{
		const files = { "_attachment-cache/a.png": true };
		const { app, calls } = makeApp(files);
		const removed = await removeOrphanCopies([cacheTarget("a.png", "_attachment-cache/a.png")], {
			app,
			forget: () => true,
			persist: async () => {
				calls.persisted += 1;
			},
			onPersistError: () => {},
		});
		assert.equal(removed, 1, "删掉了一个");
		assert.deepEqual(calls.delete, ["_attachment-cache/a.png"], "★ 缓存副本走 Vault.delete（空间立刻释放）");
		assert.deepEqual(calls.trash, [], "★ 缓存副本不许走回收站 —— 回收站不释放物理空间");
		assert.equal(files["_attachment-cache/a.png"], undefined, "文件真的没了");
	}

	// ============================================================
	// 3. 拿不到删除凭据（宿主文件索引滞后）⇒ 文件与记录都不动
	// ============================================================
	// 这条守的是"不绕过宿主自己删"。跳过时**也不能摘记录**：
	// 文件其实还在磁盘上，那条记录仍然是对的（摘了就变成"索引指向不存在的副本"）。
	{
		const { app, calls } = makeApp({});
		let forgotten = 0;
		const removed = await removeOrphanCopies([cacheTarget("a.png", "_attachment-cache/a.png")], {
			app,
			forget: () => {
				forgotten += 1;
				return true;
			},
			persist: async () => {
				calls.persisted += 1;
			},
			onPersistError: () => {},
		});
		assert.equal(removed, 0, "拿不到凭据 ⇒ 没删任何东西");
		assert.deepEqual(calls.delete, [], "★ 不绕过宿主自己删（那会留下「看得见、读不到」的幽灵条目）");
		assert.equal(forgotten, 0, "★ 也没摘记录 —— 文件其实还在，记录还是对的");
		assert.equal(calls.persisted, 0, "什么都没删 ⇒ 不该落盘");
	}

	// ============================================================
	// 4. 删失败：不算成功、不摘记录、如实记下来
	// ============================================================
	{
		const files = { "_attachment-cache/a.png": true, "_attachment-cache/b.png": true };
		const errors = [];
		let forgotten = 0;
		const { app, calls } = makeApp(files, { deleteThrows: true });
		const removed = await removeOrphanCopies(
			[cacheTarget("a.png", "_attachment-cache/a.png"), cacheTarget("b.png", "_attachment-cache/b.png")],
			{
				app,
				forget: () => {
					forgotten += 1;
					return true;
				},
				persist: async () => {
					calls.persisted += 1;
				},
				onPersistError: () => {},
				onDeleteError: (error, path) => errors.push(`${path}:${error.message}`),
			}
		);
		assert.equal(removed, 0, "★ 删失败不能记成删成功（否则汇报是假的）");
		assert.equal(errors.length, 2, "两个都失败、两个都记下来");
		assert.equal(forgotten, 0, "★ 没删掉就不摘记录");
		assert.equal(calls.persisted, 0, "没有任何变化 ⇒ 不落盘");
	}

	// ============================================================
	// 5. 一次失败不中断整批（用户要的是"把能清的清掉"）
	// ============================================================
	{
		const files = { "attachments/mine.png": true, "_attachment-cache/b.png": true };
		const { app, calls } = makeApp(files, { trashThrows: true });
		const removed = await removeOrphanCopies(
			[userTarget("mine.png", "attachments/mine.png"), cacheTarget("b.png", "_attachment-cache/b.png")],
			{
				app,
				forget: () => true,
				persist: async () => {
					calls.persisted += 1;
				},
				onPersistError: () => {},
				onDeleteError: () => {},
			}
		);
		assert.equal(removed, 1, "★ 第一个失败，第二个照删（一个失败不中断整批）");
		assert.deepEqual(calls.delete, ["_attachment-cache/b.png"], "删掉的正是第二个");
	}

	// ============================================================
	// 6. ⚠️ 索引落盘：整个运行**最多一次**（不是每个文件一次）
	// ============================================================
	{
		const files = { "_attachment-cache/a.png": true, "_attachment-cache/b.png": true, "_attachment-cache/c.png": true };
		const { app, calls } = makeApp(files);
		let forgotten = 0;
		await removeOrphanCopies(
			[
				cacheTarget("a.png", "_attachment-cache/a.png"),
				cacheTarget("b.png", "_attachment-cache/b.png"),
				cacheTarget("c.png", "_attachment-cache/c.png"),
			],
			{
				app,
				forget: () => {
					forgotten += 1;
					return true;
				},
				persist: async () => {
					calls.persisted += 1;
				},
				onPersistError: () => {},
			}
		);
		assert.equal(forgotten, 3, "三个记录都摘了");
		assert.equal(calls.persisted, 1, "★ 落盘只做一次（三个文件三次落盘是白写磁盘）");
	}

	// 反向：`forget` 说记录根本不存在（跳过的都算）⇒ 没有变化就不落盘
	{
		const files = { "_attachment-cache/a.png": true };
		const { app, calls } = makeApp(files);
		await removeOrphanCopies([cacheTarget("a.png", "_attachment-cache/a.png")], {
			app,
			forget: () => false,
			persist: async () => {
				calls.persisted += 1;
			},
			onPersistError: () => {},
		});
		assert.equal(calls.persisted, 0, "索引没有任何变化 ⇒ 不落盘");
	}

	// ============================================================
	// 7. 落盘失败：如实汇报（与批量清理同一条纪律）
	// ============================================================
	{
		const files = { "_attachment-cache/a.png": true };
		const { app } = makeApp(files);
		const reported = [];
		const removed = await removeOrphanCopies([cacheTarget("a.png", "_attachment-cache/a.png")], {
			app,
			forget: () => true,
			persist: async () => {
				throw new Error("写不进去");
			},
			onPersistError: (error) => reported.push(error.message),
		});
		assert.deepEqual(reported, ["写不进去"], "★ 索引存不下去必须说出来，不能静默");
		assert.equal(removed, 1, "文件确实删掉了 —— 汇报里删掉的数量仍然要对");
	}

	// ============================================================
	// 8. 空清单：一个 API 都不该被碰
	// ============================================================
	{
		const { app, calls } = makeApp({});
		const removed = await removeOrphanCopies([], {
			app,
			forget: () => true,
			persist: async () => {
				calls.persisted += 1;
			},
			onPersistError: () => {},
		});
		assert.equal(removed, 0, "空清单 ⇒ 0");
		assert.equal(calls.persisted, 0, "空清单不该落盘");
	}

	return { cases: 8 };
}
