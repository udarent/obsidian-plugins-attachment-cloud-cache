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
			from: "\t\t} catch (error) {\n\t\t\t// 单个对象失败不能中断整批（用户要的是\"把能清的清掉\"），但必须计数\n\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: \"failed\" });\n\t\t\tvoid error;\n\t\t}",
			to: "\t\t} catch (error) {\n\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: \"failed\" });\n\t\t\tif (deps.index().remove(key)) removed.push(key);\n\t\t\tvoid error;\n\t\t}",
			expect: "只有**删成功**的对象才摘索引",
		},
		{
			// 后果：服务端回 404（对象本来就不在桶里）被记成"删除失败" ⇒ 提示语撒谎
			//（用户看到"有一个没删掉"，其实早就没了）。
			// ⚠️ 这也是两个入口对同一个返回值给出**相反解释**的那一半（审计 P2）。
			// ⚠️ 变异锚点只能削到"计数写错"这一层：把 `if (ok)` 反过来写会**同时**
			// 破坏第 5 节（成功数恒 0），而套件是"第一条失败断言决定报错" ⇒
			// 那样红在"成功数要如实统计"上，归因就不是这一条了。
			name: "★ 404 被记成失败（提示语撒谎：本来就没有的东西说成没删掉）",
			from: "\t\t\t} else {\n\t\t\t\t// 404 ⇒ 本来就不存在 ⇒ 目标状态已达成（见上面那段说明）\n\t\t\t\tresult.alreadyGone += 1;",
			to: "\t\t\t} else {\n\t\t\t\t// 404 ⇒ 本来就不存在 ⇒ 目标状态已达成（见上面那段说明）\n\t\t\t\tresult.failed += 1;",
			expect: "要单独计数",
		},
		{
			// 后果：删除**失败**时也把台账忘掉 ⇒ 对象还在云端，插件却不再认领它，
			// 下一次孤儿判定会把它当成"不是我们的" —— 从"少问一次"变成"彻底管不了它"。
			name: "★★ 删除失败也忘台账（对象还在云端却不再被认领）",
			from: "\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: \"failed\" });\n\t\t\tvoid error;",
			to: "\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: \"failed\" });\n\t\t\tdeps.index().forgetUploaded(key);\n\t\t\tvoid error;",
			expect: "上传台账同样只在删成功时忘掉",
		},
		{
			// 后果：落盘条件只看"摘掉了条目" ⇒ 「不留副本」那一档**只有台账变化**
			// （没有副本 ⇒ 没有条目）⇒ 它的云端删除永远不落盘，
			// 下次启动台账又把那些对象认回来（表现为"删了，重启后又被问一遍"）。
			name: "★★ 台账变化不落盘（「不留副本」档的删除下次启动被忘掉）",
			from: "\tif (removed.length > 0 || forgotLedger) {",
			to: "\tif (removed.length > 0) {",
			expect: "台账变了也必须落盘",
		},
		{
			// 后果：留痕把**删除失败**的对象也记进去 ⇒ 事后翻日志看到"删了这一个"，
			// 而它其实还在桶里 —— 留痕的全部价值就是"说的与事实一致"。
			name: "★ 删除失败的对象也被留痕（日志说删了，其实还在桶里）",
			from: "\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: \"failed\" });\n\t\t\tvoid error;",
			to: '\t\t\tresult.failed += 1;\n\t\t\tdeps.onItem?.({ key, status: "failed" });\n\t\t\tdeps.onRemoved?.({ key, name: "", outcome: "deleted" });\n\t\t\tvoid error;',
			expect: "留痕只记真的不在桶里的对象",
		},
		{
			// 后果：名字在摘索引**之后**才读 ⇒ 永远读到空串（记录已经没了），
			// 留痕里只剩一串十六进制 key —— "删了哪些文件"变得不可读。
			name: "★ 留痕的名字在摘记录之后才读（日志里只剩一串 key）",
			from: "\t\t\tconst name = store.get(key)?.sourceName ?? \"\";\n\t\t\tif (store.remove(key)) removed.push(key);",
			to: "\t\t\tif (store.remove(key)) removed.push(key);\n\t\t\tconst name = store.get(key)?.sourceName ?? \"\";",
			expect: "名字要在摘记录**之前**读到",
		},
	],
});
