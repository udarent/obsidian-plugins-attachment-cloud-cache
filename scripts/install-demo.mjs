/**
 * 把构建产物同步进真机演示库（默认 `../ObsidianVault`）—— **开发脚本：不参与 CI、不参与门禁**。
 *
 * ## 为什么需要它（2026-10-13 加的）
 *
 * `esbuild.config.mjs` 只往**仓库根**写 `main.js`；演示库里的那份是**另存的副本**。
 * 于是「改完源码忘了拷」的后果是**静默的** —— 真机测试跑的其实是旧版，而界面看不出任何区别。
 * 这个脚本把这件事变成一条命令，并提供 `--check`：只比对、不写。
 *
 * ## 它只碰三个发布资产
 *
 * `main.js` / `manifest.json` / `styles.css`。
 * ⛔ **绝不碰** `data.json`（用户设置）与 `.cache-index.json`（索引）—— 那两个是**库的状态**，
 * 不是插件的产物，覆盖它们等于把测试现场清掉。
 *
 * ## 用法
 *
 *     node scripts/install-demo.mjs            # 同步（默认；只写有差异的文件）
 *     node scripts/install-demo.mjs --check    # 只比对：不一致时退出码 1，并列出哪几个
 *     OBSIDIAN_VAULT_DIR=<库的绝对路径> node scripts/install-demo.mjs
 *
 * 库路径的取法：环境变量 `OBSIDIAN_VAULT_DIR` 优先；否则按「仓库的同级目录 `../ObsidianVault`」
 * 找（本工作区的实际布局）。两处都找不到时**如实报错**，不会去猜别的路径。
 *
 * ⚠️ 宿主正在运行时，拷贝**不会**让插件重新加载 —— 要重载插件（或重启宿主）才生效。
 * ⚠️ 写文件走「临时文件 + rename」，避免宿主在半个文件上重载。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/** 插件的发布资产（顺序只影响打印）。 */
const ASSETS = ["main.js", "manifest.json", "styles.css"];

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

// ── 找库 ─────────────────────────────────────────────────────────
const override = process.env.OBSIDIAN_VAULT_DIR;
const vaultDir = override ? resolve(override) : resolve(REPO, "..", "ObsidianVault");
if (!existsSync(vaultDir) || !existsSync(join(vaultDir, ".obsidian"))) {
	fail(
		`找不到演示库：${vaultDir}\n` +
			`    库目录下必须有 .obsidian/。用 OBSIDIAN_VAULT_DIR=<路径> 指定别处；` +
			`本脚本不会去猜其它位置。`
	);
}

// ── 插件 id 从 manifest 读，不写死（改名时这里不用跟着改）──
const manifestPath = join(REPO, "manifest.json");
if (!existsSync(manifestPath)) fail(`缺少 ${manifestPath} —— 这是发布资产，仓库里本该有它`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (typeof manifest.id !== "string" || manifest.id.length === 0) {
	fail(`manifest.json 里没有可用的 id：${JSON.stringify(manifest.id)}`);
}
const destDir = join(vaultDir, ".obsidian", "plugins", manifest.id);

// ── 源文件必须在（否则是"还没构建"，不是"库不对"）──
const sources = [];
for (const name of ASSETS) {
	const file = join(REPO, name);
	if (!existsSync(file)) {
		fail(`缺少 ${file} —— 先跑 npm run build（这个脚本只搬产物，不负责构建）`);
	}
	sources.push({ name, file, hash: sha256(file), size: statSync(file).size });
}

// ── 比对 ─────────────────────────────────────────────────────────
const rows = sources.map((source) => {
	const target = join(destDir, source.name);
	const exists = existsSync(target);
	return { ...source, target, exists, destHash: exists ? sha256(target) : null };
});
const stale = rows.filter((row) => row.destHash !== row.hash);

if (CHECK) {
	const where = join(".obsidian", "plugins", manifest.id);
	console.log(`演示库 ${vaultDir}`);
	console.log(`  对照 ${where}/（${manifest.id} v${manifest.version}）`);
	for (const row of rows) {
		const mark = row.destHash === row.hash ? "✅ 一致" : row.exists ? "⚠️ 不一致" : "⛔ 缺失";
		console.log(`    ${mark}  ${row.name}  ${row.hash.slice(0, 12)}${row.exists ? "" : "（目标不存在）"}`);
	}
	if (stale.length > 0) {
		console.error(
			`\n✗ 演示库不是最新构建：${stale.map((row) => row.name).join("、")}` +
				`\n    同步：npm run install:demo（或 node scripts/install-demo.mjs）`
		);
		process.exit(1);
	}
	console.log("\n✅ 演示库与仓库构建一致 —— 真机测试跑的就是当前源码这一版。");
	process.exit(0);
}

// ── 同步（只写有差异的；临时文件 + rename）──────────────────────
mkdirSync(destDir, { recursive: true });
let written = 0;
for (const row of rows) {
	if (row.destHash === row.hash) continue;
	const tmp = `${row.target}.tmp-install-demo`;
	copyFileSync(row.file, tmp);
	renameSync(tmp, row.target);
	const after = sha256(row.target);
	if (after !== row.hash) {
		rmSync(tmp, { force: true });
		fail(`写入后校验不通过：${row.target}（写坏了，请重试）`);
	}
	written += 1;
	console.log(`  ${row.exists ? "更新" : "新增"}  ${row.name}  ${row.hash.slice(0, 12)}`);
}

const where = join(".obsidian", "plugins", manifest.id);
if (written === 0) {
	console.log(`演示库已是最新：${where}/ 三个文件与仓库构建逐字节一致（v${manifest.version}）。`);
} else {
	console.log(
		`已同步 ${written} 个文件 → ${where}/（${manifest.id} v${manifest.version}）。` +
			`\n⚠️ 宿主正在运行的话，要重载插件或重启宿主才会加载新版。`
	);
}
