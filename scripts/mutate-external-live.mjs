import { runMutations } from "./lib/mutate.mjs";
import { runExternalLiveSuite } from "./lib/external-live-suite.mjs";

/**
 * 变异验证：实时预览下的站外图（`src/render/external-live.ts`）。
 *
 * 这一层失效的症状**全都是安静**：不延后就一张都不处理；不攒批就是白烧 CPU；
 * 按"当前活动笔记"猜归属会在分屏时**改写另一篇笔记**（损坏用户数据）；
 * 卸载不清理就是"插件关掉了还在改笔记"。
 */
await runMutations({
	source: "src/render/external-live.ts",
	suite: runExternalLiveSuite,
	mutations: [
		{
			// 后果：赋值那一刻元素还没进 DOM ⇒ 归属永远是 null ⇒ **一张都不处理**，
			// 也就是"编辑态里缓存外站图片完全没反应"这个 bug 原样复发。
			name: "★ 不再延后（当场处理，归属解析全部失败）",
			from: "\t\t\t\tschedule(flush);\n",
			to: "\t\t\t\tflush();\n",
			expect: "记下候补时不能立刻处理",
		},
		{
			// 后果：一屏几十张图会连着遍历几十次打开的视图（每次都要走一遍所有 leaf）。
			name: "不再攒批（每张图各排一次调度）",
			from: "\t\t\tif (scheduled) return;\n",
			to: "\t\t\t// 变异：不攒批\n",
			expect: "一批只排一次调度",
		},
		{
			// 后果：不再判断"这个元素确实在这个视图里"，于是**不在任何笔记里的图**
			// 也会被当成属于第一个视图 —— 那张图会被拿去改写**别的**笔记。
			name: "★ 归属解析只看第一个视图、不再判断包含关系（会改写另一篇笔记）",
			from: "\t\t\tif (contains.call(view.root, element)) return view.path;\n",
			to: "\t\t\treturn view.path;\n",
			expect: "不在任何笔记里的元素必须返回 null",
		},
		{
			// 后果：调度标志永远停在"已排"，一次取视图失败之后**所有**候补都进不来
			//（表现是"之后编辑态里的站外图再也不处理了"）。
			name: "★ 取视图失败后调度标志不复位（队列被永久卡死）",
			from: "\tconst flush = (): void => {\n\t\tscheduled = false;\n",
			to: "\tconst flush = (): void => {\n\t\t// 变异：不重置调度标志\n",
			expect: "一次取视图失败之后仍应能继续工作",
		},
		{
			// 后果：一张图出问题会让整批候选都不处理。
			name: "单张图抛错会拖垮整批（不再逐张隔离）",
			from:
				"\t\t\ttry {\n\t\t\t\tconst path = notePathForElement(views, element);\n" +
				"\t\t\t\t// 拿不到归属就跳过：这条链路会改写笔记，改错了就是损坏用户数据\n" +
				"\t\t\t\tif (!path) continue;\n\t\t\t\tdeps.handle(element, path);\n" +
				"\t\t\t} catch (error) {\n\t\t\t\t// 单张图出问题不能拖垮这一批（还有别的图要处理）\n" +
				"\t\t\t\treport(error);\n\t\t\t}\n",
			to: "\t\t\tconst path = notePathForElement(views, element);\n\t\t\tif (path) deps.handle(element, path);\n",
			expect: "单张图抛错不能拖垮整批",
		},
		{
			// 后果：静默。取不到视图列表这件事会被完全吞掉，排查时没有任何线索。
			name: "取视图失败不再记录（静默）",
			from: "\t\t\treport(error);\n\t\t\treturn;\n",
			to: "\t\t\treturn;\n",
			expect: "这个错误要被记录",
		},
		{
			// 后果：插件卸载后仍在处理并**改写笔记**（最典型的"卸载不干净"）。
			name: "★ 卸载不清空待处理（卸载后仍在处理并改写笔记）",
			from: "\t\t\tdisposed = true;\n\t\t\tbatch.clear();\n",
			to: "\t\t\tdisposed = true;\n",
			expect: "卸载后不该还攒着候补",
		},
		{
			// 后果：卸载后新的上报照样被收下并处理 —— 同上，只是入口不同。
			name: "★ 卸载后仍接受新的候补",
			from: "\t\t\tdisposed = true;\n",
			to: "\t\t\t// 变异：不标记已卸载\n",
			expect: "卸载之后新的上报也要被忽略",
		},
		{
			// 后果：默认调度变成同步 ⇒ 拿不到归属 ⇒ 编辑态里站外缓存再次完全失效
			//（注入的调度器测不出这条，因为它不走默认路径）。
			name: "★ 默认调度不再延后（不注入调度器时站外缓存再次失效）",
			from: "\t\tqueueMicrotask(flush);\n",
			to: "\t\tflush();\n",
			expect: "默认调度也必须是延后的",
		},
	],
});
