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
 * 笔记里的引用写法**有十来种**，各自的边界不同：
 *
 * | 写法 | 注意 |
 * |---|---|
 * | `![[photo.png]]` | wikilink，**没有**扩展名也能指向同一文件 |
 * | `![[photo.png\|600]]` | 带显示尺寸/别名；⚠️ **`\|` 的那个反斜杠不属于路径** |
 * | `![[photo.png#page=2]]` | 带子路径，`#` 之后要保留 |
 * | `![alt](attachments/photo.png)` | 标准 Markdown，可带标题 |
 * | `![alt](<attachments/a b.png>)` | 含空格时用尖括号包起来 |
 * | `![alt](attachments/Pasted%20image%201.png)` | **百分号编码**的空格（宿主的「相对路径」格式） |
 * | `![alt](../assets/photo.png)` | **相对当前笔记**的路径（同上，随链接格式设置而变） |
 * | `<img src="attachments/photo.png">` | **行内 HTML**（1.8 起阅读态/实时预览都渲染）；`href` / `<video>` 同理 |
 * | `![alt][ref]` + `[ref]: photo.png` | **引用式链接**：定义行在哪都要认（改写落在定义行上） |
 * | `---` 里的 `cover: "[[photo.png]]"` | **属性区**：认（判据），但**不改**（理由见 `LinkSpan.inFrontmatter`） |
 *
 * 用一个正则通吃会漏掉后几种、或者把 `|600` 一起换掉（那就改坏了）。
 * 所以这里**先定位链接范围、再按结构拆分**。
 *
 * ⚠️ 每一条的后果都一样、而且都**不报错**：判据说"没人指着它"（那份文件可能被删）、
 * 改写默默跳过（命令报告成功、而笔记里那条还是本地路径）。⇒ 这张表就是**验收矩阵**
 * （`maintenance-suite` 的 3b 一节逐条钉着）。
 *
 * ## ⭐⭐ 每一种写法都必须认：否则"传上去了、笔记没变"
 *
 * 归一只落在一个字符串上，而同一个文件在正文里的写法有十来种。少认一形**不报错**：
 * 改写那一趟默默跳过它（用户看到的是"命令报告成功、而笔记里那条链接还是本地路径"，
 * 2026-10-15 用户就是这么报的），删除判据那一趟则可能把还被人指着的文件判成没人引用。
 * ⇒ 「这条链接指着哪个文件」**只有一份判据**（{@link linkTargetForms}），两趟都走它。
 * 详见 {@link linkTargetForms} 与 {@link targetIsPath} 的说明。
 * ⚠️ 2026-10-15（D-32）补齐的三类：**行内 HTML 标签**、**引用式链接的定义行**、
 * **wikilink 的转义竖线** —— 补齐前它们两侧一起静默失效（矩阵探针量出来的）。
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
	/**
	 * 写法类别。`html` = **标签属性里的地址**（`<img src="…">`）：
	 * 只能换属性值那一段，**绝不能**整体换形态（标签结构是用户写的）。
	 */
	kind: "wikilink" | "markdown" | "html";
	/** wikilink 的 `|` 之后那一段（别名或显示尺寸）；没有则为 `null`。 */
	alias: string | null;
	/** wikilink 的 `#` 之后那一段（子路径）；没有则为 `null`。 */
	subpath: string | null;
	/** 原文里有没有 `!` 前缀（wikilink 的"嵌入"）。 */
	embed: boolean;
	/**
	 * 这一处在 frontmatter（属性区，`---` 那一段）里吗。
	 *
	 * ⚠️ 属性里的 `[[x.png]]` 是**属性链接**（Obsidian 单独记在 `frontmatterLinks` 里）：
	 * - 整条换成 `![x.png](url)` ⇒ 属性值被写坏（属性不接受 Markdown 图片）；
	 * - 只换路径那段 ⇒ 得到 `[[https://…]]`，而 wiki 语法只解析库内文件 ⇒ **死链**。
	 * ⇒ 改写器对"属性里的 wikilink 且目标是 URL"**整处跳过**（文件仍在库里，那张图照样显示；
	 * 见 `planLinkRewrites`）。判据那边照旧认（`stillMentionsPath`）—— 它确实还指着那个文件。
	 */
	inFrontmatter: boolean;
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
		const cut = cuts.length > 0 ? Math.min(...cuts) : body.length;
		// ⚠️ **`\|` 的那个反斜杠不属于路径**（在表格里必须这么写，是常见写法）：
		// 带上它就成了 `图.png\` ⇒ 归一之后**对不上任何文件** ⇒ 判据"没人指着它"、改写也不改
		//（2026-10-15 用矩阵探针量出来的：`![[图 1.png\|600]]` 两侧一起静默失效）。
		const raw = body.slice(0, cut > 0 && body[cut - 1] === "\\" ? cut - 1 : cut);
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
			inFrontmatter: false,
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
			inFrontmatter: false,
		};

		// 尖括号形式：路径被 `<...>` 包住（含空格时 Markdown 规范允许这么写）
		if (body.startsWith("<")) {
			const close = body.indexOf(">");
			if (close <= 1) continue;
			spans.push({ ...base, start: bodyStart + 1, end: bodyStart + close, raw: body.slice(1, close) });
			continue;
		}

		// 标题在引号里：`path "title"` —— 只替换引号之前那一段。
		//
		// ⚠️ 分界是"**引号前面**那个空白"，不是"第一个空白"（2026-10-14 修）：
		// Obsidian 容忍**没加尖括号**的含空格路径 —— `![](attachments/照片 1.png)`
		// 是很常见的写法（用户手写、或从别处复制过来）。"第一个空白就切"会把目标
		// 截成 `attachments/照片`，后果不只是"这条不改写"：`stillMentionsPath` 用的是
		// 同一套解析，于是这一处引用被判成**不存在** ⇒ 那个文件哪怕还有人指着也可能被删。
		// Markdown 规范里 title 必须用引号包着，所以真正的分界只能是引号前的空白。
		const quoteAt = firstIndexOf(body, ['"', "'"]);
		const sep = quoteAt === -1 ? -1 : quoteAt - 1;
		const raw = (sep > 0 && /\s/.test(body[sep]) ? body.slice(0, sep) : body).trim();
		if (!raw) continue;
		spans.push({ ...base, start: bodyStart, end: bodyStart + raw.length, raw });
	}

	// ── HTML 标签属性里的地址：`<img src="…">` / `<a href='…'>` / `<video src="…">` ──
	//
	// ⭐ 2026-10-15（D-32）补：Obsidian 1.8 起这类标签在阅读态与实时预览里都渲染
	//（相对路径也行），而**宿主的链接索引不保证收录它** ⇒ 这一层必须自己认。少认一形的后果
	// 与 wikilink 那条一样、而且都不报错：① 那份文件被判成"没人指着它"（可能被删）
	// ② 命令跑完笔记里那条还是本地路径。
	// ⚠️ 替换范围只能是**属性值本身**（`start`/`end` 落在引号之间）——
	// 标签结构是用户写的，整体换形态就不是他的东西了（所以 `kind: "html"` 永远走"只换值"那条路）。
	for (const target of htmlAttributeTargets(text)) {
		spans.push({
			start: target.start,
			end: target.start + target.value.length,
			raw: target.value,
			linkStart: target.tagStart,
			linkEnd: target.tagEnd,
			kind: "html",
			alias: null,
			subpath: null,
			embed: true,
			inFrontmatter: false,
		});
	}

	// ── 引用式链接的定义行：`[ref]: attachments/x.png`（正文里用 `![alt][ref]`） ──
	//
	// CommonMark 的另一种写法。宿主认不认没有保证，而**判据必须认**（否则那份文件会被
	// 判成没人指着它）；改写落在**定义行**上：`[ref]: https://…/x.png` 之后引用处自然指向云端。
	for (const match of text.matchAll(REFERENCE_DEFINITION)) {
		const inner = (match[1] ?? match[2] ?? "").trim();
		// ⚠️ 目标**可以带空格**（`[ref]: attachments/图 1.png`）—— 与 Markdown 那一趟同一条规矩：
		// 分界是**引号前面**那个空白（`[ref]: path "标题"`），不是"第一个空白"。
		const quoteAt = firstIndexOf(inner, ['"', "'"]);
		const sep = quoteAt === -1 ? -1 : quoteAt - 1;
		const value = (sep > 0 && /\s/.test(inner[sep]) ? inner.slice(0, sep) : inner).trim();
		if (!value) continue;
		const at = (match.index ?? 0) + match[0].lastIndexOf(value);
		spans.push({
			start: at,
			end: at + value.length,
			raw: value,
			linkStart: match.index ?? 0,
			linkEnd: (match.index ?? 0) + match[0].length,
			kind: "markdown",
			alias: null,
			subpath: null,
			embed: false,
			inFrontmatter: false,
		});
	}

	// frontmatter（属性区）里的那些标记出来 —— 改写器要跳过"属性里的 wikilink 改成 URL"
	//（理由见 `LinkSpan.inFrontmatter`）。
	const fm = frontmatterRange(text);
	if (fm) {
		for (const span of spans) span.inFrontmatter = span.start >= fm.start && span.end <= fm.end;
	}

	// 按出现位置排序，便于调用方按顺序重建文本
	return spans.sort((a, b) => a.start - b.start);
}

/**
 * 标签属性里的地址（`src=` / `href=`，单双引号都行）。
 *
 * ⚠️ **一处定义、两处用**：这里（找链接）与 `batch.ts` 的站外候选采集。
 * 两处各写一个正则 ⇒ 迟早分叉成"改写认得、候选不认得"这类错位（而且不报错）。
 */
export const HTML_ATTRIBUTE = /<[a-z][a-z0-9]*\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gi;

/** 引用式链接的定义行（`[ref]: <path>`）。 */
// ⚠️ 非尖括号那一支**要允许空格**（`[ref]: attachments/图 1.png`）—— 截到第一个空白就会
// 得到 `attachments/图`，那是个**指向别的东西**的路径（与 D-25 那类坑同一个形态）。
export const REFERENCE_DEFINITION = /^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*(?:<([^>\n]*)>|([^\n]+?))[ \t]*$/gm;

/** frontmatter（开头 `---` 包起来的那一段）的范围；没有则 `null`。 */
function frontmatterRange(text: string): { start: number; end: number } | null {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
	const close = text.search(/\r?\n---[ \t]*(\r?\n|$)/);
	if (close < 0) return null;
	return { start: 0, end: close };
}

/**
 * 这些标签上的地址是**被显示**的资源；其余（`a` / `iframe` / `link` / `script`）只是**指向**某处。
 *
 * ⚠️ 用途只有一个：站外候选采集（`maintenance/batch.ts`）要告诉判定层
 * "这条地址在笔记里是被**显示**，还是只被**指向**"（`decideExternalCache` 的 `embedded`）——
 * 笔记在显示一个资源时，那个地址长什么样与"它是不是文件"无关（图片 CDN 的令牌形状地址、
 * `/photo?id=5` 都很常见，而它们**确实是文件**）。
 *
 * ⚠️ 名单刻意**只收"渲染出一个文件"的标签**：`iframe` 看着像"显示"，但它渲染出来的是一张
 * **页面**（B站播放器那种）—— 用户 2026-10-16 第二次实测报的正是它。
 */
export const EMBED_TAGS = new Set(["img", "video", "audio", "source", "track", "embed"]);

/**
 * 取出标签属性里的地址，并**带上它在原文里的位置**（改写要按位置替换）。
 *
 * `start` 是值的起点、`tagStart`/`tagEnd` 是整条标签的范围（只用于诊断；替换永远只动值）。
 * `tag` 是**小写的标签名** —— 站外候选采集据此判断"这条地址是被显示还是只被指向"
 *（见 {@link EMBED_TAGS}）。
 */
export function htmlAttributeTargets(text: string): {
	value: string;
	tag: string;
	start: number;
	tagStart: number;
	tagEnd: number;
}[] {
	const out: { value: string; tag: string; start: number; tagStart: number; tagEnd: number }[] = [];
	if (typeof text !== "string" || text === "") return out;
	for (const match of text.matchAll(HTML_ATTRIBUTE)) {
		const double = match[1];
		const single = match[2];
		const value = String(double ?? single ?? "").trim();
		if (!value) continue;
		const quote = double === undefined ? "'" : '"';
		const body = match[0];
		const tagStart = match.index ?? 0;
		// 用"两端带引号"去找值的位置：单靠值本身会在标签里出现两次时找错
		const inner = body.lastIndexOf(quote + value + quote);
		if (inner < 0) continue;
		out.push({
			value,
			tag: (/^<([a-z][a-z0-9]*)/i.exec(body)?.[1] ?? "").toLowerCase(),
			start: tagStart + inner + 1,
			tagStart,
			tagEnd: tagStart + body.length,
		});
	}
	return out;
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
	/**
	 * 改写后链接里该显示的名字（`![这里](url)`）；缺省时用"原路径的最后一段"。
	 *
	 * ⭐ 为什么需要它：整条换形态（wikilink → Markdown）时，显示位原本取**原文件名**，
	 * 而宿主撞名另落的重复副本叫 `照片 1.png`、链接目标却用的是主干名字
	 * （`…/照片-<哈希>.png`）⇒ 同一个链接里两个名字不一样。用户 2026-10-14 报了它。
	 * 调用方（知道 key 的那一层）把 `IngestResult.displayName` 填进来即可。
	 *
	 * ⚠️ **只影响"整条换形态"那一路**：原文本来就是 Markdown 形态
	 * （`![我的名字](attachments/x.png)`）时，`[]` 里那串是**用户自己写的**显示文字，
	 * 我们只换路径段、一个字都不动它。
	 */
	display?: string;
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
		// ⚠️ **属性区（frontmatter）里的一律不碰**（2026-10-15 / D-32）。
		//
		// 属性是**结构化数据**（Obsidian 自己写、自己读）：
		// - 属性里的 wikilink 换成 `![x.png](url)` ⇒ 属性值写坏（属性不接受 Markdown 图片）；
		//   只换路径那段又会得到 `[[https://…]]` —— wiki 语法只解析库内文件 ⇒ **死链**；
		// - 属性里的 Markdown 链接本来就只是**一段文本**（属性不渲染 Markdown）⇒ 改它没有收益。
		// ⇒ 而"不改"没有任何损失：文件仍在库里，那一处引用照常工作，判据那边也照旧认它。
		if (span.inFrontmatter) continue;

		// 上一条换形态时可能已经吃掉了这一条（防御：宁可跳过，也不要产出错位文本）
		if (span.start < cursor) continue;

		const resolved = resolve(span.raw);
		if (resolved === undefined) continue;
		const replacement = resolved.to;

		if (span.kind === "wikilink" && hasScheme(replacement)) {
			// ⭐ URL 装不进 wikilink ⇒ 整条换形态（见文件头那张表）。
			// 显示位用规则给的名字（= 链接目标里的名字），见 `RewriteRule.display`。
			out += text.slice(cursor, span.linkStart) + wikilinkToMarkdown(span, replacement, resolved.display);
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
/** 解析结果：改写后的目标，以及（可选）改写后链接里该显示的名字。 */
interface ResolvedRewrite {
	to: string;
	display?: string;
}

function buildResolver(rules: readonly RewriteRule[]): ((raw: string) => ResolvedRewrite | undefined) | null {
	if (rules.length === 0) return null;

	const byPath = new Map<string, ResolvedRewrite>();
	const byName = new Map<string, ResolvedRewrite>();
	const ambiguous = new Set<string>();

	for (const rule of rules) {
		const full = normalizeLinkTarget(rule.from);
		if (!full) continue;
		// `display` 只在真给了非空串时才带上 —— 免得解析器那边还要判一次 undefined 与 ""。
		const trimmed = (rule.display ?? "").trim();
		const resolved: ResolvedRewrite = trimmed === "" ? { to: rule.to } : { to: rule.to, display: trimmed };
		byPath.set(full, resolved);

		const name = baseNameOf(full);
		const seen = byName.get(name);
		// ⚠️ 歧义判据只看**目标**（`to`）：同一个 `from` 上挂两条目标相同、显示名不同的规则
		//（例如"主干那份"与"重复副本"都指向同一个地址）不该被当成歧义。
		if (seen !== undefined && seen.to !== resolved.to) ambiguous.add(name);
		else byName.set(name, resolved);
	}

	return (raw: string): ResolvedRewrite | undefined => {
		const forms = linkTargetForms(raw);
		if (forms.length === 0) return undefined;

		// ① **完整路径优先**：精确匹配永远比短名可信（短名匹配是下面那一档的兜底）。
		for (const form of forms) {
			const exact = byPath.get(form);
			if (exact !== undefined) return exact;
		}

		// ② 再按短名（`../` 那种相对前缀只有短名这一档兜得住 —— 前缀要笔记的位置才解得开）。
		// ⚠️ 同名歧义 → 宁可不改（改成错的那张图比不改更糟）。
		for (const name of new Set(forms.map(baseNameOf))) {
			if (ambiguous.has(name)) continue;
			const hit = byName.get(name);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};
}

/**
 * 目标是不是"带 scheme 的绝对 URL"。
 *
 * 这条线决定改写**形态**：URL 装不进 wikilink（wiki 语法只解析库内文件），
 * 所以必须整条换成 Markdown；而库内路径两种写法都成立，就保持用户/宿主选的那一种。
 */
export function hasScheme(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * 把一条 wikilink 改写成 Markdown 形态：`![[a.png|600]]` → `![600](https://…/a.png)`。
 *
 * ⚠️ 别名（`|` 之后）落在 **alt 位**：Markdown 没有"显示尺寸"这个概念，
 * 数字尺寸因此**不再影响渲染**，但文字不丢 —— 如实写进了发版说明。
 * 没有别名时用路径的最后一段（与宿主自己生成链接的写法一致）。
 */
function wikilinkToMarkdown(span: LinkSpan, url: string, display?: string): string {
	const alias = (span.alias ?? "").trim();
	// alt 里出现 `]` 会把链接提前闭合，去掉（alt 是给人看的，不是数据）
	// 显示位：用户显式写的别名优先；否则用改写**规则给的**名字（= 链接目标里的名字），
	// 规则没给才退回原路径最后一段（老行为，供不关心名字的调用方使用）。
	const named = (display ?? "").trim();
	const fallback = named === "" ? baseNameOf(span.raw) : named;
	const alt = (alias === "" ? fallback : alias).replace(/[[\]]/g, "");
	const target = span.subpath === null || span.subpath === "" ? url : `${url}#${span.subpath}`;
	return `${span.embed ? "!" : ""}[${alt}](${target})`;
}

/** 取路径的最后一段（目录名不参与短名匹配）。 */
function baseNameOf(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}

/** 安全解码：不是合法编码就原样返回（正文里的 `%` 是合法字符）。 */
function decodeSafe(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * 一处链接目标的**所有归一形式**（按可信度从高到低）。
 *
 * ⭐⭐ **这是「这条链接指着哪个文件」的唯一一份判据** —— 改写（`buildResolver`）与
 * 「这份文件还有人引用吗」（{@link targetIsPath}）都走它。两处各写一遍的话，同一条链接会在
 * 一边被认出来、在另一边认不出来，而**两边都不报错**（2026-10-15 用户实测：一条
 * `../assets/Pasted%20image%2020260930162541.png` 传上去了、笔记却一处都没改）。
 *
 * ## 为什么要"多种形式"而不是一种
 *
 * 归一只落在一个字符串上，而同一个文件在正文里的写法随**宿主的链接格式设置**与来源而变：
 *
 * | 正文里写的 | 归一之后 | 片段 |
 * |---|---|---|
 * | `attachments/图 1.png` | `attachments/图 1` | 规则给的就是这一形 |
 * | `attachments/图%201.png` | `attachments/图%201` | ❌ 对不上 ⇒ 必须再有**解码那一形** |
 * | `../attachments/图 1.png` | `../attachments/图 1` | ❌ 对不上 —— `../` 要**笔记的位置**才解得开 |
 *
 * 前缀那一形这里**刻意不"猜着剥掉"**（剥了就可能匹配到另一个目录里的同名文件 ⇒
 * 把链接改到错的那张图上）。它由调用方按**短名**兜（`baseNameOf`，对前后缀不敏感），
 * 而短名的歧义各有守卫：改写时**宁可不改**，判「还有引用」时**宁可信其有**。
 *
 * ⚠️ **原样那一形必须排在前面**：文件名里真的写着 `%20` 的（合法、少见）只有原样对得上，
 * 解码那一形会把这条链接指到"名字里是空格"的另一份文件上去。
 */
export function linkTargetForms(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	const value = raw.trim();
	if (value === "") return [];
	const forms: string[] = [];
	for (const candidate of [value, decodeSafe(value)]) {
		const normalized = normalizeLinkTarget(candidate);
		if (normalized !== "" && !forms.includes(normalized)) forms.push(normalized);
	}
	return forms;
}

/**
 * 这一处链接的**目标**是不是 `path`。
 *
 * ⚠️ 只看**路径段**（`LinkSpan.raw`），不看显示文字：改写 wikilink 时显示文字保留的正是
 * 原文件名（`![照片 1.png](https://…)`），拿整段正文做字面匹配会把**改写后的链接本身**
 * 当成"还指着它"—— 那样这一份就永远删不掉了（实测踩到过）。
 *
 * 归一用的是与改写**同一个** {@link linkTargetForms}（原样 + 百分号解码），
 * 并按"完整路径 / 文件名"两个键匹配（与解析器同一套）。
 *
 * ⭐ 两侧都取**短名**再比一次：`../assets/图.png` 这种带相对前缀的目标在"完整路径"那一比
 * 上永远对不上（前缀要笔记的位置才解得开，而这两趟都拿不到）。判据落在**保守的一侧**：
 * 多认一句"还指着它"只是少删一份重复副本（下次运行还会再来），而漏认会在链接还指着它的时候
 * 把文件删掉 —— 用户看到的就是「图没了」。
 * ⚠️ 与解析器唯一的差别是没有同名歧义那一档：歧义时解析器宁可不改，而这里必须当成"还指着它"。
 */
function targetIsPath(raw: string, path: string): boolean {
	if (typeof raw !== "string" || raw === "" || typeof path !== "string" || path === "") return false;
	const wanted = [
		...new Set(
			[path, baseNameOf(path)]
				.map((form) => normalizeLinkTarget(form))
				.filter((form) => form !== "")
		),
	];
	if (wanted.length === 0) return false;
	const names = new Set(wanted.map(baseNameOf));
	for (const form of linkTargetForms(raw)) {
		if (wanted.includes(form)) return true;
		if (names.has(baseNameOf(form))) return true;
	}
	return false;
}

/**
 * 这段正文里**还**提得到 `path` 吗（用来判断"删掉这个文件安不安全"）。
 *
 * ## 为什么必须重新读正文，而不是问宿主的链接索引
 *
 * ⚠️⚠️ `metadataCache.resolvedLinks` **滞后于刚写下的笔记**。批量上传的收尾要在
 * "链接已改写"之后删掉宿主撞名另落的重复副本，而那一刻索引里**多半还写着它被引用**：
 * 后果是**永远删不掉**，而且看不出为什么（断言写不出来、日志里也没有异常）。
 * 判据改成"当场读到的正文"之后才成立。
 *
 * ## 判据 = 逐个链接看**目标**（含改写器认不出的那些写法）
 *
 * 用 `findLinkSpans` + {@link targetIsPath}：覆盖"正文里确实指着它"的所有链接形态，
 * 包括改写器**改不掉**的那些 —— 典型是**相对前缀**（`../assets/图.png`：要笔记的位置才解得开，
 * 而改写器的规则里只有库内路径，它靠短名兜住的是"能改"，判据这边则一律认下来）
 * 与**同名歧义**（改写器宁可不改）。那种引用原样留在正文里，若判据只看"改写器认不认得"，
 * 这份文件就会被删掉，而正文里那条链接**还指着一个不存在的文件**。
 *
 * ⚠️ 2026-10-15 起**百分号编码**（`图%201.png`）不再属于这一类：那份写法改写器也认了
 * （见 {@link linkTargetForms}）—— 判据两侧共用同一份归一，不再各写一遍。
 */
export function stillMentionsPath(text: string, path: string): boolean {
	if (typeof text !== "string" || text === "") return false;
	if (typeof path !== "string" || path === "") return false;
	return findLinkSpans(text).some((span) => targetIsPath(span.raw, path));
}

/**
 * 画布正文里**还**提得到 `path` 吗（`text` 节点里的链接，或 `file` 节点的库内路径）。
 *
 * 与 {@link stillMentionsPath} 同理，只是画布多了 `file` 那一类值（画布只能指向库内文件）——
 * 两类都要看，漏了 `file` 就会出现"笔记里没人引用、画布里却还挂着一个节点"的删除误判。
 * `file` 与 `text` 两类都由 {@link planCanvasRewrites} 的探针覆盖；
 * 再加 `canvasTextTargets` 兜"编码写法"那一侧（画布的 `file` 值是宿主写下的原样路径，
 * 不需要这一层）。
 */
export function canvasStillMentionsPath(text: string, path: string): boolean {
	if (typeof text !== "string" || text === "") return false;
	if (typeof path !== "string" || path === "") return false;
	const probe: RewriteRule[] = [{ from: path, to: "（仍在引用）" }];
	if (planCanvasRewrites(text, { linkRules: probe, fileRules: probe }).count > 0) return true;
	return canvasTextTargets(text).some((raw) => targetIsPath(raw, path));
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
			// 画布 `file` 节点只有路径、没有显示文字 ⇒ 只取目标（`display` 在这儿没用途）
			return target === undefined ? null : target.to;
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
