/**
 * 校验 manifest.json 是否符合 Obsidian 的发布要求，并确认版本号各处一致。
 *
 * 为什么要有它（而不是靠 CI 或记忆）：
 * - 版本号散落在 package.json / manifest.json，不一致时宿主会认定
 *   「该版本不支持你的 Obsidian」并拒绝加载，且**不报错**。
 * - versions.json 记录每个已发布版本对应的最低宿主版本，漏登记会导致
 *   别人装不上。
 *
 * 用法：
 *   node scripts/check-manifest.mjs
 *       仓库内一致性检查（`npm run check` 使用）
 *   node scripts/check-manifest.mjs --expect-version <tag>
 *       额外校验 tag 与版本号相等 —— 发布工作流的闸门
 *   node scripts/check-manifest.mjs --skip-assets
 *       跳过构建产物检查（CI 在构建前跑时用）
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const argv = process.argv.slice(2);
const flagValue = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? undefined : argv[i + 1];
};
const expectedVersion = flagValue("--expect-version");
const skipAssets = argv.includes("--skip-assets");

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");

const problems = [];
const check = (ok, message) => {
	if (!ok) problems.push(message);
};

// ---------- 必填字段 ----------
for (const key of ["id", "name", "version", "minAppVersion", "description", "author"]) {
	check(Boolean(manifest[key]), `缺少必填字段：${key}`);
}

// ---------- id：小写字母、数字、连字符 ----------
check(/^[a-z0-9-]+$/.test(manifest.id || ""), `id 含非法字符：${manifest.id}`);

// ---------- version：x.y.z ----------
check(/^\d+\.\d+\.\d+$/.test(manifest.version || ""), `version 不是 x.y.z：${manifest.version}`);

// ---------- description ----------
const description = manifest.description ?? "";
check(description.length > 0, "description 为空");
check(description.length <= 250, `description 超长（${description.length} > 250）`);
check(description.trim() === description, "description 首尾有空白");
// 插件列表页已提供上下文，重复提及这两个词会被提交校验拦下
check(!/obsidian/i.test(description), 'description 不应包含 "Obsidian"');
check(!/\bplugin\b/i.test(description), 'description 不应包含 "plugin"');
// 注：**不检查**结尾标点。曾有说法称不得以句号结尾，实测官方示例
// 与 96% 的已上架插件都以句号结尾 —— 该限制不存在。

// ---------- 商标：显示名不得用 "Obsidian" ----------
check(!/obsidian/i.test(manifest.name || ""), `显示名不应含 "Obsidian" 商标：${manifest.name}`);

// ---------- 版本号一致 ----------
check(
	pkg.version === manifest.version,
	`package.json（${pkg.version}）与 manifest.json（${manifest.version}）版本不一致 —— 应通过 npm version 同步`
);

// ---------- versions.json（存在时校验） ----------
const versionsPath = join(ROOT, "versions.json");
if (existsSync(versionsPath)) {
	const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
	check(
		Object.prototype.hasOwnProperty.call(versions, manifest.version),
		`versions.json 未登记当前版本 ${manifest.version}`
	);
	check(
		versions[manifest.version] === manifest.minAppVersion,
		`versions.json 里 ${manifest.version} 的 minAppVersion 与 manifest.json（${manifest.minAppVersion}）不一致`
	);
}

// ---------- 发布闸门：tag 必须等于版本号 ----------
//
// 拦下"来源不明的 tag"。触发它的真实场景：release 工作流若对任意 tag 都触发，
// 一次 `git push --tags` 就可能用一个不匹配的 tag 发出错误版本的 release。
// 顺带这也是 Obsidian 自身规范：release tag 与 manifest version 完全相等（不带 v）。
if (expectedVersion !== undefined) {
	check(
		expectedVersion === manifest.version,
		`tag「${expectedVersion}」与 manifest.json 的 version「${manifest.version}」不一致。` +
			`Obsidian 要求二者完全相同；来源不明的 tag 不应发布，请删除该 tag。`
	);
	check(expectedVersion === pkg.version, `tag「${expectedVersion}」与 package.json 的 version 不一致`);
}

// ---------- 发布资产 ----------
if (!skipAssets) {
	for (const file of ["main.js", "styles.css"]) {
		check(existsSync(join(ROOT, file)), `缺少发布资产 ${file}（先运行 npm run build）`);
	}
}

if (problems.length > 0) {
	console.error("manifest 校验未通过：");
	for (const problem of problems) console.error(`  ✗ ${problem}`);
	process.exit(1);
}

const scope = expectedVersion === undefined ? "" : `，tag ${expectedVersion} 与版本号一致`;
console.log(`manifest 校验通过：${manifest.id} v${manifest.version}（minAppVersion ${manifest.minAppVersion}${scope}）`);
