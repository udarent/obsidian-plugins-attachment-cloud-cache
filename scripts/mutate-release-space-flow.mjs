import { runMutations } from "./lib/mutate.mjs";
import { runReleaseSpaceFlowSuite } from "./lib/release-space-flow-suite.mjs";

/**
 * 变异验证：**「清理本地占用」（F18）的编排**（`src/plugin/release-space-flow.ts`）。
 *
 * 与另外两个的分工：`mutate-release-space.mjs` 变异的是**判定层**（`planReleaseSpace`
 * 那四条准入判据）；这里变异的是**编排层** —— 判定层说得再对，
 * 编排层把台账/引用集合传错了，或者把确认框的警示漏了、把"一个都没删"的解释漏了，
 * 后果一样：删了不该删的，或者让用户完全不知道发生了什么。
 *
 * ⚠️ **前两条是从 `mutate-load-acceptance.mjs` 搬过来的**（2026-10-13 随 A1 第四批）：
 * 它们盯的原来是 `main.ts::localSpaceSelection` 里的两行，实现搬到 `plugin/` 之后
 * 那两条锚点就"找不到目标"了。⚠️ 这**不是**锚点失效，而是**锚点指向了文件而不是通路**——
 * 修法是让锚点跟着实现走。搬过来之后，它们由本套件（跑的是真实执行层）继续守着同一件事。
 *
 * 断言套件与正式测试共用（`lib/release-space-flow-suite.mjs`）。
 */
await runMutations({
	source: "src/plugin/release-space-flow.ts",
	// ⚠️「执行层模块」是删文件那一步的宿主模块：套件里有一节直接调它，
	// 缺了它那个函数就是 undefined，基线直接失败。
	entries: ["src/plugin/release-space-flow", "src/i18n", "src/s3/client", "src/maintenance/run"],
	suite: runReleaseSpaceFlowSuite,
	mutations: [
		{
			// ⭐ 从 mutate-load-acceptance 搬来。后果：候选不再要求"这个对象是我们传上去的"
			// ⇒ 一个**从没上传成功**的本地附件也会被删，而它云端可能根本没有 ——
			// 那是真正丢数据的一条。
			name: "★★ 存量清理不再查上传台账（没传成功过的本地文件也会被删）",
			from: "\t\tuploaded: new Set(index.uploadedKeys()),",
			to: "\t\tuploaded: new Set(entries.map((entry) => entry.key)),",
			expect: "台账里没有的对象不得删",
		},
		{
			// ⭐ 从 mutate-load-acceptance 搬来。后果：候选不再要求"该对象**被笔记引用着**"
			// ⇒ 连**孤儿**一起清 —— 而孤儿正是"用户可能还想留着"的那一类
			//（笔记删了、图还在），且它越过了与 R17 三档询问的分工线（那条线是**逐次询问**）。
			name: "★ 存量清理不再要求「带远端链接」（孤儿也被一起清掉）",
			// ⚠️ 2026-10-15（D-31）：源码里这两行之间多了 `referencedPaths`（另一半引用判据），
			// 锚点跟着改成三行；`to` 把每一行都还回去（它俩是两项不同的判据，都要留在对象里）。
			from: "\t\treferencedKeys,\n\t\treferencedPaths,\n\t\tkeepBytes,",
			to: "\t\treferencedKeys: new Set(entries.map((entry) => entry.key)),\n\t\treferencedPaths: new Set(),\n\t\tkeepBytes,",
			expect: "孤儿（没有任何笔记引用）不归它管",
		},
		{
			// 后果：读不到笔记时异常直接冒泡 —— 两个入口都在没有 catch 的回调里
			// ⇒ 变成一句 unhandled rejection，用户什么都看不到。
			name: "★ 去掉\"读不到笔记 ⇒ 整体放弃\"的兜底（异常冒泡，用户什么都看不到）",
			from: "\tlet selection: ReleaseSpaceSelection;\n\ttry {\n\t\tselection = await localSpaceSelection(ctx, keepBytes);\n\t} catch (error) {",
			to: "\tconst selection = await localSpaceSelection(ctx, keepBytes);\n\tif (false) {",
			// ⚠️ 这条的失败形态与别条不同：套件在 await 那一步就被拒绝（断言没机会跑），
			// 报错就是那句从 i18n 冒出来的错误文本 —— 照实写。
			expect: "Could not read notes/broken.md",
		},
		{
			// 后果：读不到的那篇可能正是**引用着这些图**的笔记 ⇒ 引用集合变小、候选变大
			// ⇒ 删掉还在用的。这是这个功能唯一能"因为读不到而多删"的方向。
			name: "★ 读不到笔记时当作\"没有可清的\"继续（候选凭空变大，删掉还在用的）",
			from: "\t\tnew Notice(describeError(error));\n\t\treturn;\n\t}",
			to: "\t\tvoid error;\n\t\tselection = { candidates: [], bytes: 0, missing: 0 };\n\t}",
			expect: "必须明确告知并取消",
		},
		{
			// 后果：切档那次也出声 ⇒ 用户刚改了设置，却被弹一句"没东西可清"（他在改设置，不是来清理的）。
			name: "★ 切档那次也出声（用户刚改完设置就被打扰）",
			from: '\t\tif (whenEmpty === "silent") return;\n',
			to: "",
			expect: "没东西可清就别打扰他",
		},
		{
			// 后果：永久删除的确认框不当成破坏性渲染 —— 用户面对不可逆的动作，
			// 看到却是一个普通框。
			name: "★ 确认框不标破坏性（永久删除按普通框渲染）",
			from: "\t\tdestructive: true,",
			to: "\t\tdestructive: false,",
			expect: "永久删除必须标成破坏性",
		},
		{
			// 后果：确认框漏掉\"云端与笔记都不动\"这句 ⇒ 用户不敢按（他怕把图删死，
			// 而真相是删的只是本地副本、随时能再下载回来）。
			name: "★ 确认框漏掉\"云端不动、笔记不动\"（用户不敢按下去）",
			from: '\t\tctx.t("releaseSpaceCloudUntouched"),\n',
			to: "",
			expect: "必须写明云端不动",
		},
		{
			// 后果：用户点了"取消"，文件照样被永久删除 —— 确认框成了装饰。
			name: "★ 取消之后仍然继续删（确认框形同虚设）",
			from: '\tif (!confirmed) {\n\t\tnew Notice(ctx.t("maintainCancelled"));\n\t\treturn;\n\t}',
			to: '\tif (!confirmed) {\n\t\tnew Notice(ctx.t("maintainCancelled"));\n\t}',
			expect: "一个文件都不许删",
		},
		{
			// 后果："一个都没删"时不再解释 ⇒ 用户刚按下"永久删除"、只看到"跳过 N 个"，
			// 完全不知道发生了什么（他会以为功能坏了）。
			name: "★ \"一个都没删\"时不解释（用户以为功能坏了）",
			from: '\tif (result.evicted === 0 && result.skipped.length > 0) {\n\t\tnew Notice(ctx.t("releaseSpaceNothingDeleted", { skipped: result.skipped.length }));\n\t}',
			to: "\t// 变异：不解释",
			expect: "必须**再解释一句**",
		},
		{
			// 后果：清单不截断 ⇒ 几百张卡把摘要与三句警示挤掉，而用户正是照着摘要
			// 判断"值不值得清"的。
			name: "★ 清单不截断（几百张卡挤掉摘要与警示）",
			from: "\t\tRELEASE_SPACE_LIST_MAX\n\t);",
			to: "\t\tselection.candidates.length\n\t);",
			expect: "清单上限是 10",
		},

		// ── ⭐⭐ 目标（2026-10-15 用户报告：设了上限 500，清理却全清）──
		{
			// 后果：目标在**编排层**就丢了（永远当成"一份不留"）⇒ 用户设了 500 MB、按下清理，
			// 结果本地副本一份不剩。⭐ 这正是用户报的那个行为。
			name: "★★ 目标在编排层丢掉（上限档退化成全清）",
			from: "\tconst keepBytes = target.kind === \"limit\" ? megabytesToBytes(target.mb) : 0;",
			to: "\tconst keepBytes = 0;",
			expect: "只删到上限以内就停",
		},
		{
			// 后果："没有目标"（保留副本档 + 没设上限）被放进下面的路径 ⇒ `target.mb` 是
			// `undefined` ⇒ 目标算成 0 = **全清** —— 一个防御分支变成了破坏性行为。
			name: "★★ 没有目标时继续往下走（被解释成「全清」）",
			from: "\tif (target.kind === \"none\") return;",
			to: "\tif (false) return;",
			expect: "没有目标 ⇒ 一个文件都不许删",
		},
	],
});
