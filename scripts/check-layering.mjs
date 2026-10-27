/**
 * 门禁：**分层方向**（ACC-LLD C1 / ACC-HLD 的依赖矩阵）。
 *
 * ## 背景
 *
 * 分层单向是这套代码唯一的"结构性承诺"：`main → plugin → 领域 → 基础设施`。
 * 破一次不会报错，症状是以后某次改动牵动两头。2026-10-27 的合规审查就抓到一条真违规 ——
 * `ui/gallery-modal.ts` **值导入**了 `plugin/gallery-flow` 的 6 个函数，而依赖矩阵里
 * `ui → plugin` 是 ⛔。它这么写了很久，没有任何门禁发现，最后是靠手写扫描器查出来的。
 * ⇒ 判据必须机器化，否则下一次同样会**很自然地**再犯。
 *
 * ## 判据（照抄 ACC-HLD §3 的矩阵，不自创）
 *
 * 按**目录首段**分层，然后禁这几条：
 *
 * | # | 关系 | 依据 |
 * |---|---|---|
 * | R1 | 领域层（`core` `maintenance` `render` `s3` `cache` `gallery`）→ `plugin/` / `main.ts` | 领域层 → `plugin` / `main` ⛔ |
 * | R2 | `maintenance/` → `ui/` | `maintenance` → `ui` ⛔（执行层认识视图 ⇒ 第二份装配） |
 * | R3 | `ui/` → `plugin/` / `main.ts` | `ui` → `main` / `plugin` ⛔ —— **`import type` 放行** |
 * | R4 | 流程 ↔ 流程（`plugin/` 内互相 import） | 流程 ↔ 流程 ⛔（归位判断失效） |
 *
 * ⚠️ 只有 R3 有"类型除外"—— 矩阵只对 `ui` 写了那个例外。这里照抄，不加宽也不收紧。
 * `host/` / `editor/` 在矩阵里**没有**被禁止的方向，所以本门禁不管它们（别自己加戏）。
 *
 * ## 共享层（R4 的例外，由"归位判据"决定，不是拍脑袋）
 *
 * ACC-HLD 的归位判据：**被两条以上用的能力下沉到共享层**。所以 `plugin/` 里这几个
 * 虽然住在流程目录，按判据属于共享层、允许被别的流程 import：
 *
 * - `context.ts` —— 窄接口本身
 * - `notes-query.ts` / `shared-flows.ts` —— 矩阵点名的共享层
 * - `shared-bucket-flow.ts` —— 云端声明的读写与守卫，**被 3 条流程用**
 *   （`gallery-flow` / `migrate-flow` / `orphan-flow`）；名字里带 flow，实际是共享能力。
 *
 * ## 豁免（显式清单，不靠放宽判据）
 *
 * 真正做不到"归位"的个例写进 `EXEMPT`，每条都要有**理由**与**消除条件**。
 * 加一条豁免 = 明确承认这里分层没做到，而不是假装判据不适用。
 *
 * ## 为什么需要自证
 *
 * 判据是"路径段匹配"，很容易写成**永远匹配不上**（把 `plugin` 写成 `./plugin`、
 * 或拿 `plugin/context` 去比 `plugin/context.ts`）。那样门禁会**安静地全绿**。
 * `check-no-dev-doc-refs` 就烂过一次（清单只剩两个已删的旧名，一条都检查不到）。
 * ⇒ `FIXTURES` 每次先证明：每条规则认得出自己的样本，反例**不**被认出来。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO, "src");

/** 领域层：六个目录。 */
const DOMAIN = new Set(["core", "maintenance", "render", "s3", "cache", "gallery"]);

/** `plugin/` 里按"归位判据"属于共享层的文件（见文件头）。 */
const SHARED_PLUGIN = new Set(["context", "notes-query", "shared-flows", "shared-bucket-flow"]);

/** 显式豁免：每条都要能答出"为什么现在做不到"与"什么时候消掉"。 */
const EXEMPT = [
	{
		from: "plugin/gallery-flow.ts",
		to: "plugin/revert-flow.ts",
		why:
			"附件管理的「改为本地引用」要复用「把链接改回本地」那份纯逻辑 `revertLinksForKeys`。按归位判据它被两条流程用 ⇒ 该下沉；暂留原处是因为它紧挨着 `revertLinksToLocal` 的入口语义，拆开读不出全貌。",
		until: "下次改「改为本地引用」或「把链接改回本地」任一侧时，把 `revertLinksForKeys` 搬进 `shared-flows.ts`。",
	},
	{
		from: "plugin/upload-existing-flow.ts",
		to: "plugin/release-space-flow.ts",
		why:
			"两个入口（「上传全部附件」与「释放空间」）共用同一份**纯函数**清理计划 `planLocalCleanup`。它只有两个消费者，暂留原处；下沉到 `shared-flows.ts` 会把 `release-space-flow` 的断言与变异锚点整段搬动。",
		until: "下一次同时改这两条流程的功能时，把 `planLocalCleanup` 搬进 `shared-flows.ts`。",
	},
];

const RULE_TEXT = {
	R1: "领域层 → plugin/main",
	R2: "maintenance → ui",
	R3: "ui → plugin/main（值导入）",
	R4: "流程 ↔ 流程",
};

const posix = (p) => p.split(sep).join("/");
const fam = (rel) => (rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : rel);
const base = (rel) => (rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel);
const norm = (rel) => rel.replace(/\.ts$/, "");

/** 判据本体：给一条 import 语句的上下文，返回命中的规则号（或 null）。 */
function judge(fromRel, spec, isType) {
	if (!spec.startsWith(".")) return null; // 包名 / obsidian / node:* —— 不是内部分层
	const dir = dirname(join(SRC, fromRel));
	const target = posix(relative(SRC, join(dir, spec)));
	if (target.startsWith("..")) return null; // 跑到 src 外面去了，不归这条门禁管
	const from = fam(fromRel);
	const to = fam(target);
	const toBase = base(target);

	if (DOMAIN.has(from) && (to === "plugin" || norm(target) === "main")) return "R1";
	if (from === "maintenance" && to === "ui") return "R2";
	if (from === "ui" && (to === "plugin" || norm(target) === "main") && !isType) return "R3";
	if (from === "plugin" && to === "plugin" && target !== fromRel && !SHARED_PLUGIN.has(norm(toBase))) return "R4";
	return null;
}

/**
 * 判据自证：**每条规则必须认得出自己的样本**，反例必须**不**被认出。
 * 样本写成 {from, 语句, 期望规则号}，走的是同一个 `judge`，不另写一套判据。
 */
const FIXTURES = [
	// ── R1：领域层不许碰流程与装配 ──
	{ from: "maintenance/foo.ts", line: 'import { ctx } from "../plugin/context";', want: "R1" },
	{ from: "maintenance/foo.ts", line: 'import type { PluginContext } from "../plugin/context";', want: "R1" },
	{ from: "core/foo.ts", line: 'import { bar } from "../plugin/notes-query";', want: "R1" },
	{ from: "s3/foo.ts", line: 'import type Plugin from "../main";', want: "R1" },
	{ from: "gallery/foo.ts", line: 'import { modal } from "../ui/gallery-modal";', want: null },
	{ from: "maintenance/foo.ts", line: 'import { refs } from "./references";', want: null },
	// ── R2：执行层不认识视图 ──
	{ from: "maintenance/foo.ts", line: 'import { card } from "../ui/file-cards";', want: "R2" },
	{ from: "maintenance/foo.ts", line: 'import type { Card } from "../ui/file-cards";', want: "R2" },
	{ from: "maintenance/foo.ts", line: 'import { remove } from "../cache/index";', want: null },
	// ── R3：界面不许反向驱动编排（类型放行）──
	{ from: "ui/foo.ts", line: 'import { loadGallery } from "../plugin/gallery-flow";', want: "R3" },
	{ from: "ui/foo.ts", line: 'import type Plugin from "../main";', want: null },
	{ from: "ui/foo.ts", line: 'import type { PluginContext } from "../plugin/context";', want: null },
	{ from: "ui/foo.ts", line: 'import { t } from "../maintenance/delete-log";', want: null },
	// ── R4：流程之间不互相 import（共享层除外）──
	{ from: "plugin/upload-existing-flow.ts", line: 'import { a } from "./orphan-flow";', want: "R4" },
	{ from: "plugin/upload-existing-flow.ts", line: 'import { b } from "./shared-flows";', want: null },
	{ from: "plugin/gallery-flow.ts", line: 'import { c } from "./shared-bucket-flow";', want: null },
	{ from: "plugin/shared-flows.ts", line: 'import { d } from "./orphan-flow";', want: "R4" },
	{ from: "plugin/orphan-flow.ts", line: 'import { e } from "../maintenance/run";', want: null },
];

/** 从一行源码里取出 (spec, isType)；不是 import/export 语句就返回 null。 */
const IMP = /^\s*(?:import|export)\b([\s\S]*?)from\s*["']([^"']+)["']/;
const BARE = /^\s*import\s*["']([^"']+)["']/;

function parse(line) {
	const bare = BARE.exec(line);
	if (bare) return { spec: bare[1], isType: false };
	const m = IMP.exec(line);
	if (!m) return null;
	return { spec: m[2], isType: /^\s*type\b/.test(m[1]) };
}

// ── 自证 ──
const fixtureProblems = [];
for (const f of FIXTURES) {
	const parsed = parse(f.line);
	if (!parsed) {
		fixtureProblems.push(`样本解析不出 import：「${f.line}」`);
		continue;
	}
	const got = judge(f.from, parsed.spec, parsed.isType);
	if (got !== f.want) {
		fixtureProblems.push(`样本「${f.line}」（来自 ${f.from}）期望 ${f.want ?? "不报"}，实际 ${got ?? "不报"}`);
	}
}
if (fixtureProblems.length > 0) {
	console.error("✗ 门禁自证失败 —— 判据本身不准，先修它（不要放着它去判断仓库）：");
	for (const problem of fixtureProblems) console.error(`    ${problem}`);
	process.exit(1);
}

// ── 扫仓库 ──
const SKIP_DIRS = new Set([".git", "node_modules", "_verify", ".vscode", ".idea"]);

function listTs(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			out.push(...listTs(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

const exemptHits = new Map();
const problems = [];
const files = listTs(SRC);

for (const full of files) {
	const fromRel = posix(relative(SRC, full));
	const text = readFileSync(full, "utf8");
	text.split("\n").forEach((line, index) => {
		const parsed = parse(line);
		if (!parsed) return;
		const rule = judge(fromRel, parsed.spec, parsed.isType);
		if (!rule) return;

		const dir = dirname(join(SRC, fromRel));
		const target = posix(relative(SRC, join(dir, parsed.spec)));
		const exemption = EXEMPT.find((e) => norm(e.from) === norm(fromRel) && norm(e.to) === norm(target));
		if (exemption) {
			exemptHits.set(`${exemption.from}→${exemption.to}`, exemption);
			return;
		}
		problems.push({ file: fromRel, line: index + 1, rule, text: line.trim().slice(0, 110), target });
	});
}

// 豁免也要自证：写在清单里但实际已经不违规的，必须报出来（否则清单会腐烂）
const staleExempt = EXEMPT.filter((e) => !exemptHits.has(`${e.from}→${e.to}`));

if (problems.length > 0 || staleExempt.length > 0) {
	if (problems.length > 0) {
		console.error(`✗ 分层方向被破坏 ${problems.length} 处：`);
		for (const p of problems) {
			console.error(`    ${p.file}:${p.line}  [${p.rule} ${RULE_TEXT[p.rule]}]`);
			console.error(`      ${p.text}`);
			console.error(`      → 打到了 ${p.target}`);
		}
		console.error("");
		console.error("  改法：把动作**从装配点注入**（照 `ui/gallery-modal.ts` 的 `deps.flow`），或者把共享能力下沉到共享层。");
		console.error("  确实做不到 ⇒ 在 `EXEMPT` 里加一条，写清理由与消除条件（不是放宽判据）。");
	}
	if (staleExempt.length > 0) {
		console.error(`✗ 豁免清单里有 ${staleExempt.length} 条已经不再违规 —— 删掉它们（清单腐烂比没有清单更糟）：`);
		for (const e of staleExempt) console.error(`    ${e.from} → ${e.to}`);
	}
	process.exit(1);
}

console.log(
	`分层方向检查通过：${files.length} 个源文件，4 条规则（R1 领域→流程 / R2 维护→界面 / R3 界面→流程（值） / R4 流程↔流程）` +
		`，豁免 ${EXEMPT.length} 条（全部仍在生效），判据自证 ${FIXTURES.length} 条夹具全过。`
);
