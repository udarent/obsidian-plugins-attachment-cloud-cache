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
			// 后果：跳过「临时文件 + 改名」，直接写目标文件 ⇒ 写到一半被中断（崩溃/断电/同步冲突）
			// 就留下一段截断的 JSON。最终内容看着是对的，所以只有崩溃时才显形。
			name: "★ 不再走临时文件 + 改名（崩溃会留下半截 JSON）",
			from: "\tawait adapter.write(temp, payload);",
			to: "\tawait adapter.write(path, payload);",
			expect: "临时文件",
		},
		{
			// 后果：一份合法但不是我们格式的文件（`{"decisions":"nope"}`）被当成"空记忆且无错" ⇒
			// 症状是"我答过的站点又问我了"，而用户永远查不出为什么。
			name: "★ 形状不对却当成「没有记忆」（用户答过的又重问且查不出原因）",
			from: '\tif (!Array.isArray(parsed.decisions)) {\n\t\treturn { decisions: new SiteDecisions(), existed: true, error: "结构不对：decisions 不是数组" };\n\t}\n',
			to: "\t// 变异：不检查 decisions 的形状\n",
			expect: "留下错误原因",
		},
		{
			// 后果：父目录不存在时写入失败。真实适配器的 `write` 不会替你建目录
			// （替身会，所以这条只能靠套件里那个严格的假适配器抓）。
			name: "★ 不再先建目录（真实适配器上直接写不进去）",
			from: "\t\tawait adapter.mkdir(folder);\n",
			to: "\t\tvoid folder; // 变异：不建目录\n",
			expect: "先建",
		},
	],
});
