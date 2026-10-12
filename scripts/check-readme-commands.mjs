/**
 * 门禁：README 的命令表必须与**实际注册的命令**对得上（双向）。
 *
 * ## 它抓的是什么（真实事故，2026-10-12）
 *
 * `clean-cache` 退役那一批改完之后，README 的命令表里**还挂着"清理未使用的缓存文件"**。
 * 用户照着表去命令面板里找 —— 找不到，因为那条命令已经不存在了。
 *
 * ⚠️ 这是**跨文件**的漂移，而当时没有任何判据：
 * · `check:readme` 明确只校**结构**（两半齐全、章节数一致），它的文件头就写着"不检查文义"；
 * · `check:i18n-keys` 只管"键有没有接线" —— 删掉的 `cmdCleanCache` 键它会因为**死键**报红，
 *   但它管不到 README 里那行**文本**。
 * ⇒ 表在 `README.md`、真相在 `src/main.ts` 的 `addCommand(...)`，两条文档各自都"自洽"，
 * 中间那层对应关系**没人看着**，漂移不会报错。
 *
 * ## 两个方向，各自对应一种失效
 *
 * ① **README 列了、插件没注册** → 用户按名字去找，找不到（上面那次事故）。
 * ② **插件注册了、README 没列** → 用户不知道有这条命令（发现性缺失，轻一些，但同样是漂移）。
 *
 * ## 判据为什么要求**逐字相同**（不做模糊/包含匹配）
 *
 * 用户拿到的路径是「在 README 里看到一个名字 ⇒ 去命令面板搜这个名字」，所以判据就是这两个
 * 字符串是否一致。**会误报的门禁比没有门禁更糟** —— 红过几次假的之后，真红时人只当成噪声
 *（这条纪律在本项目已经付过一次学费）。
 * 省略号形态不同（`…` vs `...`）这类差别**在消息里点出来**，方便一眼改掉，但**不放宽判据**。
 *
 * ## 它保证什么 / 不保证什么
 *
 * · 保证：**表里出现的名字都是真的，且真的名字都出现在表里**（中英两半各一遍）。
 * · 不保证：命令的**行为**是否与表里那句描述相符（那是人读一遍的事），也不校描述文案。
 *
 * ## 两道防线（缺一条它就是纸糊的）
 *
 * 1. **判据失效必须响亮地红**：任何"本该解析出东西却解析出空"（找不到命令表、
 *    抽不到 `addCommand`、某个 `addCommand` 没有 `name:`、查不到某个命令键的值）
 *    都直接报错，**不静默跳过**。
 * 2. **比对逻辑自带正反夹具**（每次运行都先跑，与 `check:notice-i18n` 同一规格）：
 *    上面第 1 条守的是"输入被改形"，守不住"**判据自己写反了**" ——
 *    一个把方向搞反、或把判据放宽成模糊匹配的比对会安静地全绿。所以比对被抽成
 *    纯函数 `compareCommands`，由 6 条夹具（一致 / 多一条 / 少一条 / 只差省略号 /
 *    空表 / 空注册）钉住；夹具红了就**直接失败**，绝不放它去判断 README。
 *
 * ⚠️ 纯文件读取，不派生任何子进程（本机 `spawnSync` 会间歇性 `EBUSY`）。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README_FILE = join(REPO, "README.md");
const MAIN_FILE = join(REPO, "src", "main.ts");
const I18N_FILE = join(REPO, "src", "i18n.ts");

/** 双语标记与各半的表头（命令表的第一列就是命令名）。 */
const MARKERS = { en: "<!-- lang:en -->", zh: "<!-- lang:zh -->" };
const TABLE_HEAD = { en: "| Command |", zh: "| 命令 |" };
const LOCALE_LABEL = { en: "英文", zh: "中文" };

/**
 * 名字**没走文案表**的命令：`id → 为什么可以不在核对范围内`。
 *
 * 默认空。真要用（例如某个命令名必须是固定英文字面量），**在这里写明理由** ——
 * 显式写下的例外会被人看见，悄悄跳过的那条不会。
 */
const ALLOWED_UNTRANSLATED = new Map();

// ────────────────────────────────────────────────────────────
// 纯判据：比对"README 列的名字"与"实际注册的名字"（两个方向）
//   ⚠️ 抽成纯函数是为了能被 `--self-test` 直接喂假数据 —— 见文件头"两道防线"。
// ────────────────────────────────────────────────────────────

/** 只在消息里用：把省略号形态/空白归一，用来判断"是不是只差这一点"。 */
const normalize = (text) => text.replace(/\.{2,}|…/g, "…").replace(/\s+/g, " ").trim();

/**
 * @param expected   `Map<名字, 文案键>` —— 实际注册的命令（本语言下的名字）
 * @param tableNames `Array<{name, line}>` —— README 命令表里列的名字
 * @param locale     "en" | "zh"（只影响消息措辞）
 * @returns          问题描述数组（空数组 = 一致）
 */
function compareCommands({ expected, tableNames, locale }) {
	const found = [];
	const listed = new Set(tableNames.map((row) => row.name));

	// ── 方向 ①：README 列了，但插件没注册 ──
	for (const row of tableNames) {
		if (expected.has(row.name)) continue;
		const near = [...expected.keys()].find((name) => normalize(name) === normalize(row.name));
		found.push(
			`README:${row.line}（${LOCALE_LABEL[locale]}命令表）列了「${row.name}」，` +
				"但插件里没有注册叫这个名字的命令 —— 用户按这个名字去命令面板里找，**找不到**。" +
				(near ? `（文案表里最接近的是「${near}」，只差省略号/空白形态 —— 多半是两处没抄成一样。）` : "") +
				"多半是某条命令已经退役或改名，而这张表没跟着改。"
		);
	}

	// ── 方向 ②：插件注册了，但 README 没列 ──
	for (const [name, key] of expected) {
		if (listed.has(name)) continue;
		found.push(
			`插件注册了命令 \`${key}\`（名字「${name}」），但 README 的${LOCALE_LABEL[locale]}命令表里**没有它** —— ` +
				"用户不知道有这条命令。要么补进表里，要么确认它是不是该退役了。"
		);
	}

	return found;
}

// ────────────────────────────────────────────────────────────
// 自证：**每次运行都先跑**（无开关 —— 与 `check:notice-i18n` 同一规格）
//   夹具只喂纯函数、不碰磁盘，所以它证明的是**判据本身**对不对：
//   把任一方向改瞎、或把判据放宽，这里立刻红，而不是安静地全绿。
// ────────────────────────────────────────────────────────────
const row = (name, line = 1) => ({ name, line });
const FIXTURES = [
	{
		name: "完全一致 ⇒ 不报问题",
		expected: new Map([["Show cache usage", "cmdAuditCache"]]),
		table: [row("Show cache usage")],
		want: 0,
		mustInclude: null,
	},
	{
		name: "① README 多列一条（命令已退役 / 改名）⇒ 报 1 条、且说的是「列了」",
		expected: new Map([["Show cache usage", "cmdAuditCache"]]),
		table: [row("Show cache usage"), row("Clean up unused cache files", 9)],
		want: 1,
		mustInclude: "列了",
	},
	{
		name: "② 插件注册了但 README 漏列 ⇒ 报 1 条、且说的是「没有它」",
		expected: new Map([
			["Show cache usage", "cmdAuditCache"],
			["Repair the local-copy index", "cmdRepairIndex"],
		]),
		table: [row("Show cache usage")],
		want: 1,
		mustInclude: "没有它",
	},
	{
		name: "只差省略号形态 ⇒ 照样报（判据不放宽），但消息点明「只差省略号」",
		expected: new Map([["Cache files from other sites…", "cmdPickExternal"]]),
		table: [row("Cache files from other sites...")],
		want: 2, // ① 表里这条不认；② 注册的那条在表里找不到
		mustInclude: "只差省略号",
	},
	{
		name: "README 表空了 ⇒ 每条注册命令都报（不许因为「表里没东西」就静默通过）",
		expected: new Map([["Show cache usage", "cmdAuditCache"]]),
		table: [],
		want: 1,
		mustInclude: "没有它",
	},
	{
		name: "一条命令都没注册 ⇒ 表里每条都报",
		expected: new Map(),
		table: [row("Ghost command", 3)],
		want: 1,
		mustInclude: "列了",
	},
];

const fixtureProblems = [];
for (const fixture of FIXTURES) {
	const found = compareCommands({ expected: fixture.expected, tableNames: fixture.table, locale: "en" });
	const countOk = found.length === fixture.want;
	const textOk = fixture.mustInclude === null || found.some((line) => line.includes(fixture.mustInclude));
	if (!countOk || !textOk) {
		fixtureProblems.push(
			`夹具「${fixture.name}」期望 ${fixture.want} 条` +
				`${fixture.mustInclude ? `、且含「${fixture.mustInclude}」` : ""}，实际 ${found.length} 条：` +
				JSON.stringify(found)
		);
	}
}
if (fixtureProblems.length > 0) {
	console.error("✗ 门禁自证失败 —— 判据本身不准，先修它（不要放着它去判断 README）：");
	for (const problem of fixtureProblems) console.error(`   · ${problem}`);
	process.exit(1);
}

// ════════════════════════════════════════════════════════════
// 以下是对真实仓库的检查
// ════════════════════════════════════════════════════════════

const problems = [];

function readFileOrDie(path, label) {
	if (!existsSync(path)) {
		console.error(`✗ 缺少 ${label}（${path}）—— 判据没法跑。`);
		process.exit(1);
	}
	return readFileSync(path, "utf8");
}

// ────────────────────────────────────────────────────────────
// 1. 真相 A：插件实际注册了哪些命令（src/main.ts）
//    ⚠️ 只认 `name: this.t("键")` 这一种写法：命令名必须来自文案表（R11 附则），
//      否则中英双语这一层就断了 —— 而那不是本门禁该默默放过的事。
// ────────────────────────────────────────────────────────────
const mainText = readFileOrDie(MAIN_FILE, "src/main.ts");

const ADD_COMMAND = "this.addCommand(";
const starts = [];
for (let at = mainText.indexOf(ADD_COMMAND); at !== -1; at = mainText.indexOf(ADD_COMMAND, at + 1)) {
	starts.push(at);
}

if (starts.length === 0) {
	console.error(`✗ ${MAIN_FILE} 里一条 \`${ADD_COMMAND}\` 都没找到 —— 判据失效了（不要让它静默通过）。`);
	process.exit(1);
}

/** 注册项：`{ line, id, key }`（`key` 为 null 表示名字不是从文案表取的）。 */
const registered = [];

for (const start of starts) {
	const line = mainText.slice(0, start).split("\n").length;
	const next = mainText.indexOf(ADD_COMMAND, start + ADD_COMMAND.length);
	// 一个 `addCommand({...})` 的范围：到下一个 addCommand，或到它自己的 `\t\t});` 为止。
	const slice = next === -1 ? mainText.slice(start) : mainText.slice(start, next);
	const close = slice.indexOf("\n\t\t});");
	const block = close === -1 ? slice : slice.slice(0, close);

	const idMatch = block.match(/\bid:\s*"([^"]+)"/);
	const nameMatch = block.match(/\bname:\s*([^,\n]+?),?\s*$/m) ?? block.match(/\bname:\s*([^,\n]+)/);

	if (!nameMatch) {
		console.error(
			`✗ ${MAIN_FILE}:${line} 的 \`${ADD_COMMAND}\` 里找不到 \`name:\` —— 判据失效了（不要让它静默通过）。`
		);
		process.exit(1);
	}

	const id = idMatch ? idMatch[1] : `（第 ${line} 行，没写 id）`;
	const raw = nameMatch[1].trim();
	const keyed = raw.match(/^this\.t\(\s*"([A-Za-z0-9_]+)"\s*\)$/);

	if (!keyed) {
		if (ALLOWED_UNTRANSLATED.has(id)) continue;
		problems.push(
			`${MAIN_FILE}:${line} 的命令（id \`${id}\`）名字不是从文案表取的（\`${raw}\`）—— ` +
				"本门禁没法核对它，而且写死的名字在英文界面下也是那一串。" +
				"要么改成 `this.t(\"键名\")`，要么在 ALLOWED_UNTRANSLATED 里写明为什么例外。"
		);
		continue;
	}

	registered.push({ line, id, key: keyed[1] });
}

if (registered.length === 0) {
	console.error("✗ 没抽到任何一条走文案表的命令 —— 判据失效了（不要让它静默通过）。");
	process.exit(1);
}

// ────────────────────────────────────────────────────────────
// 2. 真相 B：那些键在中英两种语言下各是什么名字（src/i18n.ts）
// ────────────────────────────────────────────────────────────
const i18nText = readFileOrDie(I18N_FILE, "src/i18n.ts");

/** 某个语言表里 `键 → 值`（只收单行写法 —— 命令名都是单行；抽不到会响亮报错）。 */
function entriesOf(locale) {
	const head = `\t${locale}: {`;
	const start = i18nText.indexOf(head);
	if (start < 0) throw new Error(`src/i18n.ts 里找不到 ${head}`);
	const end = i18nText.indexOf("\n\t},", start);
	if (end < 0) throw new Error(`src/i18n.ts 里 ${locale} 表没有找到结束行`);

	const map = new Map();
	// ⚠️ 缩进：表头 1 个 tab、键行 **2 个** tab（写成 3 个会得到"表里 0 个键"）。
	for (const m of i18nText
		.slice(start, end)
		.matchAll(/^\t\t([A-Za-z0-9_]+):\s*"((?:[^"\\]|\\.)*)"/gm)) {
		map.set(m[1], m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
	}
	if (map.size === 0) throw new Error(`src/i18n.ts 里 ${locale} 表一个键都没抽到 —— 判据失效了`);
	return map;
}

let localeTables;
try {
	localeTables = { en: entriesOf("en"), zh: entriesOf("zh") };
} catch (error) {
	console.error(`✗ 解析文案表失败：${error.message}`);
	process.exit(1);
}

/** `键 → 该语言下的名字`；某个键没写这一语言时响亮报错（那本身就是 R11 的问题）。 */
function nameOf(key, locale) {
	const table = localeTables[locale];
	if (!table.has(key)) {
		console.error(
			`✗ 命令 \`${key}\` 在文案表的**${LOCALE_LABEL[locale]}**里没有值 —— ` +
				"这条命令在那种界面下会显示成一串键名，本门禁也没法核对它。"
		);
		process.exit(1);
	}
	return table.get(key);
}

// ────────────────────────────────────────────────────────────
// 3. README 的命令表（中英两半各一份）
// ────────────────────────────────────────────────────────────
const readme = readFileOrDie(README_FILE, "README.md");

for (const [locale, marker] of Object.entries(MARKERS)) {
	if (!readme.includes(marker)) {
		console.error(`✗ README.md 里没有 ${marker} —— 本门禁要靠它切分两半。`);
		process.exit(1);
	}
}

const enAt = readme.indexOf(MARKERS.en);
const zhAt = readme.indexOf(MARKERS.zh);
if (enAt > zhAt) {
	console.error(`✗ README.md 里 ${MARKERS.en} 排在 ${MARKERS.zh} 之后 —— 本门禁按"英文在前"切分。`);
	process.exit(1);
}

const halves = {
	en: readme.slice(enAt + MARKERS.en.length, zhAt),
	zh: readme.slice(zhAt + MARKERS.zh.length),
};

/** 某半里"命令表"那一列的命令名（`{ name, line }`，line 是文件里的绝对行号）。 */
function commandNamesIn(locale) {
	const half = halves[locale];
	const halfStartLine = readme.slice(0, readme.indexOf(MARKERS[locale])).split("\n").length;
	const lines = half.split("\n");
	const headIndex = lines.findIndex((line) => line.trim().startsWith(TABLE_HEAD[locale]));

	if (headIndex < 0) {
		problems.push(
			`README 的**${LOCALE_LABEL[locale]}**半里找不到命令表` +
				`（表头应以 \`${TABLE_HEAD[locale]}\` 开头）—— 表被改形了，或者表头换了个写法。`
		);
		return [];
	}

	const names = [];
	for (let i = headIndex + 1; i < lines.length; i++) {
		// ⚠️ 先 trim 再判：文件是 LF 行尾（`.gitattributes` 的 `eol=lf`），
		//    但万一被别的工具改成 CRLF，`\r` 会被 trim 掉，判据不受影响。
		const line = lines[i].trim();
		if (!line.startsWith("|")) break;
		if (i === headIndex + 1) continue; // 分隔行 `| --- | --- |`
		const first = line.replace(/^\|/, "").replace(/\|$/, "").split("|")[0];
		const name = first.replace(/\*/g, "").trim();
		if (name === "") {
			problems.push(`${README_FILE}:${halfStartLine + i} 命令表里这一行的第一格是空的 —— 每一行都要写命令名。`);
			continue;
		}
		names.push({ name, line: halfStartLine + i });
	}

	if (names.length === 0) {
		problems.push(`README 的**${LOCALE_LABEL[locale]}**半命令表里一行命令都没有 —— 判据失效了（不要让它静默通过）。`);
	}
	return names;
}

const tables = { en: commandNamesIn("en"), zh: commandNamesIn("zh") };

for (const locale of ["en", "zh"]) {
	const expected = new Map(); // 名字 → 键
	for (const command of registered) expected.set(nameOf(command.key, locale), command.key);
	problems.push(...compareCommands({ expected, tableNames: tables[locale], locale }));
}

if (problems.length > 0) {
	console.error(`✗ README 命令表与注册命令不一致 ${problems.length} 处：`);
	for (const problem of problems) console.error(`    ${problem}`);
	console.error("");
	console.error("  怎么改：命令的**唯一真相**是 src/main.ts 里的 this.addCommand({ name: this.t(\"键\") })；");
	console.error("  README 两半的命令表都要与它对齐（中英各一遍），名字**逐字**抄过去。");
	console.error("  ⚠️ 这条检查只看\"名字在不在\"，看不出描述文案写得对不对 —— 别把它当文义保证。");
	process.exit(1);
}

console.log(
	`README 命令表与注册命令一致：插件注册 ${registered.length} 条，` +
		`README 英文半 ${tables.en.length} 条 / 中文半 ${tables.zh.length} 条，双向都有对应、名字逐字相同；` +
		`判据自证 ${FIXTURES.length} 条夹具全过。`
);
