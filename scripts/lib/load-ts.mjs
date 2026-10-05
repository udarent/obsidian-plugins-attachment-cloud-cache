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
 * ## 为什么用临时目录而不是改 tsconfig/esbuild 配置
 *
 * 垫片只在测试时存在，不污染构建产物与仓库；也不需要为测试改动生产配置。
 */

import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MOCK_OBSIDIAN = join(HERE, "mock-obsidian.mjs");

/**
 * 打包一个 TS 入口并 import 它。
 *
 * @param {string} entryPath  相对仓库根的路径，如 "src/settings.ts"
 * @param {() => Promise<void>} fn  在模块可用时调用，避免临时目录泄漏
 */
export async function withLoadedTs(entryPath, fn) {
	const dir = await mkdtemp(join(tmpdir(), "acc-load-"));
	try {
		const outfile = join(dir, "bundle.mjs");

		await build({
			entryPoints: [join(REPO_ROOT, entryPath)],
			outfile,
			bundle: true,
			format: "esm",
			platform: "node",
			target: "node18",
			// 宿主提供，运行时由下方垫片解析
			external: ["obsidian"],
			logLevel: "silent",
		});

		// 造 node_modules/obsidian 垫片，转发到唯一那份 mock
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
		await writeFile(
			join(shimDir, "index.mjs"),
			`export * from ${JSON.stringify(pathToFileURL(MOCK_OBSIDIAN).href)};\n`
		);

		const mod = await import(pathToFileURL(outfile).href);
		return await fn(mod);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** 同上，但不传回调 —— 需要跨多次 import 共享状态时用（调用方负责清理）。 */
export async function loadTs(entryPath) {
	const dir = await mkdtemp(join(tmpdir(), "acc-load-"));
	const outfile = join(dir, "bundle.mjs");

	await build({
		entryPoints: [join(REPO_ROOT, entryPath)],
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
		JSON.stringify(
			{ name: "obsidian", version: "0.0.0-mock", type: "module", main: "index.mjs", exports: "./index.mjs" },
			null,
			2
		)
	);
	await writeFile(
		join(shimDir, "index.mjs"),
		`export * from ${JSON.stringify(pathToFileURL(MOCK_OBSIDIAN).href)};\n`
	);

	const mod = await import(pathToFileURL(outfile).href);
	return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
