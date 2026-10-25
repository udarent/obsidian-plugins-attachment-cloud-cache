/**
 * 发版门槛：把「哪几个真机脚本算数」变成**一条命令**。
 *
 * ## 为什么需要它
 *
 * 2026-10-25 的教训：`verify:real-storage` 名字挂在 `package.json` 上、文档也提过，
 * 但自 1.2.0（取消缓存目录）起**每次必红**，红了近一个月没人发现 —— 因为它不在任何
 * 「发版前要跑什么」的清单里，而那份清单只存在于人的记忆里。
 *
 * 所以这里把它写死：**跑哪些、按什么顺序、任何一个不通过就整体失败**。
 *
 * ## 两档
 *
 * - 默认：全部 6 个（后 3 个会往**真实桶**写对象与声明，跑完各自清理）；
 * - `--no-real`：只跑不碰真实桶的前 3 个（日常改完代码想快速确认界面没坏时用）。
 *
 * ## 几条硬约束（都是踩出来的）
 *
 * 1. **必须显式给 `OBSIDIAN_VAULT`**：仓库里不写死任何人的库名。不给就立刻报错，
 *    并把本机认得的库列出来（复用 `knownVaultNames()`）。
 * 2. **串行，不并行**：每个脚本都会独占 Obsidian（单实例锁），并行只会互相踩。
 * 3. **每个子进程有超时**：脚本自己也可能卡住（WebSocket 不关 ⇒ Node 不退出，
 *    现象是「跑完了但命令不返回」），所以这里再兜一层 —— 默认 10 分钟，
 *    超时就 kill 并按失败计。
 * 4. **子进程的输出落文件**，控制台只打一行结果；失败时把最后 40 行贴出来。
 *    否则 6 个脚本的输出混在屏幕上，等于没输出。
 *
 * 用法：
 *   node scripts/verify-release.mjs                  # 全部（含真实桶）
 *   node scripts/verify-release.mjs --no-real        # 只跑不碰真实桶的
 *   OBSIDIAN_VAULT=ObsidianVault node scripts/verify-release.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { knownVaultNames } from "./lib/obsidian-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** ⭐ 发版门槛的**唯一**定义。增删脚本改这里，别改文档里那份清单。 */
const SUITE = [
	{
		name: "real",
		script: "verify-obsidian-smoke.mjs",
		what: "插件加载 / 命令集合 / 原型拦截",
		realBucket: false,
	},
	{
		name: "flows",
		script: "verify-flows.mjs",
		what: "附件管理弹窗（真实 DOM，38＋2 跳过）",
		realBucket: false,
	},
	{
		name: "confirm",
		script: "verify-confirm.mjs",
		what: "确认框、清单与共享桶（本机 mock）",
		realBucket: false,
	},
	{
		name: "settings",
		script: "verify-settings-real.mjs",
		what: "设置页两项的入口（会写真桶探针对象）",
		realBucket: true,
	},
	{
		name: "migrate",
		script: "verify-migrate-real.mjs",
		what: "统一对象名 ＋ 声明（真实桶）",
		realBucket: true,
	},
	{
		name: "real-storage",
		script: "verify-real-storage.mjs",
		what: "上传链 ＋ 声明（真实桶）",
		realBucket: true,
	},
];

const TIMEOUT_MS = Number(process.env.ACC_VERIFY_TIMEOUT_MS ?? 10 * 60 * 1000);
const onlyOffline = process.argv.includes("--no-real");

const vault = String(process.env.OBSIDIAN_VAULT ?? "").trim();
if (!vault) {
	const known = knownVaultNames();
	console.error("✗ 必须先指定库：OBSIDIAN_VAULT=<库名>");
	console.error(
		known.length > 0
			? `  本机认得这些 vault：${known.map((name) => `「${name}」`).join("、")}`
			: "  （本机读不到 obsidian.json —— 直接填 Obsidian 里显示的库名）"
	);
	console.error("  例：OBSIDIAN_VAULT=ObsidianVault node scripts/verify-release.mjs");
	process.exit(2);
}

const planned = onlyOffline ? SUITE.filter((entry) => !entry.realBucket) : SUITE;
const logDir = join(tmpdir(), "acc-release");
mkdirSync(logDir, { recursive: true });

const log = (line = "") => console.log(line);
const bar = "═".repeat(84);

log(bar);
log(`发版门槛：${planned.length} / ${SUITE.length} 个真机脚本（${onlyOffline ? "--no-real" : "含真实桶"}）`);
log(`  vault：${vault}`);
log(`  每个脚本超时：${Math.round(TIMEOUT_MS / 60000)} 分钟`
	+ (onlyOffline ? "" : "（后 3 个会往真实桶写对象，跑完各自清理）"));
log(bar);

/** 跑一个脚本：输出落文件，只回结果。 */
function runOne(entry) {
	return new Promise((resolve) => {
		const logPath = join(logDir, `${entry.name}.log`);
		const started = Date.now();
		const child = spawn(process.execPath, [join(HERE, entry.script)], {
			env: { ...process.env, OBSIDIAN_VAULT: vault },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let captured = "";
		child.stdout.on("data", (chunk) => {
			captured += chunk;
		});
		child.stderr.on("data", (chunk) => {
			captured += chunk;
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch {
				// 已经退了
			}
		}, TIMEOUT_MS);

		child.on("close", (code) => {
			clearTimeout(timer);
			try {
				writeFileSync(logPath, captured);
			} catch {
				// 落不下日志不影响判定 —— 它只是给人看的
			}
			const ms = Date.now() - started;
			const ok = !timedOut && code === 0;
			resolve({ ok, code, ms, timedOut, logPath, tail: lastLines(captured, 40) });
		});
	});
}

function lastLines(text, count) {
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return lines.slice(-count).join("\n");
}

const results = [];
for (const [index, entry] of planned.entries()) {
	log("");
	log(`▶ [${index + 1}/${planned.length}] ${entry.name} —— ${entry.what}`);
	const result = await runOne(entry);
	results.push({ entry, ...result });

	if (result.ok) {
		log(`  ✓ 通过（${(result.ms / 1000).toFixed(1)}s）`);
	} else if (result.timedOut) {
		log(`  ✗ 超时（${Math.round(TIMEOUT_MS / 60000)} 分钟）—— 已 kill`);
		log("    先确认没有残留的 Obsidian 进程（脚本可能没走完自己的清理）：");
		log("      关掉所有 Obsidian 窗口后重跑这一个脚本，别直接重跑整轮。");
	} else {
		log(`  ✗ 失败（退出码 ${result.code}，${(result.ms / 1000).toFixed(1)}s）`);
	}
	log("");
	log("    ── 最后几行 ──");
	for (const line of result.tail.split("\n")) log(`    ${line}`);

	// 第一个失败就停：后面的脚本会互相踩（单实例锁 + 真桶状态），跑下去只是浪费
	if (!result.ok) {
		log("");
		log(`⚠️ 在 ${entry.name} 停下 —— 后面的脚本没有跑（修完从这一个开始）。`);
		break;
	}
}

log("");
log(bar);
log("汇总");
log(bar);
for (const item of results) {
	const mark = item.ok ? "✓" : item.timedOut ? "⏱" : "✗";
	log(`  ${mark} ${item.entry.name.padEnd(14)} ${(item.ms / 1000).toFixed(1).padStart(7)}s`);
}
const skipped = planned.length - results.length;
if (skipped > 0) log(`  · 未跑 ${skipped} 个（前面有失败，按纪律停下）`);

const failed = results.filter((item) => !item.ok);
log("");
log(`  每个脚本的完整输出：${logDir}`);
log(bar);
if (failed.length === 0) {
	log(`✓ 发版门槛通过（${results.length} / ${planned.length}）`);
	process.exitCode = 0;
} else {
	log(`✗ 发版门槛未通过：${failed.map((item) => item.entry.name).join("、")}`);
	process.exitCode = 1;
}
