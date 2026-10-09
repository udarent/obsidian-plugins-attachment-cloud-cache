import { runMutations } from "./lib/mutate.mjs";
import { runCloudCleanupSuite } from "./lib/cloud-cleanup-suite.mjs";

/**
 * 变异验证：云端空间清理（`src/maintenance/cloud-cleanup.ts`）—— **会真的删云端对象**。
 *
 * 这一层每一条变异都对应一种**不可恢复**的后果，所以没有一条是"体验差一点"：
 *
 * - 收进"仍被引用"的对象 ⇒ 别人的笔记、别的设备上的图直接失效；
 * - 收进站外缓存 ⇒ 用户明确要求缓存的东西被删掉（而他的笔记里写的是别处的地址）；
 * - 列举没读全却当成读全了 ⇒ 用户以为"剩下的都还有人用"，实际是**我们没看到**；
 * - 删除失败也摘索引 ⇒ 那条 URL 从此被当成站外图（不下载、离线看不到），而对象还在。
 */
await runMutations({
	source: "src/maintenance/cloud-cleanup.ts",
	entries: ["src/maintenance/cloud-cleanup", "src/cache/index"],
	suite: runCloudCleanupSuite,
	mutations: [
		{
			// 后果：**还在被引用的对象**进了候选 ⇒ 删掉之后，那些笔记与画布上的引用
			// 在别的设备/清过缓存的设备上直接失效，而且**不可恢复**。
			name: "★ 仍被引用的对象也进候选（删掉别人的图，不可恢复）",
			from: "\t\tif (input.referencedKeys.has(object.key)) {\n\t\t\tbump(\"仍被笔记或画布引用\");\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tbump(\"仍被笔记或画布引用\");\n\t\t\tcontinue;\n\t\t}",
			expect: "只挑既没被引用、也不是站外缓存的对象",
		},
		{
			// 后果：站外缓存进候选 ⇒ 用户明确要求缓存的对象被删掉，
			// 而它的"引用"（笔记里的原站外地址）我们的判据根本认不出来。
			name: "★ 站外缓存也进候选（用户明确要求缓存的对象被删掉）",
			from: "\t\tif (input.externalKeys.has(object.key)) {\n\t\t\tbump(\"站外缓存（不动）\");\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tbump(\"站外缓存（不动）\");\n\t\t\tcontinue;\n\t\t}",
			expect: "只挑既没被引用、也不是站外缓存的对象",
		},
		{
			// 后果：列举到页数上限就停下，却报告"清单是全的" ⇒ 用户看到的是
			// "剩下那些都还有人用"，而真相是**我们根本没看到它们**。
			name: "★ 列举没读全却不标记截断（用户以为剩下的都还有人用）",
			from: "\treturn { objects, truncated: true };",
			to: "\treturn { objects, truncated: false };",
			expect: "提前停下必须标记",
		},
		{
			// 后果：摘索引不看删除结果 ⇒ 对象还在，而记录没了；
			// 渲染时那条 URL 会被当成站外图（不下载、离线看不到），且**永远查不出原因**。
			name: "★ 删除失败也摘索引（那条 URL 从此被当成站外图）",
			from: "\t\t\tresult.deleted += 1;\n\t\t\tif (deps.index().remove(key)) removed.push(key);",
			to: "\t\t\tif (deps.index().remove(key)) removed.push(key);\n\t\t\tresult.failed += 0;",
			expect: "成功数要如实统计",
		},
	],
});
