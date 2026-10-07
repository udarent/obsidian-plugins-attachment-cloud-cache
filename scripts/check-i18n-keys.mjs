/**
 * 门禁：文案键必须**双向接线**。
 *
 * ## 两个方向，各自对应一种静默失效
 *
 * ① **源码用了表里没有的键** → `translate` 回落到 key 本身，于是界面上直接显示
 *    `s3Endpoint` 这样的键名。不报错、不抛异常，只有用户看得见。
 * ② **表里有、但没有任何源码引用的键（死键）** → 它会一直占着一份翻译，
 *    而且在 review 时看起来"这个功能有文案"。
 *
 * ②在本项目**真实发生过**：原先 `test-i18n.mjs` 拿 `uploadFailed` 当夹具，
 * 而那个键从第一个提交起就从未在 `src/` 里接线过 —— 于是"文案键被使用"这件事
 * 被一个死键假装满足了。当时是**手工**发现的，没有判据。
 *
 * ⚠️ 所以 ② 的判据**只看 `src/`，绝不看 `scripts/`**：测试引用一个死键
 * 恰恰是当初掩盖问题的方式，把它算作"被使用"就等于把门换成纸糊的。
 *
 * ## 判据的两个集合不能混用（第一版混了，炸出 370 个噪音）
 *
 * · `calledKeys` —— 只在**调用点**取（`t("K")` / `translate("en","K")`）。
 *   用它回答 ①，判准、不误报。
 * · `seenStrings` / `prefixes` —— src 里出现过的**任何**字符串字面量与模板前缀。
 *   键名还有别的写法：`return "externalCached";`、`t(cond ? "a" : "b")`、
 *   `{ key: "testOk", tone: "ok" }`，以及 `` `testFail_${kind}` `` 这种拼出来的。
 *   用调用点正则去回答 ② 会把它们全部误报成死键。
 *
 * 宁可**漏报**也不能误报 —— 一个会随机变红的门禁比没有门禁更糟：
 * 它红过几次假的之后，真红时人只会当成噪声。
 *
 * ⚠️ 纯文件读取，不派生任何外部进程（本机 `spawnSync` 会间歇性 `EBUSY`）。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC_DIR = join(REPO_ROOT, "src");
const I18N_FILE = join(SRC_DIR, "i18n.ts");

/**
 * 允许保留的死键：`键名 → 为什么留着`。
 *
 * 默认空。若确实要留（例如为下一版预留），**在这里写明理由** ——
 * 显式写下的例外会被人看见，而悄悄留着的死键不会。
 */
const ALLOWED_UNUSED = new Map();

/** 递归收集 `src/` 下的 .ts 文件。 */
async function collectSources(dir, out = []) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await collectSources(path, out);
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

/** 抽出 i18n.ts 里某个语言表的全部键。 */
function keysOf(i18nText, locale) {
	const start = i18nText.indexOf(`\t${locale}: {`);
	if (start < 0) throw new Error(`i18n.ts 里找不到 \`${locale}: {\` 表头`);
	const end = i18nText.indexOf("\n\t},", start);
	if (end < 0) throw new Error(`i18n.ts 里 ${locale} 表没有找到结束行`);
	// ⚠️ 缩进：表头是 1 个 tab、键行是 **2 个** tab。
	// 写成 3 个 tab 会得到"表里 0 个键"，于是每个真实存在的键都被误报成缺失。
	return new Set([...i18nText.slice(start, end).matchAll(/^\t\t([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
}

const i18nText = await readFile(I18N_FILE, "utf8");
const en = keysOf(i18nText, "en");
const zh = keysOf(i18nText, "zh");

if (en.size === 0 || zh.size === 0) {
	console.error("✗ 没能从 src/i18n.ts 提取到文案键 —— 检查判据是不是失效了（不要让它静默通过）");
	process.exit(1);
}

const calledKeys = new Set();
const seenStrings = new Set();
const prefixes = new Set();

for (const file of await collectSources(SRC_DIR)) {
	if (file === I18N_FILE) continue; // 表自己不算"引用者"
	const text = await readFile(file, "utf8");
	for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) calledKeys.add(m[1]);
	for (const m of text.matchAll(/\btranslate\(\s*"[a-z]{2}"\s*,\s*"([A-Za-z0-9_]+)"/g)) calledKeys.add(m[1]);
	for (const m of text.matchAll(/["'`]([A-Za-z0-9_]{3,})["'`]/g)) seenStrings.add(m[1]);
	// 模板前缀（`` `testFail_${kind}` ``）。长度 < 3 的（`` `, T${…}` ``）会匹配掉太多键，
	// 丢掉更干净 —— 那属于"漏报"一侧。
	for (const m of text.matchAll(/`([A-Za-z0-9_]{3,})\$\{/g)) prefixes.add(m[1]);
}

const problems = [];

// ── ① 源码在调用点用到、但表里没有 ──────────────────────
const known = new Set([...en, ...zh]);
for (const key of [...calledKeys].sort()) {
	if (!known.has(key)) {
		problems.push(
			`源码调用了 \`${key}\`，但 i18n 表里没有这个键 —— 界面上会直接显示这串键名。` +
				"要么在两张表里补上它，要么改正调用处的拼写。"
		);
	}
}

// ── ② 表里有、但 src 里从未出现（死键）───────────────
const looksDynamic = (key) => [...prefixes].some((p) => key.startsWith(p));
for (const key of [...en].sort()) {
	if (ALLOWED_UNUSED.has(key)) continue;
	if (seenStrings.has(key) || looksDynamic(key)) continue;
	problems.push(
		`文案键 \`${key}\` 在 src/ 里从未被引用（死键）—— ` +
			"它占着一份翻译，还会让 review 时误以为这个功能有文案。" +
			"要么接线、要么从两张表里删掉、要么在 ALLOWED_UNUSED 里写明为什么保留。"
	);
}
for (const key of [...zh].sort()) {
	if (en.has(key)) continue;
	problems.push(`文案键 \`${key}\` 只出现在中文表里 —— 英文表也必须有它（否则取不到时会回落成键名）。`);
}

if (problems.length > 0) {
	console.error("✗ 文案键接线检查未通过：");
	for (const problem of problems) console.error(`   · ${problem}`);
	process.exit(1);
}

console.log(
	`文案键接线检查通过（en ${en.size} / zh ${zh.size} 键；src/ 里 ${calledKeys.size} 个调用点、` +
		`${prefixes.size} 个模板前缀；没有缺键、也没有死键）。`
);
