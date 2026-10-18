import { runMutations } from "./lib/mutate.mjs";
import { runProbeSampleSuite } from "./lib/probe-sample-suite.mjs";

/**
 * 变异验证：「测试连接」探针回路（`src/probe-sample.ts`）。
 *
 * 这一层坏掉的后果**一条都不会报错**，全都发生在我们看不见的地方：
 *
 * - 没真的写就去测 ⇒ 测的是不存在的对象，"结论"是假的，而界面照样显示正常；
 * - 放不上去还继续测 ⇒ 把"写权限被拒"这条真信息盖掉；
 * - 测量失败不清理 / 删不掉却说删了 ⇒ 用户的桶里留下一条他不认识的对象；
 * - 探针内容为空 ⇒ "读回一致"变成 0 == 0，等于什么都没验。
 *
 * ⚠️ 套件的断言顺序就是这条回路的执行顺序（放 → 测 → 删 → key/内容），
 * 所以每个变异都会撞在**自己那一段**的断言上，报出的原因与变异点对得上。
 */
await runMutations({
	source: "src/probe-sample.ts",
	entries: ["src/probe-sample", "src/s3/client"],
	suite: runProbeSampleSuite,
	mutations: [
		{
			// 后果：根本没写，就直接"测"—— 测的是一条不存在的对象，"结论"是假的，
			// 而界面上一切正常（这正是只读探针那条路的病）。
			name: "★★ 不写就去测（测的是一条不存在的对象，结论是假的）",
			from: "\ttry {\n\t\tawait deps.put(deps.key);\n\t} catch (putError) {",
			to: "\ttry {\n\t\tvoid deps.put;\n\t} catch (putError) {",
			expect: "★ 顺序必须是 放 → 测 → 删",
		},
		{
			// 后果：写被拒（只有读权限的密钥）时继续往下测 ⇒ 界面不说"上传会失败"，
			// 而是给一条基于不存在对象的匿名结论 —— 用户被引去改没坏的东西。
			name: "★ 放不上去还继续拿不存在的地址去测（结论完全是假的）",
			from:
				"\t} catch (putError) {\n" +
				"\t\t// 没放上去 ⇒ 什么都没留下，也没测（测出来的结论会是假的）\n" +
				"\t\treturn { placed: false, putError, leftBehind: false };\n" +
				"\t}",
			to: "\t} catch (putError) {\n\t\tvoid putError;\n\t}",
			expect: "★ 放不上去时要说 placed:false",
		},
		{
			// 后果：测量一失败就跳过清理（挪出 `finally`）⇒ 探针对象永久留在用户的桶里，
			// 而用户从界面上什么都看不出来。
			name: "★★ 清理挪出 finally（测量一失败就留下垃圾对象）",
			from:
				"\tconst outcome: TempProbeOutcome<T> = { placed: true, leftBehind: false };\n" +
				"\ttry {\n" +
				"\t\toutcome.value = await deps.measure();\n" +
				"\t} finally {\n" +
				"\t\ttry {\n" +
				"\t\t\tawait deps.remove(deps.key);\n" +
				"\t\t} catch (removeError) {\n" +
				"\t\t\toutcome.leftBehind = true;\n" +
				"\t\t\toutcome.removeError = removeError;\n" +
				"\t\t}\n" +
				"\t}",
			to:
				"\tconst outcome: TempProbeOutcome<T> = { placed: true, leftBehind: false };\n" +
				"\toutcome.value = await deps.measure();\n" +
				"\ttry {\n" +
				"\t\tawait deps.remove(deps.key);\n" +
				"\t} catch (removeError) {\n" +
				"\t\toutcome.leftBehind = true;\n" +
				"\t\toutcome.removeError = removeError;\n" +
				"\t}",
			expect: "★ 测量失败也必须删掉探针对象",
		},
		{
			// 后果：明明没删掉，却对界面说"已经删了" ⇒ 用户的桶里留着一条他不认识的对象，
			// 而唯一的提示被我们吞掉了。
			name: "★★ 删不掉却说自己删了（桶里留垃圾而不告知）",
			from: "\t\t\toutcome.leftBehind = true;",
			to: "\t\t\toutcome.leftBehind = false;",
			expect: "★ 删不掉要如实回报",
		},
		{
			// 后果：干净跑完也报"还留着" ⇒ 用户每次都被叫去手工删一条其实已经删掉的对象。
			// 这方向的代价是**信任**：多报几次之后他就再也不看这条提示了。
			name: "★ 干净跑完也报残留（用户被叫去删一条已经没了的东西）",
			from: "\tconst outcome: TempProbeOutcome<T> = { placed: true, leftBehind: false };",
			to: "\tconst outcome: TempProbeOutcome<T> = { placed: true, leftBehind: true };",
			expect: "干净跑完应报 placed 且不残留",
		},
		{
			// 后果：探针内容为空 ⇒ "读回一致"变成 0 == 0，写/读两段等于没验
			//（而界面上那条"读回一致（0 字节）"看着还挺正常）。
			name: "★★ 探针内容为空（0 == 0 的比对永远通过，写读两段等于没验）",
			from: 'export const TEMP_PROBE_BODY = "attachment-cloud-cache connection probe";',
			to: 'export const TEMP_PROBE_BODY = "";',
			expect: "探针对象要有非空内容",
		},
	],
});
