import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const banner = `/*
GENERATED FILE — do not edit. Sources live in src/; see the repository README
for the build command. Any change made here will be overwritten on the next build.
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	// obsidian / electron / CodeMirror 由宿主提供，不打进产物；
	// Node 内置模块同理（用 node:module 自带的清单，省掉 builtin-modules 依赖）
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
