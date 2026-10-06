/**
 * 变异验证的共用运行器。
 *
 * ## 什么是变异验证，以及为什么必须要
 *
 * 「把实现改坏，测试必须变红」。若改坏了测试仍然通过，说明那条断言没有牙齿 ——
 * 它守护不了任何东西，只是让人以为已被守护。
 *
 * 本项目已经吃过一次亏：曾靠**子进程**跑校验脚本看退出码，判定"9 条规则全部拦截成功"，
 * 而实际上子进程因 `EBUSY` 根本没启动、返回的 `status` 是 `null`，
 * 于是 `status !== 0` 对所有输入都成立 —— 一次从未发生的验证被当成了通过。
 *
 * ## 为什么在**进程内**做
 *
 * ⚠️ 先澄清一个容易说错的前提：本机**只有同步**子进程 API 不可用 ——
 *   · `spawnSync` / `execFileSync` → 必 `EBUSY`（多次实测）
 *   · 异步 `spawn` → **正常**（实测退出码 0、能取到输出）
 *
 * 所以选进程内**不是**因为"派生不了进程"，而是因为它更简单、且断言不会漂移：
 *   · 断言套件与正式测试**共用同一份**（`*-suite.mjs`）。若派生进程，套件就得变成
 *     可执行文件并接受"跑哪个变异"的参数，多一层机械结构。
 *   · 20+ 个变异 × 进程启动开销，明显更慢。
 *   · 进程内可控模块缓存（唯一查询串），不需要临时目录与 IPC。
 *
 * 做法：改源码 → 用**唯一查询串**重新 esbuild + import（拿到全新模块实例）
 * → 跑同一套断言 → 还原。
 *
 * ⚠️ 查询串必须唯一：Node 按 URL 缓存模块，不加就会拿到上一次的实例，
 * 于是"变异后仍然通过"是假的（跑的还是旧代码）。
 *
 * ## 两条纪律
 *
 * 1. **断言套件必须与正式测试共用**（见 `settings-suite.mjs`）。若变异脚本自带一套断言，
 *    "变异被抓住"只证明变异脚本的断言有效，与正式测试无关。
 * 2. **每个变异必须因自己的原因失败**。断言"有报错"是不够的：
 *    一条规则坏了可能被另一条规则的报错掩盖，看起来仍然"抓住了"。
 *    所以用 `expect` 关键词比对，报错里必须出现该变异对应的线索。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installHostGlobals } from "./host-globals.mjs";
import { bundleEntries, writeObsidianShim } from "./load-ts.mjs";

// 与 load-ts.mjs 同理：变异验证也要在同样的宿主环境下跑套件，
// 否则"变异前的基线"会因为环境差异而红，结论就不可比了。
installHostGlobals();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * 把一组 TS 入口打包成临时 ESM 模块并 import。
 * 每次调用都是全新实例（临时目录 + 唯一查询串）。
 *
 * ⚠️ 打包与垫片都**复用 `load-ts.mjs`**，不在这里另写一套：
 * 变异套件与正式测试必须跑在同一套打包规则下，否则"变异被抓住"证明的
 * 是另一个环境里的行为。顺便也保证了多入口进同一个 bundle
 * （跨模块 `instanceof` 才不会恒为 false）。
 */
async function loadFresh(entries) {
	const dir = await mkdtemp(join(tmpdir(), "acc-mut-"));
	const outfile = join(dir, "bundle.mjs");

	// 统一成"相对仓库根、不带扩展名"的写法（`bundleEntries` 的约定）
	const list = (Array.isArray(entries) ? entries : [entries]).map(stripToEntrySpec);

	await bundleEntries(list, outfile);
	await writeObsidianShim(dir);

	const mod = await import(`${pathToFileURL(outfile).href}?mut=${Math.random()}`);
	await rm(dir, { recursive: true, force: true });
	return mod;
}

/** `src/core/ingest.ts` → `src/core/ingest`（barrel 里用不带扩展名的相对写法）。 */
function stripToEntrySpec(entry) {
	return String(entry).replace(/\\/g, "/").replace(/\.ts$/, "");
}

/**
 * @param {{
 *   source: string,                    相对仓库根的 TS 路径（要被改坏的那个文件）
 *   entries?: string[],                打包入口；默认就是 source 本身。
 *                                      需要跨模块断言（如 `instanceof`）时传多个
 *   suite: (mod: any) => void | Promise<void>,   断言套件（抛错 = 失败）
 *   mutations: Array<{ name: string, from: string, to: string, expect: string }>,
 * }} options
 */
export async function runMutations({ source, entries, suite, mutations }) {
	const sourcePath = join(REPO_ROOT, source);
	const original = readFileSync(sourcePath, "utf8");
	const loadEntries = entries ?? [source];

	// ⚠️ 必须 await：签名与网络类的套件是 async 的（要起 mock S3 服务、
	// 要 await crypto）。若漏掉 await，套件返回的 Promise 被丢弃，
	// 里面的断言失败会变成**未处理的拒绝**，而这里看到的是"通过" ——
	// 又是一次"从未发生的验证被当成通过"。
	const attempt = async () => {
		try {
			await suite(await loadFresh(loadEntries));
			return { failed: false, message: "" };
		} catch (error) {
			return { failed: true, message: String(error?.message ?? error) };
		}
	};

	// 基线：未变异必须通过 —— 否则下面的"抓住"没有意义
	const baseline = await attempt();
	if (baseline.failed) {
		console.log("✗ 基线未通过：未变异时套件就失败了，先修实现或测试");
		console.log(`   ${baseline.message.split("\n")[0]}`);
		process.exit(1);
	}
	console.log(`基线：未变异时 ${source} 的套件通过 ✓`);
	console.log("");

	let allCaught = true;

	for (const mutation of mutations) {
		if (!original.includes(mutation.from)) {
			console.log(`✗ 变异点未找到（脚本需更新）：${mutation.name}`);
			console.log(`   期望源码含：${JSON.stringify(mutation.from.slice(0, 76))}`);
			allCaught = false;
			continue;
		}

		writeFileSync(sourcePath, original.replace(mutation.from, mutation.to));
		let result;
		try {
			result = await attempt();
		} finally {
			writeFileSync(sourcePath, original);
		}

		const caught = result.failed;
		const onTarget = !mutation.expect || result.message.includes(mutation.expect);
		const ok = caught && onTarget;

		if (!caught) {
			console.log(`✗ 漏过（测试无牙）  ${mutation.name}`);
		} else if (!onTarget) {
			// 红了，但不是因为这条规则 —— 说明该规则可能被别的报错掩护着
			console.log(`✗ 原因不符        ${mutation.name}`);
			console.log(`      期望报错含「${mutation.expect}」，实际：${result.message.split("\n")[0].slice(0, 80)}`);
		} else {
			console.log(`✓ 抓住            ${mutation.name}`);
			console.log(`      ${result.message.split("\n")[0].slice(0, 88)}`);
		}
		if (!ok) allCaught = false;
	}

	// 还原后必须仍然通过
	const after = await attempt();
	console.log("");
	if (after.failed) {
		console.log("★ 还原后仍失败 —— 源码没有被正确还原！");
		allCaught = false;
	} else {
		console.log("还原后：套件通过 ✓");
	}

	console.log("");
	console.log(
		allCaught
			? `${mutations.length} 个变异全部被捕获，且各自因相应原因失败 —— 套件确实有牙齿`
			: "★ 存在漏过或原因不符，需补断言"
	);
	process.exit(allCaught ? 0 : 1);
}
