/**
 * 实时预览下的站外图（`src/render/external-live.ts`）的断言套件。
 *
 * ## 这一层坏掉的症状是"什么都没发生"
 *
 * 编辑态里看到一张站外图 → 应当弹一次询问。这条链路上任何一环断掉，
 * 表现都一样：**安静**。所以逐条钉住：
 *
 * - 不延后 → 拿不到归属（赋值那一刻元素还没进 DOM），于是一张都不处理；
 * - 不攒批 → 一屏几十张图会连着遍历几十次打开的视图（白烧 CPU）；
 * - 不按 DOM 归属而按"当前活动笔记" → 分屏时改写**另一篇**笔记（损坏用户数据）；
 * - 单张图抛错没隔离 → 拖垮整批；
 * - 卸载不清理 → 已排的调度还在跑。
 */

import assert from "node:assert/strict";

/** 让微任务链跑完。 */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个"打开着的视图"：`contains` 用一组元素来回答。 */
function viewsOf(entries) {
	return entries.map(([path, elements]) => ({
		path,
		root: { contains: (node) => elements.includes(node) },
	}));
}

export async function runExternalLiveSuite(mod) {
	const { createExternalLiveQueue, notePathForElement } = mod;

	const EL_A = { id: "a" };
	const EL_B = { id: "b" };
	const EL_ORPHAN = { id: "orphan" };

	// ============================================================
	// 1. 归属解析：按 DOM 归属，而不是"当前活动笔记"
	// ============================================================
	{
		const views = viewsOf([
			["notes/one.md", [EL_A]],
			["notes/two.md", [EL_B]],
		]);
		assert.equal(notePathForElement(views, EL_A), "notes/one.md", "要按容器归属解析出笔记路径");
		assert.equal(notePathForElement(views, EL_ORPHAN), null, "★ 不在任何笔记里的元素必须返回 null（拿不准就不做）");
		assert.equal(notePathForElement(views, EL_B), "notes/two.md", "分屏时各归各的（这正是不能用活动笔记的理由）");
		assert.equal(notePathForElement([], EL_A), null, "一个视图都没有时返回 null");
	}

	// ============================================================
	// 2. 归属解析：怪形状的视图不能让它抛错，也不能挡住后面的视图
	//
	// 打开的视图里可能有**别的插件**造的视图（形状不受我们控制）。
	// 一个坏掉的 `contains` 不该让整批站外图都处理不了。
	// ============================================================
	{
		const broken = [
			{ path: "bad/no-root", root: null },
			{ path: "bad/no-contains", root: {} },
			{ path: "bad/not-a-function", root: { contains: 42 } },
			{ path: "", root: { contains: () => true } },
			{ path: "bad/throws", root: { contains: () => { throw new Error("别的插件造的视图"); } } },
		];
		assert.equal(notePathForElement(broken, EL_A), null, "全是怪形状时应安全返回 null，而不是抛错");
		assert.equal(
			notePathForElement([...broken, ...viewsOf([["notes/ok.md", [EL_A]]])], EL_A),
			"notes/ok.md",
			"★ 前面几个坏视图不能挡住后面那个正常的"
		);
	}

	// ============================================================
	// 3. 攒批 + 延后：一次渲染里的几十张图只遍历一次视图
	// ============================================================
	{
		let viewsCalls = 0;
		const handled = [];
		const scheduled = [];
		const queue = createExternalLiveQueue({
			openViews: () => {
				viewsCalls += 1;
				return viewsOf([["notes/one.md", [EL_A, EL_B]]]);
			},
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => scheduled.push(flush),
		});

		queue.see(EL_A);
		queue.see(EL_B);
		queue.see(EL_A); // 同一批里重复上报（重渲染会这样）

		assert.deepEqual(handled, [], "★ 记下候补时不能立刻处理 —— 那一刻元素还没进 DOM，归属问不出来");
		assert.equal(queue.pending(), 2, "同一批里同一个元素只该算一次");
		assert.equal(scheduled.length, 1, "★ 一批只排一次调度，不是每张图排一次");

		scheduled[0]();
		assert.deepEqual(
			handled,
			[
				[EL_A, "notes/one.md"],
				[EL_B, "notes/one.md"],
			],
			"处理时要带上元素与它所属的笔记路径，且每个元素只处理一次"
		);
		assert.equal(viewsCalls, 1, "★ 整批只遍历一次打开的视图（一屏几十张图时这是几十倍的差别）");
		assert.equal(queue.pending(), 0, "处理完应当清空");
	}

	// ============================================================
	// 4. 拿不到归属 → 跳过（不改写任何笔记）
	// ============================================================
	{
		const handled = [];
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [EL_A]]]),
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => flush(),
		});
		queue.see(EL_ORPHAN);
		assert.deepEqual(handled, [], "★ 解析不出归属时必须跳过 —— 这张链路会改写笔记，改错了就是损坏用户数据");
		assert.equal(queue.pending(), 0, "跳过的候补也要从待处理里清掉（不能永远攒着）");
	}

	// ============================================================
	// 5. 取视图列表本身抛错 → 报出来，且不把调度卡死
	//
	// ⚠️ 顺序刻意放在"单张图抛错"之前：下面那条变异（调度标志不复位）会先在
	// **任何**需要"flush 之后还能再排一次"的用例上炸掉，而这个用例是第一个这样的用例 ——
	// 放在前面才能让报错落在它该命中的那条断言上（否则会被后一条的报错掩护）。
	// ============================================================
	{
		const handled = [];
		const errors = [];
		let broken = true;
		const queue = createExternalLiveQueue({
			openViews: () => {
				if (broken) throw new Error("列视图失败");
				return viewsOf([["notes/one.md", [EL_A]]]);
			},
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => flush(),
			onError: (error) => errors.push(error),
		});
		queue.see(EL_A);
		assert.deepEqual(handled, [], "取不到视图时什么都不做");
		assert.equal(errors.length, 1, "这个错误要被记录");

		// ⭐ 关键：一次失败不能把队列**永久卡住**（卡住的表现是"之后所有站外图都不处理了"）
		broken = false;
		queue.see(EL_A);
		assert.deepEqual(handled, [[EL_A, "notes/one.md"]], "★ 一次取视图失败之后仍应能继续工作");
	}

	// ============================================================
	// 6. 同一批里单张图出问题不能拖垮其余的
	//
	// ⚠️ 必须让两张图落在**同一批**里：如果让 `see` 各自同步 flush 一次，
	// 它们就是两次独立的 flush —— 这时"逐张隔离"坏掉了也看不出来
	//（第一张的异常会被 `see` 自己的容错兜住，第二张照样在下一批里被处理）。
	// 这条是先写成"两个 `see` + 同步调度"而变异**漏过**之后改的。
	// ============================================================
	{
		const handled = [];
		const errors = [];
		let pendingFlush = null;
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [EL_A, EL_B]]]),
			handle: (element) => {
				handled.push(element);
				if (element === EL_A) throw new Error("这一张处理失败");
			},
			schedule: (flush) => {
				pendingFlush = flush;
			},
			onError: (error) => errors.push(error),
		});
		queue.see(EL_A);
		queue.see(EL_B);
		assert.equal(typeof pendingFlush, "function", "两张图应当落在同一批里（只排了一次调度）");

		let thrown = null;
		try {
			pendingFlush();
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown, null, "★ 单张图抛错不能拖垮整批（这条路径上抛错会毁掉整批候选）");
		assert.deepEqual(handled, [EL_A, EL_B], "★ 前一张抛错，后一张仍要被处理");
		assert.equal(errors.length, 1, "出错要被记录（而不是静默吞掉）");
	}

	// ============================================================
	// 7. 调度本身抛错 → 报出来，且下一次仍能排
	// ============================================================
	{
		const handled = [];
		const errors = [];
		let scheduled = null;
		let breakSchedule = true;
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [EL_A]]]),
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => {
				if (breakSchedule) throw new Error("排不了调度");
				scheduled = flush;
			},
			onError: (error) => errors.push(error),
		});
		queue.see(EL_A);
		assert.equal(errors.length, 1, "排调度失败要被记录");

		breakSchedule = false;
		queue.see(EL_A);
		assert.equal(typeof scheduled, "function", "★ 上一次排调度失败不能让它永远排不上（那会让功能静默失效）");
		scheduled();
		assert.deepEqual(handled, [[EL_A, "notes/one.md"]], "恢复之后要正常处理");
	}

	// ============================================================
	// 8. 卸载：丢掉待处理并取消已排的调度
	// ============================================================
	{
		const handled = [];
		let scheduled = null;
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [EL_A]]]),
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => {
				scheduled = flush;
			},
		});
		queue.see(EL_A);
		queue.dispose();
		assert.equal(queue.pending(), 0, "卸载后不该还攒着候补");
		if (scheduled) scheduled();
		assert.deepEqual(handled, [], "★ 卸载之后不该再处理任何东西（否则插件已卸载仍在改写笔记）");

		queue.see(EL_A);
		assert.equal(queue.pending(), 0, "卸载之后新的上报也要被忽略");
	}

	// ============================================================
	// 9. 形状不对的候补不该抛错（它跑在全 app 的图片赋值路径上）
	// ============================================================
	{
		const handled = [];
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [null]]]),
			handle: (element, path) => handled.push([element, path]),
			schedule: (flush) => flush(),
		});
		let thrown = null;
		try {
			queue.see(null);
			queue.see(undefined);
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown, null, "★ 上报 null/undefined 不该抛错（这条路径上抛错会毁掉整篇笔记的渲染）");
		assert.deepEqual(handled, [], "没有元素的候补不该被处理");
	}

	// ============================================================
	// 10. 默认调度器：一个微任务（不注入 schedule 时的真实行为）
	//
	// 为什么是微任务而不是动画帧：真机实测，赋值那一刻元素还没进 DOM，
	// 而**微任务时刻** 6/6 张图已连上文档、都在编辑器里、且都能反查到正确笔记 ——
	// 微任务就够。选它还有个附带好处：窗口隐藏时动画帧会被节流，微任务不会。
	// ============================================================
	{
		const handled = [];
		const queue = createExternalLiveQueue({
			openViews: () => viewsOf([["notes/one.md", [EL_A]]]),
			handle: (element, path) => handled.push([element, path]),
		});
		queue.see(EL_A);
		assert.deepEqual(handled, [], "★ 默认调度也必须是延后的（同步处理等于拿不到归属）");
		await flushMicrotasks();
		assert.deepEqual(handled, [[EL_A, "notes/one.md"]], "★ 默认调度必须真的会跑（延后成不执行就完全没用了）");
	}
}
