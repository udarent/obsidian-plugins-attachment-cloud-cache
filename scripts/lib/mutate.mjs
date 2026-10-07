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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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

// 最早装上：任何一条日志都可能撞上"下游已经关掉管道"，而那一刻若正处在
// 变异中途，进程一退出就会把源码留在被改坏的状态（详见函数说明）。
installBrokenPipeGuard();

/**
 * 把一组 TS 入口打包成临时 ESM 模块并 import。
 * 每次调用都是全新实例（临时目录 + 唯一查询串）。
 *
 * ⚠️ 打包与垫片都**复用 `load-ts.mjs`**，不在这里另写一套：
 * 变异套件与正式测试必须跑在同一套打包规则下，否则"变异被抓住"证明的
 * 是另一个环境里的行为。顺便也保证了多入口进同一个 bundle
 * （跨模块 `instanceof` 才不会恒为 false）。
 */
async function loadFresh(entries, reexportDefault) {
	const dir = await mkdtemp(join(tmpdir(), "acc-mut-"));
	const outfile = join(dir, "bundle.mjs");

	// 统一成"相对仓库根、不带扩展名"的写法（`bundleEntries` 的约定）
	const list = (Array.isArray(entries) ? entries : [entries]).map(stripToEntrySpec);
	// 入口若是「默认导出型模块」（如 src/main.ts），必须显式再导一次 default ——
	// `export *` 按规范不含它，否则套件拿到的是模块命名空间而不是插件类。
	const defaults = reexportDefault ? (Array.isArray(reexportDefault) ? reexportDefault : [reexportDefault]).map(stripToEntrySpec) : undefined;

	await bundleEntries(list, outfile, { reexportDefault: defaults });
	await writeObsidianShim(dir);

	const mod = await import(`${pathToFileURL(outfile).href}?mut=${Math.random()}`);
	await rm(dir, { recursive: true, force: true });
	return mod;
}

/** `src/core/ingest.ts` → `src/core/ingest`（barrel 里用不带扩展名的相对写法）。 */
function stripToEntrySpec(entry) {
	return String(entry).replace(/\\/g, "/").replace(/\.ts$/, "");
}

/*
 * ⚠️ 关于"一个文件只能调一次 runMutations"
 *
 * 它在结束时会 `process.exit()`，所以同一个文件里的**第二次调用永远不会执行** ——
 * 而第一次的"全部被捕获"照样打印，于是"一半的验证从没跑过"被当成"全部通过"。
 * （实测踩过：判定层与执行层写在一个文件里，执行层的 8 条一条都没跑。）
 *
 * 这里**故意不加运行时守卫**：进程已经 `exit` 了，守卫根本没有机会执行 ——
 * 加了也只会给人一种"已经防住了"的错觉。改用**静态检查**
 * （`scripts/check-mutate-files.mjs`），在 `npm run check` 里挡住这类写法。
 */

/**
 * 每个被变异的源文件，对应的"原始内容"备份路径。
 *
 * ⚠️ 放在**系统临时目录**而不是仓库里：放仓库里会出现在 `git status` 里，
 * 每次跑变异都留下噪音，也很容易被误提交。
 */
function backupPathFor(sourcePath) {
	const digest = createHash("sha256").update(sourcePath).digest("hex").slice(0, 16);
	return join(tmpdir(), `acc-mutation-backup-${digest}.txt`);
}

/**
 * 让"输出被下游截断"不至于**掐死整个变异过程**。
 *
 * ⚠️ 这条是实测踩出来的，而且症状极具误导性：
 * 常用 `node scripts/mutate-x.mjs | head` 只想看开头几行 ——
 * `head` 读够就关掉管道，于是本进程下一次 `console.log` 触发 **EPIPE**，
 * 未处理的流错误会让 Node **立刻退出**，而此时源码正处在"已变异"状态。
 * 源码就被留在了一个被改坏的版本上，而下游看到的现象是
 * 「某个业务断言失败」（例如"alt 里的方括号必须清掉"），
 * 让人以为是实现坏了、跑去改实现。
 *
 * 所以这里吞掉 EPIPE（那是"下游不看了"的正常信号），其余错误照抛。
 */
function installBrokenPipeGuard() {
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", (error) => {
			if (error?.code === "EPIPE") return;
			throw error;
		});
	}
}

/**
 * 自愈：若上次运行被**强杀**（超时 / SIGKILL）在变异中途，源码会停在"已变异"状态。
 *
 * 这不是理论风险 —— 实测踩过：一次 `timeout` 掐掉了变异进程，
 * `src/editor/editor-hooks.ts` 就少了一行 `replace(...)`，而工作区看上去"只是脏了一点"。
 * 更糟的是那次**没有报错**：下一个变异脚本的基线失败，报出来的却是一句业务断言
 * （"alt 里的方括号必须清掉"），很容易被当成实现坏了去改实现。
 *
 * 所以每次启动先看有没有遗留备份：有就**先还原再干活**。
 */
async function recoverFromInterruptedRun(sourcePath) {
	const backup = backupPathFor(sourcePath);
	const stale = await readFile(backup, "utf8").catch(() => null);
	if (stale === null) return false;
	writeFileSync(sourcePath, stale);
	await rm(backup, { force: true });
	return true;
}

/** 装信号处理：被 SIGINT / SIGTERM 打断时先把源码还原回去，再去死。 */
function installRestoreHandlers(sourcePath, original) {
	const restore = () => {
		try {
			writeFileSync(sourcePath, original);
		} catch {
			// 尽力而为：真要失败也没别的办法了
		}
		void rm(backupPathFor(sourcePath), { force: true });
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.once(signal, () => {
			restore();
			process.exit(130);
		});
	}
}

/**
 * @param {{
 *   source: string,                    相对仓库根的 TS 路径（要被改坏的那个文件）
 *   entries?: string[],                打包入口；默认就是 source 本身。
 *                                      需要跨模块断言（如 `instanceof`）时传多个
 *   reexportDefault?: string[],        需要拿到 **default 导出**的入口（如插件入口）。
 *                                      barrell 是 `export *`，按规范**不含 default**，
 *                                      不显式列出就会拿到模块命名空间而非那个类
 *                                      （症状：`X is not a constructor`）。
 *   suite: (mod: any) => void | Promise<void>,   断言套件（抛错 = 失败）
 *   mutations: Array<{ name: string, from: string, to: string, expect: string }>,
 * }} options
 */
export async function runMutations({ source, entries, reexportDefault, suite, mutations }) {
	const sourcePath = join(REPO_ROOT, source);

	// ⭐ 先自愈：上次若被强杀在变异中途，源码会停在"已变异"状态。
	// 必须在**读原文之前**做，否则会把"被改坏的版本"当成基线。
	const recovered = await recoverFromInterruptedRun(sourcePath);

	const original = readFileSync(sourcePath, "utf8");
	const loadEntries = entries ?? [source];

	// 备份 + 装信号处理：本次若被打断，下次启动能自愈
	await writeFile(backupPathFor(sourcePath), original);
	installRestoreHandlers(sourcePath, original);

	if (recovered) {
		console.log(`⚠️  检测到上次运行被中断，已先还原 ${source} 再继续`);
		console.log("");
	}

	// ⭐ 锚点预检：**在做任何耗时动作之前**把所有 `from` 校验一遍。
	//
	// 为什么要前置：`from` 写的是源码里的**字面片段**，所以它会在无声中被改签名毁掉 ——
	// "变异点未找到"就是这么来的，而它在原来的顺序里要等**基线跑完**才报，
	// 于是"跑十分钟、最后告诉你一条锚点过期了"（我连踩过三次，每次都是同一个签名改动）。
	// 一次遍历的代价换掉整轮空跑，很划算。
	//
	// ⚠️ 这里只**预检**、不代替运行时的判断：真正执行前仍会再查一次
	//（源码在运行过程中会被临时改写，条件与此刻不同）。
	const staleAnchors = mutations.filter((mutation) => !original.includes(mutation.from));
	if (staleAnchors.length > 0) {
		console.log(`✗ ${staleAnchors.length} 条变异的锚点在 ${source} 里找不到 —— 先更新变异脚本：`);
		for (const mutation of staleAnchors) {
			// 只打第一行，避免把多行锚点刷屏
			console.log(`    · ${mutation.name}`);
			console.log(`      期望源码含：${JSON.stringify(mutation.from.split("\n")[0])}`);
		}
		await rm(backupPathFor(sourcePath), { force: true });
		process.exit(1);
	}

	// ⭐ **只查锚点**的开关：`MUTATION_PREFLIGHT_ONLY=1` 时到这里就退出。
	//
	// 为什么值得有：锚点会在**改名**时整批失效（实测一次重命名就让三个脚本同时过期）。
	// 而运行器默认会继续跑基线+每条变异 —— 于是一轮排查要几分钟，
	// 而"还有没有别的过期锚点"要等下一轮才知道。
	// 有了它，改名之后可以一条命令把 34 个脚本的锚点全过一遍（每个只要一次 import 的时间）：
	//   MUTATION_PREFLIGHT_ONLY=1 npm run mutate
	if (process.env.MUTATION_PREFLIGHT_ONLY === "1") {
		console.log(`✓ 锚点预检通过：${source}（${mutations.length} 条变异）`);
		await rm(backupPathFor(sourcePath), { force: true });
		process.exit(0);
	}

	// ⚠️ 必须 await：签名与网络类的套件是 async 的（要起 mock S3 服务、
	// 要 await crypto）。若漏掉 await，套件返回的 Promise 被丢弃，
	// 里面的断言失败会变成**未处理的拒绝**，而这里看到的是"通过" ——
	// 又是一次"从未发生的验证被当成通过"。
	const attempt = async () => {
		try {
			await suite(await loadFresh(loadEntries, reexportDefault));
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
		await rm(backupPathFor(sourcePath), { force: true });
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

	// 还原后必须仍然通过 —— 顺带也确认"还原"这件事本身生效了。
	// 若这里红了，说明源码没被正确还原（下一次运行的自愈会再兜一层）。
	const after = await attempt();
	console.log("");
	if (after.failed) {
		console.log("★ 还原后仍失败 —— 源码没有被正确还原！");
		// ⚠️ 必须把原因打出来：只说"失败了"的话，人会先去怀疑业务代码，
		// 而真正的原因可能是"上次运行留下的残留"或"套件本身偶发"。
		console.log(`      实际：${String(after.message).split("\n")[0].slice(0, 120)}`);
		allCaught = false;
	} else {
		console.log("还原后：套件通过 ✓");
	}

	// 全部收尾完成，撤掉备份（留着会让下次启动误以为"上次被中断了"）
	await rm(backupPathFor(sourcePath), { force: true });

	console.log("");
	console.log(
		allCaught
			? `${mutations.length} 个变异全部被捕获，且各自因相应原因失败 —— 套件确实有牙齿`
			: "★ 存在漏过或原因不符，需补断言"
	);
	process.exit(allCaught ? 0 : 1);
}
