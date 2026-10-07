/**
 * 门禁：注入进页面的代码里**不许出现反引号**。
 *
 * ## 为什么需要一条专门的检查
 *
 * 真机探针的做法是"把一段表达式拼成字符串送进页面"，所以那段代码写在**模板字符串**里。
 * 于是注入的代码内部只要出现一个反引号（最常见的是中文注释里给标识符加反引号，
 * 比如 `settings.s3`），模板就会**提前闭合**，后面的代码被当成 JS 解析 ——
 * 报出来的却是一句指向后面十几行的：
 *
 * ```
 * SyntaxError: missing ) after argument list
 *     at ...:304        ← 真正的原因在 321 行
 * ```
 *
 * **这条检查是踩了两次之后加的**（第二次是在我写下"注释里不许用反引号"那条注释的那一行里
 * 又用了反引号）。当时的对策是"记住"，而"记住"显然不是对策。
 *
 * ## 判据
 *
 * 只扫**注入块**：以 `` `(() => { `` / `` `(async () => { `` 开头的行进入块，
 * 以 `` })()` `` 结尾的行离开块。块内任何一行若含**奇数个**反引号，就是可疑行 ——
 * 合法的情况要么没有反引号，要么成对出现（嵌套模板）。
 *
 * ⚠️ 刻意不做通用 JS 解析：本项目所有注入块都是这个形状，而通用解析要处理嵌套模板、
 * 转义、注释里的大括号…… 收益为零、误报却会拖垮门禁的可信度。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = HERE;

/** 注入块的起止行（按去空白后的内容判断）。 */
const BLOCK_START = /^`\((?:async )?\(\) => \{$/;
const BLOCK_END = /^\}\)\(\)`$/;

function listScriptFiles() {
	return readdirSync(SCRIPTS, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
		.map((entry) => relative(SCRIPTS, join(entry.parentPath ?? SCRIPTS, entry.name)).split(sep).join("/"))
		.sort();
}

const problems = [];

for (const file of listScriptFiles()) {
	const lines = readFileSync(join(SCRIPTS, file), "utf8").split("\n");
	let inside = false;
	let blockStartLine = 0;

	lines.forEach((line, index) => {
		const trimmed = line.trim();

		if (!inside) {
			if (BLOCK_START.test(trimmed)) {
				inside = true;
				blockStartLine = index + 1;
			}
			return;
		}

		if (BLOCK_END.test(trimmed)) {
			inside = false;
			return;
		}

		const ticks = (line.match(/`/g) ?? []).length;
		if (ticks % 2 === 1) {
			problems.push({
				file,
				line: index + 1,
				blockStartLine,
				text: trimmed.slice(0, 100),
			});
		}
	});
}

if (problems.length > 0) {
	console.error(`✗ 注入块里出现反引号 ${problems.length} 处 —— 它会把模板字符串提前闭合：`);
	for (const problem of problems) {
		console.error(`    ${problem.file}:${problem.line}（注入块从第 ${problem.blockStartLine} 行开始）`);
		console.error(`      ${problem.text}`);
	}
	console.error("");
	console.error("  改法：注入的代码里不要用反引号。中文注释要强调就用「」。");
	console.error("  ⚠️ 症状会指向**后面十几行**（missing ) after argument list），别去查那里。");
	process.exit(1);
}

console.log("注入代码检查通过：所有探针块里的反引号都是成对的（没有提前闭合模板的风险）。");
