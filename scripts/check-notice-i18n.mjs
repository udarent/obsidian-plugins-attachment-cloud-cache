/**
 * 门禁：**用户可见的提示不许硬编码中文**。
 *
 * ## 它挡的是什么
 *
 * 这个插件的界面有中英两套文案，全部落在 `src/i18n.ts`。但"用户能看到一句话"
 * 有两条出口不走 `t()`：
 *
 *   · `new Notice("…")` —— 宿主右上角那一条；
 *   · `notify(…)` / `deps.notify?.(…)` —— 维护层与核心层往上传话的那个口。
 *
 * 任何一条出口上写死一句中文，英文用户就会在那**唯一一次**提示里看到中文字符。
 * ⚠️ 而现有的 `check-i18n-keys.mjs` **看不见这一类**：它检查的是"文案键有没有接线"，
 * 硬编码字面量既不缺键、也不构成死键 —— 于是它一路静默通过。
 * 2026-10-11 就实测到 `core/ingest.ts` 里有 **4 条**这样的提示（上传成功但后续
 * 某步没走完时弹的那几句），并且其中一条还被套件用"包含『索引』两个字"断言的 ——
 * 断言本身也写成了中文，等于把缺陷钉在了测试里。
 *
 * ## 判据
 *
 * 对 `src/` 下每个 `.ts` 文件，做一次**词法扫描**（跳过注释与字符串），只在**代码**里
 * 找这两个出口，然后把**调用参数**里出现的**字符串字面量**（含模板串）取出来 ——
 * 只要其中含 CJK 字符就报。
 *
 * ⚠️ 三条刻意的取舍：
 * ① **不看注释**：注释里写多少中文都无所谓（本项目注释本来就是中文）。
 *    这也是必须真做词法扫描、不能用正则扫全文的原因 ——
 *    `new Notice(\n  // 这里写中文\n  this.t("k")\n)` 是**合法且正确**的。
 * ② **只看 `src/`，不看 `scripts/`**：套件里出现中文字面量是正常的（断言消息、
 *    夹具文件名）。与 `check-i18n-keys.mjs` 同一条纪律。
 * ③ **参数里的字面量也算**：`new Notice(this.t("k", { name: "中文" }))` 同样报 ——
 *    那句话里唯一不可翻译的部分就是那个字面量。文案要显示中文，就该进 `i18n.ts`。
 *
 * ## 自证（正反两向都钉住）
 *
 * 脚本自带一组夹具：**该抓的必须抓到**（含"注释里有中文但文案是英文"这种必须
 * 不误报的），另有"英文文案不许报"的反向夹具。夹具跑不通就直接失败 ——
 * 一个自己都不准的门禁比没有门禁更糟（它会让人把真红当噪声）。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC_DIR = join(REPO_ROOT, "src");

/** CJK：汉字 + 兼容汉字 + 中文标点 + 全角形式。 */
const CJK = /[\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * 找出**用户可见的提示出口**：`new Notice(` 与 `notify(`（含 `notify?.(`）。
 *
 * ⚠️ `notify: (message) => …`（对象属性**定义**）不能算 —— 它后面是 `:` 不是 `(`。
 * 这也正是这个正则不写成裸 `notify` 的原因。
 */
const CALL_RE = /(?:\bnew\s+Notice|\bnotify\s*\??\.?)\s*\(/g;

/**
 * 词法扫描：标记出哪些字符属于**代码**，并收集所有**字符串字面量**。
 *
 * 要处理的只有四种形态：行注释、块注释、普通字符串（`'` / `"`）、模板串（`` ` ``）。
 * 模板串里的 `${…}` 一律按"串的一部分"处理 —— 代价是那种位置上的 `Notice` 调用
 * 扫不到（漏报一侧，可以接受），换来的是不必实现完整表达式解析。
 */
function scan(text) {
	const isCode = new Array(text.length).fill(true);
	const strings = [];
	let i = 0;

	// `/` 是除号还是正则开头：看前一个非空白字符。这份文件里没有正则，
	// 但 src/ 里可能有（`/["']/` 这种会让朴素的扫描器把后面一大截当成字符串）。
	const regexAllowedAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];

		if (ch === "/" && next === "/") {
			const start = i;
			while (i < text.length && text[i] !== "\n") i += 1;
			for (let k = start; k < i; k += 1) isCode[k] = false;
			continue;
		}
		if (ch === "/" && next === "*") {
			const start = i;
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i = Math.min(text.length, i + 2);
			for (let k = start; k < i; k += 1) isCode[k] = false;
			continue;
		}
		if (ch === "/") {
			// 正则字面量：跳过整个 /…/flags
			let j = i - 1;
			while (j >= 0 && /\s/.test(text[j])) j -= 1;
			const prev = j < 0 ? "" : text[j];
			if (prev === "" || regexAllowedAfter.has(prev)) {
				const start = i;
				i += 1;
				let inClass = false;
				while (i < text.length) {
					const c = text[i];
					if (c === "\\") {
						i += 2;
						continue;
					}
					if (c === "[") inClass = true;
					else if (c === "]") inClass = false;
					else if (c === "/" && !inClass) {
						i += 1;
						break;
					} else if (c === "\n") break;
					i += 1;
				}
				while (i < text.length && /[a-z]/.test(text[i])) i += 1;
				for (let k = start; k < i; k += 1) isCode[k] = false;
				continue;
			}
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			const quote = ch;
			const start = i;
			let body = "";
			i += 1;
			while (i < text.length) {
				const c = text[i];
				if (c === "\\") {
					i += 2;
					continue;
				}
				if (c === quote) {
					i += 1;
					break;
				}
				if (c === "\n" && quote !== "`") break; // 未闭合的普通字符串：当它到此为止
				body += c;
				i += 1;
			}
			for (let k = start; k < i; k += 1) isCode[k] = false;
			strings.push({ start, end: i, body });
			continue;
		}
		i += 1;
	}

	return { isCode, strings };
}

/** 从 `(` 开始做括号配平，返回**参数区**的 `[start, end)`（只看代码字符）。 */
function argRange(text, isCode, openParen) {
	let depth = 0;
	for (let i = openParen; i < text.length; i += 1) {
		if (!isCode[i]) continue;
		const c = text[i];
		if (c === "(") depth += 1;
		else if (c === ")") {
			depth -= 1;
			if (depth === 0) return [openParen + 1, i];
		}
	}
	return null;
}

/** 行号（1 起）。 */
function lineOf(text, index) {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
	return line;
}

/** 核心判据：返回这份源码里"硬编码中文的用户提示"。 */
export function findHardcodedNotices(text) {
	const { isCode, strings } = scan(text);
	const hits = [];

	CALL_RE.lastIndex = 0;
	let match;
	while ((match = CALL_RE.exec(text)) !== null) {
		if (!isCode[match.index]) continue;
		const openParen = match.index + match[0].length - 1;
		const range = argRange(text, isCode, openParen);
		if (!range) continue;
		const [start, end] = range;
		const offenders = strings.filter((s) => s.start < end && s.end > start && CJK.test(s.body));
		if (offenders.length === 0) continue;
		hits.push({
			line: lineOf(text, match.index),
			call: text.slice(match.index, openParen + 1).replace(/\s+/g, " ").trim(),
			samples: offenders.map((s) => s.body.slice(0, 40)),
		});
	}
	return hits;
}

// ─────────────────────────── 自证 ───────────────────────────

const FIXTURES = [
	{
		name: "中文直接写在 Notice 参数里 → 必须抓到",
		code: 'new Notice("缓存索引保存失败");',
		expect: 1,
	},
	{
		name: "中文写在 notify 参数里（模板串）→ 必须抓到",
		code: "deps.notify?.(`搬移失败：${error}`);",
		expect: 1,
	},
	{
		name: "通知本身走 t()，只有参数里带中文字面量 → 也算（那句话里唯一不可翻译的就是它）",
		code: 'new Notice(this.t("key", { name: "报告" }));',
		expect: 1,
	},
	{
		name: "⭐ 注释里有中文、文案是英文 → 不许误报（这一条必须靠词法扫描才过得了）",
		code: 'new Notice(\n\t// 这里写中文注释完全正常\n\tthis.t("ingestCopyMoveFailed", { error: describeError(error) })\n);',
		expect: 0,
	},
	{
		name: "英文文案 → 不许报",
		code: 'new Notice("The copy could not be moved: " + reason);',
		expect: 0,
	},
	{
		name: "⭐ 属性定义 `notify: (message) => …` 不是调用 → 不许报",
		code: "const deps = { notify: (message) => new Notice(message) };",
		expect: 0,
	},
	{
		name: "同名助手 `notifyUser(...)` 不是那个出口 → 不许报（它的参数是键名）",
		code: 'function f() { notifyUser(deps, "ingestCopyMoveFailed", { error }); }',
		expect: 0,
	},
	{
		name: "中文只出现在别处（不在出口的参数里）→ 不算",
		code: 'const comment = "中文"; // 与出口无关\nnew Notice(this.t("k"));',
		expect: 0,
	},
];

const fixtureProblems = [];
for (const fixture of FIXTURES) {
	const got = findHardcodedNotices(fixture.code).length;
	if (got !== fixture.expect) {
		fixtureProblems.push(`夹具「${fixture.name}」期望 ${fixture.expect} 处，实际 ${got} 处`);
	}
}
if (fixtureProblems.length > 0) {
	console.error("✗ 门禁自证失败 —— 判据本身不准，先修它（不要放着它去判断源码）：");
	for (const problem of fixtureProblems) console.error(`   · ${problem}`);
	process.exit(1);
}

// ─────────────────────────── 扫源码 ───────────────────────────

async function collectSources(dir, out = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await collectSources(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

const problems = [];
for (const file of await collectSources(SRC_DIR)) {
	const text = await readFile(file, "utf8");
	for (const hit of findHardcodedNotices(text)) {
		problems.push(
			`${relative(REPO_ROOT, file).split("\\").join("/")}:${hit.line} —— \`${hit.call}\` 的参数里有硬编码中文` +
				`（${hit.samples.map((s) => `「${s}」`).join("、")}）。` +
				"把它变成 `t(\"某个键\")` 并在 `src/i18n.ts` 的两张表里补上文案。"
		);
	}
}

if (problems.length > 0) {
	console.error("✗ 用户可见的提示里出现了硬编码中文（英文用户会看到中文）：");
	for (const problem of problems) console.error(`   · ${problem}`);
	process.exit(1);
}

console.log("用户可见提示的文案检查通过（src/ 里所有 Notice / notify 出口都没有硬编码中文；判据自证 8 条夹具全过）。");
