import { runMutations } from "./lib/mutate.mjs";
import { runProbeSampleSuite } from "./lib/probe-sample-suite.mjs";

/**
 * 变异验证：测试连接第二步的样本选择（`src/probe-sample.ts`）。
 *
 * 这一层坏掉的后果都**不报错**、而且大多发生在用户看不见的地方：
 *
 * - 索引命中还去列举桶 ⇒ 自动探测（保存设置时每敲一个字符一次）平白多一次请求；
 * - 列举失败就抛 ⇒ 没有 `ListBucket` 权限的人**永远测不了**第二步；
 * - 默认允许临时探针 ⇒ 自动探测开始往用户的桶里写字；
 * - 测失败不删 / 删不掉却说删了 ⇒ 用户的桶里留下一条他不认识的对象。
 *
 * ⚠️ 套件按"索引 → 桶 → 善后"的顺序排断言，所以除了最后几条，绝大多数变异都会
 * 撞在**自己那一段**的第一条断言上，报出的原因与变异点对得上。
 */
await runMutations({
	source: "src/probe-sample.ts",
	entries: ["src/probe-sample", "src/s3/client"],
	suite: runProbeSampleSuite,
	mutations: [
		{
			// 后果：索引里明明有现成的真实对象，却还去列举桶 —— 而这条路径在
			// 「保存设置」时是**每敲一个字符**一次。白花的是一次真实网络请求。
			name: "★ 索引命中后仍然去列举桶（自动探测平白多一次请求）",
			from: "\tfor (const key of options.indexedKeys ?? []) {",
			to: "\tfor (const key of ([] as readonly string[])) {",
			expect: "★ 索引里有对象就直接用它",
		},
		{
			// 后果：索引里的空串被当成候选 ⇒ `probeUrlFor` 返回 null ⇒ 整个探测白跑，
			// 界面显示"没有可用来检查的对象"，而桶里可能明明有对象。
			name: "索引里的空 key 也被当成候选（探测直接白跑）",
			from: '\t\tif (clean !== "") return { key: clean, source: "index" };',
			to: "\t\tif (true) return { key: clean, source: \"index\" };",
			expect: "索引里的空 key 不能拿去拼地址",
		},
		{
			// 后果：没有 ListBucket 权限（与上传权限无关，很多桶就是这么配的）时
			// 列举会抛 ⇒ 第二步永远测不了，而用户看到的是一句听不懂的错误。
			name: "★ 列举失败直接把异常抛出去（没有列举权限就永远测不了）",
			from: "\t\t} catch {\n\t\t\t// 没有列举权限、网络抖了一下 —— 都一样：往下走\n\t\t}",
			to: "\t\t} catch (error) {\n\t\t\tthrow error;\n\t\t}",
			expect: "★ 列举失败（没有列举权限）不应打断测试",
		},
		{
			// 后果：自动探测也会走临时探针 ⇒ **用户没点任何按钮**，他的桶里就多了一个对象。
			name: "★★ 默认就允许临时探针（用户没点按钮也往桶里写字）",
			from: "\tif (options.allowTempObject) return { key: TEMP_PROBE_KEY, source: \"temp\" };",
			to: "\tif (options.allowTempObject !== false) return { key: TEMP_PROBE_KEY, source: \"temp\" };",
			expect: "★ 没有 allowTempObject 时**不许**临时放探针",
		},
		{
			// 后果：桶里找回来的样本被记成"索引里的" ⇒ 设置页说不出"这条是怎么来的"，
			// 而"临时探针"那条说明也会跟着错。
			name: "桶里找到的样本被标成「索引里的」（来源说明全错）",
			from: '\t\t\tif (clean !== "") return { key: clean, source: "bucket" };',
			to: '\t\t\tif (clean !== "") return { key: clean, source: "index" };',
			expect: "索引空时应改用桶里第一个对象",
		},
		{
			// 后果：测量抛错时清理不再执行（挪出 `finally`）⇒ 探针对象永久留在用户的桶里，
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
			// 后果：放不上去还继续"测"一条不存在的地址 ⇒ 结论要么是 404 要么是网络错，
			// 而真正该说的是"连接正常、但存储不允许写入"（上传同样会失败）。
			name: "★ 放不上去还继续拿不存在的地址去测（结论完全是假的）",
			from:
				"\t} catch (putError) {\n" +
				"\t\t// 没放上去 ⇒ 什么都没留下\n" +
				"\t\treturn { placed: false, putError, leftBehind: false };\n" +
				"\t}",
			to: "\t} catch (putError) {\n\t\tvoid putError;\n\t}",
			expect: "★ 放不上去时要说 placed:false",
		},
	],
});
