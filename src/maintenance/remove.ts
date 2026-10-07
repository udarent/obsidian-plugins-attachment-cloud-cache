/**
 * 「把一个缓存文件拿掉」这一步的**唯一**实现。
 *
 * ## 为什么值得单独一个模块
 *
 * 这是全库仅有的、真的会**删文件**的地方，而它有两个互斥的取值。两者的区别
 * 只落在用户能感知的那一件事上：**磁盘空间是现在释放，还是等清空回收站**。
 * 选错了不会报错，只会让用户觉得"设了缓存上限，磁盘空间却一点没变"。
 *
 * 所以"用哪个原语"必须有**一处**定义、且能被穷举断言 —— 而不是在两条调用路径上
 * 各写一个 if（那种写法迟早会分叉，而分叉的症状是两个入口行为不一致）。
 *
 * ## 两个原语都是宿主级的
 *
 * | 取值 | 用的 API | 磁盘空间 |
 * |---|---|---|
 * | `permanent`（默认） | `vault.delete()` | **立刻**释放 |
 * | `trash` | `fileManager.trashFile()` | 等系统清空回收站 |
 *
 * ⚠️ **绝不用 `adapter.remove`。** 这条纪律在引入「直接删除」之后**依然成立**，
 * 而且理由变得更清楚：`adapter.remove` 绕开的是**宿主的文件索引**，
 * 不是"回收站设置"。那样删掉之后，文件在磁盘上没了，而宿主的 `getFiles()`
 * 仍然认得它 —— 留下"看得见、读不到"的幽灵条目，渲染层还会照着它去换
 * `app://` 地址然后加载失败。
 *
 * 换句话说：**要直接删就用 `vault.delete`，而不是绕开宿主自己删。**
 * 前者是"我们告诉宿主把这个文件彻底删掉"，后者是"我们背着宿主改了它的地盘"。
 *
 * ⚠️ 社区 lint 规则 `obsidianmd/prefer-file-manager-trash-file` 会对下面那行
 * `vault.delete` 报警（它的立场是"删除一律走回收站"）。这条规则已经**有意**
 * 在这个文件上关掉，理由写在 `eslint.config.mts` 里紧挨着那一条的位置 ——
 * 只关这一个文件，其余地方若冒出 `vault.delete` 仍会被报出来。
 */

import type { App, TAbstractFile } from "obsidian";

import type { DeleteMode } from "../types";

/**
 * 这个取值是不是"走系统回收站"。
 *
 * ## 为什么认不出的一律当「直接删除」
 *
 * 因为**另一层已经保证过取值合法**：`settings.ts` 的字段表用 `oneOfValue(DELETE_MODES)`
 * 读这个字段，任何看不懂的值都会被回落成默认值（`permanent`）。所以这里
 * "只认 `trash`、其余当直接删除"恰好与那一层的回落方向一致 ——
 * 两层对同一个坏值给出**同一个**答案。
 *
 * 反过来写（认不出的走回收站）就危险了：设置页显示"直接删除"，实际却送进回收站，
 * 用户会得到一个"空间没释放"且查不出原因的状态。**两处不一致比任一种选择都糟。**
 */
export function usesSystemTrash(mode: unknown): boolean {
	return mode === "trash";
}

/**
 * 文案 key 的后缀：`cacheEvicted_permanent` / `cacheEvicted_trash`。
 *
 * 放在这里而不是散在各调用处，是为了让"模式 → 文案"这条映射也只有一处：
 * 通知里"删掉了"和"移进了回收站"是两句话，说错会让用户去回收站里找一个
 * 根本不存在的文件（或反过来，以为还能找回已经删掉的东西）。
 */
export function deleteModeSuffix(mode: unknown): DeleteMode {
	return usesSystemTrash(mode) ? "trash" : "permanent";
}

/**
 * 按设置里的方式删掉一个文件。
 *
 * 调用方负责**先确认删除凭据**（宿主的文件索引可能滞后于磁盘，
 * 那时 `getAbstractFileByPath` 返回 null）并复核路径在缓存目录内 ——
 * 那些判断在 `run.ts` 里，因为只有它知道"什么算可以删的"。
 */
export async function removeCacheFile(app: App, file: TAbstractFile, mode: unknown): Promise<void> {
	if (usesSystemTrash(mode)) {
		// 走宿主的回收站：尊重用户"删除即进回收站"的全局设置（可能是系统回收站，
		// 也可能是 vault 内的 `.trash/`）
		await app.fileManager.trashFile(file);
		return;
	}
	// 官方文档原话是 "Deletes the file completely" —— 不经回收站。
	// 第二个参数 `force` 只关"文件夹里有隐藏子项时要不要照删"，对文件无意义。
	await app.vault.delete(file);
}
