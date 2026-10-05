/**
 * 由 `npm version` 触发的版本同步脚本。
 *
 * npm 已经改好 `package.json` 并把新版本放进 `process.env.npm_package_version`，
 * 这里只负责把它同步到另外两处 —— **不自己算版本号**（那是 npm 的职责，
 * 自己算就要处理 pre-release、build metadata 等一堆规则，且容易与 npm 不一致）。
 */

import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("缺少 npm_package_version —— 本脚本只应由 `npm version` 调用");
	process.exit(1);
}

// ── manifest.json ──
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

// ── versions.json：记录"该版本要求的最低宿主版本"，供宿主判断能否加载 ──
let versions = {};
try {
	versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
	// 首次发布时还没有这个文件
}
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`版本已同步为 ${targetVersion}（minAppVersion ${minAppVersion}）`);
