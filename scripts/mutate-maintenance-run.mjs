import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：维护功能的**执行层**（`src/maintenance/run.ts`）。
 *
 * 执行层的大部分行为（先自愈再清理、拿不到删除凭据就跳过、不删原文件）
 * 要么已经在 `test-maintenance.mjs` 的纯判定层被钉住，要么需要一个
 * **验收环境里造不出来的场景**（比如"宿主的文件索引滞后于磁盘"）——
 * 硬塞一条打不中要害的变异，只会让"全部被捕获"这句话贬值。
 *
 * 所以这里只留三条**在验收环境里真的能观察、且后果具体**的变异：
 * 批量上传只传不改链接（用户以为笔记已经搬走了）、
 * 以及两条"忽略删除方式"的接反 —— 两条调用路径各一条。
 * 那两条正是"设置项与实际行为分叉"的落点：设置页写得清清楚楚，
 * 实际却按另一档删，而用户只能从"空间怎么没释放 / 回收站里怎么没有"倒推。
 *
 * ⚠️ 变异目标是 `run.ts`，但入口是 `src/main.ts` —— 靠 import 链把它带进 bundle，
 * 于是套件跑的还是**同一条接线路径**。
 */
await runMutations({
	source: "src/maintenance/run.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			name: "★ 批量上传只传不改链接（笔记仍指向本地，用户以为已经搬走了）",
			from: "\t\t\tawait deps.app.vault.modify(note, rewritten.text);",
			to: "\t\t\tvoid note; // 变异：不改笔记",
			expect: "链接被改写成远端地址",
		},
		{
			// 后果：用户选了「移入系统回收站」（他看重可还原），清理命令却把文件**直接抹除** ——
			// 而确认框里还写着"可以还原"，他会去回收站里找一个根本不在那儿的文件。
			name: "★ 清理命令忽略删除方式（选了回收站却被直接抹除，确认框还在说可还原）",
			from:
				"\t\t\tawait removeCacheFile(deps.app, file, deps.settings().deleteMode);\n" +
				"\t\t\tresult.removed += 1;",
			to: '\t\t\tawait removeCacheFile(deps.app, file, "permanent");\n\t\t\tresult.removed += 1;',
			expect: "「移入回收站」就该走宿主",
		},
		{
			// 后果：默认那一档（直接删除，图的是立刻腾出空间）在**后台**被换成回收站 ⇒
			// 磁盘空间一点没释放，而这一切发生在没人在旁边看的时候。
			// 顺带说明为什么要打在**淘汰**这条路径上：清理命令那一侧由上面那条覆盖。
			name: "★ 后台淘汰忽略删除方式（默认的直接删除被换成回收站，空间不释放）",
			from:
				"\t\t\tawait removeCacheFile(deps.app, file, deps.settings().deleteMode);\n" +
				"\t\t\tresult.evicted += 1;",
			to: '\t\t\tawait removeCacheFile(deps.app, file, "trash");\n\t\t\tresult.evicted += 1;',
			expect: "默认的淘汰方式必须是",
		},
	],
});
