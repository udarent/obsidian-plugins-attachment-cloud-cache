/**
 * `npm run check:affected` —— 按本次改动**圈定**要跑的门禁，而不是一律全量。
 *
 * ## 解决什么问题
 *
 * 全量门禁的耗时大头高度集中（实测见 `lib/affected-map.mjs` 文件头）：
 * 三个真盘真网套件 ≈50s、35 个变异脚本 ≈8.5min，而静态门禁 + tsc + lint +
 * 其余 27 个套件加起来只有十几秒。"改一行文案等九分钟"就是这条曲线的日常。
 *
 * 本脚本把「改了什么」翻译成「该跑什么」：
 *
 *   1. **静态门禁永远全跑**（9 个一共 ~2s，划不来圈 —— 而且改门禁脚本本身
 *      就能被即时验证，这个性质值得保住）；
 *   2. **tsc 只要有 .ts 改动就跑**（类型错误是全局的，圈不得，反正 ~2s）；
 *   3. **eslint 只查改动的文件**（全量 ~5s，单文件亚秒）；
 *   4. **测试套件按覆盖闭包圈定**（规则见 `lib/affected-map.mjs`）；
 *   5. **变异脚本只跑 source 被动了的**（口径同上，这是省掉 8 分钟的关键）。
 *
 * 圈定的保守原则：**圈不定就全量**（工具链自身改动、映射解析失败、
 * 源码无套件覆盖）。宁可多跑，绝不漏跑。
 *
 * ## 用法
 *
 *   node scripts/affected.mjs                  # 圈定「工作区未提交的改动」
 *   node scripts/affected.mjs --base=origin/main   # 圈定「本分支相对 base 的全部改动」
 *   node scripts/affected.mjs --all            # 显式全量（等价 check + mutate）
 *   node scripts/affected.mjs --no-mutate      # 跳过变异阶段（迭代中更快的内圈）
 *   node scripts/affected.mjs --dry-run        # 只打印圈定结果，不执行
 *
 * ## ⚠️ 它的定位
 *
 * 这是**迭代内圈**的门禁，不是发布门禁。合并/推送前仍然要跑
 * `npm run check`（+ 攒齐改动后的 `npm run mutate`）全量 ——
 * 圈定逻辑由 `test-affected.mjs` 护栏守着，但"子集"永远是子集。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAffectedMap, selectAffected } from "./lib/affected-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

// ── 参数 ──
const args = process.argv.slice(2);
const FLAG = {
	all: args.includes("--all"),
	noMutate: args.includes("--no-mutate"),
	dryRun: args.includes("--dry-run"),
	base: args.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? null,
};

// ── 子进程（⚠️ 本机只有**异步** spawn 可用：spawnSync 必 EBUSY，见 lib/mutate.mjs）──
function run(command, argv, label) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, argv, { cwd: REPO_ROOT, stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code: code ?? 1, label }));
	});
}

function runCaptured(command, argv) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, argv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
	});
}

/** 跑到第一个失败就停（与 `check` 的 && 链同一语义）。 */
async function runStep(command, argv, label) {
	process.stdout.write(`\n── ${label} ${"─".repeat(Math.max(2, 60 - label.length))}\n`);
	const { code } = await run(command, argv, label);
	if (code !== 0) {
		console.error(`\n✗ ${label} 失败（退出码 ${code}），后续步骤已跳过`);
		process.exit(1);
	}
}

// ── 收集改动文件（posix 相对路径）──
async function changedFiles() {
	const files = new Set();

	const porcelain = await runCaptured("git", ["status", "--porcelain", "-z", "--untracked-files=all"]);
	if (porcelain.code !== 0) {
		console.error(`✗ git status 失败：${porcelain.stderr.trim()}`);
		process.exit(1);
	}
	const entries = porcelain.stdout.split("\0").filter(Boolean);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		if (path) files.add(path);
		// -z 格式下重命名/复制是两条记录：新路径 + 原路径，后者也算改动
		if (status.includes("R") || status.includes("C")) {
			const original = entries[++i];
			if (original) files.add(original);
		}
	}

	if (FLAG.base) {
		const diff = await runCaptured("git", ["diff", "--name-only", "-z", `${FLAG.base}...HEAD`]);
		if (diff.code !== 0) {
			console.error(`✗ git diff ${FLAG.base}...HEAD 失败：${diff.stderr.trim()}`);
			process.exit(1);
		}
		for (const path of diff.stdout.split("\0").filter(Boolean)) files.add(path);
	}

	return [...files].sort();
}

// ── 主流程 ──
const changed = FLAG.all ? [] : await changedFiles();

if (!FLAG.all && changed.length === 0) {
	console.log("工作区没有未提交的改动 —— 没什么可圈定的。");
	console.log("要跑全量就用 npm run check / npm run mutate，或加 --all。");
	process.exit(0);
}

const map = await buildAffectedMap();
const selection = FLAG.all
	? { full: true, fullReasons: ["--all：显式要求全量"], tests: new Map(), mutations: new Map(), notes: [] }
	: selectAffected(changed, map);

// ── 打印圈定结果（逐项可见：哪个改动选中了哪个套件）──
console.log("改动文件：");
if (FLAG.all) console.log("    （--all，不看改动）");
else for (const file of changed) console.log(`    ${file}`);
console.log("");

if (selection.full) {
	console.log("⇒ 触发全量：");
	for (const reason of selection.fullReasons) console.log(`    ${reason}`);
} else {
	const pickedTests = [...selection.tests.keys()];
	const pickedMutations = [...selection.mutations.keys()];
	console.log(`⇒ 圈定 ${pickedTests.length}/${map.tests.size} 个测试套件：`);
	for (const [file, reasons] of selection.tests) {
		console.log(`    ${file.replace("scripts/", "")}  ⇐ ${reasons.join("、")}`);
	}
	if (pickedTests.length === 0) console.log("    （无 —— 改动不落在任何套件覆盖范围）");
	if (!FLAG.noMutate) {
		console.log(`⇒ 圈定 ${pickedMutations.length}/${map.mutations.size} 个变异脚本：`);
		for (const [file, reasons] of selection.mutations) {
			console.log(`    ${file.replace("scripts/", "")}  ⇐ ${reasons.join("、")}`);
		}
		if (pickedMutations.length === 0) console.log("    （无 —— 没有变异对象的 source 被动到）");
	}
	for (const note of selection.notes) console.log(`    · ${note}`);
}

if (FLAG.dryRun) {
	console.log("\n（--dry-run，到此为止）");
	process.exit(0);
}

// ── 阶段 1：静态门禁（永远全跑 —— 9 个一共 ~2s，且门禁脚本改动即时生效）──
const STATIC_GATES = [
	"check-manifest",
	"check-api-floor",
	"check-lockfile-platforms",
	"check-credential-files",
	"check-mutate-files",
	"check-injected-snippets",
	"check-no-dev-doc-refs",
	"check-readme",
	"check-i18n-keys",
];
for (const gate of STATIC_GATES) {
	await runStep(process.execPath, [join("scripts", `${gate}.mjs`)], `静态门禁 ${gate}`);
}

// ── 阶段 2：tsc（类型错误是全局的，只要有 ts 改动就跑；~2s）──
const anyTsChanged = FLAG.all || changed.some((f) => /\.(?:ts|mts)$/.test(f));
if (anyTsChanged) {
	await runStep(process.execPath, [join("node_modules", "typescript", "bin", "tsc"), "--noEmit"], "tsc --noEmit");
}

// ── 阶段 3：eslint（只查改动的 src 文件；全量时查全部）──
const lintTargets = FLAG.all
	? ["."]
	: changed.filter((f) => f.startsWith("src/") && f.endsWith(".ts") && existsSync(join(REPO_ROOT, f)));
if (lintTargets.length > 0) {
	await runStep(
		process.execPath,
		[join("node_modules", "eslint", "bin", "eslint.js"), "--no-warn-ignored", ...lintTargets],
		`eslint（${FLAG.all ? "全量" : `${lintTargets.length} 个改动文件`}）`
	);
}

// ── 阶段 4：测试（先构建产物 —— load-acceptance 测的是 main.js）──
const testsToRun = selection.full ? [...map.tests.keys()] : [...selection.tests.keys()];
if (testsToRun.length > 0) {
	await runStep(process.execPath, ["esbuild.config.mjs", "production"], "esbuild production（供 load-acceptance）");
	const testArgs = selection.full
		? [join("scripts", "run-tests.mjs")]
		: [join("scripts", "run-tests.mjs"), `--only=${testsToRun.map((f) => f.replace("scripts/", "")).join(",")}`];
	await runStep(process.execPath, testArgs, selection.full ? "测试套件（全量）" : `测试套件（${testsToRun.length} 个）`);
} else {
	console.log("\n── 测试套件：圈定结果为空，跳过");
}

// ── 阶段 5：变异（只跑 source 被动到的；串行 —— 每个脚本会临时改写源码）──
if (FLAG.noMutate) {
	console.log("\n── 变异验证：--no-mutate，跳过（提交前记得跑全量 npm run mutate）");
} else {
	const mutationsToRun = selection.full
		? (await readdir(join(REPO_ROOT, "scripts"))).filter((f) => /^mutate-.*\.mjs$/.test(f)).sort()
		: [...selection.mutations.keys()].map((f) => f.replace("scripts/", ""));
	if (mutationsToRun.length === 0) {
		console.log("\n── 变异验证：圈定结果为空，跳过");
	} else {
		for (const file of mutationsToRun) {
			await runStep(process.execPath, [join("scripts", file)], `变异 ${file.replace(/\.mjs$/, "")}`);
		}
	}
}

// ── 收尾 ──
console.log(`\n${"=".repeat(72)}`);
if (selection.full) {
	console.log("✓ check:affected 全量通过 —— 与 npm run check（+ mutate）等价");
} else {
	console.log("✓ check:affected 通过 —— 本次跑的是按改动圈定的**子集**。");
	console.log("  合并/推送前仍要跑全量：npm run check && npm run mutate");
}
