import { withLoadedTs } from "./lib/load-ts.mjs";
import { runMigrateFlowSuite } from "./lib/migrate-flow-suite.mjs";

/**
 * 「统一对象名」的编排测试（`src/plugin/migrate-flow.ts`，CR-15）。
 *
 * 纯逻辑套件钉"算得对不对"，这一套钉**五个阶段连起来以后数据变成什么样**：
 * 被挡下时一个旧对象都没删、搬账真的搬了、状态位按 running → idle / interrupted 走。
 *
 * 断言在 `lib/migrate-flow-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs("src/plugin/migrate-flow", async (mod) => {
	const stats = await runMigrateFlowSuite(mod);
	console.log(
		`Migrate-flow tests passed (${stats.cases} groups: 完整一轮 / 连跑幂等 / 残留挡住 / ` +
			`字节没到挡住 / 读不到不开始 / 取消不动 / 状态写不下不迁 / 复制失败计数 / 画布)`
	);
});
