import { runMutations } from "./lib/mutate.mjs";
import { runSiteStoreSuite } from "./lib/site-store-suite.mjs";

/**
 * 变异验证：站点决定记忆持久化（`src/host/site-store.ts`）。
 *
 * 三条各自对应一种"不报错但会害人"的退化：
 * 丢原子性（崩溃后读到半截）、把"格式不对"当"没有记忆"（用户答过的又重问，且查不出原因）、
 * 忘了建目录（真机上直接写不进去）。
 */
await runMutations({
	source: "src/host/site-store.ts",
	entries: ["src/host/site-store", "src/render/site-decisions"],
	suite: runSiteStoreSuite,
	mutations: [
		{
			// 后果：记忆**看着写成功了、其实一个字节都没落盘** ⇒
			// 下次启动用户的回答全没了，于是"我明明点过'不再询问'"。
			//
			// ⚠️ 这条是在把原子写**抽成共享模块**之后补的。原来这里有两条约会写细节的变异
			//（"不走临时文件"、"不先建目录"）—— 那些实现已经搬进 `src/atomic-write.ts`，
			// 由 `mutate-atomic-write.mjs` 的同名变异继续守着；本文件改成守
			// **"这个 store 到底有没有把东西交给落盘层"**。
			name: "★ 保存被静默跳过（记忆看着写成功、其实没落盘）",
			from: "\tawait writeJsonAtomically(adapter, path, JSON.stringify(decisions.toJSON()));",
			to: "\tvoid decisions; // 变异：根本不落盘",
			expect: "写入后应存在",
		},
		{
			// 后果：一份合法但不是我们格式的文件（`{"decisions":"nope"}`）被当成"空记忆且无错" ⇒
			// 症状是"我答过的站点又问我了"，而用户永远查不出为什么。
			name: "★ 形状不对却当成「没有记忆」（用户答过的又重问且查不出原因）",
			from: '\tif (!Array.isArray(parsed.decisions)) {\n\t\treturn { decisions: new SiteDecisions(), existed: true, error: "结构不对：decisions 不是数组" };\n\t}\n',
			to: "\t// 变异：不检查 decisions 的形状\n",
			expect: "留下错误原因",
		},
	],
});
