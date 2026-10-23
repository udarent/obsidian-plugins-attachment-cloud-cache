/**
 * 门禁：**移动端能不能把这个插件加载起来**（D-79）。
 *
 * ## 为什么需要它
 *
 * `manifest.json` 写着 `isDesktopOnly: false` —— 那是对所有手机用户的**承诺**：
 * 插件能在 Obsidian Mobile 上安装并运行。而评审（2026-10-22）指出：这条承诺
 * **没有任何需求覆盖**，iOS 从未真机、Android 自 1.1.2 未回归。
 *
 * 没有真机的情况下，能**自动**守住的是这件事故的**根因**：移动端崩溃几乎只有一个来源 ——
 * **加载期碰到桌面专属的 Node 能力**。产物的格式是 CJS 单文件，esbuild 把 Node 内置模块
 * 列进 `external`，所以：
 *
 * - 顶层 `import "node:fs"`（或 `fs` / `path` / `os` / `crypto`）⇒ 手机端**加载插件时就抛错**。
 *   那不是"这个功能不可用"，而是**整个插件都装不上**（`src/local-file.ts` 的文件头记着这次事故）。
 * - `require("node:…")` 写在**函数体里**是允许的，但**只有**在平台判据之后调用才安全。
 * - `process` / `Buffer` / `__dirname` 同理：桌面有、手机没有。
 *
 * ## 四条判据（每条一个"曾经真出过事"的形状）
 *
 * 1. **顶层不许有 Node 内置模块的 import**（加载期就死）；
 * 2. `require(` 只允许出现在**白名单文件**里，且必须带理由（新增一处就要显式登记）；
 * 3. `process` / `Buffer` / `__dirname` / `__filename` 全库不许出现；
 * 4. **平台问题只有一处问** —— `Platform.` 只许出现在白名单文件里（本项目已有纪律：
 *    "谁去问平台"只能有一处，否则两处判据迟早分叉）。
 *
 * ⚠️ 这条门禁**证明不了**"移动端功能正常"（那要真机）。它证明的是**不会在加载期崩**，
 * 以及"桌面专属能力没有偷偷扩散"。`design.md` 的 R23 把这条边界写清楚了。
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SRC = join(REPO_ROOT, "src");

/** Node 内置模块：顶层 import 会让移动端**加载插件**时抛错。 */
const NODE_BUILTINS = new Set([
	"assert",
	"buffer",
	"child_process",
	"crypto",
	"events",
	"fs",
	"http",
	"https",
	"module",
	"net",
	"os",
	"path",
	"process",
	"stream",
	"url",
	"util",
	"zlib",
]);

/**
 * `require(` 的白名单：**文件 → 为什么它可以有**。
 *
 * ⚠️ 只登记一处（`local-file.ts` 的 `fsPromises`），而且它自己就写着三条真机教训。
 * 新加一条时请先问：这个能力有没有跨平台的替代（`app.vault` / `app.fileManager`）？
 * 没有的话，**调用点必须全部落在 `Platform.isDesktopApp` 之后**，并在文件头写清为什么。
 */
const REQUIRE_ALLOWED = new Map([
	[
		"local-file.ts",
		"读库外绝对路径（`file:///D:/…`）只能用 `node:fs`；只在桌面判据之后调用，且是函数体内 require（保移动端加载）",
	],
]);

/**
 * `Platform.` 的白名单：**文件 → 为什么它可以问平台**。
 *
 * ⚠️ 判据是"问平台"这件事只能有一处出答案，别处都收参数（见 `decideLocalFile` 的 `isDesktop`
 * 与 `PluginContext` 的同名字段）：两处各问一次，迟早出现"判定说桌面、执行按移动"。
 */
const PLATFORM_ALLOWED = new Map([
	["main.ts", "装配点：把 `Platform.isDesktopApp` / `resourcePathPrefix` 收成一个注入项交给插件上下文"],
	["core/external-cache.ts", "核心层兜底：装配点没注入 `isDesktop` 时问宿主（有套件钉住两条路一致）"],
]);

/**
 * 出现在任何地方都不对的全局。
 *
 * ⚠️ 用正则而不是子串：`ArrayBuffer.isView(...)` 里就藏着 `Buffer.`，
 * 而它**是**跨平台的标准 API（`core/external-cache.ts` 正在用）。
 * 子串匹配会把那句判成违规 —— 第一次跑就假红了一次。
 */
const FORBIDDEN_GLOBALS = [
	{ label: "process.", pattern: /\bprocess\./ },
	{ label: "Buffer.", pattern: /\bBuffer\./ },
	{ label: "__dirname", pattern: /\b__dirname\b/ },
	{ label: "__filename", pattern: /\b__filename\b/ },
];

const problems = [];
const notes = [];

/** 递归收集 `src/` 下的 .ts 文件（相对路径用 `/`，便于白名单写死）。 */
async function collectTs(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await collectTs(full)));
		else if (entry.name.endsWith(".ts")) out.push(full);
	}
	return out;
}

const files = (await collectTs(SRC)).sort();
if (files.length === 0) {
	console.error("✗ 没找到任何 src/*.ts —— 门禁的路径写错了（它现在什么都没检查）");
	process.exit(1);
}

/**
 * 只看**代码**，不看注释。
 *
 * ⚠️ 这不是为了省事：本项目的注释里大量引用 `require("node:fs")` / `Buffer` 这些**反例**
 * （"不能这么写"），扫注释会立刻假红一片。而"注释里能写、代码里不能写"正是这条门禁的本意。
 *
 * 处理顺序：先抹掉块注释，再抹掉行注释。⚠️ 行注释那条正则要求 `//` 前面是行首或空白，
 * 免得把 `http://` 当成注释起点（`src/s3/client.ts` 里有 URL 字面量）。
 */
function stripComments(text) {
	const withoutBlock = text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
	return withoutBlock
		.split("\n")
		.map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
		.join("\n");
}

/** 一行是不是**顶层** import（缩进为 0 且以 import 开头）。 */
const TOP_LEVEL_IMPORT = /^import\s[\s\S]*?from\s+["']([^"']+)["']/;
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["']/;

for (const file of files) {
	const rel = relative(SRC, file).split("\\").join("/");
	const code = stripComments(await readFile(file, "utf8"));
	const lines = code.split("\n");

	// ① 顶层 Node 内置 import
	lines.forEach((line, index) => {
		const match = TOP_LEVEL_IMPORT.exec(line) ?? SIDE_EFFECT_IMPORT.exec(line);
		if (!match) return;
		const spec = match[1];
		const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
		const isBuiltin = spec.startsWith("node:") || NODE_BUILTINS.has(bare);
		if (!isBuiltin) return;
		problems.push(
			`${rel}:${index + 1} 顶层 import 了 Node 内置模块 \`${spec}\` —— ` +
				"移动端**加载插件时**就会抛错（不是功能不可用，是整个插件装不上）。" +
				"改成「函数体内 + 平台判据之后 + 宿主作用域的 require」。"
		);
	});

	// ② require(
	if (code.includes("require(") && !REQUIRE_ALLOWED.has(rel)) {
		const line = lines.findIndex((text) => text.includes("require(")) + 1;
		problems.push(
			`${rel}:${line} 用了 \`require(\` —— 只有 ${[...REQUIRE_ALLOWED.keys()].join(" / ")} ` +
				"登记过（移动端没有 Node 内置模块）。要加新的一处，先在 `check-mobile-api.mjs` " +
				"的白名单里写清理由，并确认调用点全在平台判据之后。"
		);
	}

	// ③ 禁止的全局
	for (const forbidden of FORBIDDEN_GLOBALS) {
		const hit = lines.findIndex((text) => forbidden.pattern.test(text));
		if (hit >= 0) {
			problems.push(
				`${rel}:${hit + 1} 出现 \`${forbidden.label}\` —— 移动端没有它（桌面专属）。` +
					"用宿主 API（`app.vault` / `app.fileManager`）或把值从装配点传进来。"
			);
		}
	}

	// ④ 谁问平台
	if (code.includes("Platform.") && !PLATFORM_ALLOWED.has(rel)) {
		const line = lines.findIndex((text) => text.includes("Platform.")) + 1;
		problems.push(
			`${rel}:${line} 自己问了 \`Platform.\` —— 全库只允许 ${[...PLATFORM_ALLOWED.keys()].join(" / ")} 问，` +
				"其余地方请收参数（`decideLocalFile` 的 `isDesktop` / `PluginContext.isDesktop`）。" +
				"两处各问一次，迟早出现「判定说桌面、执行按移动」。"
		);
	}
}

// ⑤ manifest 的承诺与这份门禁**必须同时成立**
const manifest = JSON.parse(await readFile(join(REPO_ROOT, "manifest.json"), "utf8"));
if (typeof manifest.isDesktopOnly !== "boolean") {
	problems.push("manifest.json: `isDesktopOnly` 必须是布尔值（缺省会被当成 false ⇒ 对移动端许下承诺）");
}
notes.push(
	manifest.isDesktopOnly === false
		? "manifest 承诺移动端可用（isDesktopOnly: false）⇒ 本门禁守住「加载期不崩」与「桌面能力没有扩散」"
		: "manifest 声明 isDesktopOnly: true ⇒ 移动端不会安装本插件；本门禁仍然守住桌面能力不扩散"
);

if (problems.length > 0) {
	console.error(`\n✗ 移动端 API 门禁：${problems.length} 处`);
	for (const problem of problems) console.error(`  · ${problem}`);
	process.exit(1);
}

console.log(
	`Mobile API gate passed (${files.length} 个源文件：没有顶层 Node 内置 import；` +
		`\`require(\` 只在 ${REQUIRE_ALLOWED.size} 个登记过的文件里；` +
		`无 process/Buffer/__dirname；\`Platform.\` 只在 ${PLATFORM_ALLOWED.size} 处问。` +
		`${notes[0]})`
);
