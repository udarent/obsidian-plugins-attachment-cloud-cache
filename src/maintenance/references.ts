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
 * | `![alt](attachments/报告(1).pdf)` | 目标里带**成对括号**（下载来的重名文件）：边界按括号深度找，不是"第一个 `)`"（见 `markdownDestinationEnd`） |
 * | `![alt](<attachments/a b.png>)` | 含空格时用尖括号包起来 |
 * | `![alt](attachments/Pasted%20image%201.png)` | **百分号编码**的空格（宿主的「相对路径」格式） |
 * | `![alt](../assets/photo.png)` | **相对当前笔记**的路径（同上，随链接格式设置而变） |
 * | `<img src="attachments/photo.png">` | **行内 HTML**（1.8 起阅读态/实时预览都渲染）；`href` / `<video>` 同理 |
 * | `![alt][ref]` + `[ref]: photo.png` | **引用式链接**：定义行在哪都要认（改写落在定义行上） |
 * | `---` 里的 `cover: "[[photo.png]]"` | **属性区**：认（判据），但**不改**（理由见 `LinkSpan.inFrontmatter`） |
 * | 代码块 / 行内代码 / `%%注释%%` / `<!-- -->` / `$…$` / `<code>` 里的 `[](photo.png)` | **不算引用**：这些位置宿主都不渲染（理由见 `inertRanges`） |
 * | `\![](photo.png)` / `\![[photo.png]]` | **转义**：渲染出来是字面文本，也不算引用（见 `isEscaped`） |
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

/**
 * ## 模块地图（六节，从"位置"到"结果"）
 *
 * 1. **惰性区域**（`inertRanges` / `isEscaped`）：宿主**不会渲染**的位置 —— 代码块、
 *    行内代码、注释、公式、`<code>`、转义。这些位置里的目标**不是引用**。
 *    ⚠️ 它是**唯一**的剔除点：`markdownLinks` 与 `findLinkSpans` 都从它取区间，
 *    所以"候选 / 报告 / 云端清理 / 删除前复核"四侧不可能再分叉（D-62/D-63 的教训）。
 * 2. **链接位置**（`markdownLinks` / `findLinkSpans` / `htmlAttributeTargets`）：
 *    每种写法各自怎么定界。`markdownLinks` 只管位置（站外 / 本机候选也要用它），
 *    `findLinkSpans` 在其上补齐 wikilink / 行内 HTML / 引用式定义。
 * 3. **目标归一**（`linkTargetForms` / `normalizeLinkTarget` / `hasScheme`）：
 *    "这条链接指着哪个文件"的**唯一**判据（含百分号解码、去扩展名、同名歧义）。
 * 4. **目标 → 库内路径**（`referencedPathsFrom` / `resolveVaultTargets`）：
 *    把一批目标解析成"库里真实存在"的路径。⚠️ 与改写器**同一套归一**，
 *    歧义时**一个都不收**（否则搬走文件而链接改不掉 ⇒ 死链）。
 * 5. **远端 key**（`keysInText` / `keysInCanvasText`）：哪些远端地址还"被引用"。
 *    ⚠️ 与第 1/2 节是**同一语义的不同扫描**（裸 URL），惰性区域一样要剔。
 * 6. **改写**（`planLinkRewrites` / `planCanvasRewrites` / `stillMentionsPath`）：
 *    唯一会动用户内容的地方；属性区"认但不改"。
 */

import { PLAUSIBLE_EXTENSION, extensionOfName, isEmbeddable } from "../vault-files";

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
		// 转义的 wikilink（`\![[x.png]]` / `\[[x.png]]`）在宿主里是**字面文本** ⇒ 不算引用
		if (isEscaped(text, at)) continue;
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
	//
	// ⚠️⚠️ 目标的边界**不能**用"遇到第一个 `)` 就停"来定（旧写法正是 `([^)\n]*)`）。
	//
	// 2026-10-21 用户实测报的：`[说明](../assets/【…】游立强%204年(1).pdf)` ——
	// 文件名里那个 `(1)` 是**下载来的文件常见形态**，而 Markdown 规范允许目标里出现
	// **成对**的括号。按"第一个 `)`"读出来的是 `…游立强%204年(1`（少了 `)` 与 `.pdf`）：
	// - 「这份文件还有人引用吗」答**否** ⇒ 它被判成没人用（`audit` 会报成可回收）；
	// - 改写一处都不改 ⇒ 文件**传上去了、笔记里那条还是本地路径**，用户看到的就是
	//   「没有被上传」（他的原话）；而且它**不报错**。
	// ⇒ 边界改成按括号嵌套深度找**真正的那个 `)`**（见 {@link markdownLinks}）。
	// 代码区间**算一次**：这里（Markdown 那一支）与收尾的其余写法共用（D-62）
	const frozen = inertRanges(text);
	for (const link of markdownLinks(text, frozen)) {
		const body = text.slice(link.start, link.end);
		if (!body) continue;
		// 这几种写法里目标就是路径本身 ⇒ 只可能"只换路径那一段"，所以别名/子路径都是 null
		const base = {
			linkStart: link.linkStart,
			linkEnd: link.linkEnd,
			kind: "markdown" as const,
			alias: null,
			subpath: null,
			embed: link.embed,
			inFrontmatter: false,
		};

		// 尖括号形式：路径被 `<...>` 包住（含空格时 Markdown 规范允许这么写）
		if (body.startsWith("<")) {
			const close = body.indexOf(">");
			if (close <= 1) continue;
			spans.push({ ...base, start: link.start + 1, end: link.start + close, raw: body.slice(1, close) });
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
		spans.push({ ...base, start: link.start, end: link.start + raw.length, raw });
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

	// ⭐⭐ 代码块 / 行内代码 / `%%注释%%` 里的那些：**不算引用**，一条都不产出
	// （2026-10-22，D-62，用户明确要求）。理由见 {@link inertRanges}：
	// 宿主不渲染它们，宿主的 `resolvedLinks` 里也没有它们 —— 我们多扫出来的这一半
	// 只会让"只在代码块里被提到"的文件进候选（白传一次），并在清理流程里保它一命。
	// ⚠️ 在**产出处**一次性剔除（而不是在消费方各自过滤）：判据只有一份，
	// 上传候选 / 引用快照 / 云端清理 / 删除前复核四侧不可能再分叉。
	const spansOutsideCode = frozen.length === 0
		? spans
		: spans.filter((span) => !frozen.some((range) => span.start >= range.start && span.end <= range.end));

	// frontmatter（属性区）里的那些标记出来 —— 改写器要跳过"属性里的 wikilink 改成 URL"
	//（理由见 `LinkSpan.inFrontmatter`）。
	const fm = frontmatterRange(text);
	if (fm) {
		for (const span of spansOutsideCode) span.inFrontmatter = span.start >= fm.start && span.end <= fm.end;
	}

	// 按出现位置排序，便于调用方按顺序重建文本
	return spansOutsideCode.sort((a, b) => a.start - b.start);
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
 * 正文里**不是链接**的区间（"惰性区域"）：围栏代码块（``` / ~~~）、行内代码（同一串反引号之间）、
 * Obsidian 注释（`%%…%%`）、HTML 注释（`<!-- -->`）、数学公式（`$$…$$` 与 `$…$`）、
 * HTML 的 `<code>` / `<pre>`。
 *
 * ⭐ 为什么要有它（2026-10-22，D-62，用户明确要求）：这些位置里的 `[](…)` **不是引用**。
 * - Obsidian **不渲染**它们，宿主的 `resolvedLinks` 里也没有它们 ——
 *   我们额外扫正文是为了补宿主的盲区（属性链接 / 行内 HTML / 引用式链接），
 *   而**这些位置从来不是盲区**；
 * - 那些是**用户抄下来的样例**（本插件的用户就在写 Obsidian 用法笔记）⇒ 既不该被
 *   改写，也不该因为"样例里出现过"就把它传上去、更不该因此在清理流程里保它一命。
 *
 * ⚠️ 用户 2026-10-22 的原话是「除了代码块,行内代码也不应该有引用附件,这和语义不符」——
 * 于是这里列的是**所有"看起来像链接、但它不会被渲染"的位置**，不是只列代码。
 * 同一类里刻意**没有**收的两处（都写清楚了理由，不是漏）：
 * - **4 空格缩进的代码块**：`- 项目
     ![图](x.png)` 是**列表续行**（正常渲染的正文），
 *   与缩进代码块在文本上无法区分 ⇒ 收进来会误伤真实引用；
 * - **属性区里的 Markdown 形式**（`cover: "![](x.png)"`）：Obsidian 的属性链接
 *   （`frontmatterLinks`）两种写法都收，判据跟着宿主走（`LinkSpan.inFrontmatter`）。
 *
 * ⇒ 结果只有一个用法：**从链接识别里剔掉**（`markdownLinks` 与 `findLinkSpans` 都剔）。
 * 判断做在产出处，于是上传候选 / 引用快照 / 云端清理 / 删除前复核四侧不可能再分叉。
 *
 * ⚠️ 判定**宁可保守**：只在"确实落在区间内"时才算，拿不准的写法都当普通正文
 * （多认一条只是多传一次，少认一条才会把真实引用当没人用）。
 * ⚠️ 未闭合的围栏 / `%%` / `<!--` / `$$` 一律按"到文末"处理：宿主渲染时也是这样。
 */
function inertRanges(text: string): { start: number; end: number }[] {
	const ranges: { start: number; end: number }[] = [];
	const lines = text.split("\n");

	// ① 围栏代码块：行首（最多 3 个空格）的 ``` 或 ~~~，同种符号开、同种符号关
	let open: { char: string; start: number } | null = null;
	let lineStart = 0;
	for (const line of lines) {
		const lineEnd = lineStart + line.length;
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (open === null) {
			if (fence) open = { char: fence[1][0], start: lineStart };
		} else if (fence && fence[1][0] === open.char) {
			ranges.push({ start: open.start, end: lineEnd });
			open = null;
		}
		lineStart = lineEnd + 1;
	}
	if (open) ranges.push({ start: open.start, end: text.length });

	// ② 成对出现、可能跨行的定界符：`%%…%%`（Obsidian 注释）、`<!--…-->`、`$$…$$`（块级公式）、
	//    `<code>…</code>` / `<pre>…</pre>`。未闭合一律到文末（与宿主的渲染一致）。
	// ⚠️ 配对是"开 → 第一个关"，配完**从关之后**继续找 —— 否则 `$$x$$` 的那个闭合符
	// 会被当成下一段的开头，把后面整篇正文都并进区间（真实引用就全丢了）。
	const lower = text.toLowerCase();
	const paired: [string, string][] = [
		["%%", "%%"],
		["<!--", "-->"],
		["$$", "$$"],
		["<code", "</code>"],
		["<pre", "</pre>"],
	];
	for (const [opener, closer] of paired) {
		let at = lower.indexOf(opener);
		while (at >= 0) {
			// ⚠️ 标签类开头要卡边界：`<premium>` 不是 `<pre>`（收窄的好处是"宁可多算"，
			// 而放宽会把后面一整段正文都划进惰性区间 —— 那是**少认**的方向）。
			if (opener.startsWith("<") && !/[>\s/]/.test(lower[at + opener.length] ?? ">")) {
				at = lower.indexOf(opener, at + opener.length);
				continue;
			}
			const close = lower.indexOf(closer, at + opener.length);
			if (close < 0) {
				ranges.push({ start: at, end: text.length });
				break;
			}
			ranges.push({ start: at, end: close + closer.length });
			at = lower.indexOf(opener, close + closer.length);
		}
	}

	// ③ 行内数学 `$…$`：**两端都不许贴空白**（否则 `价格 $5 到 $10` 会被当成公式，
	//    而中间那一段正文就再也不算引用了 —— 这是这条判据最容易误伤的地方）。
	for (const match of text.matchAll(/(?<!\\)\$([^$\n]{1,300}?)\$/g)) {
		const inner = match[1];
		const at = match.index ?? 0;
		if (!inner.trim()) continue;
		if (/^\s/.test(inner) || /\s$/.test(inner)) continue;
		if (text[at + 1] === "$" || text[at - 1] === "$") continue; // 属于 `$$` 的那一半
		ranges.push({ start: at, end: at + match[0].length });
	}

	// ④ 行内代码：同一行里**等长**的两串反引号之间。⚠️ 两串**不必相邻**：
	//    ```` ``a ` ![](x.png) `` ```` 是合法写法（内容里可以有单个反引号），
	//    只认同行相邻的一对会漏掉它 —— 那正是用户说的"语义不符"里最像的一条。
	lineStart = 0;
	for (const line of lines) {
		const lineEnd = lineStart + line.length;
		const insideFence = ranges.some((range) => lineStart >= range.start && lineEnd <= range.end);
		if (!insideFence && line.includes("`")) {
			const runs = [...line.matchAll(/`+/g)];
			let i = 0;
			while (i < runs.length) {
				const run = runs[i];
				const width = run[0].length;
				// 找**后面**第一串等长的（奇偶同号才算一对；找不到就换下一串）
				let j = i + 1;
				while (j < runs.length && runs[j][0].length !== width) j += 1;
				if (j >= runs.length) {
					i += 1;
					continue;
				}
				const from = lineStart + (run.index ?? 0);
				const to = lineStart + (runs[j].index ?? 0) + width;
				ranges.push({ start: from, end: to });
				i = j + 1;
			}
		}
		lineStart = lineEnd + 1;
	}

	return ranges;
}

/**
 * 这个位置上的字符被反斜杠转义了吗（`\![](...)` / `\[[x]]`）。
 *
 * 转义的链接在 Markdown 里是**字面文本**（宿主不渲染），所以它也不是引用。
 * ⚠️ 数反斜杠的个数（奇数才算被转义）：`\\![](...)` 是"转义了的反斜杠 + 真链接"。
 */
function isEscaped(text: string, at: number): boolean {
	let count = 0;
	for (let i = at - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
	return count % 2 === 1;
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

/**
 * 一条 Markdown 链接（`[说明](目标)` / `![说明](目标)`）在原文里的**位置**。
 *
 * `start`/`end` 是**目标区域**（含引号里的标题），`linkStart`/`linkEnd` 是整条链接。
 * 谁需要"这一条链接的目标在哪儿"就用这个结构 —— 不要再自己写正则。
 */
export interface MarkdownLink {
	/** 整条链接的起点（`!` 或 `[`）。 */
	linkStart: number;
	/** 闭合 `)` 之后的位置。 */
	linkEnd: number;
	/** 目标区域的起点（`](` 之后，已跳过前导空白）。 */
	start: number;
	/** 目标区域的结束（不含闭合 `)`）。 */
	end: number;
	/** 原文里有没有 `!` 前缀。 */
	embed: boolean;
}

/**
 * Markdown 链接的头部：`![显示文字](`。
 *
 * ⚠️ 显示文字里**允许**出现 `(`（`[图 (1)](…)`）—— 这正是"目标起点不能靠
 * `indexOf("(")` 算"的原因（它会落在标签里那个括号上）。
 */
const MD_LINK_HEAD = /!?\[[^\]\n]*\]\(/g;

/**
 * 找出文本里所有 Markdown 链接的**位置**（`[..](` → 外层闭合 `)`）。
 *
 * ## ⭐ 「Markdown 链接的目标在哪儿」只此一份
 *
 * 两个消费者、两套完全不同的后续规则，但**边界必须一致**：
 * - `references.ts` 自己的改写 / 删除判据（`findLinkSpans`）—— 目标可以含空格；
 * - `batch.ts` 的站外 / 本机候选采集（`externalUrlEntriesIn`）—— http 那一支按空白切。
 *
 * 各写一个正则的代价实测过：`(1)` 里那个 `)` 把目标截成半截（2026-10-21，用户报
 * 「没有被上传」，实际是链接一处没改）；站外那一路同形
 *（`https://…/Foo_(bar).pdf` → `…Foo_(bar`，本机 `file:///…/报告(1).pdf` 更糟：
 * 文件被判成"早就不在了"直接摘掉）。⇒ 位置只在这里算，各自往后怎么切是各自的业务规则。
 *
 * 前导空白一并跳过：`[a]( x.png)` 是宿主/手写都出现过的写法；跳过之后 `start` 才真的
 * 落在目标上（旧代码保留空白却按 `raw.length` 算 `end`，于是替换范围偏一格 —— 又一个不报错的错位）。
 */
export function markdownLinks(text: string, frozen: readonly { start: number; end: number }[] = inertRanges(text)): MarkdownLink[] {
	const out: MarkdownLink[] = [];
	if (typeof text !== "string" || text === "") return out;

	for (const match of text.matchAll(MD_LINK_HEAD)) {
		const linkStart = match.index ?? 0;
		// ⭐⭐ **代码块 / 行内代码 / `%%注释%%` 里的不算链接**（2026-10-22，D-62）。
		// 放在这里而不是各消费方：`findLinkSpans`（判据 + 改写）与 `batch.ts`（站外 /
		// 本机候选）都从这一个函数拿位置 —— 一边过滤一边不过滤就会出现"下载了、
		// 传上去了、链接永远改不掉"（改写那一侧根本看不到这条）。
		if (frozen.some((range) => linkStart >= range.start && linkStart < range.end)) continue;
		// 转义的链接（`\![](...)`）在 Markdown 里是**字面文本**，宿主不渲染 ⇒ 不算引用
		if (isEscaped(text, linkStart)) continue;
		let start = linkStart + match[0].length;
		// 只跳空格与制表符：换行就意味着这条链接没有目标了（`markdownDestinationEnd` 会拒绝）
		while (start < text.length && (text[start] === " " || text[start] === "\t")) start += 1;

		const scan = markdownDestinationEnd(text, start);
		if (!scan) continue;
		out.push({
			linkStart,
			linkEnd: scan.closeEnd,
			start,
			end: scan.bodyEnd,
			embed: match[0].startsWith("!"),
		});
	}
	return out;
}

/**
 * 一条 Markdown 链接的目标区域到哪儿结束（`(` 之后的位置 → 那个闭合 `)` 的位置）。
 *
 * ## ⚠️ 为什么不能"遇到第一个 `)` 就停"
 *
 * 文件名里带括号是**常态**（浏览器下载的 `… 4年(1).pdf`、`IMG (2).png`、`报告(最终版).docx`），
 * 而 Markdown 规范允许目标里出现**成对**的括号。按"第一个 `)`"截断的后果已经实测过一次
 * （2026-10-21）：`[说明](../assets/…%204年(1).pdf)` 被读成 `…%204年(1` ⇒
 * ① 判据说"没人指着它"（可回收/可能被删）② 改写一处不改（文件传上去了、笔记里还是本地路径）
 * —— 两个方向都**不报错**。
 *
 * ## 三种形态，各按各自的边界走
 *
 * - **尖括号** `(<a (1).png>)`：边界由 `>` 给 —— 里面的 `)` 不是分隔符；
 * - **普通**：按括号**嵌套深度**找外层那个（`x(1).png` 里的一对是内容，不是分隔符）；
 * - **兜底**：深度扫描在同一行里收不到闭合（典型是标题里有个**不成对**的 `(`
 *   —— `![a](x.png "见(注")`），退回"第一个 `)`"，与修之前的行为逐字一致。
 *   ⚠️ 这条兜底不是"以防万一"：没有它，那种写法会从"能改"退化成"整条不认"。
 *
 * 返回值里的 `bodyEnd` 是**目标区域的结束**（不含闭合 `)`），`closeEnd` 是 `)` 之后 ——
 * 改写要按后者算整条链接的范围。同一行里找不到闭合就是 `null`（与旧正则不匹配等价）。
 */
function markdownDestinationEnd(text: string, from: number): { bodyEnd: number; closeEnd: number } | null {
	if (from >= text.length) return null;

	// 尖括号形式：边界由 `>` 给（`<a b.png>` / `<a (1).png>` 都成立）
	if (text[from] === "<") {
		const gt = text.indexOf(">", from + 1);
		if (gt < 0) return null;
		if (text.slice(from, gt).includes("\n")) return null;
		const close = text.indexOf(")", gt + 1);
		if (close < 0) return null;
		if (text.slice(gt + 1, close).includes("\n")) return null;
		return { bodyEnd: close, closeEnd: close + 1 };
	}

	let depth = 0;
	for (let i = from; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "\n") break;
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			if (depth === 0) return { bodyEnd: i, closeEnd: i + 1 };
			depth -= 1;
		}
	}

	// 兜底：括号没配平（见上面的说明）⇒ 退回"第一个 `)`"，与旧行为一致
	const fallback = text.indexOf(")", from);
	if (fallback < 0) return null;
	if (text.slice(from, fallback).includes("\n")) return null;
	return { bodyEnd: fallback, closeEnd: fallback + 1 };
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
	//
	// ⚠️⚠️ **惰性区域里的 URL 不算引用**（2026-10-22，D-63）：代码块 / 行内代码 / 注释 /
	// 公式 / `<code>` 里的地址在宿主里根本不渲染，可是这条判据原来是直接扫**原文**的
	// ⇒ 一句"我们生成的地址长这样"的样例就会把那个对象永久钉成"仍被引用"：
	// 云端清理永远不问它、引用快照也说"在用"。与 `findLinkSpans` 同一份判据（`inertRanges`）。
	const frozen = inertRanges(text);
	const insideInert = (at: number) => frozen.some((range) => at >= range.start && at < range.end);
	for (const match of text.matchAll(/https?:\/\/[^\s)>"'`\]]+/gi)) {
		if (frozen.length > 0 && insideInert(match.index ?? 0)) continue;
		const key = keyFromUrl(match[0]);
		if (key) keys.add(key);
	}
	return keys;
}
/**
 * 画布文本里的**本存储对象 key**（画布 `text` 节点里的远端地址）。
 *
 * ## ⚠️ 为什么它必须存在（2026-10-22 审计查出的第三处不一致）
 *
 * 「仍被引用吗」有两处调用方，扫的来源却不一样：
 * - `cloudReferencedKeys`（云端清理）扫 **笔记 ＋ 画布文本**；
 * - `scanReferences`（取引用快照）只扫**笔记** —— 于是一张只被画布卡片引用着的图，
 *   在报告里会被报成"没有人引用 / 可回收"，而云端清理根本不会问它。
 * 用户看到的就是"两条命令对同一份东西说法相反"。
 *
 * ⇒ 画布那一半抽成这一处，两侧共用；`keysInText` 仍然是"URL → key"的唯一实现。
 * ⚠️ 只认 `text` 节点：画布的 `file` 节点**只能**指向库内文件（宿主限制），
 * 那里不可能出现我们的远端地址。
 */
export function keysInCanvasText(text: string, keyFromUrl: (url: string) => string | null): Set<string> {
	const keys = new Set<string>();
	if (typeof text !== "string" || text === "") return keys;
	for (const raw of canvasTextTargets(text)) {
		for (const key of keysInText(raw, keyFromUrl)) keys.add(key);
	}
	return keys;
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
		// 属性区：**认但不改**（见 `LinkSpan.inFrontmatter`）。
		// 代码块/注释里的一律走不到这里 —— 它们在 `findLinkSpans` 里就不产出了（D-62）。
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
			// ⭐ 只换路径时也要看一眼 `!`：原文写了 `!`、但这个类型**不能预览**
			//（`![](报告.docx)`、`![](包.zip)`）⇒ 顺手降级成普通链接。
			// 不动的话用户拿到 `![](https://…/hash.zip)` —— 一个打不开的坏图，而且**看不出是我们改的**。
			// 判据与 `wikilinkToMarkdown` 同源（`isEmbeddable`），两条路只写一次。
			// ⚠️ 只在**确定不可嵌入**时动：`extensionOfName` 取到值且 `isEmbeddable` 为假。
			// 取不到扩展名一律不动 —— 擅自去掉 `!` 会把用户的图片嵌入变成一行链接。
			// ⚠️ `html` 的 `embed` 恒为 true（那是标签、不是 `!`）⇒ 必须排除，
			// 否则 `linkStart + 1` 会把标签的 `<` 吃掉。
			const newExt = extensionOfName(replacement);
			const dropBang = span.kind !== "html" && span.embed && newExt !== "" && !isEmbeddable(newExt);
			if (dropBang) {
				// ⚠️ 不能只把 `from` 往前挪一格：`linkStart + 1` 会连 `[alt](` 一起吞掉
				// （`![](a.zip)` 会变成 `!https://…`）。要的是"去掉首个 `!`、其余原样" ——
				// 所以把 `linkStart..start` 这段（`![]( ` 的前半）作为一个整体，切掉第一个字符再拼。
				const head = text.slice(span.linkStart, span.start);
				out += text.slice(cursor, span.linkStart) + head.replace(/^!/, "") + replacement;
			} else {
				out += text.slice(cursor, span.start) + replacement;
			}
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
	// ⭐ `!` 要**两个条件同时成立**才保留：原文写了 `!`，**且**这个类型宿主真能预览
	//（判据与插入那条链同源：`isEmbeddable`，也就是 `buildRemoteLink` 用的同一张表）。
	// ⚠️ 只照抄原文的 `!` 是不够的：`![[包.zip]]` 在库里本来就显示不出来，改写后
	// `![包.zip](https://…)` 同样是一个**坏图** —— 用户会以为是我们弄坏的。
	// 扩展名从**改写后的地址**取（那才是链接将来的目标，扩展名一定在里面）。
	// ⚠️ 取不到扩展名时**不动**（保守）：宁可留一个原文的 `!`，也不要擅自把图片降级成链接。
	const ext = extensionOfName(url);
	const keepBang = span.embed && (ext === "" || isEmbeddable(ext));
	return `${keepBang ? "!" : ""}[${alt}](${target})`;
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



// ─────────────── ④ 目标 → 库内路径（宿主的链接索引 / 自扫正文共用） ───────────────

/**
 * 从宿主的链接索引（`metadataCache.resolvedLinks`）里取出**被笔记引用着**的文件路径集合。
 *
 * ⭐ 2026-10-22（D-65）从 `maintenance/batch.ts` 挪到这里：它与"这条链接指着哪个文件"
 * 是同一件事的两半，而 `plugin/notes-query` 不该为了一个纯判据去 import 候选层。
 *
 * ## 形状与来源（真机取证，2026-10-09）
 *
 * 实测：它是 `{ 来源文件路径: { 目标文件路径: 引用次数(number) } }`；**刚起来时是空的**，
 * 约 2 秒内建好；⚠️ 而且它**连画布里的引用也算**（写一个指向附件的 `.canvas`，两秒后出现）。
 *
 * ## ⚠️ 为什么按来源**不筛**
 *
 * 这里只回答"哪些路径被提到过"。**能不能改写**是另一条判据
 * （`referenceSnapshot().rewritable` 只收笔记正文与画布文本节点）—— 两件事混在一条判据里，
 * 就会出现"画布 `file` 节点永远改不成 URL，却每轮都进待修清单"（D-57 踩过）。
 *
 * ⚠️ 认不出的输入（`null`、数组、字段类型不对）一律当成"没有引用" —— 宁可这轮不处理，
 * 也不能把"没查清"当成"没有引用"的反面（那会把文件搬走）。
 */
export function referencedPathsFrom(resolvedLinks: unknown): Set<string> {
	const referenced = new Set<string>();
	if (!resolvedLinks || typeof resolvedLinks !== "object") return referenced;

	// ⚠️ 这一层的入参是**宿主的对象**（形状已知但类型上不可信），所以先收成
	// `Record<string, unknown>` 再逐层收窄：不收窄的话 `Object.entries` 会给出 `any`，
	// 而 eslint 的 `no-unsafe-argument` 会因此判红（本项目 lint 是门禁的一部分）。
	const table = resolvedLinks as Record<string, unknown>;
	for (const [sourcePath, targets] of Object.entries(table)) {
		// ⭐ 来源**不筛**：Markdown 笔记与画布同等算数（需求 R16，2026-10-09 拍板）。
		// 空的来源路径仍然跳过 —— 那不是宿主会给的形状。
		if (!sourcePath) continue;
		if (!targets || typeof targets !== "object") continue;
		for (const targetPath of Object.keys(targets)) {
			if (targetPath) referenced.add(targetPath);
		}
	}
	return referenced;
}

/**
 * 把"笔记/画布文本里写的链接目标"解析成库里**真实存在**的文件路径。
 *
 * ## 为什么需要它
 *
 * `referencedPathsFrom` 只读宿主的链接索引。而画布 `text` 节点里的 `![[x.png]]`
 * 是**文本内容**，宿主会不会把它算进索引没有保证（取证点 E-1c）——
 * 少了这一路，"只被画布文本引用的附件"会被判成"没人引用"而永远不被处理
 * （与需求 R16 冲突，且不报错）。
 *
 * ## 匹配规则：与改写器**同一套**（含同名歧义的处理）
 *
 * `normalizeLinkTarget` 剥掉任意"像扩展名"的后缀并小写，于是 `photo`、`photo.png`、
 * `attachments/photo.png` 都能对上真实路径。⚠️ **同名歧义时一个都不收**：
 * 两个不同目录下有同名文件时，"这条引用到底指哪个"无法判断，而我们的改写器在
 * 歧义时同样拒绝改写 —— 若这里把两个都算成"被引用"，命令就会**搬走**它们，
 * 而笔记里的链接一处都改不掉 ⇒ 死链。宁可少处理（不搬）。
 */
export function resolveVaultTargets(
	targets: readonly string[],
	vaultPaths: readonly string[]
): Set<string> {
	const byPath = new Map<string, string>();
	const byName = new Map<string, string[]>();

	for (const path of vaultPaths) {
		if (typeof path !== "string" || path === "") continue;
		const full = normalizeLinkTarget(path);
		if (!full) continue;
		byPath.set(full, path);
		const name = full.split("/").pop() ?? full;
		const list = byName.get(name);
		if (list) list.push(path);
		else byName.set(name, [path]);
	}

	const out = new Set<string>();
	for (const target of targets ?? []) {
		const forms = linkTargetForms(target);
		if (forms.length === 0) continue;
		// ⭐ 与改写器**同一份归一**（含百分号解码那一形）。画布文本节点里写
		// `![[Pasted%20image%201234.png]]` 完全可能（从别处复制来的），少认一形 =
		// "只被画布文本引用的附件永远不被处理"（与需求 R16 冲突，且不报错）。
		let exact: string | undefined;
		for (const form of forms) {
			exact = byPath.get(form);
			if (exact) break;
		}
		if (exact) {
			out.add(exact);
			continue;
		}
		for (const form of forms) {
			const name = form.split("/").pop() ?? form;
			const candidates = byName.get(name);
			// ⚠️ 歧义 ⇒ 不收（与改写器一致，见上面的说明）
			if (candidates && candidates.length === 1) {
				out.add(candidates[0]);
				break;
			}
		}
	}
	return out;
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
		// 代码块 / 行内代码 / `%%注释%%` 里的那些**已经**在 `findLinkSpans` 里被剔除了
		//（D-62），这里不需要再分一档。
		for (const link of findLinkSpans(decoded)) out.push(link.raw);
	}
	return out;
}
