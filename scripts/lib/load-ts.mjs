/**
 * 把 TS 源码打包后动态 import —— 让 Node 里也能测 Obsidian 插件代码。
 *
 * ## 关键设计：obsidian mock 必须是**唯一一份**
 *
 * esbuild 把入口 bundle 成一个文件，`obsidian` 标为 external（由宿主提供）。
 * 于是产物里有 `import { TFile } from "obsidian"`，需要 Node 能解析这个裸标识符。
 *
 * ⚠️ 为什么不能直接把 mock 打包进去：那样**每个 bundle 各有一份 `TFile` 类**，
 * 而测试自己 `import { TFile }` 拿到的是另一份 →
 * `file instanceof TFile` **永远为 false**，表现为"所有文件判断都失效"，
 * 且不报错。这个坑很难定位，因为它看起来像业务逻辑写错了。
 *
 * 解法：在临时目录里造一个 `node_modules/obsidian/` 垫片，
 * 它**转发到同一个 mock 文件**（用 file:// URL 引用绝对路径）。
 * Node 按 URL 缓存模块 → 所有 bundle 与测试共享同一个副本。
 *
 * ## 多个入口必须打进**同一个** bundle
 *
 * ⚠️ 与上面同理，但更隐蔽：若把 `src/s3/client.ts` 与 `src/core/ingest.ts`
 * 分成两次 `build`，两边会**各带一份** `src/s3/errors.ts` 的副本，
 * 于是 `error instanceof S3Error` 在跨模块断言时**恒为 false** ——
 * 又是"看起来像业务逻辑写错了"的一类。
 *
 * 所以入口接受**数组**：多入口用 `stdin` barrel 合成一个 bundle，
 * 所有模块共享同一份实例。这比"要求每个人都记得别用 instanceof"可靠，
 * 因为它是结构性的。
 *
 * ## 为什么用临时目录而不是改 tsconfig/esbuild 配置
 *
 * 垫片只在测试时存在，不污染构建产物与仓库；也不需要为测试改动生产配置。
 */

import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installHostGlobals } from "./host-globals.mjs";

// 补齐宿主有、Node 没有的浏览器全局（如 window）。理由见该模块的说明。
installHostGlobals();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MOCK_OBSIDIAN = join(HERE, "mock-obsidian.mjs");

/** 造 `node_modules/obsidian` 垫片，转发到唯一那份 mock。 */
export async function writeObsidianShim(dir) {
	const shimDir = join(dir, "node_modules", "obsidian");
	await mkdir(shimDir, { recursive: true });
	await writeFile(
		join(shimDir, "package.json"),
		JSON.stringify(
			{ name: "obsidian", version: "0.0.0-mock", type: "module", main: "index.mjs", exports: "./index.mjs" },
			null,
			2
		)
	);
	await writeFile(join(shimDir, "index.mjs"), `export * from ${JSON.stringify(pathToFileURL(MOCK_OBSIDIAN).href)};\n`);
}

/**
 * 把一组入口合成一个 bundle（`stdin` + `resolveDir` 指向仓库根）。
 *
 * 导出它是为了让**变异验证**用同一套打包逻辑 —— 编排层的套件需要
 * `ingest` 与 `S3Client` 在同一个 bundle 里（否则 `instanceof` 跨副本恒为 false），
 * 若变异脚本自己再实现一遍打包，两边迟早分叉。
 */
export async function bundleEntries(entries, outfile) {
	const list = Array.isArray(entries) ? entries : [entries];
	if (list.length === 0) throw new Error("至少需要一个入口");

	// 用 stdin + resolveDir 而不是写一个临时 barrel 文件：少一次落盘，
	// 崩了也不会在仓库里留垃圾。resolveDir 设成仓库根，于是 `./src/...` 能解析。
	const contents = list.map((entry) => `export * from ${JSON.stringify(`./${entry}`)};`).join("\n");

	await build({
		stdin: { contents, resolveDir: REPO_ROOT, sourcefile: "acc-test-barrel.js", loader: "js" },
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		// 宿主提供，运行时由垫片解析
		external: ["obsidian"],
		logLevel: "silent",
	});
}

/**
 * 打包入口并 import 它。
 *
 * @param {string | string[]} entries 相对仓库根的路径，如 `["src/core/ingest", "src/s3/client"]`
 * @param {(mod: any) => Promise<any>} fn  模块可用时调用，避免临时目录泄漏
 */
export async function withLoadedTs(entries, fn) {
	const dir = await mkdtemp(join(tmpdir(), "acc-load-"));
	try {
		const outfile = join(dir, "bundle.mjs");
		await bundleEntries(entries, outfile);
		await writeObsidianShim(dir);
		return await fn(await import(pathToFileURL(outfile).href));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 同上，但不传回调 —— 需要跨多次 import 共享状态时用（调用方负责清理）。 */
export async function loadTs(entries) {
	const dir = await mkdtemp(join(tmpdir(), "acc-load-"));
	const outfile = join(dir, "bundle.mjs");
	await bundleEntries(entries, outfile);
	await writeObsidianShim(dir);
	const mod = await import(pathToFileURL(outfile).href);
	return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
