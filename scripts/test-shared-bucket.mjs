import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSharedBucketSuite } from "./lib/shared-bucket-suite.mjs";

/**
 * 「共享桶的跨库判据」测试（`src/maintenance/shared-bucket.ts`）。
 *
 * 这一层决定"能不能删桶里的对象"。断言按后果写名字：少排除自己 ⇒ 永远删不掉；
 * 少了「没有声明」这一支 ⇒ 删掉别的库还在用的对象；少了检查点 ⇒ 别人刚写的新引用照删。
 *
 * 断言在 `lib/shared-bucket-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs("src/maintenance/shared-bucket", async (mod) => {
	const stats = await runSharedBucketSuite(mod);
	console.log(
		`Shared-bucket tests passed (${stats.cases} groups: 占用表合并 / 判据（自己不算·别人算）/ ` +
			`守卫三种结论 / 检查点 / 声明写入；每条都按"错了会删掉别人的对象"写断言)`
	);
});
