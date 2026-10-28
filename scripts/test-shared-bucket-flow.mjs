import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSharedBucketFlowSuite } from "./lib/shared-bucket-flow-suite.mjs";

/**
 * 「共享桶接线」测试（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 守三件事：S3 客户端到声明 I/O 的映射不错位、身份形状不对就不参与、
 * 以及**没有身份时一个请求都不发**。
 *
 * ⚠️ 2026-10-28：这里原有一层「共享桶开关关着就全部跳过」的分支，已删 ——
 * 跨设备保护不是可选功能（关着时删除链会整块跳过跨库判据，同桶里别的设备还在用的
 * 对象会被当孤儿删掉）。唯一剩下的早退条件是**身份缺失**。
 */
await withLoadedTs("src/plugin/shared-bucket-flow", async (mod) => {
	const stats = await runSharedBucketFlowSuite(mod);
	console.log(
		`Shared-bucket flow tests passed (${stats.cases} groups: 身份形状 / I-O 映射（含 404 ⇒ null）/ ` +
			`登记引用（没身份零请求、写失败返回 false）/ 摘引用 / 整份对账（没身份连全库都不读）/ 守卫只在身份缺失时为 null；每条都按"错了会删掉别人的对象或凭空多发请求"写断言。⚠️ 开关没了：跨设备保护默认生效，早期的"关着零请求"断言改成了"没身份零请求"）`
	);
});
