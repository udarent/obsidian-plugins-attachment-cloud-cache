/**
 * 门禁：真机探针脚本必须**语法通过**，且一旦不通，把嫌疑行指出来。
 *
 * ## 它防什么
 *
 * 真机探针的写法是"把一段表达式拼成字符串送进页面"，那段代码写在**模板字符串**里。
 * 于是注入的代码内部只要出现一个**裸反引号**（最常见的是中文注释里给标识符加反引号，
 * 比如 `settings.s3`），外层模板就会提前闭合，后面的代码被当成 JS 解析 ——
 * 报出来的却是一句指向后面十几行的 `SyntaxError: missing ) after argument list`。
 *
 * ## ⚠️ 判据改过（2026-10-25），上一版是错的
 *
 * 上一版扫"块内**奇数个**反引号"。这条判据放过了一整类事故：
 * 写一句 `` // 位置列是 `—` / 空 `` 是**两个**反引号，外层模板在第一个处断掉，
 * 脚本根本跑不起来 —— 而门禁报了「通过」。**这种门禁比没有更糟**：它会让人
 * 以为已经防住了（当天就因此白跑了两轮真机）。
 *
 * 现在分两段：
 *
 * 1. **真判据**：对每个 `.mjs` 跑 `node --check` —— 语法能不能过，没有近似；
 * 2. **只在不通时**：把注入块里含反引号的行列出来当**嫌疑行**，供人定位
 *    （不去判"合不合法"：`${JSON.stringify(`…`)}` 这种插值里的嵌套模板是合法的，
 *     用文本规则去分辨它只会制造误报）。
 *
 * 「不值得写通用解析」与「判据可以放宽」是两件事 —— 后者是上一版的错。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = HERE;

/** 注入块的起止行（按去空白后的内容判断）。 */
const BLOCK_START = /^`\((?:async )?\(\) => \{$/;
const BLOCK_END = /^\}\)\(\)`[,;]?$/;

function listScriptFiles() {
	return readdirSync(SCRIPTS, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
		.map((entry) => relative(SCRIPTS, join(entry.parentPath ?? SCRIPTS, entry.name)).split(sep).join("/"))
		.sort();
}

/** 注入块里含反引号的行（**只是候选**，不做合法性判断 —— 见文件头）。 */
function suspectLines(file) {
	const lines = readFileSync(join(SCRIPTS, file), "utf8").split("\n");
	const suspects = [];
	let inside = false;
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!inside) {
			if (BLOCK_START.test(trimmed)) inside = true;
			return;
		}
		if (BLOCK_END.test(trimmed)) {
			inside = false;
			return;
		}
		if (line.includes("`")) suspects.push({ line: index + 1, text: trimmed.slice(0, 110) });
	});
	return suspects;
}

const files = listScriptFiles();
const broken = [];

/** 这个脚本里有注入块吗（没有就不必起 `node --check`：本门禁只管注入块）。 */
function hasInjectedBlock(file) {
	let inside = false;
	for (const line of readFileSync(join(SCRIPTS, file), "utf8").split("\n")) {
		if (BLOCK_START.test(line.trim())) return true;
	}
	return inside;
}

// ⚠️ 只查**含注入块**的脚本：`node --check` 每个文件要起一个进程（~50ms），
// 232 个全查会把门禁从 0.2 秒拖到 12.7 秒 —— 日常跑一下就变慢的门禁没人愿意留着。
const targets = files.filter(hasInjectedBlock);

for (const file of targets) {
	try {
		execFileSync(process.execPath, ["--check", join(SCRIPTS, file)], { stdio: "pipe" });
	} catch (error) {
		const output = String(error.stderr ?? error.message ?? "").trim();
		broken.push({ file, output });
	}
}

if (broken.length > 0) {
	console.error(`✗ ${broken.length} / ${targets.length} 个含注入块的脚本语法不通：`);
	for (const item of broken) {
		const first = item.output.split("\n").filter((line) => line.trim().length > 0).slice(0, 3);
		console.error(`\n    ${item.file}`);
		for (const line of first) console.error(`      ${line}`);
		const suspects = suspectLines(item.file);
		if (suspects.length > 0) {
			console.error("      注入块里含反引号的行（最可能的真凶，尤其当报错指向别处时）：");
			for (const suspect of suspects) console.error(`        ${item.file}:${suspect.line}  ${suspect.text}`);
			console.error("      改法：注入的代码里不要出现裸反引号 —— 中文强调用「」，真要模板就转义成 \\`。");
		}
	}
	console.error("");
	console.error("  ⚠️ 报错行常常比真凶**晚十几行**：先看上面列出的嫌疑行，别直接去改报错那一行。");
	process.exit(1);
}

console.log(
	`注入代码检查通过：${targets.length} 个含注入块的脚本语法全部通过（注入块里的模板没有被提前闭合）。`
);
