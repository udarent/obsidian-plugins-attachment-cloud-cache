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
 * | `![[photo.png\|600]]` | 带显示尺寸/别名，`\|` 之后要原样保留 |
 * | `![[photo.png#page=2]]` | 带子路径，`#` 之后要原样保留 |
 * | `![alt](attachments/photo.png)` | 标准 Markdown，可带标题 |
 * | `![alt](<attachments/a b.png>)` | 含空格时用尖括号包起来 |
 *
 * 用一个正则通吃会漏掉后几种、或者把 `|600` 一起换掉（那就改坏了）。
 * 所以这里**先定位链接范围、再按结构拆分**，改写时只替换路径那一段。
 */

/** 一处待替换的链接：`start`/`end` 是**路径部分**在原文中的下标（左闭右开）。 */
export interface LinkSpan {
	start: number;
	end: number;
	/** 原文里的路径（可能是 wikilink 的短名，也可能是相对路径）。 */
	raw: string;
}

/**
 * 找出文本里所有"可能指向库内文件"的链接的**路径段**位置。
 *
 * 只做定位，不判断该不该改（那是调用方的事，它才知道文件与 URL 的对应关系）。
 */
export function findLinkSpans(text: string): LinkSpan[] {
	const spans: LinkSpan[] = [];

	// ── wikilink: `![[path]]` / `![[path|alias]]` / `![[path#sub]]` ──
	const wiki = /!?\[\[([^\]\n]*)\]\]/g;
	for (const match of text.matchAll(wiki)) {
		const body = match[1];
		const bodyStart = (match.index ?? 0) + match[0].indexOf("[[") + 2;
		// 路径在 `|` 与 `#` 之前
		const cut = firstIndexOf(body, ["|", "#"]);
		const raw = cut === -1 ? body : body.slice(0, cut);
		if (!raw) continue;
		spans.push({ start: bodyStart, end: bodyStart + raw.length, raw });
	}

	// ── Markdown 链接/图片: `![alt](path "title")` / `![alt](<path with space>)` ──
	const md = /!?\[[^\]\n]*\]\(([^)\n]*)\)/g;
	for (const match of text.matchAll(md)) {
		const body = match[1];
		if (!body) continue;
		const bodyStart = (match.index ?? 0) + match[0].indexOf("(") + 1;

		// 尖括号形式：路径被 `<...>` 包住（含空格时 Markdown 规范允许这么写）
		if (body.startsWith("<")) {
			const close = body.indexOf(">");
			if (close <= 1) continue;
			spans.push({ start: bodyStart + 1, end: bodyStart + close, raw: body.slice(1, close) });
			continue;
		}

		// 标题在引号里：`path "title"` —— 只替换引号之前那一段
		const quote = firstIndexOf(body, [" ", '"', "'"]);
		const raw = quote === -1 ? body : body.slice(0, quote);
		if (!raw) continue;
		spans.push({ start: bodyStart, end: bodyStart + raw.length, raw });
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
 * ## ⚠️ 短名匹配必须处理**歧义**
 *
 * 两个不同目录下的同名文件（`a/photo.png` 与 `b/photo.png`）都在候选里时，
 * 一条 `![[photo.png]]` **无法判断**指的是哪一个。此时按短名匹配会把链接改成
 * **错的那张图** —— 比不改糟得多（笔记静默指向别的图）。
 * 所以歧义的短名被整体排除，只按完整路径匹配。
 */
export function planLinkRewrites(text: string, rules: readonly RewriteRule[]): RewritePlan {
	if (rules.length === 0) return { text, count: 0 };

	const byPath = new Map<string, string>();
	const byName = new Map<string, string>();
	const ambiguous = new Set<string>();

	for (const rule of rules) {
		const full = normalizeTarget(rule.from);
		if (!full) continue;
		byPath.set(full, rule.to);

		const name = baseNameOf(full);
		const seen = byName.get(name);
		if (seen !== undefined && seen !== rule.to) ambiguous.add(name);
		else byName.set(name, rule.to);
	}

	const spans = findLinkSpans(text);
	if (spans.length === 0) return { text, count: 0 };

	const resolve = (raw: string): string | undefined => {
		const full = normalizeTarget(raw);
		if (!full) return undefined;

		const exact = byPath.get(full);
		if (exact !== undefined) return exact;

		const name = baseNameOf(full);
		if (ambiguous.has(name)) return undefined; // ⚠️ 同名歧义 → 宁可不改
		return byName.get(name);
	};

	let out = "";
	let cursor = 0;
	let count = 0;

	for (const span of spans) {
		const replacement = resolve(span.raw);
		if (replacement === undefined) continue;
		out += text.slice(cursor, span.start) + replacement;
		cursor = span.end;
		count += 1;
	}

	if (count === 0) return { text, count: 0 };
	return { text: out + text.slice(cursor), count };
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
 */
function normalizeTarget(target: string): string {
	return String(target ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.?\//, "")
		.trim()
		.replace(/\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?|heic)$/i, "")
		.toLowerCase();
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
