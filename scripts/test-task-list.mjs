import { withLoadedTs } from "./lib/load-ts.mjs";
import { runTaskListSuite } from "./lib/task-list-suite.mjs";

/**
 * 清单式弹窗的**纯逻辑**测试（`src/ui/task-list.ts`）。
 *
 * 起因（用户 2026-10-15）：插件里三处"列出一批、勾一批、逐个处理"的界面
 * **三种样子**（一个有勾选没缩略图、一个只有缩略图、一个连缩略图都没有），
 * 要求统一成 **缩略图 + 勾选（含全选/全不选）+ 进度**。
 *
 * 弹窗那一层点不了（宿主的 `Modal` 在 Node 里没有可编程的 DOM），
 * 所以"进度怎么算、勾中项怎么交出去、按钮上那句文案怎么来"都在这个纯模块里，
 * 由这条套件与 `mutate-task-list.mjs` 一起钉住。
 */
await withLoadedTs(["src/ui/task-list", "src/plugin/upload-existing-flow"], (mod) => {
	const stats = runTaskListSuite(mod);
	console.log(
		`Task-list tests passed (${stats.cases} cases: the progress denominator is the number of items ` +
			"handed to this run rather than the number of rows on screen, so an unticked row cannot stop " +
			"the bar from reaching 100%; done, skipped and failed all count as finished, while skipped " +
			"stays separate from failed because 'it was already in your storage' is not a fault the user " +
			"should go and fix; status updates return a new map so the state has exactly one source; " +
			"ticked items are handed over in list order and stray keys from a previous scope cannot leak " +
			"into the run." +
			// ⚠️ 2026-10-24：原来还有一句讲 `buildTaskLabels`（主按钮带勾选数）。那个函数随弹窗容器
			// 一起退役 ⇒ 那句话不再成立（现在只有附件管理在给 labels）。
			""
	);
});
