import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		// Node 侧工具与测试，不是插件代码
		"scripts",
		"_verify",
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
	}
);
