/**
 * 一次性扫描：六类冗余 + 官方 guidelines 的可机检项。
 *
 * ⚠️ 它的职责是**给出候选**，不是下结论 —— 每个候选项都要人工核实。
 * 用完即删（点号开头，不会被 run-tests / check-mutate-files 当成正式文件）。
 *
 * 六类（前三类来自 dead-code-cleanup 技能，后三类是后补的）：
 *  1. 未引用的导出
 *  2. 废弃机制残留
 *  3. 重复实现（同名函数在多个文件）
 *  4. 未引用的文件
 *  5. 死导入（导入了但本文件没用）
 *  6. 只写不读的容器 / 无人读取的对象字段
 * 外加：未被任何代码引用的 i18n 文案键。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "src");

/** 递归列出目录下指定后缀的文件（仓库相对路径）。 */
function listFiles(dir, extension) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
		.map((entry) => relative(ROOT, join(entry.parentPath ?? dir, entry.name)).split(sep).join("/"))
		.sort();
}

const sources = listFiles(SRC, ".ts");
const scripts = listFiles(join(ROOT, "scripts"), ".mjs");
const docs = ["README.md", "docs/SCOPE.md"];
const allText = new Map();
for (const file of [...sources, ...scripts, ...docs]) {
	allText.set(file, readFileSync(join(ROOT, file), "utf8"));
}

/** 全仓（源码 + 脚本 + 文档）里某个名字出现了多少次。 */
function countEverywhere(name) {
	const pattern = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
	let total = 0;
	const where = [];
	for (const [file, text] of allText) {
		const hits = text.match(pattern)?.length ?? 0;
		if (hits > 0) {
			total += hits;
			where.push(`${file}:${hits}`);
		}
	}
	return { total, where };
}

console.log("═".repeat(72));
console.log("① 未引用的导出（全仓出现次数 ≤ 1 = 只有定义处）");
console.log("═".repeat(72));
{
	// 显式豁免「故意的公开面」：插件入口与类型索引。
	const NEVER_UNUSED = ["src/main.ts"];
	const reported = [];
	for (const file of sources) {
		const text = allText.get(file);
		const pattern = /^export (?:async )?(?:function|const|class|interface|type|enum) ([A-Za-z_$][\w$]*)/gm;
		for (const match of text.matchAll(pattern)) {
			const name = match[1];
			if (NEVER_UNUSED.includes(file)) continue;
			const { total, where } = countEverywhere(name);
			if (total <= 1) reported.push({ name, file, total, where });
		}
	}
	if (reported.length === 0) console.log("  （无）");
	for (const item of reported) console.log(`  ${item.name}  ← ${item.file}（全仓 ${item.total} 次）`);
}

console.log("");
console.log("═".repeat(72));
console.log("② 已废弃机制的残留（清单里的名字不该再出现）");
console.log("═".repeat(72));
{
	const DEPRECATED = [
		"deleteMode",
		"DeleteMode",
		"DELETE_MODES",
		"isDeleteMode",
		"usesSystemTrash",
		"deleteModeSuffix",
		"accessKeyIdRef",
		"SecretComponent",
		"cacheLayout",
		"localFileAction",
		"cacheEnabled",
		"flattenKeyForLayout",
		"restoreDraft",
	];
	for (const name of DEPRECATED) {
		const hits = [];
		for (const [file, text] of allText) {
			if (file.startsWith("docs/") || file === "README.md") continue; // 文档里记录"已删除"是正常的
			const lines = text.split("\n");
			lines.forEach((line, index) => {
				if (new RegExp(`\\b${name}\\b`).test(line)) hits.push(`${file}:${index + 1}`);
			});
		}
		console.log(`  ${name.padEnd(22)} ${hits.length === 0 ? "✓ 无残留" : `${hits.length} 处 → ${hits.slice(0, 3).join(", ")}`}`);
	}
}

console.log("");
console.log("═".repeat(72));
console.log("③ 重复实现：同名函数/常量在多个文件里各定义一份");
console.log("═".repeat(72));
{
	const defined = new Map();
	for (const file of [...sources, ...scripts]) {
		const text = allText.get(file);
		const pattern = /^(?:export )?(?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/gm;
		for (const match of text.matchAll(pattern)) {
			const name = match[1];
			if (name.length <= 2) continue; // 单双字母多半是局部变量
			if (!defined.has(name)) defined.set(name, []);
			defined.get(name).push(file);
		}
	}
	const dupes = [...defined].filter(([, files]) => files.length > 1);
	if (dupes.length === 0) console.log("  （无）");
	for (const [name, files] of dupes) console.log(`  ${name.padEnd(28)} ${files.join("  ")}`);
}

console.log("");
console.log("═".repeat(72));
console.log("④ 未被任何 import 引用的文件（入口与类型声明除外）");
console.log("═".repeat(72));
{
	const NEVER_UNUSED_FILES = ["src/main.ts"];
	const importText = [...allText.values()].join("\n");
	for (const file of sources) {
		if (NEVER_UNUSED_FILES.includes(file)) continue;
		const bare = file.replace(/^src\//, "").replace(/\.ts$/, "");
		const base = bare.split("/").pop();
		// 引用形式：`from "./xxx"` / `from "../yyy/xxx"` / `from "./xxx.js"`
		const referenced =
			importText.includes(`/${base}"`) ||
			importText.includes(`/${base}.js"`) ||
			importText.includes(`"./${base}"`) ||
			importText.includes(`"../${base}"`);
		if (!referenced) console.log(`  ⚠️ ${file}（找不到任何 import 指向它）`);
	}
	console.log("  （以上为空=每个源文件都被引用了）");
}

console.log("");
console.log("═".repeat(72));
console.log("⑤ 死导入：导入了但在本文件里从没被用到（词边界计数 ≤ 1）");
console.log("═".repeat(72));
{
	let found = 0;
	for (const file of [...sources, ...scripts]) {
		const text = allText.get(file);
		const importPattern = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+"[^"]+";?$/gm;
		for (const match of text.matchAll(importPattern)) {
			for (const raw of match[1].split(",")) {
				const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
				if (!name) continue;
				const body = text.replace(match[0], "");
				const used = body.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
				if (used === 0) {
					found += 1;
					console.log(`  ⚠️ ${file} 导入了 ${name} 但没用`);
				}
			}
		}
	}
	if (found === 0) console.log("  （无）");
}

console.log("");
console.log("═".repeat(72));
console.log("⑥ 只写不读的容器（有 add/set 但没有任何读取）");
console.log("═".repeat(72));
{
	let found = 0;
	for (const file of sources) {
		const text = allText.get(file);
		const pattern = /^(?:export )?const ([A-Za-z_$][\w$]*) = new (Map|Set|WeakMap|WeakSet)/gm;
		for (const match of text.matchAll(pattern)) {
			const name = match[1];
			const rest = text.replace(match[0], "");
			const reads =
				(rest.match(new RegExp(`\\b${name}\\.(get|has|size|values|entries|keys|forEach|find)\\b`, "g"))?.length ?? 0) +
				(rest.match(new RegExp(`for \\(const [^)]* of \\b${name}\\b`, "g"))?.length ?? 0);
			const writes = rest.match(new RegExp(`\\b${name}\\.(add|set|delete|clear)\\b`, "g"))?.length ?? 0;
			if (writes > 0 && reads === 0) {
				found += 1;
				console.log(`  ⚠️ ${file} 的 ${name}：写入 ${writes} 次、读取 0 次`);
			}
		}
	}
	if (found === 0) console.log("  （无）");
}

console.log("");
console.log("═".repeat(72));
console.log("⑦ i18n 文案键：没有任何代码引用的（动态拼接的键按前缀豁免）");
console.log("═".repeat(72));
{
	const i18n = readFileSync(join(SRC, "i18n.ts"), "utf8");
	const enBlock = i18n.slice(i18n.indexOf("\ten: {"), i18n.indexOf("\tzh: {"));
	const keys = [...enBlock.matchAll(/^\t\t([A-Za-z][\w]*):/gm)].map((m) => m[1]);
	// 动态拼接：`xxx_${kind}` 这类会把一整个前缀的键都构造出来
	const DYNAMIC_PREFIXES = ["testFail_", "hookFix", "external"];
	const code = [...sources].map((file) => allText.get(file)).join("\n");
	const orphans = keys.filter((key) => {
		if (DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))) return false;
		return !new RegExp(`["'\`]${key}["'\`]`).test(code);
	});
	console.log(`  共 ${keys.length} 个键，可疑 ${orphans.length} 个：`);
	for (const key of orphans) console.log(`    ⚠️ ${key}`);
}
