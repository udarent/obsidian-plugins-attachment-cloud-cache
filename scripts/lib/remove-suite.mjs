/**
 * 「缓存文件怎么删」的断言套件（`src/maintenance/remove.ts`）。
 *
 * ## 这里要钉住什么
 *
 * 这一个判断的两个取值，在用户眼里只差一件事：**磁盘空间是现在释放，
 * 还是等清空回收站**。选错了不会报错、也不会留下痕迹 —— 只会让用户觉得
 * "设了缓存上限，磁盘却一点没变"，或者反过来"我的文件被直接删了没处找"。
 *
 * 所以要有四组断言：
 *
 * 1. **认得出 `trash`**，且认不出的一律当默认（直接删除）—— 与设置层的回落方向一致；
 * 2. **文案后缀与真实原语必须一致**（不能出现"提示说进了回收站、其实已经删除"）；
 * 3. **两个原语各自只被调一个**；
 * 4. **失败必须抛出去**（吞掉失败会让上层把"没删掉"记成"删掉了"，
 *    于是汇报里腾出来的空间是假的）。
 */

import assert from "node:assert/strict";

/**
 * 一个只记账的极小替身。
 *
 * 刻意不用 `mock-obsidian.mjs`：那条路要连真实磁盘，而这里要看的只有一件事 ——
 * **调用了哪个宿主 API**。记账写在这里，断言才有依据。
 */
function makeAppRecorder() {
	const calls = { trash: [], delete: [], deleteForce: undefined };
	const app = {
		fileManager: {
			async trashFile(file) {
				calls.trash.push(file.path);
			},
		},
		vault: {
			async delete(file, force) {
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
	const { usesSystemTrash, deleteModeSuffix, removeCacheFile } = mod;

	// ============================================================
	// 1. 谁走回收站：只认 `trash`
	// ============================================================
	assert.equal(usesSystemTrash("trash"), true, "选了回收站就该走回收站");
	assert.equal(usesSystemTrash("permanent"), false, "选了直接删除就不该走回收站");

	// ⭐ 认不出的一律按**默认值**处理。理由不是"随便选一个"，而是：
	//   设置层（`settings.ts` 的字段表）已经把坏值回落成默认值了，
	//   所以这里保持一致 —— 两层对同一个坏值给出同一个答案。
	//   反过来写会得到一个极糟的状态：设置页显示"直接删除"，实际却送进了回收站，
	//   于是"空间没释放"成了一件查不出原因的事。
	const weirdValues = [undefined, null, "", "TRASH", "Trash", 42, {}, [], true];
	for (const weird of weirdValues) {
		assert.equal(
			usesSystemTrash(weird),
			false,
			`认不出的取值（${JSON.stringify(weird)}）必须与设置层的回落方向一致（默认直接删除）`
		);
	}

	// ============================================================
	// 2. ⭐ 文案后缀必须与真实行为同源
	// ============================================================
	// 这两者一旦分叉，症状是**误导用户**：提示说"已移入回收站"而文件其实被删了，
	// 用户会去回收站里找一个根本不在那儿的文件（反之则以为丢了、其实还在）。
	for (const mode of ["permanent", "trash", ...weirdValues]) {
		assert.equal(
			deleteModeSuffix(mode) === "trash",
			usesSystemTrash(mode),
			`对 ${JSON.stringify(mode)}：文案说「${deleteModeSuffix(mode)}」而实际走的是${usesSystemTrash(mode) ? "回收站" : "直接删除"} —— 两者必须一致`
		);
	}
	// 后缀就是 i18n 的键名片段（`cacheEvicted_${suffix}`），所以取值只能是这两个
	assert.equal(deleteModeSuffix("permanent"), "permanent", "后缀就是取值本身");
	assert.equal(deleteModeSuffix("trash"), "trash", "同上");

	const file = makeFile("_attachment-cache/a.png");

	// ============================================================
	// 3. 两个原语各自只被调一个
	// ============================================================
	{
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file, "trash");
		assert.deepEqual(calls.trash, [file.path], "★ 选了回收站就该走宿主的 trashFile");
		assert.deepEqual(calls.delete, [], "★ 同时**绝不能**也调直接删除（那是双删，且绕过了回收站）");
	}
	{
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file, "permanent");
		assert.deepEqual(calls.delete, [file.path], "★ 选了直接删除就该走 Vault.delete");
		assert.deepEqual(
			calls.trash,
			[],
			"★ 同时不该走回收站 —— 空间不会立刻释放，而这正是这个取值唯一的目的"
		);
		assert.equal(
			calls.deleteForce,
			undefined,
			"不该传 `Vault.delete` 的第二个参数：它只管文件夹的隐藏子项，传了会被读成「强制删除」"
		);
	}
	{
		// 坏值 → 与设置层的回落一致（直接删除）
		const { app, calls } = makeAppRecorder();
		await removeCacheFile(app, file, "TRASH");
		assert.deepEqual(calls.delete, [file.path], "认不出的取值按默认（直接删除）处理");
	}

	// ============================================================
	// 4. ⭐ 失败必须抛出去
	// ============================================================
	// 吞掉失败的后果很具体：`runEviction` 会把**没删掉**的文件计成"已淘汰 N 个、
	// 腾出 M MB"，并把它的索引记录摘掉 —— 于是汇报是假的；而记录一摘，
	// 渲染层会以为本地没有副本，又去重新下载一个**其实还在**的文件。
	const boom = new Error("回收站不可用");
	await assert.rejects(
		removeCacheFile(
			{ fileManager: { trashFile: async () => Promise.reject(boom) }, vault: {} },
			file,
			"trash"
		),
		/回收站不可用/,
		"★ 回收站失败要如实抛给调用方"
	);
	await assert.rejects(
		removeCacheFile(
			{ fileManager: {}, vault: { delete: async () => Promise.reject(boom) } },
			file,
			"permanent"
		),
		/回收站不可用/,
		"★ 直接删除失败同样要抛给调用方"
	);

	return { modes: 3, unknownValues: weirdValues.length, failurePaths: 2 };
}
