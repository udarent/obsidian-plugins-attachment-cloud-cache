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
 * ## 输出：耗时 + 自述**归属**
 *
 * 每个文件跑完**就地**打印一行（标记 + 文件名 + 耗时），并把该文件自己打印的
 * 那句自述缩进挂在它下面。
 *
 * 改之前是两截分开的：各套件的自述在跑的过程中先刷出来（看不出属于哪个文件），
 * 末尾才是平铺的一列 ✓（又看不出各自花了多久）。套件一旦输出多行就更对不上号。
 *
 * 为此在 `import()` 期间临时接管 `console.log`，把该文件打印的内容收进它名下。
 * ⚠️ 只接管 `console.log`：入口与套件都只用它（没有往 stderr 写的），
 * 且接管范围限于单个文件的 import，不跨文件泄漏。
 *
 * 用法：
 *   node scripts/run-tests.mjs              # 全部
 *   node scripts/run-tests.mjs settings     # 只跑文件名含 "settings" 的
 *   node scripts/run-tests.mjs --exclude=ingest,transfer,download   # 排除几个（`check:fast` 用）
 *   node scripts/run-tests.mjs --only=test-a.mjs,test-b.mjs         # 只跑列出的几个（`check:affected` 用）
 *
 * ⭐ `--exclude` 是为 `npm run check:fast` 加的：那三个真盘真网套件占了全套件耗时的大半
 * （ingest 30s / transfer 11s / download 9s ≈ 三分之二），日常迭代时跳过它们，
 * 全套留给发版前的 `npm run check`。
 *
 * ⚠️ 这里**刻意保持串行**。曾试过改成"一个套件一个子进程并行"，实测**否决**：
 * ① 耗时**反而更长** —— 这些套件是 CPU 密集的（真实 HTTP + 真实磁盘 + 加密），
 *    6 个逻辑核上并发 5 路把每个套件拖慢 1.2~2.8 倍，同时两个入口为 `src/main`
 *    的宽图套件只能独占跑；
 * ② 更糟的是**间歇性卡死**：同一份代码跑两次，一次 53 秒通过、一次 `test-download`
 *    再也不返回（卡了 5 分钟以上、零输出）。门禁"偶尔挂住"比慢危险得多。
 * ⇒ **串行 + 分层**才是这台机器上的正解，见上面的 `--exclude`。
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// 参数：位置参数 = "文件名含这个片段才选中"；`--exclude=a,b,c` = 排除含这些片段的。
// 两者都按**子串**匹配（与原来一致），所以 `--exclude=ingest` 只命中 test-ingest.mjs。
// `--only=a,b,c` = 只选中含其中任一片段的（多个精确文件名，`check:affected` 按圈定结果调用）。
let includeFilter = null;
const excludeFilters = [];
const onlyFilters = [];
for (const arg of process.argv.slice(2)) {
	if (arg.startsWith("--exclude=")) excludeFilters.push(...arg.slice("--exclude=".length).split(",").filter(Boolean));
	else if (arg.startsWith("--only=")) onlyFilters.push(...arg.slice("--only=".length).split(",").filter(Boolean));
	else includeFilter = arg;
}

if (includeFilter && onlyFilters.length > 0) {
	console.error("✗ 位置过滤与 --only 只能用一个");
	process.exit(1);
}

const entries = await readdir(HERE);
const files = entries.filter((f) => /^test-.*\.mjs$/.test(f)).sort();

if (files.length === 0) {
	console.error("✗ 未发现任何 test-*.mjs");
	process.exit(1);
}

let selected = files;
if (includeFilter) selected = selected.filter((f) => f.includes(includeFilter));
if (onlyFilters.length > 0) selected = selected.filter((f) => onlyFilters.some((o) => f.includes(o)));
if (excludeFilters.length > 0) selected = selected.filter((f) => !excludeFilters.some((e) => f.includes(e)));

if (selected.length === 0) {
	console.error(
		`✗ 没有匹配的测试文件（include=${includeFilter ?? "全部"}、only=${onlyFilters.join(",") || "无"}、exclude=${excludeFilters.join(",") || "无"}）。可用：${files.join(", ")}`
	);
	process.exit(1);
}

/** 文件名列宽（按**全部**文件名算，而不是本次选中的）—— 这样加过滤时列不会跳。 */
const NAME_WIDTH = Math.max(...files.map((f) => f.length)) + 2;

/** 打印一个文件的结果（就地调用，见文件头）。 */
function printResult(result) {
	const mark = result.ok ? "✓" : "✗";
	console.log(`${mark} ${result.file.padEnd(NAME_WIDTH)}${String(result.ms).padStart(6)}ms`);

	// 该文件的自述 —— 缩进挂在它下面，于是"谁说了什么"一眼可见
	for (const note of result.notes) {
		for (const line of note.split("\n")) console.log(`      ${line}`);
	}

	if (!result.ok) {
		const message = result.error?.stack || result.error?.message || String(result.error);
		console.log(
			message
				.split("\n")
				.map((l) => `      ${l}`)
				.join("\n")
		);
	}
}

const results = [];
const started = Date.now();

for (const [index, file] of selected.entries()) {
	const url = pathToFileURL(join(HERE, file)).href;
	const t0 = Date.now();

	// 收下这个文件打印的内容，跑完归到它名下
	const notes = [];
	const realLog = console.log;
	console.log = (...args) => notes.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));

	let result;
	try {
		// 查询串让每个文件拿到独立的模块实例（等效于干净的解释器状态）
		await import(`${url}?case=${index}&t=${t0}`);
		result = { file, ok: true, ms: Date.now() - t0, notes };
	} catch (error) {
		result = { file, ok: false, ms: Date.now() - t0, notes, error };
	} finally {
		// ⚠️ 必须还原：这个套件若在 import 之后还留了异步回调，它打印的东西
		// 会进错文件名下（也因此"归属"只在每个文件跑完那一刻成立）
		console.log = realLog;
	}

	results.push(result);
	// ⚠️ 就地打印而不是攒到最后：某个文件卡住时，至少能看出跑到了哪一步
	printResult(result);
}

const failed = results.filter((r) => !r.ok);

console.log("=".repeat(72));
if (failed.length === 0) {
	console.log(`All ${results.length} test files passed.  (${Date.now() - started}ms)`);
} else {
	console.log(`${failed.length} / ${results.length} test files FAILED.  (${Date.now() - started}ms)`);
	// 再列一次失败清单：输出长起来之后，末尾这一眼比往上翻更省事
	for (const r of failed) console.log(`   ✗ ${r.file}`);
}

process.exit(failed.length === 0 ? 0 : 1);
