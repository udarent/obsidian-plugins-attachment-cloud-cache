/**
 * 清单类界面的**纯逻辑**（`src/ui/task-list.ts`）断言套件。
 *
 * ## 守的是什么
 *
 * 三条链（上传附件 / 检查未被引用的云端附件 / 挑选要缓存的文件）现在共用一个清单式弹窗，
 * 而弹窗那一层**在测试里点不了**（宿主的 `Modal` 没有可编程的 DOM，
 * 替身的 `Setting.addButton` 是空操作）。所以能穷举的都搬到了这个纯模块里：
 *
 * - **进度的分母**：取"交给这一趟的件数"而不是清单行数 —— 用行数会让进度永远到不了 100%
 *   （用户看着弹窗，以为卡住了）；
 * - **哪些状态算走完**：`done` / `skipped` / `failed` 都是终态。只算 `done` 的话，
 *   一件失败就让进度停在 99%；
 * - **跳过与失败不是一回事**：合成一类会让用户去修一件本来不需要修的事（"已经在你自己的
 *   存储里了"不是故障），也会掩盖真正的失败；
 * - **勾中项按清单顺序交出去**：按 `Set` 的插入顺序会得到"用户点击的顺序"，
 *   既不稳定也不可复现。
 *
 * 断言在这里（与变异验证共用），入口在 `scripts/test-task-list.mjs`。
 */

import assert from "node:assert/strict";

export function runTaskListSuite(mod) {
	const { setTaskStatus, foldTaskProgress, selectionInOrder } = mod;

	// ============================================================
	// 1. 改一项状态：**返回新的 Map**，不改原来那一份
	// ============================================================
	{
		const before = new Map([["a", "pending"]]);
		const after = setTaskStatus(before, "a", "done");
		assert.equal(after.get("a"), "done", "状态要落到返回的那一份上");
		assert.equal(
			before.get("a"),
			"pending",
			"★ 改状态要返回新的 Map（状态多一个来源，界面就会显示 A、实际提交 B）"
		);
		assert.equal(setTaskStatus(after, "", "done").size, 1, "空键不该进状态表（它不是任何一行的身份）");
	}

	// ============================================================
	// 2. 进度折叠：分母是**交给这一趟**的件数，终态有三种
	// ============================================================
	{
		const statuses = new Map([
			["a", "done"],
			["b", "running"],
			["c", "failed"],
			["d", "skipped"],
		]);
		const progress = foldTaskProgress(statuses, 10);
		assert.equal(
			progress.total,
			10,
			"★ 进度的分母必须是**交给这一趟**的件数（拿清单行数当分母会让进度永远到不了 100%）"
		);
		assert.equal(progress.finished, 3, "★ 失败与跳过也算走完（只算 done 会让进度停在 99%）");
		assert.equal(progress.done, 1, "成功的一件单独计数");
		assert.equal(
			progress.skipped,
			1,
			"★ 跳过不是失败（合成一类会让用户去修一件本来不需要修的事：它只是没做）"
		);
		assert.equal(progress.failed, 1, "失败要单独计数（提示里要说清失败几个）");
		assert.equal(progress.running, "b", "正在跑的那一项要报出来（界面据此让那一行转起来）");

		// 边界：什么都没做 / 分母是 0 或坏值
		assert.deepEqual(
			foldTaskProgress(new Map(), 0),
			{ total: 0, finished: 0, done: 0, skipped: 0, failed: 0, running: null },
			"空进度不该凭空造数（界面靠 0/0 显示「没有要做的」）"
		);
		assert.equal(foldTaskProgress(new Map(), -3).total, 0, "坏分母按 0 处理（别让界面显示 -3）");
	}

	// ============================================================
	// 3. 勾中项：**按清单顺序**交出去，且只交清单里有的
	// ============================================================
	{
		const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
		const selected = new Set(["c", "a", "ghost"]);
		assert.deepEqual(
			selectionInOrder(rows, selected),
			["a", "c"],
			"★ 勾中项要按**清单顺序**交出去（点击顺序既不稳定也不可复现），且清单外的残留键不许泄进提交"
		);
		assert.deepEqual(selectionInOrder([], selected), [], "清单为空 ⇒ 什么都不交");
		assert.deepEqual(selectionInOrder([{ id: "" }], selected), [], "空 id 的行不算一行");
	}

	// ⚠️ 2026-10-24：原第 4 段（`buildTaskLabels` 造一套界面文字）随弹窗容器一起退役。
	// 它守的两条判据**没有丢**，只是搬到了生产调用点各自的守门人上：
	//   · 「主按钮要带勾选数」⇒ `verify:flows`（按钮数字＝能作用的件数）＋ 验收 §8i3（模板里必须真有 `{count}`）；
	//   · 「全选那句只维护一处」⇒ 现在只有附件管理一处在给 `labels`（`gallery-modal.ts`）。
	return { cases: 3 };
}
