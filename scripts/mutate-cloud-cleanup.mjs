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
			from: "\t\t} catch (error) {\n\t\t\t// 单个对象失败不能中断整批（用户要的是\"把能清的清掉\"），但必须计数\n\t\t\tresult.failed += 1;\n\t\t\tvoid error;\n\t\t}",
			to: "\t\t} catch (error) {\n\t\t\tresult.failed += 1;\n\t\t\tif (deps.index().remove(key)) removed.push(key);\n\t\t\tvoid error;\n\t\t}",
			expect: "只有**删成功**的对象才摘索引",
		},
		{
			// 后果：服务端回 404（对象本来就不在桶里）被记成"删除失败" ⇒ 提示语撒谎
			//（用户看到"有一个没删掉"，其实早就没了），而那条指向 404 的记录会被
			// audit / 淘汰当成**有效记录**（症状："明明删了，占用统计还在涨"）。
			// ⚠️ 这也是两个入口对同一个返回值给出**相反解释**的那一半（审计 P2）。
			name: "★ 404 被记成失败（提示语撒谎 + 留下指向空对象的有效记录）",
			from: "\t\t\tif (ok) {\n\t\t\t\tresult.deleted += 1;\n\t\t\t} else {\n\t\t\t\t// 404 ⇒ 本来就不存在 ⇒ 目标状态已达成（见上面那段说明）\n\t\t\t\tresult.alreadyGone += 1;\n\t\t\t}\n\t\t\tif (deps.index().remove(key)) removed.push(key);",
			to: "\t\t\tif (!ok) {\n\t\t\t\tresult.failed += 1;\n\t\t\t\tcontinue;\n\t\t\t}\n\t\t\tresult.deleted += 1;\n\t\t\tif (deps.index().remove(key)) removed.push(key);",
			// ⚠️ 这条变异会同时破坏三件事（`alreadyGone` 计数、`failed` 的归因、索引摘除），
			// 而套件是"第一条失败断言决定报错" ⇒ 它红在**最先**那条（`alreadyGone` 计数）上。
			// 按纪律把 expect 如实写成那一条（不是"随便红了就算抓住"）。
			expect: "要单独计数",
		},
		{
			// 后果：**入口 A** 只看文件路径 ⇒ 库里有两份同内容的附件时，删掉其中一份会放行删云端，
			// 而另一份的笔记里写着**同一条 URL** ⇒ 删掉仍在使用的对象（审计 P1，R17 明确要防的那件事）。
			name: "★★ 入口 A 只看路径维度（同内容的另一份附件仍在引用，却被放行删云端）",
			from: "\tconst stillReferenced = input.referencedByPath || input.referencedByKey;",
			to: "\tconst stillReferenced = input.referencedByPath; // 变异：丢掉 key 维度",
			expect: "key 维度",
		},
		{
			// 后果：在缓存目录里的副本也会弹"要不要连云端一起删" ⇒
			// 与 clean-cache 抢同一批文件，而且那个副本删除**本来就不该问**（它是可再生的）。
			name: "★ 缓存目录里的副本也走这个入口（和 clean-cache 抢地盘）",
			from: "\tif (input.underCacheFolder) return { action: \"skip\", reason: \"in-cache-folder\" };",
			to: "\t// 变异：不判缓存目录",
			expect: "缓存目录里的副本",
		},
	],
});
