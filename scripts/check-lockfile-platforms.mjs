/**
 * 门禁：`package-lock.json` 必须把**它自己声明的可选依赖**都记下来。
 *
 * ## 为什么要有这条
 *
 * 2026-10-08 首次推上 GitHub 后，`ci.yml` 在 ubuntu 上跑 `npm run build` **直接红**
 * （Node 20.x 与 22.x 都一样）。原因不是源码，是锁文件：它 315 个条目里**一个带
 * `os` / `cpu` 平台限制的都没有** —— 也就是说 `esbuild` 的那 23 个平台二进制包
 * （`@esbuild/linux-x64`、`@esbuild/darwin-arm64` …）**一个都没被锁进去**。
 * 而工作流用的是 `npm ci --ignore-scripts`：`ci` 严格照锁文件装、`--ignore-scripts`
 * 又跳过 esbuild 的 postinstall ⇒ 在 Linux 上根本没有可执行的 esbuild 二进制。
 * （本机一直是绿的，因为 Windows 上那个 `@esbuild/win32-x64` 恰好已经装在
 * `node_modules` 里了 —— 这是个**只在别人机器上炸**的缺陷。）
 *
 * ⭐ 根因值得记下来：**在有 `node_modules` 的目录里生成锁，npm 是按"已安装的树"写的**。
 * 实测：在装好依赖的 Windows 目录里跑 `npm install --package-lock-only`，它说
 * "up to date"、只留下 `win32-x64`；把 `package.json` 单独放到一个空目录里再跑，
 * 它才从 registry 解析出全部 23 个平台包。所以"修锁"必须**在没有 node_modules 的
 * 地方重算**，否则重算一万次也还是缺。
 *
 * ## 判据为什么是"可选依赖必须都在锁里"
 *
 * 平台二进制正是通过 `optionalDependencies` 分发的（esbuild、rollup 这类都是）。
 * 平台包被剪掉时，症状不是报错而是**静默少装**：`npm ci` 成功、构建时才炸。
 * 所以判据取"锁里每个条目声明的 `optionalDependencies`，都要在锁里有对应条目" ——
 * 不写死 esbuild，换打包器也照样管用。
 *
 * 准确度已实测：在**修好的**锁上缺失 0 条；在**坏掉的**那把上恰好报出 23 条。
 *
 * ## 这条护栏**不能**保证什么
 *
 * - 不保证**当前平台**的二进制真能装上 —— 那要真的装一次才知道（本机做到了，
 *   但 `npm ci` 在沙箱里会被批量删除保护拦下）。
 * - 不检查版本范围、不检查锁与 `package.json` 是否同步（后者 `npm ci` 自己会报）。
 * - **不能替代 CI 在真实 Linux 上跑一遍** —— 它是最便宜的预警，不是证明。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILE = join(REPO, "package-lock.json");

if (!existsSync(LOCKFILE)) {
	console.error("✗ 找不到 package-lock.json —— 这个仓库依赖锁文件保证可复现构建。");
	process.exit(1);
}

const lock = JSON.parse(readFileSync(LOCKFILE, "utf8"));
const entries = lock.packages ?? {};
const present = new Set(Object.keys(entries));

/** 缺失的「声明了却没记进锁里」的可选依赖。 */
const missing = [];
for (const [path, entry] of Object.entries(entries)) {
	for (const name of Object.keys(entry.optionalDependencies ?? {})) {
		const key = `node_modules/${name}`;
		if (!present.has(key)) {
			missing.push({ from: path === "" ? "(根包)" : path.replace(/^node_modules\//, ""), name });
		}
	}
}

const platformCount = Object.values(entries).filter((e) => e.os || e.cpu).length;

if (missing.length > 0) {
	console.error(`✗ 锁文件漏记了 ${missing.length} 个被声明的可选依赖：`);
	for (const item of missing) console.error(`    ${item.from} → ${item.name}`);
	console.error("");
	console.error("  后果：`npm ci` 会照锁装，于是这些包（多半是平台二进制）在**别的操作系统上**");
	console.error("  静默缺失 —— 本机的构建照样绿，只有当 CI 或别人在 Linux/macOS 上构建时才炸。");
	console.error("");
	console.error("  改法：**在没有 node_modules 的目录里**用同一个 package.json 重算锁，例如");
	console.error("      mkdir /tmp/relock && cp package.json .npmrc /tmp/relock/");
	console.error("      cd /tmp/relock && npm install --package-lock-only");
	console.error("      cp package-lock.json <仓库>/package-lock.json");
	console.error("  ⚠️ 不要在仓库里直接 `npm install --package-lock-only` —— 有 node_modules 时");
	console.error("     npm 按已安装的树写锁，会把其它平台的可选依赖再次剪掉。");
	console.error("");
	console.error(`  （当前锁里带 os/cpu 限制的条目：${platformCount} 个）`);
	process.exit(1);
}

const declared = Object.values(entries).reduce(
	(total, entry) => total + Object.keys(entry.optionalDependencies ?? {}).length,
	0
);

console.log(
	`锁文件可选依赖检查通过：${declared} 个被声明的可选依赖都在锁里，` +
		`其中带平台限制（os/cpu）的条目 ${platformCount} 个。`
);
