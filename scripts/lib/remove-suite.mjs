/**
 * 「把缓存文件拿掉」这一步的断言套件（`src/maintenance/remove.ts`）。
 *
 * ## 这里要钉住什么
 *
 * 缓存清理**只有一种方式：直接删除**，磁盘空间立刻释放 —— 那正是「设上限」要解决的问题。
 * 「移入系统回收站」这个备选被**有意去掉了**：它让物理空间一直占着，
 * 与"空间有限"这个动机直接矛盾（用户设上限的期待是"空间被腾出来"）。
 *
 * 所以本套件守三件事：
 *
 * 1. **不许碰回收站。** 替身**同时**提供 `trashFile` 与 `delete` —— 这样"没走回收站"
 *    是一条真断言，而不是"因为它没有那个 API 所以走不了"（后者是假通过）。
 * 2. **必须等删除真的完成。** 调用方（淘汰与清理）紧接着就要摘索引记录；
 *    不等的话记录先被摘掉而文件还在磁盘上，渲染层会以为本地没有副本、
 *    又去下载一个**其实还在**的文件。
 * 3. **失败必须抛出去。** 吞掉失败等于把"没删掉"记成"已删掉、腾出 N MB"。
 *
 * ⚠️ 这里删的**只是缓存副本**（笔记里存的始终是远端地址，副本会重新下载）；
 * 与"上传后不留本地副本"（`localCopy: "trash"`）删**用户自己的文件**是两回事 ——
 * 后者仍然走回收站，不受本套件约束。那条边界由 `test-remove.mjs` 的静态守卫把着。
 */

import assert from "node:assert/strict";

/**
 * 一个只记账的极小替身。
 *
 * 刻意不用 `mock-obsidian.mjs`：那条路要连真实磁盘，而这里要看的只有一件事 ——
 * **调用了哪个宿主 API**。记账写在这里，断言才有依据。
 */
function makeAppRecorder(options = {}) {
	const calls = { trash: [], delete: [], deleteForce: undefined };
	const app = {
		fileManager: {
			async trashFile(file) {
				calls.trash.push(file.path);
			},
		},
		vault: {
			async delete(file, force) {
				if (options.deleteDelayMs) {
					await new Promise((resolve) => setTimeout(resolve, options.deleteDelayMs));
				}
				if (options.deleteThrows) throw new Error("删除失败");
				calls.delete.push(file.path);
				// 记下第二个参数：`Vault.delete` 的 `force` 只管"文件夹里有隐藏子项"，
				// 传它会让读代码的人以为"force = 强制永久删除"。真实调用不该传。
				calls.deleteForce = force;
			},
		},
	};
	return { app, calls };
}

/** 一个最小的"文件"（调用方负责校验路径，这里只需要 `path`）。 */
function makeFile(path) {
	return { path, name: path.split("/").pop() };
}

export async function runRemoveSuite(mod) {
	const { removeCacheFile } = mod;
	const file = makeFile("_attachment-cache/a.png");

	// ============================================================
	// 1. ⭐ 绝不碰回收站 —— 这是"备选方案已被去掉"的核心断言
	// ============================================================
	// ⚠️ 这条**刻意排在最前**：把实现换成 `trashFile` 的变异，应当在**这一条**上失败，
	// 而不是先撞上"没调用 delete"（那会让报出的原因与变异意图不符）。
	//
	// 替身**提供了** `trashFile`，所以这条不是"因为没有才没用"。
	// 它同时也是防回归的钉子：将来若有人把"移入回收站"这个备选加回来，
	// 这一条会立刻红 —— 而那个决定的后果是具体的：
	// 用户设了上限，磁盘空间却一直不释放。
	{
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file);
		assert.deepEqual(
			calls.trash,
			[],
			"★ 缓存清理不许走回收站 —— 回收站不释放物理空间，与「空间有限」的动机直接矛盾"
		);
	}

	// ============================================================
	// 2. 只用 `Vault.delete`，且**恰好一次**
	// ============================================================
	// ⚠️ 计数断言排在 `deepEqual` 之前：它是更**具体**的那条 —— "删了两次"与
	// "删错了对象"是两种不同的失效，而重复删除的变异应该报出前者。
	{
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file);
		assert.equal(calls.delete.length, 1, "★ 缓存文件必须被 Vault.delete 删除，且恰好一次");
		assert.deepEqual(calls.delete, [file.path], "★ 要走 Vault.delete（立刻释放空间的那个原语），且删的是那个文件");
	}

	// ============================================================
	// 3. ⭐ 必须等删除真的完成（调用方紧接着要摘索引记录）
	// ============================================================
	// 这条断言的形状是刻意的：让替身的 `delete` 慢一拍，然后**在 await 之后**检查。
	// 实现若写成 `void app.vault.delete(file)`（不 await），这里会看到"还没删"。
	{
		const { app, calls } = makeAppRecorder({ deleteDelayMs: 5 });
		await removeCacheFile(app, file);
		assert.deepEqual(
			calls.delete,
			[file.path],
			"★ `removeCacheFile` 返回时删除必须已经完成 —— 调用方紧接着就要摘索引记录"
		);
	}

	// ============================================================
	// 4. 不传 `Vault.delete` 的第二个参数
	// ============================================================
	// `force` 的语义是"文件夹里有隐藏子项时也照删"，对单个文件没有意义。
	// 传它会让后来的人把这行读成"强制永久删除"，而那句解释是错的。
	{
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file);
		assert.equal(
			calls.deleteForce,
			undefined,
			"不该传 `Vault.delete` 的第二个参数（它只管文件夹的隐藏子项，不是「强制删除」）"
		);
	}

	// ============================================================
	// 5. ⭐ 失败必须抛出去
	// ============================================================
	// 吞掉失败的后果很具体：`runEviction` / `runCleanup` 会把**没删掉**的文件计成
	// "已删掉 N 个、腾出 M MB"，并把它的索引记录摘掉 —— 于是汇报是假的；
	// 而记录一摘，渲染层会以为本地没有副本，又去重新下载一个**其实还在**的文件。
	await assert.rejects(
		removeCacheFile(makeAppRecorder({ deleteThrows: true }).app, file),
		/删除失败/,
		"★ 删除失败要如实抛给调用方（吞掉会让上层把「没删掉」记成「已腾出空间」）"
	);

	return { primitives: 1, awaitsCompletion: true, failurePaths: 1 };
}
