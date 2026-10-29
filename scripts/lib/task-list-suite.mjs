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

// ⚠️ 与 `load-ts` 打进 bundle 的那份**是同一个实例**（`obsidian` 被映射到这里），
// 所以能通过 `Notice.instances` 观察"进度条到底往通知里放了什么"。
import { Notice } from "./mock-obsidian.mjs";

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

	// ============================================================
	// N. 「上传全部附件」进度条的**步长**（`plugin/upload-existing-flow.ts`）
	//
	// 为什么放在这个套件里：它和 `foldTaskProgress` 是同一类东西（进度的算术），
	// 而它守的风险也很具体 —— 步长算错时进度条**看着卡住**（节流过头，50 件只动一两次），
	// 或者干脆为 0（`% 0` 得 NaN ⇒ 一次都不更新，用户对着 0/50 等到结束）。
	// ⚠️ 那条链以前**一个逐项回调都不传**，界面上什么都没有（用户 2026-10-29 报的）。
	// ============================================================
	const stepFor = mod.progressStepFor;
	assert.ok(typeof stepFor === "function", "★ `progressStepFor` 必须能从这里拿到（拿不到说明接线断了，别让这组断言空转）");
	assert.equal(stepFor(0), 1, "★ 0 件也要给 1 —— 步长为 0 时 `%` 得 NaN ⇒ 进度一次都不更新");
	assert.equal(stepFor(1), 1, "1 件：每件都更新");
	assert.equal(stepFor(50), 1, "★ 少于上限时必须 1 件一更新（否则一小批也只会动一两次，看着像卡住）");
	assert.equal(stepFor(100), 1, "正好等于上限（100）时仍是 1 件一更新");
	assert.equal(stepFor(250), 3, "250 件 ⇒ 每 3 件一次（约 83 次更新）");
	assert.equal(stepFor(1000), 10, "1000 件 ⇒ 每 10 件一次（正好 100 次）");
	assert.ok(stepFor(9999) >= 1, "★ 再大也不许返回 0");

	// ── 进度条本身（DOM 序列）：真机验不了，只能在这一层钉住 ──
	//
	// ⚠️ 为什么不跑真机：演示库的 `localCopy` 是 `trash`，跑一次真实上传会把库里的
	// 附件送进回收站 —— 拿用户的库换一次"进度条长什么样"不值得。所以这里驱动
	// `openProgress`（它只依赖 `t`），断言它往通知里放了什么、随计数怎么动、收尾怎么变。
	const t = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);
	const before = Notice.instances.length;
	const progress = mod.openProgress({ t }, 4);
	const notice = Notice.instances.at(-1);
	assert.equal(Notice.instances.length, before + 1, "★ 进度**只占一条**通知（D-80：多条会叠成一摞）");
	assert.equal(notice.timeout, 0, "★ 必须是常驻（`duration: 0`）—— 5 秒自动消失的进度条等于没有");

	const bar = notice.noticeEl.children.find((child) => child.tag === "progress");
	const label = notice.noticeEl.children.find((child) => child.tag === "div");
	assert.ok(bar, "★ 通知里必须真的挂了一个 <progress>（没有它，用户看到的就只是一行字）");
	assert.equal(bar.attrs.max, "4", "进度条上限 = 这一趟的件数");
	assert.equal(bar.attrs.value, "0", "开跑前是 0");
	assert.ok(label?.textContent.includes("uploadAllProgressCount"), `★ 初始文案要说清「N / M」，实际 ${label?.textContent}`);

	// 一件一件走到满：`step` 在 4 件时是 1 ⇒ 每一件都该推动进度条
	progress.tick("done");
	assert.equal(bar.value, 1, "第 1 件 ⇒ 1");
	progress.tick("failed");
	assert.equal(bar.value, 2, "★ 失败也算「处理过了」（否则一整批都在失败时进度永远不动）");
	assert.ok(label.textContent.includes("uploadAllProgressCountFailed"), `★ 有失败要当场说出来，实际 ${label.textContent}`);
	progress.tick("skipped");
	progress.tick("done");
	assert.equal(bar.value, 4, "满进度");
	assert.ok(label.textContent.includes("uploadAllProgressRewriting"), `★ 满了之后必须说「正在改写链接」，实际 ${label.textContent}`);

	// 收尾：同一条通知原地变结果，进度文字让位
	progress.finish("已上传 3 个");
	assert.equal(notice.message, "已上传 3 个", "★ 结论写进**同一条**通知（不另发，否则界面上会有两条）");
	assert.equal(label.removed, true, "结果出来之后那行 N/M 要让位（留着会读成「还在跑」）");

	// ⚠️ 2026-10-24：原第 4 段（`buildTaskLabels` 造一套界面文字）随弹窗容器一起退役。
	// 它守的两条判据**没有丢**，只是搬到了生产调用点各自的守门人上：
	//   · 「主按钮要带勾选数」⇒ `verify:flows`（按钮数字＝能作用的件数）＋ 验收 §8i3（模板里必须真有 `{count}`）；
	//   · 「全选那句只维护一处」⇒ 现在只有附件管理一处在给 `labels`（`gallery-modal.ts`）。
	return { cases: 3 };
}
