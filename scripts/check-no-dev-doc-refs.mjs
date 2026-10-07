/**
 * 门禁：仓库里不许引用**已移出的开发文档**。
 *
 * ## 背景
 *
 * `docs/SCOPE.md`（立项依据、功能范围、实施路线）与 `docs/INDEPENDENCE.md`（"没抄代码"的取证记录）
 * 曾经在仓库里，2026-10-07 移了出去 —— 前者的市场调研**点名竞品**并做量化比较，
 * 后者是一份**自证**，两者都不适合出现在要提交到官方社区目录的公开仓库里。
 *
 * 移走之后剩下一件事：**代码与文档里到处都在引用它们**（29 处，包括 `src/` 注释、
 * eslint 的报错文案、测试脚本的说明）。指针留着，读者就会去找一个仓库里不存在的文件。
 * 当时的处理是把这些规则**就地写清楚**（"SCOPE 承诺缓存可随时删除" → "这是承诺过的：
 * 缓存目录可随时整体删除"），不再依赖任何外部文档。
 *
 * ## 为什么要有这条门禁，而不是靠记得
 *
 * 这次是**一次性的大扫除**，靠的是我逐条手工改；而下一次会**很自然地**再犯 ——
 * 写注释时想引"设计依据是这么定的"，很顺手就会写回去。所以判据必须机器化。
 *
 * ## 判据
 *
 * 扫**所有被 git 跟踪的文件**（= 真正会被发布出去的那一份，未跟踪的草稿不算），
 * 逐行匹配下面这几个词之一即失败：
 * - `docs/SCOPE.md` / `docs/INDEPENDENCE.md`（带路径）
 * - 裸的 `SCOPE` / `INDEPENDENCE`（这正是当初的写法：把文档名当权威来引）
 *
 * ⚠️ **豁免本文件自己**：检查器必须写下这些字面量才能检查它们。
 * 除此之外没有任何豁免 —— 若要临时豁免，说明理由并加在下面，而不是放宽正则。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 这些名字属于**已移出仓库**的文档，出现即失败。 */
const FORBIDDEN = [
	{ pattern: /docs\/SCOPE\.md/, what: "指向已移出的 docs/SCOPE.md" },
	{ pattern: /docs\/INDEPENDENCE\.md/, what: "指向已移出的 docs/INDEPENDENCE.md" },
	{ pattern: /\bSCOPE\.md\b/, what: "提到已移出的 SCOPE.md" },
	{ pattern: /\bINDEPENDENCE\.md\b/, what: "提到已移出的 INDEPENDENCE.md" },
	{ pattern: /\bSCOPE\b/, what: "把 SCOPE 当权威文档引用（它已不在仓库里）" },
	{ pattern: /\bINDEPENDENCE\b/, what: "把 INDEPENDENCE 当权威文档引用（它已不在仓库里）" },
];

/** 本文件必须写下这些字面量，无法自证清白。 */
const SELF = "check-no-dev-doc-refs.mjs";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
	.split("\0")
	.filter((path) => path !== "");

const problems = [];
for (const file of tracked) {
	if (file.endsWith(SELF)) continue;

	let content;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		// 跟踪着但读不到（少见：符号链接、权限）。跳过而不是崩掉 ——
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
	console.error(`✗ 仓库里出现对已移出文档的引用 ${problems.length} 处：`);
	for (const problem of problems) {
		console.error(`    ${problem.file}:${problem.line}  ${problem.what}`);
		console.error(`      ${problem.text}`);
	}
	console.error("");
	console.error("  改法：把那条规定**就地写清楚**（谁承诺的、什么行为），不要指向仓库外的文档。");
	console.error("  若确实需要引用：说明它属于开发笔记、不在本仓库内 —— 但更好的做法是不引用。");
	process.exit(1);
}

console.log(`引用检查通过：${tracked.length} 个被跟踪文件里没有任何对已移出开发文档的引用。`);
