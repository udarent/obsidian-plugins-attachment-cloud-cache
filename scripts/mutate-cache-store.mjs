import { runMutations } from "./lib/mutate.mjs";
import { runCacheStoreSuite } from "./lib/cache-store-suite.mjs";

/**
 * 变异验证：`src/cache/store.ts`。
 *
 * 两条硬要求各两条锚点：读失败必须能降级（启动路径不许抛）、写必须原子且完整。
 */
await runMutations({
	source: "src/cache/store.ts",
	entries: ["src/cache/store"],
	suite: runCacheStoreSuite,
	mutations: [
		{
			// 后果：首次运行被当成读失败 ⇒ 每次全新安装都弹一条"索引读取失败"。
			name: "文件不存在时不再提前返回（首次运行报错）",
			from: "\t\tif (!(await adapter.exists(path))) {",
			to: "\t\tif (false) {",
			expect: "文件不存在 ⇒ existed=false",
		},
		{
			// 后果：坏 JSON 被当成"读取成功但内容为空" ⇒ 原因不再如实汇报（用户与日志都看不出索引坏了）。
			name: "坏 JSON 不再如实给出原因",
			from: '\t\t\terror: `JSON 解析失败：${describeError(error)}`,',
			to: '\t\t\terror: "",',
			expect: "坏 JSON 必须降级成空索引，但如实给原因",
		},
		{
			// 后果：路径两端的斜杠没清 ⇒ 拼出 `a/b//.cache-index.json`（宿主对它的解释不可预测）。
			name: "路径不再清掉尾随斜杠",
			from: '.replace(/^\\/+|\\/+$/g, "")',
			to: '.replace(/^\\/+/, "")',
			expect: "索引文件路径必须落在插件目录下",
		},
		{
			// 后果：写入只写了个空壳 ⇒ 下次启动索引里一条都没有（每张图白下载一次）。
			name: "保存时不再写真实条目",
			from: "\tawait writeJsonAtomically(adapter, path, JSON.stringify(index.toJSON()));",
			to: '\tawait writeJsonAtomically(adapter, path, JSON.stringify({ version: 1, entries: [], uploaded: [] }));',
			expect: "写出去的内容必须保留条目",
		},
	],
});
