import { runMutations } from "./lib/mutate.mjs";
import { runSharedFlowsSuite } from "./lib/shared-flows-suite.mjs";

/**
 * 变异验证：`src/plugin/shared-flows.ts`（跨流程共用的三件事）。
 *
 * 两条最要紧的方向：
 * - `cloudReferencedKeys` 少认一篇 = **多删**（不可恢复）；
 * - `writeDeleteLog` 抛错 = 附属功能炸断主流程。
 */
await runMutations({
	source: "src/plugin/shared-flows.ts",
	entries: ["src/plugin/shared-flows"],
	suite: runSharedFlowsSuite,
	mutations: [
		{
			// 后果：画布文本节点里的引用看不见 ⇒ 只被画布引用的对象被判"没人引用"。
			name: "画布分支退回普通文本解析（画布里的 key 全丢）",
			from: '\tif (kind !== "canvas") return keysInText(text, keyOf);',
			to: "\treturn keysInText(text, keyOf);",
			expect: "画布里的转义地址必须能被解出来",
		},
		{
			// 后果：画布里的引用整路丢掉 ⇒ "仍被引用"的集合偏小 ⇒ 候选偏大（多删）。
			name: "★ 不再扫画布（仍被引用的集合偏小）",
			from: '\t\tif (file.extension !== "canvas") continue;',
			to: "\t\tif (true) continue;",
			expect: "画布里的引用也要算",
		},
		{
			// 后果：读不到的那篇被当成"没有引用" ⇒ 候选凭空变大 = 多删。
			name: "★ 读不到笔记时跳过（把『不知道』当成『没有引用』）",
			from: '\t\t\tthrow new Error(ctx.t("cloudCleanupUnreadableNote", { path: note.path }));',
			to: "\t\t\tvoid note;",
			expect: "读不到笔记时必须抛错",
		},
		{
			// 后果：插件目录未知时仍然写 ⇒ 兜底名落到 vault 根，跟着同步出去。
			name: "插件目录未知时仍然写日志",
			from: "\tif (!path) {",
			to: "\tif (false) {",
			expect: "插件目录未知时不能写",
		},
		{
			// 后果：新文件用 append ⇒ 依赖"append 会建文件"这条宿主约定，不成立时静默不写。
			name: "不再分辨文件是否存在（新文件也 append）",
			from: "\t\t\t\tif (await adapter.exists(path)) await adapter.append(path, text);\n\t\t\t\telse await adapter.write(path, text);",
			to: "\t\t\t\tawait adapter.append(path, text);",
			expect: "文件不存在时必须 write",
		},
	],
});
