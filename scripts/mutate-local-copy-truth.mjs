import { runMutations } from "./lib/mutate.mjs";
import { runLocalCopyTruthSuite } from "./lib/local-copy-truth-suite.mjs";

/**
 * 变异验证：**"一个事实一个持有者"**（`src/cache/index.ts`，计划里的 A2）。
 *
 * 判据是跨模块一致性套件（`lib/local-copy-truth-suite.mjs`），所以要同时打包
 * `eviction` 与 `object-key`（它俩是那三处接缝的另一半）。
 *
 * ⚠️ 这条套件横跨**三个**源文件，而运行器一次只变异一个（`source` 是单数）。
 * 这里选 `cache/index.ts` 是**有取舍的**：它承载了历史上真的出过事的那两件
 *（"是不是我们上传的" N11 / "副本在哪条路径上"），所以先把它逐条打坏。
 * ⚠️ 另两个源文件（`eviction.ts` 的字节口径、`object-key.ts` 的哈希段）**尚未配锚点** ——
 * 这是已知的覆盖缺口，别把它当成"已覆盖"。
 */
await runMutations({
	source: "src/cache/index.ts",
	entries: ["src/cache/index", "src/maintenance/eviction", "src/object-key"],
	suite: runLocalCopyTruthSuite,
	mutations: [
		{
			// 后果：**"是不是我们上传的"退回看条目** —— 于是「不留副本」那一档
			// （按纪律不写条目）对所有对象都答"不是我们的"，那条自动询问**永不出现**。
			// 这正是 N11 的形状：不报错，只是某个档位下静默失效。
			name: "★★ 归属判定退回「看条目」（不留副本档的询问永不出现）",
			from: "\twasUploaded(key: string): boolean {\n\t\treturn typeof key === \"string\" && this.uploaded.has(key.trim());\n\t}",
			to: "\twasUploaded(key: string): boolean {\n\t\treturn typeof key === \"string\" && this.entries.has(key.trim());\n\t}",
			expect: "就该认它是我们的",
		},
		{
			// 后果：用条目构造出来的索引带着**空台账** ⇒ 它的行为与"从文件读回来的同一份内容"
			// 不一致（重启就变）。构造函数里那一行就是为了堵这个。
			name: "★★ 构造函数不再补台账（用条目构造的索引认不出自己传过）",
			from: "\t\t\tthis.uploaded.add(entry.key);",
			to: "\t\t\t// 变异：不补台账",
			expect: "有副本 ⇒ 台账里必然有它",
		},
		{
			// 后果：**摘条目顺手把台账也忘了** ⇒ "云端还在、只是本地副本没了"的对象
			// 从此认领不回来（下一次孤儿判定会说"不是我们的"，连问都不问）。
			name: "★★ 删本地副本顺手忘掉台账（云端还在的对象从此没人管）",
			from: "\tremove(key: string): boolean {\n\t\treturn this.erase(key);\n\t}",
			to: "\tremove(key: string): boolean {\n\t\tconst clean = typeof key === \"string\" ? key.trim() : \"\";\n\t\tthis.uploaded.delete(clean);\n\t\treturn this.erase(key);\n\t}",
			expect: "台账还在",
		},
		{
			// ⚠️ 这条锚点钉的是**"一起搬"**：同一个路径可能挂着多条记录（同一文件被两个远端地址引用过），
			// 目录改名时子文件路径也要跟着搬。只搬第一条 ⇒ 余下的记录继续指着旧路径
			//（渲染据此以为本地还有副本，而那份文件已经不在那儿了）。
			name: "★ 改名只搬第一条记录（同路径的多条 / 子文件漏搬）",
			from: "\t\t\tif (!next || next === path) continue;\n\t\t\tthis.write({ ...entry, cachePath: next });\n\t\t\tmoved += 1;",
			to: "\t\t\tif (!next || next === path) continue;\n\t\t\tif (moved > 0) continue;\n\t\t\tthis.write({ ...entry, cachePath: next });\n\t\t\tmoved += 1;",
			expect: "深层子文件也跟着搬",
		},
	],
});
