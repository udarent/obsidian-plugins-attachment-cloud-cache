/**
 * 门禁：面向用户的 README 是**一份双语文件**，且两种语言不许单边漂移。
 *
 * ## 为什么从"两份文件"改成"一份文件的两半"（2026-10-09）
 *
 * 原先有 `README.md` + `README.zh.md` 两份，护栏断言"两份都存在、互链、章节数一致"。
 * 但 **Obsidian 的插件市场页只读 `README.md` 这一个文件名、没有语言协商** ——
 * 从 `obsidian.asar` 反解出来的取件逻辑就是 `githubusercontent/<repo>/HEAD/README.md`
 *（文件名是硬编码字面量、分支固定 HEAD、零语言参数）⇒ `README.zh.md` **在 App 内永远不可达**，
 * 它只服务 GitHub 读者，却要额外维护一份随时可能漂移的文档。
 * ⇒ 合并成**一份双语文件**：插件市场页、GitHub、目录网页三条路都只看这一个文件。
 *
 * ## 现在守什么
 *
 * 1. `README.md` 里必须**同时有**中英两半，各由 `<!-- lang:en -->` / `<!-- lang:zh -->` 标出、
 *    各恰好一次（HTML 注释渲染后不可见，标记本身不影响阅读）；
 * 2. 两半的 `#` / `##` / `###` 数量必须**相同** —— 判据与旧护栏完全一样，
 *    只是对象从"两份文件"变成"一份文件的两半"，照样能抓住"整节缺失 / 只在一半里加了新节"；
 * 3. `README.zh.md` **如果存在，只能是"指路牌"**：非空行少、不含任何 `##`、必须链回 `README.md`
 *    ⇒ 有人把全文写回那里时立刻变红（那样漂移风险就回来了）。
 *    ⚠️ **该文件已于 2026-10-09 删除**：它 2026-10-07 才被创建（`42e9ffe`），仓库内已无人引用，
 *    指向它的外链最多只有 2 天历史 ⇒ 为一个几乎不存在的 404 风险维护第二份文档不划算。
 *    ⇒ 这条规则现在是**纯防御性**的：文件不存在时不触发，但**谁再用这个名字放一份全文
 *    （或让它长出 `##` 章节），照样会被抓住** —— 不要因为"文件没了"就把这条规则删掉。
 *
 * ## 仍然不保证什么（别把它当质量保证）
 *
 * - **不检查文义**：中文半写错一个数字、或整段翻错，它一点都看不出来。
 * - 不检查措辞是否对应、不检查表格行数。
 * 真正让两半一致的办法只有一个：**改一半时同时改另一半**，改完跑 `npm run check`。
 *
 * ⚠️ 实测（2026-10-07，还是"两份文件"那会儿）：准备中文版时才发现英文版里已有三处过时/自相矛盾。
 * 翻译一份错的原文等于把错误复制一份 —— 所以两半都要能被检查，但**检查替代不了人读一遍**。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const CANONICAL = "README.md";
const POINTER = "README.zh.md";
const MARKERS = { en: "<!-- lang:en -->", zh: "<!-- lang:zh -->" };

/** 指路牌的非空行上限：超过它说明有人把全文写回来了。 */
const POINTER_MAX_LINES = 12;

const problems = [];

function read(path) {
	const full = join(REPO, path);
	if (!existsSync(full)) return null;
	return readFileSync(full, "utf8");
}

/** 某个级别的标题数量（`## x` 不会被算成一级标题）。 */
function countHeadings(text, level) {
	const prefix = `${"#".repeat(level)} `;
	return text.split("\n").filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}#`)).length;
}

// ── README.md：一份双语文件 ──
const canonical = read(CANONICAL);

if (canonical === null) {
	problems.push(`缺少 ${CANONICAL}`);
} else {
	for (const [lang, marker] of Object.entries(MARKERS)) {
		const hits = canonical.split(marker).length - 1;
		if (hits !== 1) {
			problems.push(`${CANONICAL} 里 ${marker} 应恰好出现一次（实际 ${hits} 次）—— 中英两半各要一个。`);
		}
	}

	const enAt = canonical.indexOf(MARKERS.en);
	const zhAt = canonical.indexOf(MARKERS.zh);

	if (enAt >= 0 && zhAt >= 0 && enAt > zhAt) {
		problems.push(`${CANONICAL} 里 ${MARKERS.en} 必须排在 ${MARKERS.zh} 之前（英文在前）。`);
	} else if (enAt >= 0 && zhAt >= 0 && problems.length === 0) {
		const halves = {
			en: canonical.slice(enAt + MARKERS.en.length, zhAt),
			zh: canonical.slice(zhAt + MARKERS.zh.length),
		};

		for (const level of [1, 2, 3]) {
			const en = countHeadings(halves.en, level);
			const zh = countHeadings(halves.zh, level);
			if (en !== zh) {
				problems.push(
					`两半的章节数不一致：英文半有 ${en} 个 ${"#".repeat(level)} 标题，中文半有 ${zh} 个 —— ` +
						"多半只改了一半。"
				);
			}
		}
	}
}

// ── 两半都不得复述"自己是哪个版本" ──
//
// 为什么要有这条：README 描述的是**当前**插件，而"当前是哪个版本"的唯一来源是 `manifest.json`
// （Obsidian 自己就会显示它）。在 README 里再写一遍就是**第二份真相**，而它只会漂移 ——
// 实测：`Status: 1.0.0` 从 1.0.0 一直挂到 1.0.1 发布之后才被顺手改掉；
// 更早还有"设置项数""签名器行数"两个手写数字过期。⇒ 按本项目自己的判据：
// **宁可不显示，也不要显示一个可能不对的数字。**
//
// ⚠️ 只匹配"状态 / Status + 版本号"这种**自我描述**，不去禁止 README 里出现任何数字 ——
// 例如 “Requires Obsidian 1.13.0+” 说的是**宿主**版本，那个数字不随本插件漂移。
const SELF_VERSION_CLAIM = /(?:Status|状态)\s*[:：][^\n]{0,40}?\d+\.\d+\.\d+/;

if (canonical !== null) {
	const claim = canonical.split("\n").find((line) => SELF_VERSION_CLAIM.test(line));
	if (claim !== undefined) {
		problems.push(
			`${CANONICAL} 里又出现了"自己是哪个版本"的自我描述（${claim.trim().slice(0, 60)}…）—— ` +
				"版本号的唯一来源是 manifest.json，在这里复述它只会漂移。" +
				"请删掉版本号，只保留对“验证到什么程度”的说明。"
		);
	}
}

// ── README.zh.md：只允许是指路牌 ──
const pointer = read(POINTER);

if (pointer !== null) {
	const nonEmpty = pointer.split("\n").filter((line) => line.trim() !== "").length;

	if (nonEmpty > POINTER_MAX_LINES) {
		problems.push(
			`${POINTER} 有 ${nonEmpty} 行非空内容（上限 ${POINTER_MAX_LINES}）—— 它只允许是指路牌：` +
				`中文全文应当放在 ${CANONICAL} 的中文半里。`
		);
	}
	if (countHeadings(pointer, 2) > 0) {
		problems.push(`${POINTER} 里出现了 ## 标题 —— 它只允许是指路牌，不该有自己的章节。`);
	}
	if (!pointer.includes(CANONICAL)) {
		problems.push(`${POINTER} 里没有指向 ${CANONICAL} 的链接（读者找不到正文）。`);
	}
}

if (problems.length > 0) {
	console.error(`✗ README 双语检查未通过 ${problems.length} 处：`);
	for (const problem of problems) console.error(`    ${problem}`);
	console.error("");
	console.error("  改法：中英两半都在 README.md 里（各由 <!-- lang:en --> / <!-- lang:zh --> 标出），");
	console.error("  改一半就同时改另一半；README.zh.md 已删，别再拿这个名字放第二份文档。");
	console.error("  ⚠️ 这条检查只看**结构**，看不出文义 —— 别把它当翻译质量保证。");
	process.exit(1);
}

const zhHalf = canonical.slice(canonical.indexOf(MARKERS.zh) + MARKERS.zh.length);

console.log(
	`README 双语检查通过：${CANONICAL} 中英两半齐全、章节数一致` +
		`（各 ${countHeadings(zhHalf, 1)} 个一级 / ${countHeadings(zhHalf, 2)} 个二级）；` +
		`${POINTER} ${pointer === null ? "不存在" : "是指路牌"}。`
);
