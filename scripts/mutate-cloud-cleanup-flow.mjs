import { runMutations } from "./lib/mutate.mjs";
import { runCloudCleanupFlowSuite } from "./lib/cloud-cleanup-flow-suite.mjs";

/**
 * 变异验证：**入口 B 的编排**（`src/plugin/cloud-cleanup-flow.ts`）。
 *
 * 与 `mutate-cloud-cleanup.mjs` 的分工：那个变异的是**判定层**（`selectCleanupCandidates`：
 * 什么该进候选）；这里变异的是**编排层** —— 判定层说得再对，编排层把集合传错了、
 * 把确认框的警示漏了、把留痕忘了，后果一样是"删了不该删的、或者删了没痕迹"。
 *
 * ⚠️ 这一层此前是 `main.ts` 的私有方法，**没有任何变异锚点**（套件加载不了插件类）。
 * 2026-10-13 的 A1 重构把它搬进 `plugin/` 之后才能这样逐条打坏。
 *
 * 断言套件与正式测试共用（`lib/cloud-cleanup-flow-suite.mjs`）。
 */
await runMutations({
	source: "src/plugin/cloud-cleanup-flow.ts",
	entries: ["src/plugin/cloud-cleanup-flow", "src/i18n", "src/s3/client"],
	suite: runCloudCleanupFlowSuite,
	mutations: [
		{
			// 后果：把 2026-10-13 之前的形状**还原**回来 —— 读不到笔记时异常直接冒泡，
			// 命令回调没有 catch ⇒ 变成一句 unhandled rejection：用户什么都看不到，
			// 而 i18n 里那句文案写着"因此取消了这次清理"（从来没机会显示）。
			name: "★ 去掉\"读不到笔记 ⇒ 整体放弃\"的兜底（异常冒泡，用户什么都看不到）",
			from: "\tlet referenced: Set<string>;\n\ttry {\n\t\treferenced = await cloudReferencedKeys(ctx);\n\t} catch (error) {\n\t\tnew Notice(describeError(error));\n\t\treturn;\n\t}",
			to: "\tconst referenced = await cloudReferencedKeys(ctx);",
			// ⚠️ 这条的失败形态与别条不同：套件在 `await` 那一步就被拒绝（断言根本没机会跑），
			// 报错就是那句从 i18n 冒出来的错误文本 —— 照实写。
			expect: "Could not read notes/broken.md",
		},
		{
			// 后果：读不到的那篇可能正是**引用着这些对象**的笔记 ⇒ 引用集合变小、
			// 候选凭空变大 ⇒ 删掉还在用的对象。这是"跳过继续"唯一的方向。
			name: "★ 读不到笔记时当成\"没有引用\"继续（候选凭空变大，删掉还在用的）",
			from: "\t\treferenced = await cloudReferencedKeys(ctx);\n\t} catch (error) {\n\t\tnew Notice(describeError(error));\n\t\treturn;\n\t}",
			to: "\t\treferenced = await cloudReferencedKeys(ctx);\n\t} catch (error) {\n\t\tvoid error;\n\t\treferenced = new Set();\n\t}",
			expect: "必须明确告知并取消",
		},
		{
			// 后果：桶里几百个对象、列举只读了前 50 页 —— 此时"没有候选"这句话会被
			// 用户读成"剩下的都还有人用"，而真相是"我们根本没读完"。
			name: "★ 列举没读全时按\"没有可清理的\"报（假装清单是完整的）",
			from: '\t\t\tlisted.truncated ? ctx.t("cloudCleanupTruncatedNothing") : ctx.t("cloudCleanupNothing")',
			to: '\t\t\tctx.t("cloudCleanupNothing")',
			expect: "列举没读全时",
		},
		{
			// 后果：判定层算出来的\"仍在被引用\"被丢掉 ⇒ 还在笔记/画布里的对象进候选。
			name: "★ 不把\"仍被引用\"传给判定层（引用着的对象被当成可删）",
			from: "\t\treferencedKeys: referenced,",
			to: "\t\treferencedKeys: new Set(),",
			expect: "只剩一个候选",
		},
		{
			// 后果：站外缓存的对象被当成孤儿 —— 而它的引用可能写在别处（`CacheEntry.origin`）。
			name: "★ 不排除站外缓存的对象（别人的图被删）",
			from: "\t\texternalKeys: externalKeysOf(ctx.currentIndex()),",
			to: "\t\texternalKeys: new Set(),",
			expect: "只剩一个候选",
		},
		{
			// 后果：确认框不当成\"会删东西\"来展示（标题与按钮不再按破坏性渲染）——
			// 用户面对一次不可恢复的删除，却看到和\"刷新索引\"一样的框。
			name: "★ 确认框不标破坏性（不可恢复的删除按普通框渲染）",
			from: "\t\tdestructive: true,",
			to: "\t\tdestructive: false,",
			expect: "必须标成破坏性",
		},
		{
			// 后果：清单可能不全这件事**只在"一个候选都没有"时才说**（上面那条管），
			// 真到要删的时候反倒不说了 —— 而这正是用户需要知道的那一刻。
			name: "★ 要删的时候不提示\"清单可能不全\"",
			from: '\t\t...(listed.truncated ? [ctx.t("cloudCleanupTruncatedWarning")] : []),',
			to: "\t\t// 变异：不提示清单不全",
			expect: "确认框里也要再写一次",
		},
		{
			// 后果：用户点了\"取消\"，对象照样被删 —— 确认框成了装饰。
			name: "★ 取消之后仍然继续删（确认框形同虚设）",
			from: '\tif (!confirmed) {\n\t\tnew Notice(ctx.t("maintainCancelled"));\n\t\treturn;\n\t}',
			to: '\tif (!confirmed) {\n\t\tnew Notice(ctx.t("maintainCancelled"));\n\t}',
			expect: "取消 ⇒ 一个对象都不许删",
		},
		{
			// 后果：删了云端却什么都不留 —— 而"不可恢复 + 自动/一步删除 + 不留痕"
			// 是本产品风险最集中的三件事叠在一起。
			name: "★ 删完不留痕（云端对象没了，事后查不到删过什么）",
			from: "\tawait writeDeleteLog(ctx, records);",
			to: "\tvoid records;",
			expect: "每个被删的对象都要留一行痕",
		},
		{
			// 后果：留痕把入口记错 ⇒ 事后排查时会把"用户手动清的"当成"孤儿询问清的"，
			// 两条入口的追责与复现路径完全不同。
			name: "★ 留痕把入口记成 orphan（事后分不清哪条入口删的）",
			from: 'records.push({ ...record, scope: "command" })',
			to: 'records.push({ ...record, scope: "orphan" })',
			expect: "入口必须记成 command",
		},
		{
			// 后果：桶里几千个对象时把每一张卡都塞进弹窗 —— 用户看不到摘要，
			// 也就看不到\"总体积\"与\"多设备盲区\"这两句最要紧的告知。
			name: "★ 清单不截断（几千张卡挤掉摘要与警示）",
			from: "\t\tCLOUD_CLEANUP_LIST_MAX\n\t);",
			to: "\t\tselection.candidates.length\n\t);",
			expect: "清单上限是 10",
		},
	],
});
