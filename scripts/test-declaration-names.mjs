import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDeclarationNamesSuite } from "./lib/declaration-names-suite.mjs";

/**
 * 「改名待补队列」测试（`src/maintenance/declaration-names.ts`，CR-16）。
 *
 * 这一层的失败都是静默的：队列无限膨胀、同一个 hash 留着旧名字、结清时把没补的也丢掉。
 * 断言都按这些后果写名字，变异锚点也照它们定。
 *
 * 断言在 `lib/declaration-names-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs("src/maintenance/declaration-names", async (mod) => {
	const stats = await runDeclarationNamesSuite(mod);
	console.log(`Declaration-names tests passed (${stats.cases} groups: 入队覆盖 / 非法输入 / 上限淘汰 / 结清 / 摊平顺序 / 路径取名 / 不可变)`);
});
