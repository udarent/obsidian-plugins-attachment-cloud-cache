/**
 * 守住 `minAppVersion` 的**依据**。
 *
 * `manifest.json` 的 `minAppVersion` 是一句对外承诺："在低到这个版本的 Obsidian 上，
 * 这个插件能跑。" 承诺错了的代价是不对称的：填高了只是少一部分用户；
 * **填低了会让老版本用户装得上、然后在运行时崩** —— 而且崩在他们身上，不在我们这里。
 *
 * 本项目把这句话从"推断"变成了"证明"，做法是：**把 `obsidian` 类型包精确钉在
 * 所声明的版本上**，于是 `tsc --noEmit`（`npm run build` 的一部分）就成了一道
 * 版本闸门 —— 只要有人用了比它更新的 API，编译立刻失败。
 * 实测有效：把类型钉在 1.11.4、调用 1.12.3 才有的 `DataAdapter.appendBinary`，
 * `tsc` 直接报 `Property 'appendBinary' does not exist on type 'DataAdapter'`。
 *
 * ⚠️ 但这道闸门有个**必须由本脚本堵住的漏洞**：它完全依赖"类型包**正好**钉在
 * `minAppVersion` 上"这件事。一旦 `npm update` 或某次 `npm i obsidian@latest`
 * 把类型包推到前方，闸门会**静默失效** —— 编译照样过，而 `minAppVersion`
 * 那句承诺已经不再有任何东西支撑了。这类"检查还在跑、但已经不检查任何东西"的
 * 失效，比没有检查更危险，所以这里显式校验三件事。
 *
 * 用法：node scripts/check-api-floor.mjs（由 `npm run check` 调用）
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const problems = [];
const check = (ok, message) => {
	if (!ok) problems.push(message);
};

/** 语义化版本比较（只用于 x.y.z）。 */
function compare(a, b) {
	const A = String(a).split(".").map(Number);
	const B = String(b).split(".").map(Number);
	for (let i = 0; i < 3; i += 1) {
		const x = A[i] ?? 0;
		const y = B[i] ?? 0;
		if (x !== y) return x - y;
	}
	return 0;
}

const manifest = readJson("manifest.json");
const pkg = readJson("package.json");
const declared = manifest.minAppVersion;
const spec = pkg.devDependencies?.obsidian;

// ---------- 1. 依赖声明必须是**精确**版本（不能有 ^ / ~ 范围） ----------
//
// 有范围前缀就等于允许装到前方去，闸门随时会失守。
check(
	typeof spec === "string" && /^\d+\.\d+\.\d+$/.test(spec),
	`package.json 的 devDependencies.obsidian 必须精确钉版（现在是 ${JSON.stringify(spec)}）。` +
		`带 ^ 或 ~ 会让 npm 装到更新的类型包上，于是 minAppVersion 的依据（编译闸门）静默失效。`
);

// ---------- 2. 声明的版本必须等于 minAppVersion ----------
check(
	spec === declared,
	`devDependencies.obsidian（${spec}）与 manifest.minAppVersion（${declared}）不一致。` +
		`二者必须相同 —— 前者是"用什么类型编译"，后者是"承诺支持到多老"，` +
		`只有相等才意味着"编译通过"对 minAppVersion 构成证明。`
);

// ---------- 3. 实际装上的类型包也必须等于它（防 node_modules 与 package.json 脱节） ----------
const installedPkg = join(ROOT, "node_modules", "obsidian", "package.json");
if (!existsSync(installedPkg)) {
	problems.push("node_modules/obsidian 不存在 —— 先运行 npm install（否则没有任何版本闸门）");
} else {
	const installed = JSON.parse(readFileSync(installedPkg, "utf8")).version;
	check(
		installed === declared,
		`实际安装的 obsidian 类型包是 ${installed}，但 minAppVersion 是 ${declared}。` +
			`请运行 npm install 让二者对齐，否则"编译通过"证明不了任何事。`
	);

	// ---------- 4. 类型包里的 @since 不得高于所声明版本 ----------
	//
	// 若类型包自称含有更新的 API，那么"用它编译通过"就不再能推出
	// "没有用到 minAppVersion 之后的东西"，闸门被削弱。这里把它显式挡住。
	const dts = join(ROOT, "node_modules", "obsidian", "obsidian.d.ts");
	if (existsSync(dts)) {
		const text = readFileSync(dts, "utf8");
		const marks = [...text.matchAll(/@since\s+(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
		const max = marks.reduce((acc, v) => (compare(v, acc) > 0 ? v : acc), "0.0.0");
		check(
			compare(max, declared) <= 0,
			`类型包 ${installed} 里存在 @since ${max} 的 API，高于 minAppVersion（${declared}）。` +
				`这说明类型包已经跑到前方，编译闸门不再能证明该 minAppVersion。`
		);
		if (marks.length === 0) {
			problems.push("obsidian.d.ts 里找不到任何 @since 标注 —— 闸门的前提不成立，请人工确认");
		}
	}
}

if (problems.length > 0) {
	console.error("minAppVersion 依据校验未通过：");
	for (const problem of problems) console.error(`  ✗ ${problem}`);
	process.exit(1);
}

console.log(
	`minAppVersion 依据校验通过：类型包精确钉在 ${declared}，` +
		`编译通过即证明未使用更高版本的 API`
);
