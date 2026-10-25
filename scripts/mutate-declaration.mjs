import { runMutations } from "./lib/mutate.mjs";
import { runDeclarationSuite } from "./lib/declaration-suite.mjs";

/**
 * 变异验证：共享桶引用声明的纯逻辑（`src/s3/declaration.ts`）。
 *
 * 这一层的错误**不会当场报错**，要等到某台设备清理孤儿时才发作 —— 而那时候的动作是
 * 删除云端对象、不可恢复。所以每条不变量都要证明"改坏了测试会红"，而不是"看起来写了测试"。
 *
 * 这里的四条各自对应一种真实失效：合并优先级反了（读到旧名字甚至旧集合）、
 * 压缩顺序反了（有一瞬间声明里少了若干 hash）、封存边界差一（多写一个空段）、
 * 指纹只取最后一条时间（集合没变也判"变了"⇒ 批量删除白停，或反之）。
 */
await runMutations({
	source: "src/s3/declaration.ts",
	suite: runDeclarationSuite,
	mutations: [
		{
			// 后果：**先读到的赢**（段在 head 之前处理）⇒ head 里的最新名字/状态被旧段盖住。
			// 压缩中断期间这是常态（同一个 hash 同时在新旧两处），读错就会显示旧名，
			// 更糟的是把"已删除的引用"读成"还在"，或者反过来。
			name: "★ 合并优先级反了（先读到的赢，head 不再最新）",
			from: "\t\tif (prev !== undefined && prev.seq > seq) return;",
			to: "\t\tif (prev !== undefined) return;",
			expect: "head 当最新",
		},
		{
			// 后果：**先删旧段、再写新段** ⇒ 中间有一瞬间声明里少了若干 hash。
			// 如果此刻另一台设备在清理，它读到的就是"没人引用" —— 删掉的是别人还在用的对象。
			name: "★★ 压缩顺序反了（先删旧段、再写新段）",
			from:
				"\t\tfor (const segment of finalSegments) {\n" +
				'\t\t\tdeletes.push({ kind: "delete", key: `${prefix}/seg-${String(segment.number).padStart(4, "0")}.json` });\n' +
				"\t\t}\n" +
				"\t\treturn [...writes, ...deletes];",
			to:
				"\t\tfor (const segment of finalSegments) {\n" +
				'\t\t\tdeletes.push({ kind: "delete", key: `${prefix}/seg-${String(segment.number).padStart(4, "0")}.json` });\n' +
				"\t\t}\n" +
				"\t\treturn [...deletes, ...writes];",
			expect: "先写新段、再删旧段",
		},
		{
			// 后果：恰好 500 条时也封存 ⇒ 多一个只装 500 条的空 head 往返，
			// 而且"段数 = ⌈refs/500⌉"这条成本口径从此不成立（压缩会被无端触发）。
			name: "★ 封存边界差一（恰好 500 条就封存）",
			from: "\twhile (Object.keys(headRefs).length > SEGMENT_LIMIT) {",
			to: "\twhile (Object.keys(headRefs).length >= SEGMENT_LIMIT) {",
			expect: "恰好 500 条 ⇒ 只写 head，不封存",
		},
		{
			// 后果：指纹只反映"最后一条"的 LastModified ⇒ 集合没变但顺序变了就判"变了"，
			// 批量删除每次都白停；反之若最后一条恰好是最大值，真变了也可能判"没变"。
			name: "★ 指纹只取最后一条时间（不是最大值）",
			from: '\t\tif (typeof object.lastModified === "string" && object.lastModified > maxModified) {',
			to: '\t\tif (typeof object.lastModified === "string") {',
			expect: "指纹与输入顺序无关",
		},
	],
});
