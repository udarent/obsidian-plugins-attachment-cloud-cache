import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：**「上传已有附件」那条命令的编排**（`src/plugin/upload-existing-flow.ts`）。
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
			// ⚠️ 从 mutate-load-acceptance 搬来。后果：维护命令不再请求确认 ⇒
			// 用户在命令面板里点错一下就开始改笔记、下载站外图
			//（"取消 = 什么都没发生"这条路径整个不存在了）。
			name: "★ 维护命令不再请求确认（点错命令即改笔记、下载站外图）",
			from: '\tif (!confirmed) {\n\t\tnew Notice(ctx.t("maintainCancelled"));\n\t\treturn;\n\t}\n\n\tconst result = await runBatchUpload(deps, { external, referencedPaths });',
			to: "\tvoid confirmed;\n\tconst result = await runBatchUpload(deps, { external, referencedPaths });",
			expect: "取消之后",
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
			// ⚠️ 从 mutate-load-acceptance 搬来。后果：算出了外链候选却不交给执行层 ⇒
			// 命令只搬库内文件、外链图原样留着，而确认框刚刚向用户承诺过会处理它们。
			// ⚠️ 只摘掉 `external` —— 把整份 options 都去掉会变成"少传参数"的报错，
			// 那样测到的就不是"外链那趟被跳过"了（变异的原因要对得上）。
			name: "★ 算出了外链候选却不交给执行层（确认框承诺了却没做）",
			from: "runBatchUpload(deps, { external, referencedPaths });",
			to: "runBatchUpload(deps, { referencedPaths });",
			expect: "外链图被下载、上传，笔记里的链接被改写",
		},
		{
			// ⚠️ 从 mutate-load-acceptance 搬来。后果：确认框不再列出即将访问的站点 ⇒
			// 用户是在**盲签**一份下载许可（这条命令会真的去访问那些站点）。
			name: "★ 确认框不列出即将访问的站点（用户盲签下载许可）",
			from: '\t\t\t\thosts: external.sites.map((site) => site.host).join(", "),',
			to: '\t\t\t\thosts: "",',
			expect: "确认框必须列出即将访问的站点",
		},
	],
});
