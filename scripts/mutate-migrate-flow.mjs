import { runMutations } from "./lib/mutate.mjs";
import { runMigrateFlowSuite } from "./lib/migrate-flow-suite.mjs";

/**
 * 变异验证：统一对象名的编排（`src/plugin/migrate-flow.ts`，CR-15）。
 *
 * 纯逻辑那套守"算得对不对"，这里守**顺序与闸门**：
 * 少搬一次账（全库重下）、放行一次删除（不可逆）、状态位不落（改名闸门失效）、
 * 把"这一轮该复制却失败"当成"对象在就行"（删掉旧对象、链接却是坏的）。
 */
await runMutations({
	source: "src/plugin/migrate-flow.ts",
	suite: runMigrateFlowSuite,
	mutations: [
		{
			// 后果：台账与索引还按旧 key 记 ⇒ 升级完渲染按新 URL 反查不到 ⇒ **全库重新下载**，
			// 而下载落点是附件目录 ⇒ 用户库里多出一整批重复文件。
			name: "★★ 不搬账（升级完全库重新下载）",
			from: "\t\t\t\tstore.rekey(candidate.oldKey, candidate.newKey, urlFor(candidate.newKey) ?? \"\");",
			to: "\t\t\t\tvoid candidate;",
			expect: "E 阶段搬账",
		},
		{
			// 后果：复核没通过也进 D 阶段 ⇒ 删掉一个还有链接指向的旧对象。这是唯一不可逆的后果。
			name: "★★ 闸门失效（复核没过也删旧对象）",
			from: "\t\tif (gate.ok) {",
			to: "\t\tif (true) {",
			expect: "一个都没删",
		},
		{
			// 后果：`drop` 那批（从来没复制过）的条目被改指到一个不存在的 key ⇒
			// 渲染永远下载失败、每次打开都重试一遍。
			name: "★★ 给 drop 批次也搬账（指向不存在的对象）",
			from: "\t\t\tconst rekeyable = removable.filter((candidate) => candidate.bucket !== \"drop\");",
			to: "\t\t\tconst rekeyable = removable.filter(() => true);",
			expect: "E 阶段搬账",
		},
		{
			// 后果：状态位停在 `running` ⇒ 重启后**改名永远被拒**（用户看到"没有改名：正在统一对象名"，
			// 而实际上什么都没在跑）。
			name: "★★ 收尾不写 idle（改名被永久拦住）",
			from: "\tawait deps.setState(\"idle\").catch(() => undefined);",
			to: "\tawait deps.setState(\"running\").catch(() => undefined);",
			expect: "状态位按 running → idle 走",
		},
		{
			// 后果：这一轮"该复制却失败"的那条被当成"对象在就算到位" ⇒ 闸门放行 ⇒
			// 删掉旧对象，而新对象根本不存在/是半截的。
			name: "★★ 复制失败被当成「对象在就行」",
			from: "\t\t\tconst sizeOk = want === undefined ? candidate.bucket !== \"copy\" : head?.size === want;",
			to: "\t\t\tconst sizeOk = true;",
			expect: "复制成功但字节数不对",
		},
		{
			// 后果：有笔记读不到也继续 ⇒ 那一侧决定"哪些没人引用" ⇒ 会删掉还在被引用的对象。
			name: "★★ 读不到笔记也照样开始",
			from:
				"\t\tnew Notice(ctx.t(\"unifyNamesUnreadable\", { error: describeError(error) }));\n\t\treturn idle(ZERO_COUNTS);",
			to: "\t\tnew Notice(ctx.t(\"unifyNamesUnreadable\", { error: describeError(error) }));\n\t\treferenced = new Set();",
			// 先倒的是"通知只有一条"（那条断言就是 `读不到就不开始`）——
			// 它比"没发请求"更早说话，也更贴近用户看到的现象。
			expect: "读不到就不开始",
		},
	],
});
