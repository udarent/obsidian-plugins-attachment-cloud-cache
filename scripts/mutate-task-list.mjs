import { runMutations } from "./lib/mutate.mjs";
import { runTaskListSuite } from "./lib/task-list-suite.mjs";

/**
 * 变异验证：清单式弹窗的纯逻辑（`src/ui/task-list.ts`）。
 *
 * 三条链（上传附件 / 检查未被引用的云端附件 / 挑选要缓存的文件）共用这一层。
 * 它坏掉**不会报错**：进度条停在 99%、每一行都写"失败"、
 * 或者提交顺序变成用户点击的顺序 —— 三种都只表现为"看起来有点怪"。
 */
await runMutations({
	source: "src/ui/task-list.ts",
	entries: ["src/ui/task-list"],
	suite: runTaskListSuite,
	mutations: [
		{
			// 后果：分母用**状态表里的条数**而不是"交给这一趟的件数" ⇒ 没勾中的行
			// 会把进度撑大，跑完了进度条也到不了 100%（用户盯着弹窗等一个永远不会结束的活）。
			name: "★ 进度分母用状态表条数（没勾中的行把进度撑大 ⇒ 永远到不了 100%）",
			from: "const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;",
			to: "const safeTotal = statuses.size;",
			expect: "进度的分母必须是**交给这一趟**的件数",
		},
		{
			// 后果：只把 `done` 当"走完" ⇒ 一件失败（或一件跳过）就让进度停在 99%，
			// 用户以为还有活没干完，而那一趟其实已经结束了。
			name: "★ 只把 done 算走完（一件失败就让进度停在 99%）",
			from: "\treturn { total: safeTotal, finished: done + skipped + failed, done, skipped, failed, running };",
			to: "\treturn { total: safeTotal, finished: done, done, skipped, failed, running };",
			expect: "失败与跳过也算走完",
		},
		{
			// 后果：跳过并进失败 ⇒ 提示里说"失败 3 个"，而其中两件只是
			// "已经在你自己的存储里了"（不是故障）⇒ 用户去查一个不存在的问题。
			name: "★ 跳过并进失败（用户去修一件本来不需要修的事）",
			from: '\t\telse if (status === "skipped") skipped += 1;',
			to: '\t\telse if (status === "skipped") failed += 1;',
			expect: "跳过不是失败",
		},
		{
			// 后果：按 `Set` 的插入顺序交（= 用户点击的顺序）⇒ 同一份勾选状态两次运行
			// 可能给出两种顺序，日志/重跑都不可复现；上一批范围的残留键也会被一起交出去。
			name: "★ 勾中项按点击顺序交（不可复现，且可能带出清单外的键）",
			from: "\tconst out: string[] = [];\n\tfor (const row of rows ?? []) {\n\t\tconst id = typeof row?.id === \"string\" ? row.id : \"\";\n\t\tif (id !== \"\" && selected.has(id)) out.push(id);\n\t}\n\treturn out;",
			to: "\tconst out: string[] = [];\n\tfor (const id of selected) out.push(id);\n\treturn out;",
			expect: "按**清单顺序**交出去",
		},
		{
			// 后果：改状态就地改传进来的那份 ⇒ 状态有了两个来源，
			// 界面可能显示 A、而提交按 B 走（"不可变"这条纪律就是为它立的）。
			name: "★ 改状态就地改（状态多出一个来源）",
			from: "\tconst next = new Map(statuses);",
			to: "\tconst next = statuses as Map<string, TaskStatus>;",
			expect: "改状态要返回新的 Map",
		},
	],
});
