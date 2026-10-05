/**
 * 变异验证（**进程内**，不派生进程）：
 * 确认 `lib/settings-suite.mjs` 真的能抓住「设置存得进读不出」这个缺陷。
 *
 * ## 为什么必须做这一步
 *
 * 一条永远通过的检查比没有检查更糟 —— 它让人以为已被守护。
 * 上一轮就吃过亏：靠子进程看退出码断定"9 条规则全部拦截成功"，
 * 实际子进程因 EBUSY 根本没启动、`status` 为 null，`status !== 0` 对任何输入都成立。
 *
 * ## 为什么本脚本不派生进程
 *
 * 本机 `spawnSync` / `execFileSync` 都会以 **EBUSY** 失败（子进程起不来）。
 * 所以改成**在同一个进程里换一份构建产物**：
 *   改源码 → 用不同查询串重新 esbuild + import（拿到全新模块）→ 跑同一套断言 → 还原
 *
 * 这与"派生进程跑测试文件"效果等价，而且**复用同一套断言**（见 settings-suite.mjs 的说明）。
 *
 * 用法：node scripts/mutate-settings.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runSettingsSuite } from "./lib/settings-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SOURCE = join(REPO_ROOT, "src", "settings.ts");
const MOCK_OBSIDIAN = join(HERE, "lib", "mock-obsidian.mjs");

const original = readFileSync(SOURCE, "utf8");

/** 每个变异：描述 + 替换 + 期望被抓住 */
const MUTATIONS = [
	{
		name: "cacheFolder 永远取默认值（经典的「存得进读不出」）",
		from: "cacheFolder: pickNonEmptyString(data.cacheFolder, defaults.cacheFolder),",
		to: "cacheFolder: defaults.cacheFolder,",
	},
	{
		name: "enabled 忽略已存值",
		from: "enabled: pickBoolean(data.enabled, defaults.enabled),",
		to: "enabled: defaults.enabled,",
	},
	{
		name: "s3.bucket 忽略已存值",
		from: "bucket: pickString(data.bucket, DEFAULT_S3.bucket),",
		to: "bucket: DEFAULT_S3.bucket,",
	},
	{
		name: "布尔校验被去掉（坏值直接透传）",
		from: 'return typeof value === "boolean" ? value : fallback;',
		to: "return value;",
	},
	{
		name: "枚举校验被去掉（非法值透传）",
		from: "return guard(value) ? value : fallback;",
		to: "return value;",
	},
	{
		// ⚠️ 必须把 `...data` 放在**开头**而不是末尾：
		// 放末尾会同时覆盖掉各字段的类型校验结果，于是先触发"坏值应回落"那条断言，
		// 报错原因就不是"未知字段被带进来"了 —— 那样虽然也红了，
		// 但证明不了"未知字段"这条断言真的有效。
		name: "未知字段被带进来（不再逐字段白名单）",
		from: "\treturn {\n\t\tenabled: pickBoolean(data.enabled, defaults.enabled),",
		to: "\treturn {\n\t\t...data,\n\t\tenabled: pickBoolean(data.enabled, defaults.enabled),",
	},
];

/** 把 settings.ts 打包成临时模块并 import（每次调用都拿全新模块）。 */
async function loadFresh() {
	const dir = await mkdtemp(join(tmpdir(), "acc-mut-"));
	const outfile = join(dir, "bundle.mjs");
	await build({
		entryPoints: [SOURCE],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		external: ["obsidian"],
		logLevel: "silent",
	});
	const shimDir = join(dir, "node_modules", "obsidian");
	await mkdir(shimDir, { recursive: true });
	await writeFile(
		join(shimDir, "package.json"),
		JSON.stringify({ name: "obsidian", version: "0", type: "module", main: "index.mjs", exports: "./index.mjs" })
	);
	await writeFile(
		join(shimDir, "index.mjs"),
		`export * from ${JSON.stringify(pathToFileURL(MOCK_OBSIDIAN).href)};\n`
	);
	// ⚠️ 查询串必须唯一：Node 按 URL 缓存模块，不加就会拿到上一次的实例
	const mod = await import(`${pathToFileURL(outfile).href}?mut=${Math.random()}`);
	await rm(dir, { recursive: true, force: true });
	return mod;
}

/** 跑套件，返回它是否**断言失败**（= 变异被抓住）。 */
async function suiteFails() {
	try {
		const mod = await loadFresh();
		runSettingsSuite(mod);
		return { caught: false, detail: "" };
	} catch (error) {
		const message = String(error?.message ?? error);
		return { caught: true, detail: message.split("\n")[0].slice(0, 92) };
	}
}

// 基线：未变异时必须通过 —— 否则下面的"抓住"毫无意义
const baseline = await suiteFails();
if (baseline.caught) {
	console.log("✗ 基线未通过：未变异时套件就失败了，先修实现或测试");
	console.log(`   ${baseline.detail}`);
	process.exit(1);
}
console.log("基线：未变异时套件通过 ✓");
console.log("");

let allCaught = true;
for (const m of MUTATIONS) {
	if (!original.includes(m.from)) {
		console.log(`✗ 变异点未找到（脚本需更新）：${m.name}`);
		console.log(`   期望源码含：${JSON.stringify(m.from.slice(0, 70))}`);
		allCaught = false;
		continue;
	}
	writeFileSync(SOURCE, original.replace(m.from, m.to));
	try {
		const { caught, detail } = await suiteFails();
		console.log(`${caught ? "✓ 抓住" : "✗ 漏过（测试无牙）"}  ${m.name}`);
		if (detail) console.log(`      ${detail}`);
		if (!caught) allCaught = false;
	} finally {
		writeFileSync(SOURCE, original);
	}
}

// 还原后必须仍然通过
const after = await suiteFails();
console.log("");
console.log(`还原后：${after.caught ? "★ 仍失败（源码未正确还原！）" : "套件通过 ✓"}`);
if (after.caught) allCaught = false;

console.log("");
console.log(allCaught ? `全部 ${MUTATIONS.length} 个变异均被捕获 —— 套件确实有牙齿` : "★ 存在漏过，需补断言");
process.exit(allCaught ? 0 : 1);
