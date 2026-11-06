import { withLoadedTs } from "./lib/load-ts.mjs";
import { runBatchDeclarationSuite } from "./lib/batch-declaration-suite.mjs";

/**
 * 「整批一次写云端声明 ＋ 有限并发」的编排层测试（`src/maintenance/run.ts`）。
 *
 * 与 `test-load-acceptance` 分工：那边跑完整插件、守「接线通了」；
 * 这边用替身盯**失败方向**——批量声明写不成、算不出哈希、缺注入时，
 * 都必须退回逐文件声明，绝不能让对象传上去却没有引用保护；
 * 并守 R14 重评的三条：失败能定位、进度仍逐项、并发有上限。
 */
await withLoadedTs(
	["src/maintenance/run", "src/cache/index", "src/settings", "src/core/ingest"],
	async (mod) => {
		const stats = await runBatchDeclarationSuite(mod);
		console.log(
			`Batch declaration tests passed (${stats.cases} scenarios: 整批一次装全部 / ` +
				"失败退回逐文件 / 缺注入与改动前一致 / 同内容去重 / 读盘失败那份不进集合 / 身份推导抛错整批降级 / " +
				"并发生效且有上限 / 降级严格串行 / 乱序完成仍按序报进度 / 单件失败隔离)"
		);
	}
);
