import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSharedBucketFlowSuite } from "./lib/shared-bucket-flow-suite.mjs";

/**
 * 「共享桶接线」测试（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 守三件事：S3 客户端到声明 I/O 的映射不错位、身份形状不对就不参与、
 * 以及**功能关着时一个请求都不发**。
 */
await withLoadedTs("src/plugin/shared-bucket-flow", async (mod) => {
	const stats = await runSharedBucketFlowSuite(mod);
	console.log(
		`Shared-bucket flow tests passed (${stats.cases} groups: 身份形状 / I-O 映射（含 404 ⇒ null）/ ` +
			`登记引用（关着零请求、写失败返回 false）/ 守卫开关；每条都按"错了会删掉别人的对象或凭空多发请求"写断言)`
	);
});
