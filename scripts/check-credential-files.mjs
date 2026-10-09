/**
 * 门禁：**凭据文件不得进仓库**。
 *
 * ## 为什么专门为它写一条
 *
 * 1.0.1 起设置页支持「从凭据文件导入」（MinIO 控制台建完访问密钥后点「下载凭据」
 * 给的就是那个 json）。于是仓库边上迟早会出现一个这样的文件 ——
 * 最自然的场景恰好是**开发时**：拿它配一次测试 vault、顺手放在仓库根目录。
 *
 * 而它里面有**明文秘密**。一旦被提交，后果与别的手滑不同：
 * 它不是"多了一个文件"，而是**秘密已经进了 git 历史** ——
 * 删掉提交也没用，只能去服务商那里**轮换密钥**。
 * 所以这条要在**提交之前**就响，而不是等 review 时有人凑巧看见。
 *
 * ## 两条判据，各自对应一种"改名了就漏"的情形
 *
 * ① **按名字** —— 各家几乎都用 `credentials.json` 这个名字。
 * ② **按形状** —— 有人把它改名成 `my-minio.json` 时，名字判据就瞎了；
 *    但内容判据仍然认得出来：一个**顶层同时带访问密钥与秘密访问密钥**的 JSON。
 *
 * ⚠️ ② 只对**能整体解析成 JSON** 的文件生效，且要求"访问键 + 秘密键"**同时**非空 ——
 * 于是测试夹具里那种写在 `.mjs` 字符串里的假凭据不会被误报
 *（那些文件整体不是 JSON）。宁可漏报也不能误报：一个会随机变红的门禁，
 * 红过几次假的之后，真红时人只会当成噪声。
 *
 * ## 扫描范围
 *
 * 工作树里**所有**文件（含被 `.gitignore` 忽略的）—— 因为"被忽略"并不等于安全：
 * `git add -f` 照样能把它提交进去，而更常见的情形是有人先放进仓库、
 * 打算"待会儿再删"。跳过 `.git` 与 `node_modules`（那里没有用户放的凭据）。
 *
 * ⚠️ 纯文件读取，不派生任何外部进程。
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** 不递归的目录。`.git` 里全是二进制对象，`node_modules` 不归用户管。 */
const SKIP_DIRS = new Set([".git", "node_modules"]);

/** 名字判据：`credentials.json` 及其常见变体。 */
const NAME_PATTERNS = [
	/(^|[-_.])credentials?\.json$/i,
	/(^|[-_.])secrets?\.json$/i,
	/(^|[-_.])access[-_.]?keys?\.json$/i,
	/(^|[-_.])mc-config\.json$/i,
];

/** 值判据用到的两族键名（与 `src/s3/credentials.ts` 认的那两族一致）。 */
const ACCESS_KEYS = ["accessKey", "accessKeyId", "access_key_id", "access_key"];
const SECRET_KEYS = ["secretKey", "secretAccessKey", "secret_key", "secret"];

/** 某个键是否存在且是**非空字符串**（空串 = 没填，不算凭据）。 */
function hasValue(record, keys) {
	return keys.some((key) => typeof record[key] === "string" && record[key].trim() !== "");
}

/** 六层目录就够（这个仓库的目录很浅，而深挖只会拖慢门禁）。 */
const MAX_DEPTH = 6;
/** 超过这个体积就不解析了：凭据文件都是几百字节，大 json 不可能是它。 */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

/** 递归收集候选文件（返回仓库相对路径）。 */
async function collect(dir, depth, out = []) {
	if (depth > MAX_DEPTH) return out;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await collect(full, depth + 1, out);
		} else if (entry.isFile()) {
			out.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
		}
	}
	return out;
}

const files = await collect(REPO_ROOT, 0);
const findings = [];

for (const file of files) {
	const name = basename(file);

	// ── ① 名字像凭据文件 ──
	const byName = NAME_PATTERNS.some((pattern) => pattern.test(name));

	// ── ② 内容像凭据文件（只在 .json 上做，且要两族键同时非空）──
	let byShape = false;
	if (name.toLowerCase().endsWith(".json")) {
		let text = null;
		try {
			const stat = await readFile(join(REPO_ROOT, file));
			if (stat.length <= MAX_PARSE_BYTES) text = stat.toString("utf8");
		} catch {
			text = null;
		}
		if (text !== null) {
			try {
				const parsed = JSON.parse(text);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					byShape = hasValue(parsed, ACCESS_KEYS) && hasValue(parsed, SECRET_KEYS);
				}
			} catch {
				// 不是合法 JSON ⇒ 不可能是凭据文件
			}
		}
	}

	if (byName || byShape) {
		findings.push({ file, why: [byName ? "名字" : null, byShape ? "内容" : null].filter(Boolean).join(" + ") });
	}
}

if (findings.length > 0) {
	console.error("✗ 仓库里出现了疑似**凭据文件**（里面有明文秘密，提交上去就等于泄露）：");
	for (const { file, why } of findings) console.error(`   · ${file}   （判据：${why}）`);
	console.error("");
	console.error("   处置：把它移到仓库**外**（例如你自己的下载目录），然后重新跑一次本检查。");
	console.error("   ⚠️ 若它已经进过提交，删掉文件是不够的 —— 秘密已在 git 历史里，");
	console.error("      必须去存储服务商那里**轮换那把密钥**。");
	process.exit(1);
}

console.log(`凭据文件检查通过（扫描 ${files.length} 个文件，没有疑似凭据文件）。`);
