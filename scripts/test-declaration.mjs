import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDeclarationSuite } from "./lib/declaration-suite.mjs";

/**
 * 「共享桶的引用声明」纯逻辑测试（`src/s3/declaration.ts`）。
 *
 * 这一层是 R25 的地基：它算错一个字节，后果不是"显示不对"，而是**别的设备还在用的对象
 * 被本机判成孤儿删掉**。所以断言按"后果"写名字，覆盖布局、解析、合并、写计划、压缩、指纹。
 *
 * 断言在 `lib/declaration-suite.mjs`（与变异验证共用同一份）。
 */
await withLoadedTs("src/s3/declaration", async (mod) => {
	const stats = await runDeclarationSuite(mod);
	console.log(
		`Declaration tests passed (${stats.cases} groups: 布局与 id 校验 / 解析失败方向 / 合并优先级 / ` +
			`写计划（新增·封存·减引用·改名·压缩）/ 指纹；段容量 500、同 hash 取序号最大、` +
			`压缩先写后删 —— 每条都按"错了会删掉别人的对象"写断言)`
	);
});
