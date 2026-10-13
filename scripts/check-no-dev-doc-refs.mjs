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
 * ## ⚠️⚠️ 它为什么需要自证（2026-10-13 审计）
 *
 * 上面那份词表是**显式清单**，而它烂过一次：清单里只剩 `SCOPE.md` / `INDEPENDENCE.md`
 * 两个**已归档的旧名**，于是这条门禁**一条都检查不到** —— 纯空转、而且**从不报错**。
 * 同一时刻，仓库里躺着 **14 处** 对现行文档的引用（`src/`、`scripts/` 的注释里，
 * 例如"见 `requirements.md` R17 的边界说明"），全是它本该挡下的东西。
 * ⇒ 所以下面 `FIXTURES` 每次运行都**先证明判据认得出样本**；判据一过时（改名、删名、
 * 换成不匹配的写法），自证会先红，而不是安静地全绿。
 *
 * ⭐ 结论：**`dev-notes/` 里新增或改名一份文档，就要回来给 `FORBIDDEN` 加一行。**
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
	// ── 目录名：任何 `dev-notes/...` 形式的引用 ──
	{ pattern: /dev-notes/, what: "引用了仓库外的开发笔记" },
	// ── 现行文档的文件名（带路径或不带路径都算）──
	// ⚠️⚠️ 这是一份**显式清单**：`dev-notes/` 新增或改名一份文档，就要回来加一行。
	// 它烂过一次，代价是这条门禁变成纯空转，详见文件头的「它为什么需要自证」。
	{ pattern: /\brequirements\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bdetailed-design\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bverification\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bmaintainer-handbook\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\brefactor-plan\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\brefactor-report\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\btest-speed-plan\.md\b/, what: "引用了仓库外的开发笔记" },
	// ── 历史名（已归档进 `dev-notes/_archive/`，仍然守着：防止有人凭记忆写回去）──
	{ pattern: /docs\/SCOPE\.md/, what: "引用了仓库外的开发笔记" },
	{ pattern: /docs\/INDEPENDENCE\.md/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bSCOPE\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bINDEPENDENCE\.md\b/, what: "引用了仓库外的开发笔记" },
	{ pattern: /\bSCOPE\b/, what: "把开发笔记当权威来引" },
	{ pattern: /\bINDEPENDENCE\b/, what: "把开发笔记当权威来引" },
];

/**
 * 判据自证：**每条 pattern 必须认得出自己的样本**，反例必须**不**被认出。
 *
 * ⚠️ 为什么非有不可（2026-10-13 审计发现）：上面那份清单曾经只剩 `SCOPE.md` /
 * `INDEPENDENCE.md` 两个**旧名**（那两份早已归档），于是门禁**一条都检查不到**，
 * 而同一时刻仓库里躺着 **14 处**对现行文档的引用（`src/` 与 `scripts/` 的注释里）——
 * 全是它本该挡下的东西。**"清单过时"不会报错，只会安静地什么都不挡。**
 * 反例同样重要：判据太宽（比如把裸词 `requirements` 也算上）会把人逼到关掉这条门禁。
 */
const FIXTURES = [
	{ sample: "边界见 `dev-notes/requirements.md` R17", want: "引用了仓库外的开发笔记" },
	{ sample: "见 `requirements.md` R17 的边界说明。", want: "引用了仓库外的开发笔记" },
	{ sample: "（F18，设计与需求见 `detailed-design.md` §20.10）", want: "引用了仓库外的开发笔记" },
	{ sample: "⚠️ 条数在 `verification.md` 顶部只记一处", want: "引用了仓库外的开发笔记" },
	{ sample: "见 `dev-notes/maintainer-handbook.md` 的「可嵌入类型表」", want: "引用了仓库外的开发笔记" },
	{ sample: "—— 见 `refactor-plan.md` §7。", want: "引用了仓库外的开发笔记" },
	{ sample: "见 `refactor-report.md` §9 的建议 #2", want: "引用了仓库外的开发笔记" },
	{ sample: "（见 `test-speed-plan.md` §10.6）", want: "引用了仓库外的开发笔记" },
	{ sample: "立项基线见 `docs/SCOPE.md`", want: "引用了仓库外的开发笔记" },
	{ sample: "见 `INDEPENDENCE.md`", want: "引用了仓库外的开发笔记" },
	{ sample: "SCOPE 里写明是红线", want: "把开发笔记当权威来引" },
	{ sample: "INDEPENDENCE 承诺过", want: "把开发笔记当权威来引" },
	// ── 反例：这些**不许**报 ──
	{ sample: "npm run check:readme 只看结构", want: null },
	{ sample: "需求里说 requirements 是活的", want: null },
	{ sample: "detailed design 的取舍写在代码旁边", want: null },
	{ sample: "这份 handbook 不在仓库里也能干活", want: null },
];

const fixtureProblems = [];
for (const fixture of FIXTURES) {
	const hit = FORBIDDEN.find((entry) => entry.pattern.test(fixture.sample));
	const got = hit ? hit.what : null;
	if (got !== fixture.want) {
		fixtureProblems.push(`样本「${fixture.sample}」期望 ${fixture.want ?? "不报"}，实际 ${got ?? "不报"}`);
	}
}
if (fixtureProblems.length > 0) {
	console.error("✗ 门禁自证失败 —— 判据本身不准，先修它（不要放着它去判断仓库）：");
	for (const problem of fixtureProblems) console.error(`    ${problem}`);
	process.exit(1);
}

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

console.log(
	`引用检查通过：${files.length} 个文件里没有任何对仓库外开发笔记的引用` +
		`（守 ${FORBIDDEN.length} 条写法；判据自证 ${FIXTURES.length} 条夹具全过）。`
);
