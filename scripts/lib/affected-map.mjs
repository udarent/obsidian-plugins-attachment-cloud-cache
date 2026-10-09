/**
 * 「按改动圈定要跑哪些门禁」的映射逻辑（纯函数，可测）。
 *
 * ## 为什么需要它
 *
 * 全量门禁在这台机器上的耗时画像是**高度不均匀**的（2026-10-09 实测）：
 *
 *   · 9 个静态门禁                ≈ 2s
 *   · tsc + esbuild + eslint      ≈ 8s
 *   · 27 个轻量套件               ≈ 5.5s
 *   · ingest/transfer/download    ≈ 50s   （真盘真网）
 *   · 35 个变异脚本               ≈ 8.5min ← 真正的大头
 *
 * 「改了一行设置页文案，等 9 分钟门禁」就是这条曲线的日常。而套件与源码的
 * 对应关系其实**本来就写在代码里**：每个 test-*.mjs 用 `withLoadedTs([...])`
 * 声明自己的入口，每个 mutate-*.mjs 用 `source:`/`entries:` 声明变异对象 ——
 * 顺着 import 图求一遍传递闭包，就能精确回答「这次改动会影响哪些套件」。
 *
 * 所以这里**不维护任何手写的对应表**：映射每次都从源码现算，
 * 加新套件、新源文件、拆文件都不用回来改它。手写的表会漂移，现算的不会。
 *
 * ## 保守原则：圈不定就全量
 *
 * 这个工具存在的意义是省时间，但它的**任何一次误判**（该跑的没跑）都会
 * 悄悄削弱整套门禁。所以选择规则一律朝"多跑"方向倒：
 *
 *   · 改动落在任何套件的覆盖闭包外（新文件还没人引用、映射解析失败…）→ 全量；
 *   · 动的是工具链自身（本文件、运行器、tsconfig、esbuild 配置…）→ 全量；
 *   · 动的是**所有** bundle 都隐式依赖的库（load-ts / mock-obsidian / host-globals
 *     / mutate 运行器 —— 它们经垫片注入，import 图里看不见）→ 全量；
 *   · import 解析不出目标（改名改坏了）→ 全量。
 *
 * ## 测试与变异的圈定口径不同（实测校准过）
 *
 * **测试**按覆盖闭包选：改了 `src/s3/sigv4.ts`，所有 bundle 里含它的套件都可能
 * 行为改变，都该跑 —— 这是依赖变化的**发现**责任所在。
 *
 * **变异**只按「source 自身 + 套件库 + 脚本自身」选，不按闭包：变异脚本验证的是
 * 「套件能抓住 **source 这个文件**被改坏」，它的锚点是 source 里的字面片段、
 * `expect` 来自套件断言文本 —— source 的**依赖**变了两者都不受影响，
 * 而依赖引入的行为变化由上面的测试圈定负责发现。第一版按闭包选变异，
 * 实测改一次 sigv4 会触发 21/35 个变异脚本（≈8 分钟），等于没圈。
 *
 * 另有 `test-affected.mjs` 护栏守着映射本身：每个 src 文件必须被至少一个
 * 套件覆盖、每个脚本的入口声明必须能解析 —— 于是"全量兜底"在实践中
 * 永远不会被触发，它只是一道保险，不是常态路径。
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HERE, "..", ".."));

/** 统一成 posix 相对路径（仓库根为基准）—— 所有集合的键都用这个形状。 */
function rel(absPath) {
	return relative(REPO_ROOT, absPath).split("\\").join("/");
}

async function listFiles(dirAbs, prefix, predicate) {
	const out = [];
	for (const entry of await readdir(dirAbs, { withFileTypes: true })) {
		const abs = join(dirAbs, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(abs, `${prefix}${entry.name}/`, predicate)));
		else if (predicate(entry.name)) out.push(`${prefix}${entry.name}`);
	}
	return out.sort();
}

/** 提取源码里的相对 import/export-from 说明符（不含裸标识符如 "obsidian"）。 */
function relativeSpecifiers(text) {
	const specs = [];
	const patterns = [
		/(?:import|export)\s[^"'`]*?from\s*["'](\.[^"']+)["']/g,
		/import\s*["'](\.[^"']+)["']/g,
	];
	for (const pattern of patterns) {
		for (const match of text.matchAll(pattern)) specs.push(match[1]);
	}
	return specs;
}

/** 把相对说明符解析成仓库内的 posix 路径；解析不出返回 null。 */
function resolveSpecifier(fromRel, spec) {
	const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
	const candidates = base.endsWith(".ts") || base.endsWith(".mjs") || base.endsWith(".css")
		? [base]
		: [`${base}.ts`, `${base}/index.ts`, base];
	for (const candidate of candidates) {
		if (existsSync(join(REPO_ROOT, candidate))) return candidate;
	}
	return null;
}

/** 求 roots 在 graph 上的传递闭包（含 roots 自身）。 */
export function closureOf(graph, roots) {
	const seen = new Set();
	const queue = [...roots];
	while (queue.length > 0) {
		const node = queue.pop();
		if (seen.has(node)) continue;
		seen.add(node);
		for (const next of graph.get(node) ?? []) queue.push(next);
	}
	return seen;
}

/** 从 test-*.mjs 文本里提取 `withLoadedTs(...)` / `loadTs(...)` 声明的入口。 */
export function extractSuiteEntries(text) {
	const entries = [];
	const callPattern = /(?:withLoadedTs|loadTs)\(\s*(\[[\s\S]*?\]|"[^"]+")/g;
	for (const call of text.matchAll(callPattern)) {
		for (const literal of call[1].matchAll(/"([^"]+)"/g)) {
			if (literal[1].startsWith("src/")) entries.push(literal[1]);
		}
	}
	return entries;
}

/**
 * 测试脚本里**一切** `src/....ts` 字面量。
 *
 * 入口声明不是源码依赖的唯一形态：有的套件把源文件当**文本**读进来做静态守卫
 *（test-settings-ui 读 settings-tab.ts 查「游离文件控件」，test-remove 读
 * types/settings/ingest 查写法约定）。这类依赖 import 图里根本没有，
 * 漏掉就会出现"改了设置页结构，静态守卫却没跑"。
 *
 * 对策朴素但可靠：脚本里出现的每个 src 字面量都算一条依赖。
 * 方向上仍是"多选不遗漏"——注释里提一句路径最多让套件多跑一次，反过来才是漏。
 */
export function extractSrcLiterals(text) {
	const refs = new Set();
	for (const match of text.matchAll(/["'](src\/[^"']+\.ts)["']/g)) refs.add(match[1]);
	return [...refs];
}

/** 从 mutate-*.mjs 文本里提取 source / entries / reexportDefault。 */
export function extractMutationConfig(text) {
	const source = text.match(/source:\s*"([^"]+)"/)?.[1] ?? null;
	const pickList = (key) => {
		const match = text.match(new RegExp(`${key}:\\s*(\\[[\\s\\S]*?\\]|"[^"]+")`));
		if (!match) return [];
		return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith("src/"));
	};
	return { source, entries: pickList("entries"), reexportDefault: pickList("reexportDefault") };
}

/** 提取脚本对 ./lib/xxx.mjs（或 lib 内部的 ./xxx.mjs）的引用。 */
function extractLibRefs(text, fromRel) {
	const refs = [];
	for (const match of text.matchAll(/(?:from|import)\s*["'](\.[^"']+\.mjs)["']/g)) {
		const resolved = resolveSpecifier(fromRel, match[1]);
		if (resolved && resolved.startsWith("scripts/lib/")) refs.push(resolved);
	}
	return refs;
}

/** 入口规格（`src/core/ingest` / `src/s3/client.ts`）→ 实际文件路径。 */
function normalizeEntry(spec) {
	const base = spec.replace(/\.ts$/, "");
	for (const candidate of [`${base}.ts`, base]) {
		if (existsSync(join(REPO_ROOT, candidate))) return candidate;
	}
	return null;
}

/**
 * test-load-acceptance.mjs 测的是**真实构建产物** main.js，不经过
 * withLoadedTs，所以正则提不到入口 —— 但它的覆盖范围定义上就是
 * 「src/main.ts 的闭包」。在这里显式补上，并在护栏里钉死这条特例。
 */
const BUILT_PRODUCT_SUITES = new Map([["scripts/test-load-acceptance.mjs", ["src/main"]]]);

/**
 * 现算完整映射。返回：
 * {
 *   srcFiles: string[],
 *   tests: Map<testFile, { entries, libs, coverage }>,
 *   mutations: Map<mutFile, { source, entries, libs, coverage }>,
 *   unresolvedImports: [{ from, spec }],   // 非空 ⇒ 调用方应转全量
 * }
 */
export async function buildAffectedMap() {
	const srcFiles = await listFiles(join(REPO_ROOT, "src"), "src/", (name) => name.endsWith(".ts"));
	const scriptFiles = await listFiles(join(REPO_ROOT, "scripts"), "scripts/", (name) => name.endsWith(".mjs"));

	// ── src 依赖图 ──
	const srcGraph = new Map();
	const unresolvedImports = [];
	for (const file of srcFiles) {
		const text = await readFile(join(REPO_ROOT, file), "utf8");
		const edges = new Set();
		for (const spec of relativeSpecifiers(text)) {
			const resolved = resolveSpecifier(file, spec);
			if (resolved) edges.add(resolved);
			else unresolvedImports.push({ from: file, spec });
		}
		srcGraph.set(file, edges);
	}

	// ── lib 依赖图（套件实现库之间的引用）──
	const libFiles = scriptFiles.filter((f) => f.startsWith("scripts/lib/"));
	const libGraph = new Map();
	for (const file of libFiles) {
		const text = await readFile(join(REPO_ROOT, file), "utf8");
		libGraph.set(file, new Set(extractLibRefs(text, file)));
	}

	// ── 每个测试 / 变异脚本的覆盖闭包 ──
	const tests = new Map();
	const mutations = new Map();

	for (const file of scriptFiles) {
		if (file.startsWith("scripts/lib/")) continue;
		const text = await readFile(join(REPO_ROOT, file), "utf8");
		const libs = closureOf(libGraph, extractLibRefs(text, file));

		if (/^scripts\/test-[^/]+\.mjs$/.test(file)) {
			let entries = extractSuiteEntries(text);
			if (entries.length === 0 && BUILT_PRODUCT_SUITES.has(file)) {
				entries = BUILT_PRODUCT_SUITES.get(file);
			}
			// 打包入口 + 文本形态的静态守卫依赖（见 extractSrcLiterals 说明）
			const roots = [...entries, ...extractSrcLiterals(text)].map(normalizeEntry).filter(Boolean);
			tests.set(file, {
				entries,
				libs,
				coverage: new Set([...closureOf(srcGraph, roots), file, ...libs]),
				unresolvedEntries: entries.length - roots.length,
			});
		} else if (/^scripts\/mutate-[^/]+\.mjs$/.test(file)) {
			const config = extractMutationConfig(text);
			const entrySpecs = [...config.entries, ...config.reexportDefault];
			const roots = [
				...(config.source ? [normalizeEntry(config.source)] : []),
				...entrySpecs.map(normalizeEntry).filter(Boolean),
			].filter(Boolean);
			mutations.set(file, {
				source: config.source,
				sourceFile: config.source ? normalizeEntry(config.source) : null,
				entries: entrySpecs,
				libs,
				coverage: new Set([...closureOf(srcGraph, roots), file, ...libs]),
			});
		}
	}

	return { srcFiles, srcGraph, libGraph, tests, mutations, unresolvedImports };
}

/**
 * 改这些文件 = 工具链自身变了，任何"圈定"都可能是拿一把被动过的尺子量东西
 * ⇒ 一律全量。注意 scripts/lib/* 不在此列：它们的影响由 lib 依赖图精确算出
 *（改 mock-s3 只波及用到它的套件，改 mock-obsidian 则自然波及全部）。
 */
const FULL_RUN_TRIGGERS = new Set([
	"scripts/run-tests.mjs",
	"scripts/affected.mjs",
	"scripts/lib/affected-map.mjs",
	"esbuild.config.mjs",
	"tsconfig.json",
	"eslint.config.mts",
	"package.json",
	"package-lock.json",
	"version-bump.mjs",
	// 这四个库不进 import 图也能影响一切：load-ts 是所有测试的打包器，
	// mock-obsidian / host-globals 经垫片与全局注入进**每个** bundle，
	// mutate.mjs 是所有变异脚本的运行器。改了它们，"圈定"本身就不成立。
	"scripts/lib/load-ts.mjs",
	"scripts/lib/mock-obsidian.mjs",
	"scripts/lib/host-globals.mjs",
	"scripts/lib/mutate.mjs",
]);

/**
 * 按改动文件清单圈定要跑的套件与变异脚本。
 *
 * @param {string[]} changedFiles posix 相对路径（仓库根为基准）
 * @param {Awaited<ReturnType<typeof buildAffectedMap>>} map
 * @returns {{
 *   full: boolean, fullReasons: string[],
 *   tests: Map<string, string[]>,       // 套件 → 选中理由（逐项可见）
 *   mutations: Map<string, string[]>,
 *   notes: string[],                    // 没选中任何东西的改动，给读者一个交代
 * }}
 */
export function selectAffected(changedFiles, map) {
	const tests = new Map();
	const mutations = new Map();
	const fullReasons = [];
	const notes = [];

	const pick = (bucket, file, reason) => {
		if (!bucket.has(file)) bucket.set(file, []);
		const reasons = bucket.get(file);
		if (!reasons.includes(reason)) reasons.push(reason);
	};

	if (map.unresolvedImports.length > 0) {
		fullReasons.push(
			`有 ${map.unresolvedImports.length} 条 import 解析不出目标（疑似改名改坏），无法圈定：`
		);
		for (const item of map.unresolvedImports.slice(0, 5)) {
			fullReasons.push(`    ${item.from} → ${item.spec}`);
		}
	}

	for (const changed of changedFiles) {
		if (FULL_RUN_TRIGGERS.has(changed)) {
			fullReasons.push(`${changed} 是工具链自身 —— 尺子变了，全部重量`);
			continue;
		}
		if (map.tests.has(changed)) {
			pick(tests, changed, "测试脚本自身被修改");
			continue;
		}
		if (map.mutations.has(changed)) {
			pick(mutations, changed, "变异脚本自身被修改");
			continue;
		}

		let hit = 0;
		// 测试按覆盖闭包选（依赖变化由套件发现 —— 见文件头「圈定口径」）
		for (const [file, info] of map.tests) {
			if (info.coverage.has(changed)) {
				pick(tests, file, changed);
				hit++;
			}
		}
		// 变异只按「source 自身 + 套件库」选（脚本自身已在上面处理）
		for (const [file, info] of map.mutations) {
			if (info.sourceFile === changed || info.libs.has(changed)) {
				pick(mutations, file, changed);
				hit++;
			}
		}
		if (hit > 0) continue;

		if (changed.startsWith("src/")) {
			// 源码却不被任何套件覆盖 —— 护栏 test-affected.mjs 不许这种状态存在，
			// 真走到这里说明映射本身失效了，只能全量。
			fullReasons.push(`${changed} 不在任何套件的覆盖闭包里，无法圈定 ⇒ 全量`);
		} else if (/^scripts\/check-[^/]+\.mjs$/.test(changed)) {
			notes.push(`${changed}：静态门禁每次都全跑，改动即时生效，无需另选`);
		} else if (/^scripts\/(verify-[^/]+|obsidian-host)\.mjs$/.test(changed)) {
			notes.push(`${changed}：真机验证脚本，本地门禁不受影响`);
		} else if (changed.startsWith("scripts/lib/")) {
			notes.push(`${changed}：未被任何套件引用（新库文件？），不影响现有套件`);
		} else {
			notes.push(`${changed}：不在任何套件覆盖范围（文档/配置类改动）`);
		}
	}

	return { full: fullReasons.length > 0, fullReasons, tests, mutations, notes };
}
