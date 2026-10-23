#!/usr/bin/env node
/**
 * 静态层的并行执行器。
 *
 * ## 为什么需要它（2026-10-13 实测）
 *
 * 静态层的每一步都是**独立**的（各自读文件、各自写自己的产物），但每一步都要付一次
 * 进程启动（实测每条门禁 ~0.8 s）：
 *
 *   · 串行：`tsc` + `esbuild` + `eslint` + 全部门禁 ≈ 21 s
 *   · 并行：三步同时起，然后 全部门禁一起 ≈ 10 s
 *
 * 对 `check:affected` 尤其明显：它的**阶段 1 就是这 全部门禁**（原先串行 ~10 s），
 * 那是日常那档最大的一块。
 *
 * ## 三条不能省的约束
 *
 * 1. **门禁必须在 `esbuild` 之后**：`check-manifest` / `check-no-dev-doc-refs` 读构建产物
 *    （`main.js` / `styles.css`）。所以分两组，第二组只在第一组通过后跑。
 * 2. **组内并行 ⇒ 失败语义与 `&&` 链不同**：`&&` 是"停在第一个失败"，这里是"**跑完全部、
 *    一次报出所有失败**"。这是有意的（一次看到所有坏掉的门禁），但要知道这个差别。
 * 3. **直接 spawn node 入口，不经过 npm**：本机 `spawn("npm")` 会 ENOENT，而
 *    `spawn("npm.cmd")` 在 Node 22 上会 **EINVAL**（必须 `shell: true`）。绕开 npm 更简单也更快。
 *    ⚠️ 代价是要知道 `build` / `lint` 的真实命令 —— 所以这里**核对 script 原文**，
 *    对不上就回退到 `npm run <name>`（`shell: true`），不让它悄悄漂移。
 *
 * ⚠️ 只并行**静态层**。**套件层与变异层都不并行** —— 那是实测否决过的（真盘真网 + CPU 密集，
 * 并发 5 路让每个脚本慢 1.2–2.8 倍并卡死；套件并行时 `test-download` 永不返回）。
 * 见 `lib/mutate.mjs` 与手册「为什么测试不能并行（实测否决，别再试）」。
 *
 * 用法：
 *   node scripts/run-static.mjs                # tsc ∥ esbuild ∥ **eslint**，然后 全部门禁 ∥（发版档）
 *   node scripts/run-static.mjs --lint=oxlint  # 同上，但 lint 换成 oxlint（快档：7.0 s → 0.37 s）
 *   node scripts/run-static.mjs --gates        # 只跑 全部门禁（`affected.mjs` 用：它自己管 build/lint/tsc）
 *
 * ⭐ 两个 lint 的分工（2026-10-13）：**oxlint 是快档**（`check:fast`），**eslint 是门禁**（`check` / 发版档）。
 * 两者**不是替代关系而是分工**，因为成本结构完全不同（实测）：
 *   · eslint 每次运行有一个 **≈3.2 s 的地板**（加载插件 + 建类型程序）—— 一条规则不跑、一个文件不查也是 3.2 s；
 *     单文件 4.5 s、63 文件 7.0 s（其中 142 条规则本身只占 ~2.2 s，固定开销占 ~5.0 s）。
 *   · oxlint 跑 **117 条规则 / 227 文件**只要 **0.06 s**（全类别 398 条也只要 0.08 s）。
 * ⇒ 结论：**规则尽量放 oxlint**（它那侧几乎免费），eslint 只留它做不了的。已落地的是
 *   `.oxlintrc.json` 补齐它天生就有、但默认关着的 **21 条**，并把**移动端安全那两条**
 *   （`no-restricted-imports` / `no-restricted-globals`）搬了过去 ⇒ 快档**第一次**能挡住
 *   `import fs from "fs"`（此前只有 eslint 挡得住，日常档是漏的）。
 *   eslint 那边剩下：**29 条类型感知** + **37 条 `obsidianmd/*`** + 10 条 oxlint 未实现 + 限制规则的 tseslint 变体。
 * ⚠️ 类型感知那 29 条搬不走：oxlint `--type-aware` 在本机跑不起来（要 spawn `tsgolint.CMD` ⇒ os error 231）。
 *   也**别指望"搬规则"能省时间**：实测这 142 条里，非类型感知的 113 条总共只值 **0.73 s**。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * 13 条静态门禁 —— **清单的唯一来源**（`affected.mjs` 走 `--gates`，不再抄一份）。
 * ⚠️ 不要在别处再抄一份 —— 这里就是唯一来源。
 *
 * ⭐ 2026-10-22（D-79）新增 `check-mobile-api`：`manifest.json` 承诺 `isDesktopOnly: false`，
 * 而移动端崩溃的唯一根因是**加载期碰到 Node / 桌面专属能力** —— 那条能静态查，所以进门禁。
 */
const GATES = [
	"check-manifest",
	"check-api-floor",
	"check-lockfile-platforms",
	"check-credential-files",
	"check-mutate-files",
	"check-injected-snippets",
	"check-no-dev-doc-refs",
	"check-readme",
	"check-readme-commands",
	"check-i18n-keys",
	"check-notice-i18n",
	// ⭐ 移动端：加载期不许碰 Node / 桌面专属能力（`manifest.json` 对手机用户有承诺）
	"check-mobile-api",
	// ⭐ 变异锚点：每条 `from` 都还在源码里（且唯一）—— 否则那些"守卫"早就空跑了
	"check-mutation-preflight",
];

/** `package.json` 的 scripts —— 用来核对"要不要回退走 npm"。 */
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

/** 跑一个步骤，**收下输出**（并行时直接透传会互相插字，输出就没法看了）。 */
function runOne(label, command, argv, useShell = false) {
	const started = Date.now();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, argv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], shell: useShell });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ label, code: code ?? 1, out, ms: Date.now() - started }));
	});
}

/**
 * 一组并行跑，然后**按声明顺序**回放输出。
 *
 * ⚠️ 完成顺序是随机的 —— 直接打印会让人以为"步骤顺序变了"。回放顺序固定成声明顺序，
 * 于是这份输出与串行时一样可读、可 diff。
 */
async function runGroup(steps) {
	const results = await Promise.all(steps.map((s) => runOne(s.label, s.command, s.argv, s.shell)));
	const wallMs = Math.max(...results.map((r) => r.ms));
	for (const r of results) {
		console.log(`${r.code === 0 ? "✓" : "✗"} ${r.label}  (${(r.ms / 1000).toFixed(1)}s)`);
		for (const line of r.out.split("\n")) if (line.trim() !== "") console.log(`    ${line}`);
	}
	const failed = results.filter((r) => r.code !== 0);
	return { ok: failed.length === 0, wallMs, failed };
}

/**
 * 第一组：类型检查、打包、lint。
 *
 * ⚠️ 三条都**核对 script 原文**：`build` 在本项目是 `tsc --noEmit && node esbuild.config.mjs production`
 * （两条互不依赖的命令，所以这里把它们拆开并行）；`lint` 是 `eslint .`。
 * 一旦哪天被改写成别的形态，就退回 `npm run <name>` —— **宁可慢，也别悄悄少跑了一步**。
 */
function firstGroupSteps(useOxlint) {
	const NODE = process.execPath;
	const tscBin = join("node_modules", "typescript", "bin", "tsc");
	const eslintBin = join("node_modules", "eslint", "bin", "eslint.js");
	const oxlintBin = join("node_modules", "oxlint", "bin", "oxlint");
	const steps = [];

	if (PKG.scripts.build === "tsc --noEmit && node esbuild.config.mjs production") {
		steps.push({ label: "tsc --noEmit", command: NODE, argv: [tscBin, "--noEmit"] });
		steps.push({ label: "esbuild production（构建产物）", command: NODE, argv: ["esbuild.config.mjs", "production"] });
	} else {
		console.log("⚠️ package.json 的 build 形态变了 —— 退回 `npm run build`（本轮至少这样更安全）");
		steps.push({ label: "build（npm run build）", command: "npm", argv: ["run", "build"], shell: true });
	}

	if (useOxlint) {
		if (PKG.scripts["lint:fast"] === "oxlint src scripts") {
			steps.push({ label: "oxlint src scripts（快档）", command: NODE, argv: [oxlintBin, "src", "scripts"] });
		} else {
			console.log("⚠️ package.json 的 lint:fast 形态变了 —— 退回 `npm run lint:fast`");
			steps.push({ label: "lint:fast（npm run lint:fast）", command: "npm", argv: ["run", "lint:fast"], shell: true });
		}
	} else if (PKG.scripts.lint === "eslint .") {
		steps.push({ label: "eslint .（门禁档）", command: NODE, argv: [eslintBin, "."] });
	} else {
		console.log("⚠️ package.json 的 lint 形态变了 —— 退回 `npm run lint`");
		steps.push({ label: "lint（npm run lint）", command: "npm", argv: ["run", "lint"], shell: true });
	}

	return steps;
}

const startedAll = Date.now();
console.log(`── 静态层（并行）${"─".repeat(48)}`);

const useOxlint = process.argv.includes("--lint=oxlint");

if (!process.argv.includes("--gates")) {
	const first = await runGroup(firstGroupSteps(useOxlint));
	if (!first.ok) {
		console.error(
			`\n✗ 静态层失败：${first.failed.map((r) => r.label).join(" / ")} —— ` +
				"门禁**未运行**（它们读构建产物，此时产物可能根本没生成，跑出来的失败会误导）"
		);
		process.exit(1);
	}
}

const gates = await runGroup(
	GATES.map((gate) => ({
		label: `门禁 ${gate.replace(/^check-/, "")}`,
		command: process.execPath,
		argv: [join("scripts", `${gate}.mjs`)],
	}))
);
if (!gates.ok) {
	console.error(`\n✗ 静态层失败：${gates.failed.length} 条门禁未通过`);
	process.exit(1);
}

const totalMs = Date.now() - startedAll;
console.log(
	`\n✓ 静态层通过 —— 全程 ${(totalMs / 1000).toFixed(1)}s（${GATES.length} 条门禁组内并行 ${(
		gates.wallMs / 1000
	).toFixed(1)}s）`
);
