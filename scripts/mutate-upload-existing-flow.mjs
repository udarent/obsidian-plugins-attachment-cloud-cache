import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**「上传附件」那条命令的编排**（`src/plugin/upload-existing-flow.ts`）。
 *
 * ## ⚠️ 判据仍然是**端到端**那套（`load-acceptance`），只是锚点换了落脚点
 *
 * 这四条锚点原来在 `mutate-load-acceptance.mjs` 里、`source` 写的是 `src/main.ts` ——
 * 2026-10-13（A1 第六批）这条命令的编排搬进 `plugin/` 之后，它们"找不到目标"了。
 * ⚠️ **锚点找不到目标 = 那四条验证从没在跑**（假绿），比"跑失败"更糟。
 *
 * ⇒ 修法是**让锚点跟着实现走**（不是搬回去、更不是删掉）：
 * `source` 改成新文件，`entries` 仍然从 `src/main` 打包（它 import 了这条流程，
 * 于是**被变异的代码照样会进 bundle**），`reexportDefault` 仍然显式再导一次
 * `src/main` 的 default（`export *` 按 ESM 规范不含 default —— 不写这行拿到的是
 * 模块命名空间对象，报一句看不出原因的 `not a constructor`）。
 *
 * ⭐ 于是**同一个端到端验收套件**继续当判据：变的只是"打坏哪一行"，
 * "打坏之后由谁发现"没变。这也是本项目"守卫/锚点绑通路、不绑文件"的又一次落地。
 */
await runMutations({
	source: "src/plugin/upload-existing-flow.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			// 后果：取消之后**装作什么都没发生**（连一句话都没有）⇒ 用户会以为命令坏了。
			// ⚠️ 2026-10-15：判据移进「清单式弹窗」之后，"取消 ⇒ 不改笔记 / 不下载"是**结构保证**的
			//（动手只发生在弹窗的 `run` 回调里，取消根本不会调到它）⇒ 这条锚点改守另一半：
			// 取消必须**如实说一句**（为此在验收里补了一条断言）。
			name: "★ 取消之后装作什么都没发生（用户以为命令坏了）",
			from: '\tif (!result) {\n',
			to: '\tif (false) {\n',
			expect: "取消之后要如实反馈",
		},
		{
			// ⚠️ 从 mutate-load-acceptance 搬来。后果：确认框不再说清"文件留在原地、
			// 只有链接会变"。用户的预期是从前那句"会被搬进缓存目录"来的 ——
			// 少了这句，他跑完发现文件还在会以为没生效（反过来也可能以为文件被搬走了）。
			name: "★ 确认框不再说清文件留在原地（用户以为没生效或以为文件被搬走）",
			from: '\t\tctx.t("maintainBatchOriginalsStay"),\n',
			to: "\t\t// 变异：去掉'留在原地'的说明\n",
			expect: "留在附件目录",
		},
		{
			// 后果：算出了外链候选却不交给执行层 ⇒ 清单里承诺了「另有 N 个站外文件」，
			// 实际一个都不处理（而且不报错）。⚠️ 2026-10-15 起**勾选**成了过滤条件，
			// 打坏它（`to` 给空数组）就等于「用户勾了却没处理」—— 判据仍是那条端到端等待。
			name: "★ 勾中的外链候选没交给执行层（清单承诺了却没做）",
			from: "candidates: externals.filter((candidate) => chosen.has(pickKey(candidate))),",
			to: "candidates: [],",
			expect: "外链图被下载、上传",
		},
		{
			// 后果：**已经不在了的本机文件又进了清单**（`file:///…` 指着的那个东西被删了）——
			// 用户看到一行连缩略图都没有、点了一定失败的条目。2026-10-16 用户实测报的正是这个
			//（WPS 的 `Temp/ksohtml/wpsDD.tmp.jpg`）。
			name: "★★ 不摘掉已经不在了的本机文件（清单里出现点了一定失败的条目）",
			from: "\t\tdeps.localFileExists ?? localFileExists",
			to: "\t\tasync () => true",
			expect: "已经不在的本机文件",
		},
		{
			// ⚠️ 从 mutate-load-acceptance 搬来。后果：确认框不再列出即将访问的站点 ⇒
			// 用户是在**盲签**一份下载许可（这条命令会真的去访问那些站点）。
			name: "★ 确认框不列出即将访问的站点（用户盲签下载许可）",
			from: '\t\t\t\thosts: external.sites.map((site) => site.host).join(", "),',
			to: '\t\t\t\thosts: "",',
			expect: "确认框必须列出即将访问的站点",
		},
		{
			// 后果：**摘要里把下面那张清单又贴了一遍**（前十条路径 + 「……还有 N 个」）——
			// 这正是用户 2026-10-16 实测提的那件事：「在上部有文件列表的摘要，但其实已经做了
			// 下面的列表了，可以精简内容」。清单越长这条越像噪音，而下面那张清单本来就
			// 带缩略图、能勾选、还自带滚动条。
			name: "★★ 摘要里重复贴出文件名（与下面那张清单重复）",
			from: '\t\tctx.t("maintainBatchSummary", { count: selection.paths.length + externals.length }),\n',
			to:
				'\t\tctx.t("maintainBatchSummary", { count: selection.paths.length + externals.length }),\n' +
				"\t\t...selection.paths.slice(0, 10),\n",
			expect: "摘要里不该重复列出文件名",
		},
		{
			// 后果：**摘要里的数字与下面那张清单对不上**。2026-10-17 真机复验实测：
			// 摘要写「将上传 0 个文件」，而清单列了 8 行 —— 因为 `count` 只数库内待传，
			// 清单还含站外、本机、以及已缓存过（只会被复用）的条目。用户读到的是
			// "这屏没什么可传的"，而下面明明能勾 8 行。
			name: "★★ 摘要只数库内待传（与清单行数对不上）",
			from: '\t\tctx.t("maintainBatchSummary", { count: selection.paths.length + externals.length }),\n',
			to: '\t\tctx.t("maintainBatchSummary", { count: selection.paths.length }),\n',
			expect: "摘要里的数字必须等于清单行数",
		},
	],
});
