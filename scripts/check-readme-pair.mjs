/**
 * 门禁：给用户看的 README 必须有中英两份，且**不许单边漂移**。
 *
 * ## 为什么要有这条
 *
 * README 是唯一面向用户的长文，而它有两种语言的版本 —— 这类"成对的东西"有一个几乎必然的
 * 失效模式：**只改了一边**。英文改了、中文忘了（或反过来），于是两份文档对着同一件事说不同的话，
 * 而且谁都看不出来 —— 除非有人恰好两种语言都读。
 *
 * 实测（2026-10-07）：准备中文版时才发现英文版里有三处已经过时/自相矛盾 —— 一处功能描述与
 * 后面的披露段直接打架、一段 "minAppVersion" 整段重复、两个数字（设置项数、签名器行数）是旧的。
 * 翻译一份错的原文等于把错误复制一份，所以两份都要能被检查。
 *
 * ## 这条护栏**能**保证什么
 *
 * - 两份文件都存在，且**互相链接**（读者能从任一份跳到另一份）。
 * - 两者的**章节结构一致**（`##` 与 `###` 的数量相同）—— 能抓住"整节缺失"与"只在一份里加了新节"。
 *
 * ## 这条护栏**不能**保证什么（别把它当质量保证）
 *
 * - **不检查文义**：中文版写错一个数字、或整段翻错，它一点都看不出来。
 * - 不检查措辞是否对应、不检查表格行数。
 * 真正让两份一致的办法只有一个：**改一份时同时改另一份**，改完跑 `npm run check`。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 成对的文件：英文为准，中文为译。 */
const CANONICAL = "README.md";
const TRANSLATED = "README.zh.md";

const problems = [];

function read(path) {
	const full = join(REPO, path);
	if (!existsSync(full)) return null;
	return readFileSync(full, "utf8");
}

const canonical = read(CANONICAL);
const translated = read(TRANSLATED);

if (canonical === null) problems.push(`缺少 ${CANONICAL}`);
if (translated === null) problems.push(`缺少 ${TRANSLATED}（用户可见的 README 必须中英两份）`);

if (canonical !== null && !canonical.includes(TRANSLATED)) {
	problems.push(`${CANONICAL} 里没有指向 ${TRANSLATED} 的链接（读者找不到中文版）`);
}
if (translated !== null && !/\]\(\.\/README\.md\)/.test(translated)) {
	problems.push(`${TRANSLATED} 里没有指向 ./${CANONICAL} 的链接（读者找不到英文版）`);
}

/** 某个级别的标题数量。 */
function countHeadings(text, level) {
	const prefix = `${"#".repeat(level)} `;
	return text.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}#`)).length;
}

if (canonical !== null && translated !== null) {
	for (const level of [2, 3]) {
		const a = countHeadings(canonical, level);
		const b = countHeadings(translated, level);
		if (a !== b) {
			problems.push(
				`章节数不一致：${CANONICAL} 有 ${a} 个 ${"#".repeat(level)} 标题，` +
					`${TRANSLATED} 有 ${b} 个 —— 多半只改了一边`
			);
		}
	}
}

if (problems.length > 0) {
	console.error(`✗ 两份 README 不成对 ${problems.length} 处：`);
	for (const problem of problems) console.error(`    ${problem}`);
	console.error("");
	console.error("  改法：把缺的一边补齐（改一份就同时改另一份），并保持两份都互相链接。");
	console.error("  ⚠️ 这条检查只看**结构**，看不出文义 —— 别把它当翻译质量保证。");
	process.exit(1);
}

console.log(
	`README 成对检查通过：${CANONICAL} 与 ${TRANSLATED} 都存在、互相链接，` +
		`章节数一致（${countHeadings(canonical, 2)} 个二级 / ${countHeadings(canonical, 3)} 个三级）。`
);
