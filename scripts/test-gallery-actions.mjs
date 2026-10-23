import { withLoadedTs } from "./lib/load-ts.mjs";
import { runGalleryActionsSuite } from "./lib/gallery-actions-suite.mjs";

/**
 * 动作可用性（`src/gallery/actions.ts`，R24 / §5.5）。
 *
 * 断言在 `lib/gallery-actions-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs(["src/gallery/actions"], async (mod) => {
	const stats = await runGalleryActionsSuite(mod);
	console.log(
		`Gallery-actions tests passed (${stats.cases} rows: 删云端默认要求“没人引用”（不可恢复）、删本地要求本地有文件、` +
			`上传只对候选成立、按钮数字 = 能作用的件数、动作后的状态迁移与 §5.5 矩阵一致).`
	);
});
