/**
 * 门禁：仓库里不许引用**只存在于仓库外的开发笔记**。
 *
 * ## 背景
 *
 * 这个仓库刻意**不携带开发笔记**（设计依据、范围决策、审计记录那一类）—— 它们放在仓库之外。
 * 于是凡是引用它们的地方都是**断链**：读者会去找一个仓库里根本不存在的文件。
 *
 * 移走笔记时做过一次大扫除（代码注释、lint 报错文案、README 共 29 处），
 * 处理方式是把那条规则**就地写清楚**（"某某承诺：缓存目录可随时整体删除"），
 * 不再指向任何外部文档。
 *
 * ## 为什么要有这条门禁，而不是靠记得
 *
 * 大扫除靠的是逐条手工改；而下一次会**很自然地**再犯 ——
 * 写注释时想引"设计依据是这么定的"，很顺手就会写回去。所以判据必须机器化。
 *
 * ## 判据
 *
 * 扫**仓库目录下的所有文件**，逐行匹配下面这几个词之一即失败：
 * - 开发笔记的**文件名**（带路径或不带路径都算）
 * - 它们的**裸名**（历史上就是把文档名当权威来引，写成"某某的红线""某某里写明"那样）
 *
 * 与"只扫 git 跟踪的文件"的差别：这里是**扫目录**（未跟踪的草稿也会被扫到）。
 * 这是有意的 —— 门禁在提交前就该红，而不是等 `git add` 之后才红。
 * 跳过的是构建产物与依赖：`SKIP_DIRS` / `SKIP_FILES`（对着 `.gitignore` 维护）。
 *
 * ## ⚠️ 为什么不用 `git ls-files`（踩过）
 *
 * 最初这版用 `execFileSync("git", ["ls-files"])`，理由是"git 跟踪的就是会发布出去的那一份"。
 * 但它在 Windows 上**间歇性**抛 `spawnSync git EBUSY`（不是稳定的失败，是时好时坏），
 * 于是门禁会**随机变红** —— 而这比没有门禁更糟：一旦它红过一次假警报，
 * 后面真红的时候人会当成噪声。
 *
 * 本项目其它检查脚本（`check-mutate-files` / `check-injected-snippets` / `check-api-floor`）
 * 都**不派生外部进程**，正是同一个道理。所以这版改成走目录，并显式列跳过项。
 *
 * ⚠️ **豁免本文件自己**：检查器必须写下这些字面量才能检查它们。
 * 除此之外没有任何豁免 —— 若要临时豁免，说明理由并加在下面，而不是放宽正则。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 这些名字属于**仓库外**的开发笔记，出现即失败。 */
const FORBIDDEN = [
	{ pattern: /docs\/SCOPE\.md/, what: "引用了仓库外的开发笔记" },
	{ pattern: /docs\/INDEPENDENCE\.md/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bSCOPE\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bINDEPENDENCE\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bSCOPE\b/, what: "把开发笔记当权威来引" },
	{ pattern: /\bINDEPENDENCE\b/, what: "把开发笔记当权威来引" },
];

/** 本文件必须写下这些字面量，无法自证清白。 */
const SELF = "check-no-dev-doc-refs.mjs";

/** 不扫的目录（对着 `.gitignore` 维护：构建产物、依赖、验证脚本产物、编辑器目录）。 */
const SKIP_DIRS = new Set([".git", "node_modules", "_verify", ".vscode", ".idea"]);

/** 不扫的文件（同上；`main.js` 是构建产物，注释已被剥离）。 */
function shouldSkipFile(name) {
	if (name === "main.js" || name === "eslintcache" || name === ".DS_Store" || name === "Thumbs.db") {
		return true;
	}
	return name.endsWith(".map") || name.endsWith(".swp");
}

function listRepoFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		// ⚠️ 只递归真目录：符号链接不跟随，免得绕回自己
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...listRepoFiles(full));
		} else if (entry.isFile()) {
			if (shouldSkipFile(entry.name)) continue;
			out.push(relative(REPO, full).split(sep).join("/"));
		}
	}
	return out;
}

const problems = [];
const files = listRepoFiles(REPO);

for (const file of files) {
	if (file.endsWith(SELF)) continue;

	let content;
	try {
		content = readFileSync(join(REPO, file), "utf8");
	} catch {
		// 读不到（少见：权限、特殊文件）。跳过而不是崩掉 ——
		// 这条门禁只该管"引用"，读不到不是它的问题。
		continue;
	}

	content.split("\n").forEach((line, index) => {
		for (const { pattern, what } of FORBIDDEN) {
			if (pattern.test(line)) {
				problems.push({ file, line: index + 1, what, text: line.trim().slice(0, 100) });
				break; // 一行只报一次
			}
		}
	});
}

if (problems.length > 0) {
	console.error(`✗ 仓库里出现对仓库外开发笔记的引用 ${problems.length} 处：`);
	for (const problem of problems) {
		console.error(`    ${problem.file}:${problem.line}  ${problem.what}`);
		console.error(`      ${problem.text}`);
	}
	console.error("");
	console.error("  改法：把那条规定**就地写清楚**（谁承诺的、什么行为），不要指向仓库外的文档。");
	process.exit(1);
}

console.log(`引用检查通过：${files.length} 个文件里没有任何对仓库外开发笔记的引用。`);
