import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		// Node 侧工具与测试，不是插件代码
		"scripts",
		// 工具链配置（Node 环境，不在 tsconfig 的 include 内）。
		// 让 eslint 去 lint 它自己的配置收益很低，反而要额外维护项目解析设置。
		"esbuild.config.mjs",
		"version-bump.mjs",
		"eslint.config.mts",
		// 生成物与非源码
		"main.js",
		"styles.css",
		"versions.json",
		"manifest.json",
		"package.json",
		"package-lock.json",
		"tsconfig.json",
	]),
	{
		languageOptions: {
			globals: {
				...js.configs.recommended.languageOptions?.globals,
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...obsidianmd.configs.recommended,
	{
		rules: {
			// 单引号在 Obsidian 官方配置里是首选，但本项目源码统一用制表符 + 双引号，
			// 与 .editorconfig 一致；这条交给编辑器与 format 负责，不在此处强制。
			"obsidianmd/ui/sentence-case": "off",
		},
	},
	{
		// ─────────────────────── 移动端安全门 ───────────────────────
		//
		// 本项目把「移动端可用」列为 P0，并把技术约束写死为：
		// **只使用两端都有的 API**。而 Node 内置模块与 Node 全局
		// 只在桌面端存在 —— 用了就"桌面全绿、手机上直接崩"，
		// 且类型系统看不出来（`@types/node` 让 `import fs from "fs"` 编译通过）。
		//
		// 所以这条约束必须由 lint 来守：它比注释与代码评审都可靠，
		// 而且报错信息能直接告诉后来的人"为什么不能用"。
		//
		// 注意：`scripts/`（测试与工具）在 globalIgnores 里 ——
		// 测试**应该**用 `node:crypto` 当独立 oracle，那是刻意的。
		files: ["src/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					paths: [
						"fs",
						"path",
						"os",
						"crypto",
						"http",
						"https",
						"zlib",
						"stream",
						"child_process",
						"worker_threads",
						"module",
						"process",
						"buffer",
						"util",
						"url",
						"assert",
					].map((name) => ({
						name,
						message: `移动端没有 Node 内置模块。请改用 Obsidian 的 vault / adapter / requestUrl，或自带一份实现 —— 本项目承诺移动端可用，平台分支不是可选项。`,
					})),
					patterns: [
						{
							group: ["node:*"],
							message:
								"移动端没有 Node 内置模块（含 node: 前缀）。请改用 Obsidian 的 vault / adapter / requestUrl，或自带实现。",
						},
					],
				},
			],
			"no-restricted-globals": [
				"error",
				{
					name: "Buffer",
					message: "Buffer 是 Node 全局，移动端不存在。请用 Uint8Array / TextEncoder / TextDecoder。",
				},
				{
					name: "process",
					message: "process 是 Node 全局，移动端不存在（平台判断请用 obsidian 的 Platform）。",
				},
				{
					name: "require",
					message: "require 在移动端不可用，且插件产物已是打包后的单文件，不需要动态 require。",
				},
				{
					name: "__dirname",
					message: "__dirname 是 Node 专有；插件里拿 vault 路径要用 adapter.getBasePath()，且它移动端不可用。",
				},
			],
		},
	},
	{
		// ─────────────────────── 缓存文件的删除方式 ───────────────────────
		//
		// 社区规范是"删文件一律走 `FileManager.trashFile()`，以尊重用户在 Obsidian
		// 里设的「删除即进回收站」"，`obsidianmd/prefer-file-manager-trash-file` 守的就是这条。
		// 这里**有意**提供另一条路：缓存副本可以直接删除。
		//
		// 因为这里删的不是用户的文件，而是**缓存副本**：笔记里存的始终是远端地址
		//（从未被改写），被删掉的副本下次看到那张图时会**自动重新下载** ——
		// 所以"能不能找回"由重新下载提供，不必依赖回收站。而回收站有一个用户会
		// 直接撞上的副作用：文件离开了 vault，磁盘空间却还占着 —— 于是
		// "设了缓存上限，磁盘还是满的"。上限本来就是为了解决空间问题，
		// 所以这一项交给用户选（默认「直接删除」），两种方式的取舍写在设置项描述里。
		//
		// ⚠️ 范围**刻意只放这一个文件**：全库只有 `maintenance/remove.ts` 决定"怎么删"，
		// 其余地方一律通过它。若哪天别处冒出 `vault.delete`，这条规则仍会报出来。
		files: ["src/maintenance/remove.ts"],
		rules: {
			"obsidianmd/prefer-file-manager-trash-file": "off",
		},
	}
);
