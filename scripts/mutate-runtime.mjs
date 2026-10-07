import { runMutations } from "./lib/mutate.mjs";
import { runRuntimeSuite } from "./lib/runtime-suite.mjs";

/**
 * 变异验证：运行时装配（`src/host/runtime.ts`）。
 *
 * 这里两条性质坏掉都不报错：
 * - **索引落盘不串行** → 两次并发写共用同一个临时文件，落盘内容可能是半截或错版
 *   （只在某些时序下发生，症状是"重启后有些图不被认识"）；
 * - **防抖落盘失效** → 要么永远不写（"最近使用时间"全丢，缓存轮换退化成按上传时间排），
 *   要么每次都写（渲染热路径持续写盘）。
 */
await runMutations({
	source: "src/host/runtime.ts",
	entries: ["src/host/runtime", "src/cache/index", "src/cache/store"],
	suite: runRuntimeSuite,
	mutations: [
		{
			// 后果：队列尾不再是"已兑现"的 promise ⇒ 前一个失败之后，后面那个**永远排不上队**
			// ⇒ 一次偶发失败永久堵死索引落盘，而界面上什么都看不出来。
			//
			// ⚠️ 这条打的必须是 `tail = run.catch(...)` 那一行。真正保证"失败不中断"的就是它；
			// 最初的 `then(task, task)` 里的失败回调其实是**多余的**（`tail` 已被 `catch` 过，
			// 永远 fulfilled）—— 变异验证正是这样把它揪出来的。
			name: "★ 队尾不再吞掉失败（一次偶发失败永久堵死后续落盘）",
			from: "\t\ttail = run.catch(() => undefined);",
			to: "\t\ttail = run;",
			expect: "堵死",
		},
		{
			// 后果：记了"最近使用"却从不落盘 ⇒ 重启后全丢，缓存轮换退化成按**上传时间**排
			//（于是"天天在看的图"可能比"上传后就没打开过的图"先被淘汰）。
			name: "★ 不再排防抖落盘（「最近使用时间」永远写不到磁盘上）",
			from: "\t\t\tif (!cancelFlush) {\n",
			to: "\t\t\tif (false) {\n",
			expect: "排了一次防抖落盘",
		},
		{
			// 后果：每次 touch 都排一次 ⇒ 一屏几十张图、滚动一次又一轮，
			// 索引被持续写盘（而这条路径上的数据只是给轮换排序用的）。
			name: "★ 防抖不再合并（渲染热路径持续写盘）",
			from: "\t\t\tif (!cancelFlush) {\n",
			to: "\t\t\tif (true) {\n",
			expect: "不重复排队",
		},
		{
			// 后果：落盘失败会从定时器回调里抛出去 ⇒ 变成未处理的拒绝（或打到渲染路径上）。
			// 这条路径由渲染触发，绝不能往外抛。
			name: "★ 防抖落盘失败不再兜住（异常打到渲染路径上）",
			from: "\t\t\t\t\treturn save().catch(report);",
			to: "\t\t\t\t\treturn save();",
			expect: "不能抛出去",
		},
		{
			// 后果：防抖延迟变成 0 ⇒ 防抖等于没有（每次 touch 都立刻写盘）。
			name: "★ 防抖延迟被忽略（等于没有防抖）",
			from: "\t\t\t\t}, flushDelayMs);",
			to: "\t\t\t\t}, 0);",
			expect: "默认延迟",
		},
	],
});
