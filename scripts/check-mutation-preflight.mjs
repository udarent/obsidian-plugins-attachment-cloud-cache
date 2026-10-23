/**
 * 门禁：**每个变异脚本的锚点都还在**（D-81，评审 4-3）。
 *
 * ## 为什么这条必须进门禁
 *
 * 变异验证的判据是「把源码改坏，测试必须变红」。而"改坏"靠的是 `from` 这段**字面片段**
 * 在源码里能找到且唯一 —— 于是只要重构时改了一行，那条锚点就**静默失效**：
 * 脚本自己会在预检时报"找不到目标"，可谁会在重构之后把所有变异脚本都跑一遍？
 *
 * 实测：D-70 抓到 `mutate-upload-existing-flow.mjs` 有 **5 条**锚点早就找不到目标
 * （等于那 5 条这一轮之前一直没在跑）；`check-mutate-files` 只查"文件/套件配齐"，
 * 查不出锚点过期。而"锚点过期"与"测试没牙"这两种失败长得完全不同，
 * 但都会让人以为**已经有守卫**。
 *
 * ⇒ 把 `MUTATION_PREFLIGHT_ONLY=1`（运行器本来就有）挂进 `npm run check`：
 * 每条变异脚本只做「读源码 + 查锚点（存在且唯一）」就退出，**不打包、不跑套件**，
 * 所以整轮是秒级的。
 *
 * ## 为什么是并行子进程，而不是在这里 import 它们
 *
 * `mutate-*.mjs` 是**带顶层副作用的脚本**（`await runMutations(...)`），
 * 在同一个进程里 import 第二个就会和 `runMutations` 的 `process.exit()` 打架
 * （`check-mutate-files` 文件头记着那次事故：一半的验证从没跑过，而输出完全正常）。
 * 所以每个脚本各起一个进程、各带一个环境变量，是唯一不会互相污染的做法。
 *
 * ⚠️ 并行度刻意压到 6：这些子进程各自读同一个仓库的源文件，开太多只是让磁盘排队。
 */

import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PARALLEL = 6;

const mutateFiles = (await readdir(HERE)).filter((name) => /^mutate-.*\.mjs$/.test(name)).sort();
if (mutateFiles.length === 0) {
	console.error("✗ 没找到任何 mutate-*.mjs —— 门禁的路径写错了（它现在什么都没检查）");
	process.exit(1);
}

/** 起一个预检进程，收下它的输出（失败时要原样打印，否则人不知道锚点该怎么改）。 */
function preflight(file) {
	return new Promise((resolveRun) => {
		const child = spawn(process.execPath, [join("scripts", file)], {
			cwd: REPO_ROOT,
			env: { ...process.env, MUTATION_PREFLIGHT_ONLY: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", (error) => resolveRun({ file, ok: false, out: `${out}\n${error}` }));
		child.on("close", (code) => {
			// 判据是**输出里那句话**，不只是退出码：退出码 0 但没走过预检（比如脚本改了结构）
			// 同样不算数 —— "检查没在检查"这件事必须在这里也被挡住。
			const ok = code === 0 && out.includes("锚点预检通过");
			resolveRun({ file, ok, out });
		});
	});
}

const results = [];
let cursor = 0;
/** 固定 6 条工人从同一个游标里取活。 */
async function worker() {
	for (;;) {
		const index = cursor++;
		if (index >= mutateFiles.length) return;
		results[index] = await preflight(mutateFiles[index]);
	}
}

await Promise.all(Array.from({ length: Math.min(PARALLEL, mutateFiles.length) }, () => worker()));

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
	console.error(`\n✗ 变异锚点预检失败：${failed.length} / ${results.length} 个脚本`);
	for (const item of failed) {
		// 只保留脚本自己的解释（预检失败时会逐条列出哪个 `from` 过期 / 不唯一）
		const detail = item.out
			.split("\n")
			.filter((line) => line.trim() !== "")
			.slice(-14)
			.join("\n");
		console.error(`\n—— ${item.file} ——\n${detail}`);
	}
	console.error(
		"\n改法：这些 `from` 在源码里已经找不到（或不再唯一）。按脚本里那句 `name` 的说明，" +
			"把 `from` 更新成**现在**那行（并带上足够上下文保证唯一）。"
	);
	process.exit(1);
}

console.log(
	`Mutation anchor preflight passed (${results.length} 个变异脚本的每一段 \`from\` 都在源码里存在且唯一；` +
		"只读源码、不打包不跑套件，所以每一轮 check 都能跑)"
);
