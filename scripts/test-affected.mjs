import {
	buildAffectedMap,
	selectAffected,
	extractSuiteEntries,
	extractMutationConfig,
	extractSrcLiterals,
} from "./lib/affected-map.mjs";

/**
 * 「按改动圈定门禁」的护栏。
 *
 * `affected.mjs` 的价值是省时间，但它的任何一次**漏选**（该跑的没跑）都会
 * 悄悄削弱整套门禁 —— 而且漏选不会有任何报错，只表现为"最近都变快了"。
 * 所以这个护栏钉住两类东西：
 *
 * 1. **映射本身的完整性**：每个 src 文件都必须落在至少一个套件的覆盖闭包里，
 *    每个脚本的入口声明都必须能解析。任何一条破了，圈定就会静默漏掉一类改动。
 *    ⚠️ 这些断言是**结构事实**：加新源文件而不接套件、把套件改名而不改声明，
 *    都会在这里变红 —— 这正是它该有的反应，不要通过放宽断言来消红。
 *
 * 2. **圈定规则的方向感**：每条断言都同时写正向（必须选中）与反向（不许选中 /
 *    不许全量），防止"一律全选"这种退化成没有圈定的实现也能变绿。
 */

function assert(condition, message) {
	if (!condition) throw new Error(`✗ ${message}`);
}

// ── 解析器的单元断言（合成文本，不依赖仓库结构）──

const entries = extractSuiteEntries(`await withLoadedTs(
	[
		"src/core/ingest",
		"src/s3/client", // 行内注释不许绊倒解析
	],
	async (mod) => {});
await withLoadedTs("src/i18n.ts", (mod) => {});`);
assert(entries.length === 3 && entries.includes("src/i18n.ts"), `入口解析丢了：${JSON.stringify(entries)}`);

const config = extractMutationConfig(`await runMutations({
	source: "src/core/ingest.ts",
	entries: ["src/core/ingest", "src/s3/client"],
	reexportDefault: ["src/main"],
	mutations: [],
});`);
assert(config.source === "src/core/ingest.ts", `source 没解析出来：${JSON.stringify(config)}`);
assert(config.entries.length === 2 && config.reexportDefault[0] === "src/main", `entries 解析错了：${JSON.stringify(config)}`);

// 文本形态的静态守卫依赖必须被抓到（test-settings-ui / test-remove 就靠这个被圈定）
const literals = extractSrcLiterals(`const tab = read("src/ui/settings-tab.ts");
// 注释里提一句 "src/i18n.ts" 也算 —— 方向是"多选不遗漏"
const x = "scripts/lib/not-src.mjs";`);
assert(
	literals.includes("src/ui/settings-tab.ts") && literals.includes("src/i18n.ts") && !literals.some((l) => l.startsWith("scripts/")),
	`src 字面量提取错了：${JSON.stringify(literals)}`
);

// ── 真实仓库上的映射完整性 ──

const map = await buildAffectedMap();

assert(map.unresolvedImports.length === 0, `有 import 解析不出目标：${JSON.stringify(map.unresolvedImports.slice(0, 3))}`);
assert(map.tests.size > 0 && map.mutations.size > 0, "映射里一个套件/变异脚本都没有 —— 发现逻辑坏了");

for (const [file, info] of map.tests) {
	assert(info.entries.length > 0, `${file} 没有解析出任何入口（withLoadedTs/loadTs 声明或构建产物特例）`);
	assert(info.coverage.has(file), `${file} 的覆盖闭包不含它自己`);
}
// 构建产物套件的特例必须钉死：它不测 bundle 入口，测的是 main.js ⇒ 覆盖 = src/main 闭包
assert(
	map.tests.get("scripts/test-load-acceptance.mjs")?.entries.includes("src/main"),
	"test-load-acceptance 的覆盖范围必须显式钉成 src/main（它测的是构建产物，正则提不到入口）"
);

for (const [file, info] of map.mutations) {
	assert(info.sourceFile, `${file} 的 source 解析不出实际文件`);
	assert(info.coverage.has(info.sourceFile), `${file} 的覆盖闭包不含自己的 source`);
}

// ⭐ 每个 src 文件至少被一个套件覆盖 —— 否则改它就是圈定的盲区（会退成全量）
const uncovered = map.srcFiles.filter((f) => ![...map.tests.values()].some((info) => info.coverage.has(f)));
assert(uncovered.length === 0, `这些源文件没有任何套件覆盖，圈定对它们只能兜底全量：${uncovered.join("、")}`);

// ── 圈定规则的方向感（正向 + 反向一起写）──

const names = (setMap) => [...setMap.keys()].map((f) => f.replace(/^scripts\/(test|mutate)-/, "").replace(/\.mjs$/, "")).sort();

// ① 文本读取依赖：改设置页 ⇒ 必须选中读它做静态守卫的 settings-ui（import 图里没有这条边）
{
	const sel = selectAffected(["src/ui/settings-tab.ts"], map);
	assert(names(sel.tests).includes("settings-ui"), "改 settings-tab.ts 没选中 test-settings-ui —— 文本形态的静态守卫依赖丢了");
	assert(names(sel.tests).includes("load-acceptance"), "改 settings-tab.ts 没选中 test-load-acceptance —— main 闭包没算上");
	assert(!names(sel.tests).includes("sigv4"), "改设置页不该选中签名套件 —— 圈定漏成了全选");
	assert(!sel.full, "改一个设置页文件不该触发全量");
}

// ② 变异口径：改 sigv4 ⇒ 变异只选 source 是它的那一个（按闭包选会拖来 20+ 个，≈8 分钟）
{
	const sel = selectAffected(["src/s3/sigv4.ts"], map);
	assert(names(sel.mutations).join(",") === "sigv4", `改 sigv4.ts 的变异圈定应为 [sigv4]，实际：${names(sel.mutations).join(",")}`);
	assert(names(sel.tests).includes("sigv4") && names(sel.tests).includes("s3-client"), "改 sigv4.ts 必须选中签名与客户端套件");
}

// ③ 垫片依赖 import 图看不见：mock-obsidian 进每个 bundle ⇒ 必须全量
{
	const sel = selectAffected(["scripts/lib/mock-obsidian.mjs"], map);
	assert(sel.full, "改 mock-obsidian.mjs 必须触发全量 —— 它经垫片注入每个 bundle，import 图里看不见");
}

// ④ 图内库依赖：mock-s3 只波及用到它的套件（不全量，但必须选中 ingest）
{
	const sel = selectAffected(["scripts/lib/mock-s3.mjs"], map);
	assert(!sel.full, "改 mock-s3.mjs 不该触发全量 —— lib 图能精确算出波及面");
	assert(names(sel.tests).includes("ingest") && names(sel.mutations).includes("ingest"), "改 mock-s3.mjs 必须选中 ingest 的测试与变异");
}

// ⑤ 文档类改动：一个都不选、也不全量（静态门禁永远全跑，已覆盖 README 的风险）
{
	const sel = selectAffected(["README.md"], map);
	assert(sel.tests.size === 0 && sel.mutations.size === 0 && !sel.full, "改 README.md 不该选中任何套件/变异，也不该全量");
}

// ⑥ 工具链自身 ⇒ 全量（尺子变了不能拿它量东西）
{
	const sel = selectAffected(["package.json"], map);
	assert(sel.full, "改 package.json 必须触发全量（脚本定义就在里面）");
}

// ⑦ 圈不定的源码 ⇒ 全量兜底（保守方向：宁可多跑）
{
	const sel = selectAffected(["src/no-such-file.ts"], map);
	assert(sel.full, "改了映射外的 src 文件必须全量兜底");
}

// ⑧ 脚本自身改动 ⇒ 只选它自己（理由必须逐项可见，空理由等于没有信号）
{
	const sel = selectAffected(["scripts/test-sigv4.mjs"], map);
	assert(names(sel.tests).join(",") === "sigv4" && sel.mutations.size === 0, `改测试脚本自身应只选它自己：${names(sel.tests).join(",")}`);
	assert(sel.tests.get("scripts/test-sigv4.mjs").length > 0, "选中理由不能为空 —— 只汇总成一个布尔值的条件，失败时等于没有信号");
}

console.log(
	`Affected-map tests passed (${map.srcFiles.length} source files all covered; ` +
		`${map.tests.size} suites / ${map.mutations.size} mutation scripts mapped; ` +
		"selection rules verified in both directions: text-form static-guard dependencies are picked up, " +
		"mutation selection follows source-not-closure, shim-injected infra forces a full run, " +
		"docs select nothing, unmappable source falls back to full)."
);
