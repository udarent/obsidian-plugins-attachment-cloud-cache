/**
 * 引用扫描与链接改写：**纯文本处理**，不碰宿主。
 *
 * ## 两件必须做对的事
 *
 * 1. **找出"哪些缓存副本还有用"**（`keysInText`）：缓存清理必须知道
 *    哪些副本仍被笔记引用 —— 判错了要么误删有用的副本，要么永远清不干净。
 * 2. **批量上传时把笔记里的本地链接换成远端链接**（`planLinkRewrites`）：
 *    这是唯一会改动**用户笔记**的操作，改错的代价是笔记内容被破坏。
 *
 * ## ⚠️ 为什么用"扫描 + 精确替换"而不是正则一次性替换
 *
 * 笔记里的引用有四种写法，各自的边界不同：
 *
 * | 写法 | 注意 |
 * |---|---|
 * | `![[photo.png]]` | wikilink，**没有**扩展名也能指向同一文件 |
 * | `![[photo.png\|600]]` | 带显示尺寸/别名，`\|` 之后要保留 |
 * | `![[photo.png#page=2]]` | 带子路径，`#` 之后要保留 |
 * | `![alt](attachments/photo.png)` | 标准 Markdown，可带标题 |
 * | `![alt](<attachments/a b.png>)` | 含空格时用尖括号包起来 |
 *
 * 用一个正则通吃会漏掉后几种、或者把 `|600` 一起换掉（那就改坏了）。
 * 所以这里**先定位链接范围、再按结构拆分**。
 *
 * ## ⭐⭐ wikilink 换成远端 URL 时，必须**整条**换形态
 *
 * 只替换路径那一段会得到 `![[https://…/a.png]]` —— 而 **wiki 语法只解析库内文件**，
 * 那条链接在宿主里**根本不显示**（真机实测；`[[https://…]]` 同理，是死链）。
 * ⇒ 目标是**带 scheme 的 URL** 时，wikilink 一律整条改写成 Markdown 形态：
 *
 * | 原文 | 改写后 |
 * |---|---|
 * | `![[a.png]]` | `![a.png](url)` |
 * | `![[a.png\|600]]` | `![600](url)`（`\|` 之后那段落进 alt 位） |
 * | `![[a.png#page=2]]` | `![a.png](url#page=2)`（子路径拼进 URL） |
 * | `[[a.png]]` | `[a.png](url)`（原文没有 `!` 就不是嵌入） |
 *
 * 目标是**库内路径**时仍只换路径那一段 —— 形态是用户或宿主选的，我们不替他们改。
 */

import { PLAUSIBLE_EXTENSION } from "../vault-files";

/** 一处待替换的链接：`start`/`end` 是**路径部分**在原文中的下标（左闭右开）。 */
export interface LinkSpan {
	start: number;
	end: number;
	/** 原文里的路径（可能是 wikilink 的短名，也可能是相对路径）。 */
	raw: string;
	/** **整条**链接在原文中的下标 —— 换形态时要连 `!`、方括号、别名一起替掉。 */
	linkStart: number;
	linkEnd: number;
	kind: "wikilink" | "markdown";
	/** wikilink 的 `|` 之后那一段（别名或显示尺寸）；没有则为 `null`。 */
	alias: string | null;
	/** wikilink 的 `#` 之后那一段（子路径）；没有则为 `null`。 */
	subpath: string | null;
	/** 原文里有没有 `!` 前缀（wikilink 的"嵌入"）。 */
	embed: boolean;
}

/**
 * 找出文本里所有"可能指向库内文件"的链接的**路径段**位置。
 *
 * 只做定位，不判断该不该改（那是调用方的事，它才知道文件与 URL 的对应关系）。
 * 除路径段之外，这里也把"整条链接的范围"和 wikilink 的别名/子路径一起给出 ——
 * 因为换形态时必须连它们一起换（见文件头那条说明）。
 */
export function findLinkSpans(text: string): LinkSpan[] {
	const spans: LinkSpan[] = [];

	// ── wikilink: `![[path]]` / `![[path|alias]]` / `![[path#sub]]` ──
	const wiki = /!?\[\[([^\]\n]*)\]\]/g;
	for (const match of text.matchAll(wiki)) {
		const body = match[1];
		const at = match.index ?? 0;
		const bodyStart = at + match[0].indexOf("[[") + 2;
		// 路径在 `|` 与 `#` 之前（两者都在时取更靠前的那个）
		const hashAt = body.indexOf("#");
		const pipeAt = body.indexOf("|");
		const cuts = [hashAt, pipeAt].filter((index) => index >= 0);
		const raw = body.slice(0, cuts.length > 0 ? Math.min(...cuts) : body.length);
		if (!raw) continue;
		spans.push({
			start: bodyStart,
			end: bodyStart + raw.length,
			raw,
			linkStart: at,
			linkEnd: at + match[0].length,
			kind: "wikilink",
			alias: pipeAt === -1 ? null : body.slice(pipeAt + 1),
			subpath: hashAt === -1 ? null : body.slice(hashAt + 1, pipeAt > hashAt ? pipeAt : body.length),
			embed: match[0].startsWith("!"),
		});
	}

	// ── Markdown 链接/图片: `![alt](path "title")` / `![alt](<path with space>)` ──
	const md = /!?\[[^\]\n]*\]\(([^)\n]*)\)/g;
	for (const match of text.matchAll(md)) {
		const body = match[1];
		if (!body) continue;
		const at = match.index ?? 0;
		const bodyStart = at + match[0].indexOf("(") + 1;
		// 这几种写法里目标就是路径本身 ⇒ 只可能"只换路径那一段"，所以别名/子路径都是 null
		const base = {
			linkStart: at,
			linkEnd: at + match[0].length,
			kind: "markdown" as const,
			alias: null,
			subpath: null,
			embed: match[0].startsWith("!"),
		};

		// 尖括号形式：路径被 `<...>` 包住（含空格时 Markdown 规范允许这么写）
		if (body.startsWith("<")) {
			const close = body.indexOf(">");
			if (close <= 1) continue;
			spans.push({ ...base, start: bodyStart + 1, end: bodyStart + close, raw: body.slice(1, close) });
			continue;
		}

		// 标题在引号里：`path "title"` —— 只替换引号之前那一段
		const quote = firstIndexOf(body, [" ", '"', "'"]);
		const raw = quote === -1 ? body : body.slice(0, quote);
		if (!raw) continue;
		spans.push({ ...base, start: bodyStart, end: bodyStart + raw.length, raw });
	}

	// 按出现位置排序，便于调用方按顺序重建文本
	return spans.sort((a, b) => a.start - b.start);
}

function firstIndexOf(text: string, needles: string[]): number {
	let best = -1;
	for (const needle of needles) {
		const at = text.indexOf(needle);
		if (at === -1) continue;
		if (best === -1 || at < best) best = at;
	}
	return best;
}

/** 一条改写规则：把指向 `from`（vault 路径或短名）的链接改成 `to`。 */
export interface RewriteRule {
	from: string;
	to: string;
}

export interface RewritePlan {
	text: string;
	/** 实际替换了几处。 */
	count: number;
}

/**
 * 按规则改写文本里的链接。
 *
 * `from` 的匹配是**宽松**的：既认完整路径，也认"短名"（去掉目录与扩展名）。
 * 原因是同一个附件在笔记里常有两种写法 —— wikilink 写 `![[photo.png]]`、
 * Markdown 写 `![x](attachments/photo.png)` —— 而规则只给得出一种
 * （批量上传时我们知道的是文件的 vault 路径）。只认一种就会出现
 * "老图只搬了一半、另一半还指向本地"，而且不报错。
 *
 * ## ⭐ 改写**形态**的两条规则
 *
 * - 目标是**远端 URL** 且原文是 wikilink ⇒ **整条**换成 Markdown（URL 装不进 wikilink，
 *   表见文件头）—— 这条是修一个真实缺陷：以前产出 `![[https://…]]`，宿主根本不显示。
 * - 其余情况只换**路径那一段**，别名/尺寸/子路径/标题原样保留。
 *
 * ## ⚠️ 短名匹配必须处理**歧义**
 *
 * 两个不同目录下的同名文件（`a/photo.png` 与 `b/photo.png`）都在候选里时，
 * 一条 `![[photo.png]]` **无法判断**指的是哪一个。此时按短名匹配会把链接改成
 * **错的那张图** —— 比不改糟得多（笔记静默指向别的图）。
 * 所以歧义的短名被整体排除，只按完整路径匹配。
 */
export function planLinkRewrites(text: string, rules: readonly RewriteRule[]): RewritePlan {
	if (rules.length === 0) return { text, count: 0 };

	const resolve = buildResolver(rules);
	if (!resolve) return { text, count: 0 };

	const spans = findLinkSpans(text);
	if (spans.length === 0) return { text, count: 0 };

	let out = "";
	let cursor = 0;
	let count = 0;

	for (const span of spans) {
		// 上一条换形态时可能已经吃掉了这一条（防御：宁可跳过，也不要产出错位文本）
		if (span.start < cursor) continue;

		const replacement = resolve(span.raw);
		if (replacement === undefined) continue;

		if (span.kind === "wikilink" && hasScheme(replacement)) {
			// ⭐ URL 装不进 wikilink ⇒ 整条换形态（见文件头那张表）
			out += text.slice(cursor, span.linkStart) + wikilinkToMarkdown(span, replacement);
			cursor = span.linkEnd;
		} else {
			out += text.slice(cursor, span.start) + replacement;
			cursor = span.end;
		}
		count += 1;
	}

	if (count === 0) return { text, count: 0 };
	return { text: out + text.slice(cursor), count };
}

/**
 * 造一个"按规则查目标"的解析器（`planLinkRewrites` 与画布改写共用）。
 *
 * 抽出来是因为**两条路径必须用同一套匹配语义**：短名、去扩展名、同名歧义
 * 这三条规则若各写一遍，画布与笔记迟早会分叉（例如画布里认得出、笔记里认不出）。
 * 规则为空时返回 `null`（调用方据此短路，不做任何扫描）。
 */
function buildResolver(rules: readonly RewriteRule[]): ((raw: string) => string | undefined) | null {
	if (rules.length === 0) return null;

	const byPath = new Map<string, string>();
	const byName = new Map<string, string>();
	const ambiguous = new Set<string>();

	for (const rule of rules) {
		const full = normalizeLinkTarget(rule.from);
		if (!full) continue;
		byPath.set(full, rule.to);

		const name = baseNameOf(full);
		const seen = byName.get(name);
		if (seen !== undefined && seen !== rule.to) ambiguous.add(name);
		else byName.set(name, rule.to);
	}

	return (raw: string): string | undefined => {
		const full = normalizeLinkTarget(raw);
		if (!full) return undefined;

		const exact = byPath.get(full);
		if (exact !== undefined) return exact;

		const name = baseNameOf(full);
		if (ambiguous.has(name)) return undefined; // ⚠️ 同名歧义 → 宁可不改
		return byName.get(name);
	};
}

/**
 * 目标是不是"带 scheme 的绝对 URL"。
 *
 * 这条线决定改写**形态**：URL 装不进 wikilink（wiki 语法只解析库内文件），
 * 所以必须整条换成 Markdown；而库内路径两种写法都成立，就保持用户/宿主选的那一种。
 */
function hasScheme(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * 把一条 wikilink 改写成 Markdown 形态：`![[a.png|600]]` → `![600](https://…/a.png)`。
 *
 * ⚠️ 别名（`|` 之后）落在 **alt 位**：Markdown 没有"显示尺寸"这个概念，
 * 数字尺寸因此**不再影响渲染**，但文字不丢 —— 如实写进了发版说明。
 * 没有别名时用路径的最后一段（与宿主自己生成链接的写法一致）。
 */
function wikilinkToMarkdown(span: LinkSpan, url: string): string {
	const alias = (span.alias ?? "").trim();
	// alt 里出现 `]` 会把链接提前闭合，去掉（alt 是给人看的，不是数据）
	const alt = (alias === "" ? baseNameOf(span.raw) : alias).replace(/[[\]]/g, "");
	const target = span.subpath === null || span.subpath === "" ? url : `${url}#${span.subpath}`;
	return `${span.embed ? "!" : ""}[${alt}](${target})`;
}

/** 取路径的最后一段（目录名不参与短名匹配）。 */
function baseNameOf(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/**
 * 把链接目标归一化成可比较的形式。
 *
 * ⚠️ 去掉扩展名是**必须的**：wikilink 里 `photo` 与 `photo.png` 指同一个文件，
 * 而用户的笔迹里两种都可能有。不去掉就会漏改一半（表现为"有些图还指向本地"）。
 *
 * ⭐ 1.1.0 起剥的是**任意"像扩展名"的后缀**，而不是一份图片后缀白名单：
 * 当时那份白名单（`png|jpe?g|gif|…`）在"支持所有附件类型"之后必然漏 ——
 * 笔记里写 `[说明](report)`、而规则给的是 `report.pdf`，两边归一结果不同
 * ⇒ 匹配不上 ⇒ **这个附件永远不会被改写**（它就一直是本地路径），
 * 而且不报错。复用的正是 `vault-files.ts` 那条形状判据（纯字母数字、≤8 字符），
 * 于是 `report.pdf` 与 `report` 等价，而 `a.b/c`（目录里的点！）不会被误剥。
 */
export function normalizeLinkTarget(target: string): string {
	let value = String(target ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.?\//, "")
		.trim()
		.toLowerCase();

	// 只在**最后一段**里剥：目录名里的点（`notes.v2/photo`）不是扩展名。
	const slash = value.lastIndexOf("/");
	const dot = value.lastIndexOf(".");
	if (dot > slash + 1 && PLAUSIBLE_EXTENSION.test(value.slice(dot + 1))) {
		value = value.slice(0, dot);
	}
	return value;
}

/**
 * 从一段文本里取出所有"属于本存储"的对象 key。
 *
 * 用于"哪些缓存副本还被引用"。**只认本存储的 URL** —— 站外链接不是我们的 key。
 * `keyFromUrl` 由调用方注入（它是判定层的一部分，这里不重复实现）。
 */
export function keysInText(text: string, keyFromUrl: (url: string) => string | null): Set<string> {
	const keys = new Set<string>();
	if (typeof text !== "string" || text === "") return keys;

	// 只找 http(s) 的裸 URL：它在笔记里总是出现在 `](...)` 或尖括号里，
	// 截到空白/右括号/引号/尖括号为止。我们的 URL 是逐段百分号编码的，
	// 所以 `)` 只会是 Markdown 语法的一部分，不会属于 key（`()` 会被编成 `%28%29`）。
	for (const match of text.matchAll(/https?:\/\/[^\s)>"'`\]]+/gi)) {
		const key = keyFromUrl(match[0]);
		if (key) keys.add(key);
	}
	return keys;
}

// ─────────────────────────── 画布（.canvas） ───────────────────────────

/**
 * 画布改写的结果。
 *
 * 比文本改写多一个 `skipped`：画布是 JSON，值被 JSON 字符串规则包着，
 * 极端情况下（手写坏了的转义）解不开 —— 那时按原则④**跳过并报出**，
 * 而不是猜。这个计数让调用方能把"没能改"如实说给用户听。
 */
export interface CanvasRewritePlan {
	text: string;
	/** 实际改写的处数（两类节点合计）。 */
	count: number;
	/** 因为**解不开 JSON 字符串**而跳过的值个数（>0 时调用方要如实告知）。 */
	skipped: number;
}

export interface CanvasRewriteInput {
	/**
	 * **`text` 节点**里的链接规则：与写笔记是同一套（目标是远端 URL）。
	 *
	 * 画布文本支持 `![]()` / `![[]]`，所以那一部分与 `.md` **完全同规则**
	 * （见 `planLinkRewrites`），包括 wikilink 整条换形态那条。
	 */
	linkRules: readonly RewriteRule[];
	/**
	 * **`file` 节点**的规则：目标是**搬移后的本地路径**。
	 *
	 * ⚠️ 与 text 节点的区别不是实现细节，而是宿主的约束：
	 * 画布 `file` 字段**只能指向库内文件**，写成远端 URL 之后画布就找不到文件了
	 * （2026-10-09 用户指出的设计错误）。所以这里改的是"旧路径 → 新路径"，
	 * 新路径就是附件被搬进缓存目录之后的那个位置 —— 本设备直接显示，
	 * 副本缺失时由回退下载补回。
	 */
	fileRules: readonly RewriteRule[];
}

/**
 * 改写画布里的附件引用（`file` 节点 → 新本地路径；`text` 节点 → 远端 URL）。
 *
 * ## 为什么是"文本级精确替换"而不是 `JSON.parse` → `JSON.stringify`
 *
 * 后者会把**用户没让我们碰的一切**重新排版：键的顺序、缩进、空行、
 * 数字的写法（`1.0` → `1`）……而画布文件是用户的数据，宿主自己也会写它。
 * 更实际的理由是实测教训：文件恢复快照证明"看着一样"与"逐字节一样"是两回事，
 * 而我们的承诺是**只动该动的那几个值**。
 *
 * ## 匹配哪些位置
 *
 * 只认画布里两个键：`"file"`（file 节点）与 `"text"`（text 节点）。
 * 做法是先把它们的**值范围**找出来（按 JSON 字符串规则，支持转义），
 * 用 `JSON.parse` 解出真实字符串，改写后再 `JSON.stringify` 编码回去 ——
 * 所以含 `"` / `\` / 换行的路径也不会写坏。
 *
 * ⚠️ 两类规则**都要跑**，而且不互斥：同一个附件完全可能一边被 file 节点摆着、
 * 一边被 text 节点里的链接引用（两种写法同时存在是常态）。
 */
export function planCanvasRewrites(text: string, input: CanvasRewriteInput): CanvasRewritePlan {
	if (typeof text !== "string" || text === "") return { text, count: 0, skipped: 0 };

	const resolveLink = buildResolver(input.linkRules);
	const resolveFile = buildResolver(input.fileRules);
	if (!resolveLink && !resolveFile) return { text, count: 0, skipped: 0 };

	interface Edit {
		start: number;
		end: number;
		next: string;
	}
	const edits: Edit[] = [];
	let skipped = 0;

	const collect = (key: string, rewrite: (value: string) => string | null): void => {
		for (const span of jsonStringSpans(text, key)) {
			let decoded: string;
			try {
				decoded = JSON.parse(`"${span.escaped}"`) as string;
			} catch {
				// 手写坏了的转义：按原则④跳过并报出，绝不猜
				skipped += 1;
				continue;
			}
			const next = rewrite(decoded);
			if (next === null || next === decoded) continue;
			edits.push({ start: span.start, end: span.end, next: encodeJsonString(next) });
		}
	};

	if (resolveFile) {
		collect("file", (value) => {
			const target = resolveFile(value);
			return target === undefined ? null : target;
		});
	}
	if (resolveLink) {
		collect("text", (value) => {
			const plan = planLinkRewrites(value, input.linkRules);
			return plan.count > 0 ? plan.text : null;
		});
	}

	if (edits.length === 0) return { text, count: 0, skipped };

	// 按位置排序后重建：`collect` 的两次遍历各按出现顺序，合并后要再排一次。
	edits.sort((a, b) => a.start - b.start);

	let out = "";
	let cursor = 0;
	let count = 0;
	for (const edit of edits) {
		if (edit.start < cursor) continue; // 防御：重叠时宁可跳过，也不要产出错位文本
		out += text.slice(cursor, edit.start) + edit.next;
		cursor = edit.end;
		count += 1;
	}
	return { text: out + text.slice(cursor), count, skipped };
}

/** JSON 字符串值在原文里的范围（`start`/`end` 指**两个引号之间**的内容）。 */
interface JsonStringSpan {
	start: number;
	end: number;
	/** 原文里那段**转义后**的内容（还没解码）。 */
	escaped: string;
}

/**
 * 找出 `"key": "…"` 里那段字符串值的范围（按 JSON 规则处理转义）。
 *
 * ⚠️ 不能写成 `"[^"]*"`：路径里出现转义引号（`\"`）时会在错误的位置截断，
 * 于是我们改掉的是半个字符串 —— 一个**语法坏掉的画布**。
 * 所以字符类必须显式承认转义序列（`\\.`）并跳过它。
 */
function jsonStringSpans(text: string, key: string): JsonStringSpan[] {
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "g");
	const spans: JsonStringSpan[] = [];
	for (const match of text.matchAll(pattern)) {
		const at = match.index ?? 0;
		const colon = match[0].indexOf(":");
		const quote = match[0].indexOf('"', colon);
		const start = at + quote + 1;
		spans.push({ start, end: start + match[1].length, escaped: match[1] });
	}
	return spans;
}

/** 按 JSON 规则编码一个字符串（不含外层引号）。 */
function encodeJsonString(value: string): string {
	return JSON.stringify(value).slice(1, -1);
}

/**
 * 从画布文本里取出**引用目标**（路径或短名，原样返回；只取路径那一段）。
 *
 * ## 为什么需要它（而不是只靠宿主的链接索引）
 *
 * "只处理被引用的文件"这条安全规则依赖"引用集合"的完备性。画布 `file` 节点那条路
 * 宿主的索引**确实认得**（真机取证）。但 `text` 节点里的 `![[x.png]]` 是**文本内容**，
 * 宿主是否把它算进 `resolvedLinks` 没有保证（这正是取证点 E-1c）。
 *
 * 而我们**不能**把"宿主没索引"当成"没人引用"：那样只被画布文本引用的附件会永远
 * 不被处理 —— 与需求 R16（画布与笔记同等算数）直接冲突，而且**不报错**。
 * 所以这里自己解析一遍，作为宿主索引的**补充**（多出来的候选由后续判据兜底，
 * 少掉的那些才是真缺陷）。
 *
 * ⚠️ 与改写器共用同一套纪律：解不开的 JSON 字符串**跳过**（不猜），
 * 绝不因为这里读不出来就当成"有引用"或"没引用"里的任意一边 —— 这里只负责
 * 把能读出来的目标交出去。
 */
export function canvasTextTargets(text: string): string[] {
	if (typeof text !== "string" || text === "") return [];
	const out: string[] = [];
	for (const span of jsonStringSpans(text, "text")) {
		let decoded: string;
		try {
			decoded = JSON.parse(`"${span.escaped}"`) as string;
		} catch {
			// 解不开就跳过（与 `planCanvasRewrites` 同一条纪律）
			continue;
		}
		if (typeof decoded !== "string") continue;
		for (const link of findLinkSpans(decoded)) out.push(link.raw);
	}
	return out;
}
