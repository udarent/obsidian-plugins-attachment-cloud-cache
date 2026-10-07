import { runMutations } from "./lib/mutate.mjs";
import { runRotationSuite } from "./lib/rotation-suite.mjs";

/**
 * 变异验证：后台自动轮换的编排（`src/maintenance/rotation.ts`）。
 *
 * 每一条对应的都是"不报错但会白干活/该干不干"：门槛失效就去读全库笔记、
 * 节流失效就连粘几张图触发多轮、并发标志写错就两轮同时删同一批文件、
 * 异常抛出去就变成了插件报错。
 */
await runMutations({
	source: "src/maintenance/rotation.ts",
	entries: ["src/maintenance/rotation", "src/maintenance/eviction", "src/cache-path"],
	suite: runRotationSuite,
	mutations: [
		{
			// 后果：用户没设上限（0）时仍然继续跑 ⇒ 整体超限 ⇒ **把整个缓存淘汰掉**。
			// "0 = 不限制"是默认值，所以这条错法会落在绝大多数用户身上。
			name: "★ 不再区分「不限制」（默认设置下就开始清空缓存）",
			from: "\t\t\t\tif (limitBytes <= 0) return null;\n",
			to: "\t\t\t\t// 变异：不区分「不限制」\n",
			expect: "不限制",
		},
		{
			// 后果：每次上传都要**列一次目录 + 逐个 stat**（这是"缓存长大"的最常见路径）。
			// 门槛①存在的全部意义就是挡住这一步。
			name: "★ 去掉便宜的门槛（每次上传都去列目录）",
			from: "\t\t\t\tif (\n\t\t\t\t\treason !== \"startup\" &&\n\t\t\t\t\tsumIndexedBytes(deps.index().toArray(), settings.cacheFolder) <= limitBytes\n\t\t\t\t) {\n\t\t\t\t\treturn null;\n\t\t\t\t}\n",
			to: "\t\t\t\t// 变异：不做便宜的门槛检查\n",
			expect: "索引没超",
		},
		{
			// 后果：磁盘上其实没超，却仍去**读全库笔记**（大库里就是几秒到几十秒的 I/O），
			// 而且会周期性重复。
			name: "★ 去掉磁盘门槛（没超也去读全库笔记）",
			from: "\t\tif (totalBytes <= limitBytes) {\n\t\t\treturn { reason, totalBytes, limitBytes, evicted: 0, freed: 0, skipped: 0, overBy: 0 };\n\t\t}\n",
			to: "\t\t// 变异：不做磁盘门槛检查\n",
			expect: "不该扫笔记",
		},
		{
			// 后果：索引坏掉/被删时（那时索引里 0 字节）启动那一轮会被便宜门槛挡下 ⇒
			// 缓存目录里那堆"孤儿"永远腾不掉，上限形同虚设。
			name: "★ 启动那一轮也去看索引（索引坏掉后上限永久失效）",
			from: '\t\t\t\t\treason !== "startup" &&\n',
			to: "\t\t\t\t\ttrue &&\n",
			expect: "启动时必须去量磁盘",
		},
		{
			// 后果：节流失效 ⇒ 连粘 20 张图触发 20 轮，每轮都量磁盘、扫笔记、删文件。
			name: "★ 去掉节流（连粘多张图就触发多轮淘汰）",
			from: "\t\t\t\tif (!isRotationDue({ now: at, lastRunAt, minIntervalMs })) return null;\n",
			to: "\t\t\t\tvoid isRotationDue;\n",
			expect: "被节流挡住",
		},
		{
			// 后果：两轮同时量磁盘、同时删同一批文件 —— 结果没法解释，
			// 而且"某个文件到底删了没有"会变得不确定。
			name: "★ 去掉并发标志（两轮同时删同一批文件）",
			from: "\t\t\tif (running) return null;\n",
			to: "\t\t\t// 变异：不挡并发\n",
			expect: "只跑一轮",
		},
		{
			// 后果：用**计划**里的数字算"还超多少"，而执行时可能有文件被跳过 ⇒
			// 报出来的超出量偏小，用户以为上限已经生效。
			name: "★ 「还超多少」用计划数字而不是实际回收量（报小了，让人以为上限生效了）",
			from: "\t\tconst overBy = Math.max(0, totalBytes - outcome.freed - limitBytes);",
			to: "\t\tconst overBy = Math.max(0, totalBytes - plan.reclaimable - limitBytes);",
			expect: "实际",
		},
		{
			// 后果：什么都没删也照样弹提示 ⇒ 后台保洁任务在用户读笔记时反复插嘴。
			name: "★ 什么都没删也会提示（后台任务开始插嘴）",
			from: "\t\tif (outcome.evicted > 0) announce(outcome, overBy);\n",
			to: "\t\tannounce(outcome, overBy);\n",
			expect: "不该提示",
		},
		{
			// 后果：后台任务把异常抛进插件的生命周期里 —— 用户看到的是"插件报错"，
			// 而触发它的可能只是"列目录时被占用了一下"。
			name: "★ 出错时把异常抛给调用方（后台任务把异常抛进插件生命周期）",
			from: "\t\t\t} catch (error) {\n\t\t\t\t// 后台任务绝不能把异常抛给调用方（它跑在插件的生命周期里）\n\t\t\t\treport(error);\n\t\t\t\treturn null;\n\t\t\t}",
			to: "\t\t\t} catch (error) {\n\t\t\t\tthrow error;\n\t\t\t}",
			expect: "绝不能抛给调用方",
		},
	],
});
