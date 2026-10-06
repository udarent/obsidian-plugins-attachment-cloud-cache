import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：维护功能的**执行层**（`src/maintenance/run.ts`）。
 *
 * ## 为什么这里只有一条变异
 *
 * 执行层的大部分行为（先自愈再清理、拿不到删除凭据就跳过、不删原文件）
 * 要么已经在 `test-maintenance.mjs` 的纯判定层被钉住，要么需要一个
 * **验收环境里造不出来的场景**（比如"宿主的文件索引滞后于磁盘"）——
 * 硬塞一条打不中要害的变异，只会让"全部被捕获"这句话贬值。
 *
 * 所以这里只保留那条**在验收环境里真的能观察、且后果严重**的：
 * 批量上传若只上传不改写链接，用户会以为笔记已经搬到图床了，其实没有。
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
	],
});
