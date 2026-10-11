import { runMutations } from "./lib/mutate.mjs";
import { runDownloadTargetSuite } from "./lib/download-target-suite.mjs";

/**
 * 变异验证：回退下载落点。
 *
 * 这一层的产物会直接写进用户的 vault，其中"覆盖已有文件"是不可逆的 ——
 * 所以逐条确认每道防线都真的在起作用，而且**报错线索要对得上**：
 * 只要"有报错"不够，一条规则坏了可能被另一条规则的报错掩护着。
 */
await runMutations({
	source: "src/download-target.ts",
	entries: ["src/download-target", "src/object-key"],
	suite: runDownloadTargetSuite,
	mutations: [
		{
			name: "不再优先用索引里的原始文件名（退化到 key 反推）",
			from: 'if (hasSubstance(sourceName)) return sanitizeFilename(typeof sourceName === "string" ? sourceName.trim() : "");',
			to: "// 变异：跳过条目原名",
			expect: "原始 扫描.png",
		},
		{
			name: "不再从 C2 key 反推名字（直接落到哈希名）",
			from: "\tconst parsed = displayNameForKey(key);\n\tif (hasSubstance(parsed)) return sanitizeFilename(parsed);",
			to: "\tconst parsed = displayNameForKey(key);\n\tif (false) return sanitizeFilename(parsed);",
			expect: "报告 扫描.pdf",
		},
		{
			name: "老 key 不再兜底（返回空名字 ⇒ 落点变成目录本身）",
			from: '\treturn sanitizeFilename(typeof key === "string" ? key : "");',
			to: '\treturn "";',
			expect: "如实用它，不编造",
		},
		{
			name: "内容相同也不复用（每次都新建一份，序号无限堆）",
			from: '\t\t\tif (existing === keyHash) return { kind: "reuse", path: candidate };',
			to: "\t\t\tif (false) return { kind: \"reuse\", path: candidate };",
			expect: "内容相同的那一份应被复用",
		},
		{
			// ⚠️ 与上一条守的是同一件事的两侧（"取到哈希"与"哈希相等"），
			// 所以红的都是**第一条**碰到它的断言（② 同内容复用）。
			// 这与"每节一条规则"的纪律一致：一条断言失败后，后面的不再有机会执行。
			name: "不再比对内容（占用就直接加序号）",
			from: "\t\tif (keyHash) {",
			to: "\t\tif (false) {",
			expect: "内容相同的那一份应被复用",
		},
		{
			name: "探针抛错时当作「未占用」（会写到已存在的路径上）",
			from: "async function looksOccupied(probe: (path: string) => Promise<boolean>, path: string): Promise<boolean> {\n\ttry {\n\t\treturn await probe(path);\n\t} catch {",
			to: "async function looksOccupied(probe: (path: string) => Promise<boolean>, path: string): Promise<boolean> {\n\ttry {\n\t\treturn await probe(path);\n\t} catch {\n\t\treturn false;",
			expect: "探针出错一律当作",
		},
		{
			name: "点开头的文件被当成扩展名（序号写到名字前面）",
			from: "\treturn dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: \"\" };",
			to: "\treturn dot >= 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: \"\" };",
			expect: ".gitignore 1",
		},
		{
			name: "落点目录不再归一（反斜杠与空段原样进路径）",
			from: '\t\t\t? folder\n\t\t\t\t\t.replace(/\\\\/g, "/")\n\t\t\t\t\t.split("/")\n\t\t\t\t\t.filter((segment) => segment !== "" && segment !== ".")\n\t\t\t\t\t.join("/")\n\t\t\t: "";',
			to: '\t\t\t? folder\n\t\t\t: "";',
			expect: "notes/子目录/a.png",
		},
		{
			// ⚠️ 这里刻意**不**把上限改成 `Number.MAX_SAFE_INTEGER`：那种变异不会与断言冲突，
			// 而是让套件里的"号码一直撞"用例**永远跑不完**（`exists` 恒真 ⇒ 死循环），
			// 于是验证进程挂死、被杀，源码还停在变异后的状态（实测踩过）。
			// 变异要选"会红"的改动，而不是"会挂"的改动。
			name: "序号循环不再执行（连空位判定都被跳过）",
			from: "\tfor (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {",
			to: "\tfor (let attempt = 0; attempt < 0; attempt += 1) {",
			expect: "空位时应落在原名上",
		},
	],
});
