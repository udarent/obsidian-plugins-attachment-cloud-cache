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
 * 批量上传只传不改链接（用户以为笔记已经搬走了），
 * 以及两条**把调用点换掉删除原语** —— 两条调用路径各一条。
 *
 * 那两条正是现在真正的风险所在：删除原语本身已经被"只用 Vault.delete、
 * 不许碰回收站"钉住了（见 `mutate-remove.mjs`），但**调用点绕开它**完全可能 ——
 * 直接调 `fileManager.trashFile` 也能"删掉文件"，只是空间不释放，
 * 于是症状变成"我设了上限/清理了缓存，磁盘却没变"。
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
			// 后果：清理命令绕过 `remove.ts`，直接把文件送进回收站 ⇒ 文件离开 vault
			// 而物理空间不释放，用户会以为"清理了缓存，磁盘却没变"。
			name: "★ 清理命令绕过删除原语，改走回收站（空间不释放）",
			from:
				"\t\t\tawait removeCacheFile(deps.app, file);\n" +
				"\t\t\tresult.removed += 1;",
			to: "\t\t\tawait deps.app.fileManager.trashFile(file);\n\t\t\tresult.removed += 1;",
			expect: "缓存清理必须用 Vault.delete",
		},
		{
			// 后果：外链那一趟根本不跑 ⇒ 命令只搬库内文件，笔记里的外链图原样留着
			//（用户以为"都搬走了"，而图还在别人的服务器上 —— 而确认框刚刚承诺过会处理它们）。
			name: "★ 批量上传不处理外链候选（笔记里的外链图原样留着）",
			from: "\tif (options.external && options.external.candidates.length > 0 && deps.cacheExternal) {",
			to: "\tif (false) {",
			expect: "外链图被下载、上传，笔记里的链接被改写",
		},
		{
			// 后果：同上，但发生在**后台**（没人在旁边看的那条路径）——
			// 用户只会发现"缓存一直不见小、磁盘也没变"。
			name: "★ 后台淘汰绕过删除原语，改走回收站（自动路径上空间不释放）",
			from:
				"\t\t\tawait removeCacheFile(deps.app, file);\n" +
				"\t\t\tresult.evicted += 1;",
			to: "\t\t\tawait deps.app.fileManager.trashFile(file);\n\t\t\tresult.evicted += 1;",
			expect: "自动淘汰也必须用 Vault.delete",
		},
	],
});
