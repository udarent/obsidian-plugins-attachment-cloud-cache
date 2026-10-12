/**
 * 「把孤儿副本删掉」这一步的断言套件（`src/maintenance/orphan-removal.ts`）。
 *
 * ## 这里要钉住什么
 *
 * 这是用户**明确确认**之后删本地副本的那条路（触发点是自动弹出的询问）。
 * 1.2.0（D-17）起删法**只有一种**：`FileManager.trashFile` —— 那份副本同时可能就是
 * 用户附件目录里的原件，判据不是「文件在哪」而是「能不能重新拿到」。
 *（要立刻腾空间的是**上限淘汰**那条自动路径，它用 `Vault.delete`，但另有一套
 * 云端 HEAD 前置复核 —— 两条路别混。）
 *
 * 所以替身**同时**提供 `trashFile` 与 `delete`（不是「少一个 API 所以走不了」，那是假通过），
 * 而断言里 `delete` 必须**始终为空** —— 一旦有人把这条路的删法改回直接删，
 * 那就是绕过回收站永久删掉用户的图。
 *
 * 另外两条纪律也在这里钉住，因为它们的后果都是「很久之后才显形」的：
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
				if (options.trashThrows || options.trashThrowsFor === file.path) {
				  throw new Error("回收站失败");
				}
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

const target = (key, path) => ({ key, path });

export async function runOrphanRemovalSuite(mod) {
	const { removeOrphanCopies } = mod;

	// ============================================================
	// 1. ⭐⭐ 只有一种删法：走回收站，**绝不能直接删**
	// ============================================================
	// ⚠️ 这一条**刻意排在最前**：把删法改成「直接删」的那个变异，应当在**这一条**上失败 ——
	// 那是这个模块最不可逆的失效（绕过回收站永久删掉用户的图）。
	{
		const files = { "attachments/mine.png": true };
		const { app, calls } = makeApp(files);
		const removed = await removeOrphanCopies([target("mine.png", "attachments/mine.png")], {
			app,
			forget: () => true,
			persist: async () => {},
			onPersistError: () => {},
		});
		assert.equal(removed, 1, "删掉了一个");
		assert.deepEqual(
			calls.trash,
			["attachments/mine.png"],
			"★ 走回收站（索引里的 cachePath 就是用户附件目录里那份）"
		);
		assert.deepEqual(calls.delete, [], "★★ 绝不能直接删 —— 那是绕过回收站、不可恢复");
	}

	// ============================================================
	// 2.（已删除）「缓存副本 ⇒ Vault.delete」
	//
	// 1.2.0（D-17）取消了缓存目录 ⇒ 那个分支**永远不会命中**，随之删掉。
	// 留一句说明而不是留一条用例：死主题的断言永远绿，还会让人以为那条路还在。
	// ============================================================

	// 3. 拿不到删除凭据（宿主文件索引滞后）⇒ 文件与记录都不动
	// ============================================================
	// 这条守的是"不绕过宿主自己删"。跳过时**也不能摘记录**：
	// 文件其实还在磁盘上，那条记录仍然是对的（摘了就变成"索引指向不存在的副本"）。
	{
		const { app, calls } = makeApp({});
		let forgotten = 0;
		const removed = await removeOrphanCopies([target("a.png", "attachments/a.png")], {
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
		const files = { "attachments/a.png": true, "attachments/b.png": true };
		const errors = [];
		let forgotten = 0;
		const { app, calls } = makeApp(files, { trashThrows: true });
		const removed = await removeOrphanCopies(
			[target("a.png", "attachments/a.png"), target("b.png", "attachments/b.png")],
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
		const files = { "attachments/mine.png": true, "attachments/b.png": true };
		const { app, calls } = makeApp(files, { trashThrowsFor: "attachments/mine.png" });
		const removed = await removeOrphanCopies(
			[target("mine.png", "attachments/mine.png"), target("b.png", "attachments/b.png")],
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
		assert.equal(
			removed,
			1,
			"★ 第一个失败（只让它失败），第二个照删 —— 一个失败不该中断整批"
		);
		assert.deepEqual(calls.trash, ["attachments/b.png"], "删掉的正是第二个（只有第一个路径被注入失败）");
	}

	// ============================================================
	// 6. ⚠️ 索引落盘：整个运行**最多一次**（不是每个文件一次）
	// ============================================================
	{
		const files = { "attachments/a.png": true, "attachments/b.png": true, "attachments/c.png": true };
		const { app, calls } = makeApp(files);
		let forgotten = 0;
		await removeOrphanCopies(
			[
				target("a.png", "attachments/a.png"),
				target("b.png", "attachments/b.png"),
				target("c.png", "attachments/c.png"),
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
		const files = { "attachments/a.png": true };
		const { app, calls } = makeApp(files);
		await removeOrphanCopies([target("a.png", "attachments/a.png")], {
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
		const files = { "attachments/a.png": true };
		const { app } = makeApp(files);
		const reported = [];
		const removed = await removeOrphanCopies([target("a.png", "attachments/a.png")], {
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
