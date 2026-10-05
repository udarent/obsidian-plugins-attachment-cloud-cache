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
		// `docs/SCOPE.md` 把移动端列为 P0，并把技术约束写死为：
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
						message: `移动端没有 Node 内置模块。请改用 Obsidian 的 vault / adapter / requestUrl，或自带实现（见 docs/SCOPE.md 的移动端约束）。`,
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
	}
);
