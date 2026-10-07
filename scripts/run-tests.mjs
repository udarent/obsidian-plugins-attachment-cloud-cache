/**
 * 测试运行器：自动发现并顺序执行 `scripts/test-*.mjs`。
 *
 * ## 为什么不用子进程隔离
 *
 * 逐个子进程跑能得到最强隔离，但本机 `spawnSync` 会以 **EBUSY** 失败
 * （子进程根本没启动、`status` 为 null）。那种失败极危险：`status !== 0`
 * 会对所有输入成立，于是"全部通过"可能是**假的**。
 *
 * 改用**带查询串的动态 import**：`import(url + "?case=N")` 会让 Node 把它
 * 当成不同模块，从而拿到全新的模块级状态 —— 隔离效果接近子进程，
 * 又不需要派生进程。
 *
 * ## 一个测试文件失败不应中断其余
 *
 * 每个文件独立 try/catch：失败累计、继续跑完，最后汇总。
 * 否则第一个失败会掩盖后面所有结果，排查时得一个个改着跑。
 *
 * 用法：
 *   node scripts/run-tests.mjs              # 全部
 *   node scripts/run-tests.mjs settings     # 只跑文件名含 "settings" 的
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const entries = await readdir(HERE);
const files = entries.filter((f) => /^test-.*\.mjs$/.test(f)).sort();

if (files.length === 0) {
	console.error("✗ 未发现任何 test-*.mjs");
	process.exit(1);
}

const selected = filter ? files.filter((f) => f.includes(filter)) : files;
if (selected.length === 0) {
	console.error(`✗ 没有匹配 "${filter}" 的测试文件。可用：${files.join(", ")}`);
	process.exit(1);
}

const results = [];
const started = Date.now();

for (const [index, file] of selected.entries()) {
	const url = pathToFileURL(join(HERE, file)).href;
	const t0 = Date.now();
	try {
		// 查询串让每个文件拿到独立的模块实例（等效于干净的解释器状态）
		await import(`${url}?case=${index}&t=${t0}`);
		results.push({ file, ok: true, ms: Date.now() - t0 });
	} catch (error) {
		results.push({ file, ok: false, ms: Date.now() - t0, error });
	}
}

console.log("");
console.log("=".repeat(72));
let failed = 0;
for (const r of results) {
	const mark = r.ok ? "✓" : "✗";
	console.log(`${mark} ${r.file}${r.ok ? "" : `  (${r.ms}ms)`}`);
	if (!r.ok) {
		failed += 1;
		const message = r.error?.stack || r.error?.message || String(r.error);
		console.log(
			message
				.split("\n")
				.map((l) => `      ${l}`)
				.join("\n")
		);
	}
}
console.log("=".repeat(72));
console.log(
	failed === 0
		? `All ${results.length} test files passed.  (${Date.now() - started}ms)`
		: `${failed} / ${results.length} test files FAILED.  (${Date.now() - started}ms)`
);

process.exit(failed === 0 ? 0 : 1);
