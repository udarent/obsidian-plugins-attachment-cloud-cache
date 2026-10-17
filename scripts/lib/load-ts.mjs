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
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
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
 *
 * ## ⚠️ `reexportDefault`：`export *` **不含 default**
 *
 * 这是 ESM 的规范行为，不是 esbuild 的怪癖：`export * from "m"` 只转发**具名**导出。
 * 于是"默认导出型模块"（插件入口 `src/main.ts` 就是这样）用这种 barrel 打包后
 * **一个东西都拿不到** —— 症状是一句很难联想到原因的
 * `PluginClass is not a constructor`（拿到的是模块命名空间对象）。
 *
 * 所以需要 default 时在这里显式再导一次。做成**可选参数**而不是默认行为：
 * 给没有默认导出的模块加 `export { default }` 会让 esbuild 直接构建失败
 * （`No matching export`），那会波及全部既有套件。
 */
export async function bundleEntries(entries, outfile, options = {}) {
	const list = Array.isArray(entries) ? entries : [entries];
	if (list.length === 0) throw new Error("至少需要一个入口");

	const defaults = (options.reexportDefault ? (Array.isArray(options.reexportDefault) ? options.reexportDefault : [options.reexportDefault]) : [])
		.map((entry) => String(entry).replace(/\\/g, "/").replace(/\.ts$/, ""));

	// 用 stdin + resolveDir 而不是写一个临时 barrel 文件：少一次落盘，
	// 崩了也不会在仓库里留垃圾。resolveDir 设成仓库根，于是 `./src/...` 能解析。
	const contents = [
		// ⭐⭐ **照实补上宿主一定有的那个 CJS 全局**（2026-10-16）。
		//
		// 产物在宿主里跑的是 **CJS**，`require` 由宿主的模块系统提供；而这条加载器打的是
		// **ESM** —— 那个环境里**没有** `require`。`src/local-file.ts` 正是用
		// `require("node:fs/promises")` 取本机 fs（**动态 `import()` 在宿主的 `app://obsidian.md`
		// 原点下被 CORS 拒**，见那个函数的说明），于是这套里它会 `ReferenceError: require is not defined`。
		// ⇒ 补上它，让套件跑在与宿主一致的前提下。
		//
		// ⚠️ **只补 `require`**：宿主只保证这一个（产物里成片的 `require("obsidian")` 就是证据）。
		// `module` / `exports` 一概不补 —— 夹具**不许凭空多出真机没有的东西**。
		//（2026-10-16 的教训：验收夹具曾自己往 `module` 上挂 `require`，于是产品代码里那句
		// `module.require(...)` 在套件里跑得通、在真机上抛 `TypeError` ⇒ 用户看到"点击命令没有反应"，
		// 而全套测试是绿的。）
		'import { createRequire as __accCreateRequire } from "node:module";',
		"globalThis.require = __accCreateRequire(import.meta.url);",
		...list.map((entry) => `export * from ${JSON.stringify(`./${entry}`)};`),
		...defaults.map((entry) => `export { default } from ${JSON.stringify(`./${entry}`)};`),
	].join("\n");

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
/*
 * ⭐ **打包工作区：整个进程复用同一个临时目录。**
 *
 * 原先每次加载都 `mkdtemp` 建一个新目录、把 bundle 与垫片写进去、import 完再删。
 * 语义上没问题，但在这台机器上慢得离谱（2026-10-13 实测，同一个 bundle）：
 *
 *   · 每次新建目录 .............. 546 ms/次
 *   · 复用同一目录、只覆盖 bundle  16 ms/次   ← 34 倍
 *
 * 差额是 Windows 实时防护对**新目录里的新文件**的扫描 —— 它按路径缓存，
 * 所以只要文件路径不变（覆盖写入），就不再重复付出这笔钱。
 * 全套件 42 次加载、全量变异约 509 次加载，这就是"看起来每个套件都要 0.5 秒"的真相。
 *
 * 边界（为什么这样仍然安全）：
 *   · 目录**每进程一个**（`mkdtemp` 依旧唯一）⇒ 多个进程并行（变异并行跑、
 *     两个终端同时跑套件）不会互相踩；进程退出时尽力删掉。
 *   · 同进程内靠**唯一查询串**保证每次 import 都是全新实例 —— 这正是原先
 *     "换目录"买到的东西，而它与目录无关（Node 按 URL 缓存模块）。
 *   · 打包 + import **串行**：两者都写同一个 `bundle.mjs`，交错会互相覆盖。
 *     ⚠️ 回调 `fn` 在临界区**之外**执行，所以套件内部再调本函数不会自锁。
 */
let workspaceDir = null;
let workspaceShimWritten = false;
let workspaceQueue = Promise.resolve();
let bundleSeq = 0;

async function ensureWorkspace() {
	if (workspaceDir === null) {
		workspaceDir = await mkdtemp(join(tmpdir(), "acc-load-"));
		// 尽力清理即可：本身在系统临时目录里、路径唯一，删不掉也不影响正确性
		process.once("exit", () => {
			try {
				rmSync(workspaceDir, { recursive: true, force: true });
			} catch {
				/* 留给系统临时目录的清理机制 */
			}
		});
	}
	if (!workspaceShimWritten) {
		await writeObsidianShim(workspaceDir);
		workspaceShimWritten = true;
	}
	return workspaceDir;
}

/**
 * 打包入口并 import 出一个**全新实例**。
 *
 * ⚠️ 每次调用递增查询串是**正确性**要求、不是优化：Node 按 URL 缓存模块，
 * 复用实例会让"变异之后仍然通过"变成假的（跑的还是旧代码）。
 *
 * @param {string | string[]} entries 相对仓库根的路径（不带扩展名，见 `bundleEntries`）
 * @param {{ reexportDefault?: string | string[] }} [options] 透传给 `bundleEntries`
 */
export async function importFresh(entries, options = {}) {
	const task = async () => {
		const dir = await ensureWorkspace();
		const outfile = join(dir, "bundle.mjs");
		await bundleEntries(entries, outfile, options);
		bundleSeq += 1;
		return import(`${pathToFileURL(outfile).href}?bundle=${bundleSeq}`);
	};
	// 两个分支都接上：前一次失败不该卡住后一次
	const run = workspaceQueue.then(task, task);
	workspaceQueue = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

/**
 * 打包入口并 import 它，然后交给回调（回调返回后不再持有任何东西）。
 *
 * @param {string | string[]} entries 相对仓库根的路径，如 `["src/core/ingest", "src/s3/client"]`
 * @param {(mod: any) => Promise<any> | any} fn 模块可用时调用
 */
export async function withLoadedTs(entries, fn) {
	return fn(await importFresh(entries));
}

/**
 * 同上，但不传回调（`affected-map.mjs` 的入口提取器认得这个名字）。
 *
 * ⚠️ `cleanup` 自 2026-10-13 起是**空操作**：打包目录整进程共用、退出时统一删，
 * 所以"用完即删"不再成立（见上面那段）。保留这个形状只是不让调用方改签名。
 */
export async function loadTs(entries) {
	const mod = await importFresh(entries);
	return { mod, cleanup: () => undefined };
}
