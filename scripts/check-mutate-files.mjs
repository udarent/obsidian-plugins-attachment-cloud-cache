/**
 * 变异验证的**静态一致性检查**。
 *
 * ## 为什么需要它：这里出过一类"看起来像成功"的错误
 *
 * `runMutations` 结束时会 `process.exit()`。所以同一个文件里写第二个调用时，
 * **它永远不会执行** —— 而第一次调用的"全部被捕获"照样打印出来。
 * 结果是"一半的验证从没跑过"被读成"全部通过"。
 *
 * 实测踩过：把判定层与执行层写在同一个 `mutate-transfer.mjs` 里，
 * 执行层的 8 条变异一条都没跑过，而输出完全正常。
 *
 * ⚠️ 这类问题**加不了运行时守卫** —— 进程已经退出了，守卫没机会执行。
 * 只能在**静态**层面挡住，所以放在 `npm run check` 里。
 *
 * ## 三项检查，各自对应一种"人会忘"的疏漏
 *
 * 1. 每个 `mutate-*.mjs` 只能有一次 `runMutations(` 调用（本次踩到的那个坑）；
 * 2. `package.json` 的 `mutate` 脚本必须列出**所有** `mutate-*.mjs`，
 *    且列出的文件都存在 —— 否则新写的变异文件会静静地不参与验证；
 * 3. 每个 `lib/*-suite.mjs` 必须同时被至少一个 `test-*.mjs` 与一个 `mutate-*.mjs` 引用
 *    —— 只写套件不接线，是"以为测了其实没测"的另一种形态。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** 读一个文件；不存在返回 null（用于"列出的文件必须存在"那项检查）。 */
async function tryRead(path) {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** 数某个子串出现的次数。 */
function countOccurrences(text, needle) {
	return text.split(needle).length - 1;
}

/** 从 import 语句里取出所有被引用的 `lib/xxx-suite.mjs` 名字。 */
function importedSuites(text) {
	const found = new Set();
	const pattern = /from\s+["'][^"']*\/?lib\/([a-z0-9-]+-suite)\.mjs["']/g;
	let match;
	while ((match = pattern.exec(text)) !== null) found.add(match[1]);
	return found;
}

const problems = [];
const notes = [];

const entries = await readdir(HERE);
const mutateFiles = entries.filter((name) => /^mutate-.*\.mjs$/.test(name)).sort();
const testFiles = entries.filter((name) => /^test-.*\.mjs$/.test(name)).sort();
const suiteDir = join(HERE, "lib");
const suiteFiles = (await readdir(suiteDir)).filter((name) => /-suite\.mjs$/.test(name)).sort();

if (mutateFiles.length === 0) problems.push("找不到任何 scripts/mutate-*.mjs");

const mutateSources = new Map();
for (const file of mutateFiles) {
	const text = await readFile(join(HERE, file), "utf8");

	// ── 检查 1：一个文件只能调一次 runMutations ──
	const calls = countOccurrences(text, "runMutations(");
	if (calls !== 1) {
		problems.push(
			`${file}: 调用了 ${calls} 次 runMutations —— ` +
				"它结束时会 process.exit()，第二次调用**永远不会执行**，而输出看起来仍然像成功了。" +
				"请把每个源文件拆成独立的 mutate-*.mjs。"
		);
	}
	mutateSources.set(file, text);
}

// ── 检查 2：package.json 的 mutate 脚本必须与目录内容一致 ──
const packageJsonText = await readFile(join(REPO_ROOT, "package.json"), "utf8");
const packageJson = JSON.parse(packageJsonText);
const mutateScript = String(packageJson.scripts?.mutate ?? "");

for (const file of mutateFiles) {
	if (!mutateScript.includes(`scripts/${file}`)) {
		problems.push(
			`${file} 没有被 \`npm run mutate\` 引用 —— 它会静静地不参与验证（写了却没人跑）。` +
				"请把它加进 package.json 的 mutate 脚本。"
		);
	}
}
for (const listed of mutateScript.match(/scripts\/[A-Za-z0-9._-]+\.mjs/g) ?? []) {
	const bare = listed.replace("scripts/", "");
	if (!mutateFiles.includes(bare)) {
		problems.push(`package.json 的 mutate 脚本引用了不存在的 ${listed}`);
	}
}

// ── 检查 3：每个套件都必须被测试与变异**同时**使用 ──
const testTexts = await Promise.all(testFiles.map((file) => readFile(join(HERE, file), "utf8")));
for (const suite of suiteFiles) {
	const bare = suite.replace(/\.mjs$/, "");
	const usedByTest = testTexts.some((text) => importedSuites(text).has(bare));
	const usedByMutate = [...mutateSources.values()].some((text) => importedSuites(text).has(bare));
	if (!usedByTest) {
		problems.push(`lib/${suite} 没有对应的 test-*.mjs 使用它 —— 那套断言平时根本没在跑。`);
	}
	if (!usedByMutate) {
		problems.push(
			`lib/${suite} 没有对应的 mutate-*.mjs 使用它 —— 那套断言没被变异验证过，` +
				"无法知道它有没有牙齿。"
		);
	}
}

// ── 反向：变异文件引用的套件必须真的存在 ──
for (const [file, text] of mutateSources) {
	for (const bare of importedSuites(text)) {
		if (!suiteFiles.includes(`${bare}.mjs`)) {
			problems.push(`${file} 引用了不存在的 lib/${bare}.mjs`);
		}
	}
}

notes.push(`变异文件 ${mutateFiles.length} 个、测试文件 ${testFiles.length} 个、套件 ${suiteFiles.length} 个`);

if (problems.length > 0) {
	console.error("✗ 变异验证的一致性检查未通过：");
	for (const problem of problems) console.error(`   · ${problem}`);
	process.exit(1);
}

console.log(`变异验证一致性检查通过（${notes.join("；")}）。`);
