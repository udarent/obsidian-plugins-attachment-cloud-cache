import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**「上传全部附件」那条链的编排**（`src/plugin/upload-existing-flow.ts`）。
 *
 * ## ⚠️ 2026-10-23 整份重写：原来的 13 条锚点全绑在**清单**上
 *
 * 用户要求「设置界面的"上传附件"改成与"恢复本地链接"相反的对应功能，取消弹窗选择的
 * 复杂交互」⇒ 清单没了，那 13 条锚点（`summaryLines` / `buildRows` / `scope.missingLocal` /
 * `externalRowMeta` / `title: maintainBatchTitle` …）**全部找不到目标**。
 * 而"锚点找不到目标"在本项目是最贵的一种假绿（那条变异从没在跑，`check-mutation-preflight`
 * 就是为此加的）⇒ 不是删掉，而是**跟着实现走**：改打在"一键流程"那几行上。
 *
 * ⚠️ 判据仍然是**端到端**那套（`load-acceptance`）：变的只是"打坏哪一行"。
 */
await runMutations({
	source: "src/plugin/upload-existing-flow.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		// ⚠️ 没有为"未引用的附件不许被传"设锚点：它在**两层**都拦着（选候选那一处 ＋
		// 执行层的默认 `includeUnreferenced: false`），改任意一层都不改变行为 ⇒
		// 这种锚点永远"漏过"（实测两次）。行为本身仍由验收的 8b2' 正向钉着
		//（那一趟前后 PUT 计数必须一样），只是没有变异覆盖 —— 如实记在这里。

		{
			// 后果：**站外那一路不再按设置走** —— 用户关掉了「站外文件」开关，插件照样
			// 去别人的服务器拉图（而界面上完全静默，这是最不该发生的一类）。
			// ⚠️ 2026-10-24 的判据就落在这一个取值上：`auto` = 受开关与名单约束，
			// `manual` = 无视两者（那是清单形态的语义，现在没有清单了）。
			name: "★★ 站外候选不再受设置里的开关约束（关掉了照样去拉图）",
			from: '\t\tpurpose: "auto",',
			to: '\t\tpurpose: "manual",',
			expect: "站外开关关着",
		},
		{
			// 后果：**本机文件那个开关形同虚设** —— 用户没允许，插件照样按笔记里的
			// 绝对路径去读这台电脑上的文件。
			name: "★★ 本机文件不看设置开关（没允许也去读磁盘）",
			from: "\t\tincludeLocalFiles: ctx.settings.uploadLocalFiles,",
			to: "\t\tincludeLocalFiles: true,",
			expect: "设置里没允许",
		},
		{
			// 后果：**库外候选算出来了却没交给执行层** —— 确认框说"会访问那台主机"，
			// 跑完却什么都没下载（用户以为已经搬过去了）。
			name: "★★ 库外候选算出来了却没交给执行层（说了会访问却什么都没做）",
			from: "\t\t\texternal: { ...external, candidates: kept },",
			to: "\t\t\texternal: { ...external, candidates: [] },",
			expect: "打开开关之后，站外图被下载",
		},
		{
			// 后果：**算出了候选却一件都没交给执行层** —— 用户按了确认、界面说"完成"，
			// 笔记一条都没变（而且不报错）。
			name: "★★ 候选算出来了却没交给执行层（确认之后什么都没做）",
			from: "\t\t\tonlyPaths: new Set(selection.paths),",
			to: "\t\t\tonlyPaths: new Set(),",
			expect: "笔记里的链接被改写成远端地址",
		},
		{
			// 后果：**"只差改链接"的那些不再进候选** ⇒ 用户重跑修不好"已经传过、正文还是
			// 本地路径"那种半成品记录（2026-10-21 实报的场景）。
			name: "★★ 只差改链接的附件没进候选（重跑修不好半成品记录）",
			from: "\t\trepairablePaths: snapshot.rewritable,\n\t\t// ⚠️ **不**收未引用的文件",
			to: "\t\trepairablePaths: new Set(),\n\t\t// ⚠️ **不**收未引用的文件",
			expect: "重修之后链接指向存储",
		},
		{
			// 后果：确认框**不再说这是"只改链接"** ⇒ 用户看到"要上传 N 个"会以为又要传一遍
			// 几百兆（而实际一个字节都不发）。
			// ⚠️ 2026-10-29：这一段的形状变了（`repairCount` 提前算好、两支措辞按
			// `transferCount` 分流）—— 锚点跟着换成现在那行的开头。
			name: "★★ 确认框不说清「只改链接」（用户以为在重传一遍）",
			from: "\tif (repairCount > 0) {",
			to: "\tif (false) {",
			expect: "确认框要说明「这些已经在你的存储里、只改链接」",
		},
		{
			// 后果：确认框**不再说"文件留在原处、云端不删"** —— 用户跑完发现文件还在，
			// 会以为没生效（或反过来以为文件被搬走了）。
			name: "★★ 确认框不再说清文件留在原地（用户以为没生效或以为文件被搬走）",
			// ⚠️ 2026-10-24：这句现在只在"真有东西要传"时才执行（纯清理那一支不说上传的事），
			// 而且下面还多了"顺手删本地副本"那一段 —— 锚点必须带上现在的条件。
			from: '\tif (total > 0) lines.push(ctx.t("uploadAllKeeps"));',
			to: '\tif (total > 0) lines.push(ctx.t("uploadAllSummary", { count: 1 }));',
			expect: "确认框要写清「文件留在原处、云端不删」",
		},
		{
			// 后果：确认框的**标题**与这一项的名字对不上（用户点了「上传全部附件」，
			// 弹出来的是别的一句话）。
			name: "★ 确认框标题与这一项的名字对不上",
			from: '\t\ttitle: ctx.t("uploadAllTitle"),',
			to: '\t\ttitle: ctx.t("uploadAllButton"),',
			expect: "确认框标题必须与这一项的名字对得上",
		},
		{
			// 后果：**取消之后装作什么都没发生**（连一句话都没有）⇒ 用户会以为按钮坏了，
			// 而这一次他其实什么也没做（该如实说一句）。
			name: "★ 取消之后装作什么都没发生（用户以为按钮坏了）",
			from: '\t\tnew Notice(ctx.t("maintainCancelled"));\n\t\treturn;\n\t}\n\n\tconst state: { summary: BatchResult | null }',
			to: '\t\treturn;\n\t}\n\n\tconst state: { summary: BatchResult | null }',
			expect: "取消之后要如实反馈",
		},
	],
});
