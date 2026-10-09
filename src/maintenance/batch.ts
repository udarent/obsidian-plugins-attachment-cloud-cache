/**
 * 批量上传：挑选候选（**纯判定**）。
 *
 * ## 这个功能补的是哪个洞
 *
 * 插件是后来才装的，而用户库里早就有几百张本地附件。没有这一条，
 * "上传到自己的图床"只对**新粘贴**的图成立 —— 老图永远是本地的。
 *
 * ## 两类候选：库内文件 + 笔记里的外链图
 *
 * | 候选 | 判定 |
 * |---|---|
 * | 附件目录里的库内文件 | {@link selectUploadCandidates} |
 * | 笔记里指向别处的图片（外链） | {@link selectExternalUploadCandidates} |
 *
 * 第二类是同一件事的另一半：那些图同样**没进你自己的存储**（它们在别人的服务器上），
 * 而用户跑这条命令的意图就是"把我还没搬走的图搬走"。
 * 外链那边**不另立标准** —— 一律走 `decideExternalCache`（按需缓存那条链路的判定），
 * 于是"功能关掉 / 自己的存储 / 回环地址 / 存储未就绪"全都自动一致。
 *
 * ## 谨慎的地方：这是唯一会改动**用户笔记**的功能
 *
 * 上传本身不碰笔记；但要让老图真正"搬到图床"，笔记里的本地链接必须换成远端
 * 链接 —— 那一步会重写用户的 `.md` 文件。所以选候选时**宁少不多**：
 *
 * - ⭐ **只挑「确实被笔记引用着」的**（`referencedPaths`）：命令跑完会把原文件
 *   **移进**缓存目录（见 `localCopy`），引用的改写正是"搬走之后不会留下死链"的前提。
 *   用户放在附件目录里、**没有任何笔记引用**的文件一概不碰（既不传也不动）——
 *   那种文件多半是废弃的旧图，动了只会让人以为丢东西。
 * - ⭐ 1.1.0 起**不再按类型白名单挑**，而是**排除制**：排除"笔记/画布/数据库"这三种
 *   宿主自己的文本文件（它们不是附件），其余一律可处理（需求 R15：任何类型都能上传）。
 *   ⚠️ 这条把候选面从"十来个图片后缀"放大到"库里每一个文件"，所以**排除列表是硬要求**，
 *   测试逐项钉住（没有它，一条命令会把整个库搬空）；
 * - 跳过**已经在索引里**的（同一个 key = 同一份内容，重复上传没有意义，
 *   而且会让"哪些是新的"变得难以解释）；
 * - 跳过尺寸为 0 的（多半是同步中的占位文件，读出来是空的 ——
 *   上传一个空文件比跳过更糟：远端会多一个坏对象）。
 */

import type { PluginSettings } from "../types";
import type { CacheIndex } from "../cache/index";
import { decideExternalCache, isCacheableExternal } from "../render/external-decide";

/** 库内文件的最小形状。 */
export interface VaultFileLike {
	path: string;
	extension?: string;
	stat?: { size?: number } | null;
}

export interface CandidateOptions {
	settings: PluginSettings;
	/** 已在索引里的 key 也算"处理过" —— 但候选文件的 key 要上传后才知道， */
	/** 所以这里按**路径**排除：索引记着某个副本的路径就是它。 */
	index: CacheIndex;
	/**
	 * **被笔记引用着**的文件路径集合（宿主解析出来的链接目标）。
	 *
	 * 只有在这个集合里的文件才会被选上 —— 因为这条命令跑完会把原文件**移进**缓存目录，
	 * 而"引用的改写"正是它的前提（见文件头）。集合外的文件一概不碰。
	 *
	 * 取值的来源是宿主的链接索引（`metadataCache.resolvedLinks`），而不是我们自己扫正文：
	 * 宿主认识所有链接形态（`![[图.png]]`、`![](attachments/图.png)`、别名、子路径……），
	 * 我们重写一遍只会得到一个更窄的近似 —— 而这里的判据是"能不能安全地把它搬走"，
	 * **漏判的代价是死链**，必须用宿主自己的解析结果。
	 */
	referencedPaths: ReadonlySet<string>;
}

/**
 * 从宿主的链接索引（`metadataCache.resolvedLinks`）里取出**被笔记引用着**的文件路径集合。
 *
 * ## 形状与来源（真机取证，2026-10-09）
 *
 * 实测（`dev-notes/_archive/.probe-referenced-links.mjs`）：它是
 * `{ 来源文件路径: { 目标文件路径: 引用次数(number) } }`；**刚起来时是空的**，
 * 约 2 秒内建好（21 个文件 / 5 个来源 / 1 个目标）；⚠️ 而且它**连画布里的引用也算**
 * （写一个指向附件的 `.canvas`，两秒后那条引用出现在索引里）。
 *
 * ## ⚠️ 为什么要按来源筛成「笔记」
 *
 * 这条命令会把**被引用**的文件移进缓存目录，而"移走"要成立，前提是那些引用会被
 * 同一条命令改写成远端地址。我们的改写器只认 Markdown 笔记里的链接
 * （`planLinkRewrites`）——**画布（`.canvas`）里的引用它不改**。
 * 所以画布引用**必须排除**：否则一个只被画布引用的附件会被搬走，
 * 而画布里的那条引用原地不动 ⇒ **死链**（画布上的图直接没了）。
 * 排除之后那种文件"不被处理"，是这里唯一安全的方向。
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
 * 这些扩展名是**宿主自己的文本文件**，不是用户的附件。
 *
 * ⚠️ 排除它们的理由不是"传上去没用"，而是**传上去会坏**：
 * 一个 `.md` 被上传 + 移入缓存目录之后，宿主的笔记索引看到的是一份
 * 位置变了、名字变了（内容寻址）的文件 —— 笔记之间的 wikilink 会集体断掉。
 * `.canvas` 同理（它引用别的文件），`.base` 是数据库。
 *
 * 用**扩展名**而不是 MIME/内容判断：这一步是纯判定（不读文件字节），
 * 而这三类后缀是宿主的约定（宿主自己也按后缀识别它们）。
 */
const NOTE_LIKE_EXTENSIONS = new Set(["md", "canvas", "base"]);

/** 这个扩展名是不是"宿主自己的文本文件"（笔记/画布/数据库）—— 见上面的说明。 */
export function isNoteLikeExtension(extension: unknown): boolean {
	return typeof extension === "string" && NOTE_LIKE_EXTENSIONS.has(extension.trim().toLowerCase());
}

export interface CandidateSelection {
	/** 要上传的文件路径。 */
	paths: string[];
	/** 被跳过的原因统计（让用户看得见"为什么只传了 N 个"）。 */
	skipped: { reason: string; count: number }[];
	/**
	 * 其中"**没有被任何笔记引用**"的那一类，单独给出一个**结构化**的数字。
	 *
	 * ⚠️ 不让调用方去 `skipped` 里认那串中文文案：文案改了调用方就会静默失效，
	 * 而这条提示正是"为什么我的老图没被处理"的唯一解释（用户跑这条命令的预期
	 * 往往是"把没搬的全搬"，而它只动被引用着的那些）。
	 */
	unreferenced: number;
}

/** 挑出要批量上传的文件。 */
export function selectUploadCandidates(files: readonly VaultFileLike[], options: CandidateOptions): CandidateSelection {
	const paths: string[] = [];
	const reasons = new Map<string, number>();
	let unreferenced = 0;
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const file of files) {
		if (!file || typeof file.path !== "string" || file.path.trim() === "") {
			bump("路径为空");
			continue;
		}

		const extension = String(file.extension ?? "").replace(/^\./, "").toLowerCase();
		if (isNoteLikeExtension(extension)) {
			bump("是笔记/画布/数据库文件，不是附件");
			continue;
		}

		// ⭐ 只处理**被笔记引用着**的文件：命令成功后会把它移进缓存目录，
		// 而没有引用的文件搬走只会让人以为丢东西（见 `referencedPaths`）。
		if (!options.referencedPaths.has(file.path)) {
			bump("没有被任何笔记引用");
			unreferenced += 1;
			continue;
		}

		// 尺寸为 0：多半是同步中的占位文件。传上去会得到一个坏对象，
		// 而"跳过它、等下次"没有任何损失。
		if (typeof file.stat?.size === "number" && file.stat.size <= 0) {
			bump("文件为空（可能是同步中的占位）");
			continue;
		}

		// 索引里已经有指向这个路径的副本 ⇒ 它已经被处理过了。
		if (options.index.findByCachePath(file.path)) {
			bump("已经在缓存索引里");
			continue;
		}

		paths.push(file.path);
	}

	return {
		paths,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
		unreferenced,
	};
}

// ─────────────────────────── 站外图（外链）候选 ───────────────────────────

/** 一篇笔记的正文（外链扫描的输入）。 */
export interface NoteTextLike {
	path: string;
	text: string;
}

/** 一个站点的汇总（确认框据此说明"将从哪些站点下载"）。 */
export interface ExternalSiteSummary {
	host: string;
	/** 这个站点下有多少张图。 */
	count: number;
}

/** 一张待处理的外链图。 */
export interface ExternalCandidate {
	url: string;
	/** 它出现在哪篇笔记里（改写链接要指名道姓）。 */
	notePath: string;
	host: string;
}

export interface ExternalCandidateOptions {
	settings: PluginSettings;
	/** 存储是否就绪（调用方同步算好）。 */
	configured: boolean;
	/** 安全拦截的可替换接缝；默认 `isBlockedHost`。 */
	blockedHost?: (host: string) => boolean;
}

export interface ExternalSelection {
	/** 要处理的（URL, 笔记）对。同一张图出现在多篇笔记里就会有多个条目。 */
	candidates: ExternalCandidate[];
	/** 站点汇总，按主机名排序（顺序稳定，便于断言与展示）。 */
	sites: ExternalSiteSummary[];
	/**
	 * 跳过原因统计（诊断用，与库内那部分同一个形状）。
	 *
	 * ⚠️ 刻意**不做**"因为 XX 而跳过了 N 张"这种展示：那个数**算不准** ——
	 * 功能关掉、自己的存储地址、回环地址、存储未就绪都会**先一步**把图挡掉，
	 * 归到任何一句给用户看的话上都可能是假的。
	 * 判定层给的原因是**诊断**（谁挡的、为什么），不是给用户看的分类。
	 */
	skipped: { reason: string; count: number }[];
}

/**
 * 找出笔记里**指向站外文件**的地址。
 *
 * 1.1.0 起不再只认图片（需求 R15）—— 音频、视频、PDF、压缩包同样可以缓存。
 * 收这四种写法：
 * - `![说明](https://…)`（嵌入，可带尖括号与标题）
 * - `[说明](https://…)`（**普通链接** —— 它可能是 PDF、也可能是网页）
 * - `<img src="https://…">`
 * - `<a href="https://…">`
 *
 * ## 为什么现在敢收普通链接
 *
 * 以前不收，是因为下载端只接受图片：收进来只会换来一串"不是图片"的失败。
 * 现在下载端接受**任意文件**（仍拒收网页，见 `isAttachmentResponse`），
 * 而 `[说明](url)` 正是 PDF / 音频 / 压缩包最常见的写法 —— 不收它，
 * "支持所有格式"就只覆盖用户用 `![]` 写的那部分。
 *
 * ⚠️ 于是候选里会混进**网页链接**。它们会在下载那一步被 `text/html` 判据挡掉，
 * 用户看到的是"该地址返回的是网页或纯文本" —— 一句**如实**的说明，
 * 而不是静默什么都不发生（原则⑥）。判定（要不要碰）仍然完全交给
 * `decideExternalCache`，这里只负责"从正文里挑出候选地址"。
 *
 * wikilink（`![[…]]`）不可能是外链（它指的是库内路径），所以不用管。
 */
export function externalFileUrlsIn(text: string): string[] {
	if (typeof text !== "string" || text === "") return [];
	const urls = new Set<string>();

	// Markdown：嵌入与普通链接都收 —— **不需要**写 `!?`：`![a](url)` 里的 `[a](url)`
	// 本来就会被 `\[` 命中（锚点在 `[` 上，`!` 不属于匹配的一部分）。
	for (const match of text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>)\n]*>|[^)\s\n]+)/g)) {
		const raw = stripAngles(match[1]);
		if (isHttpUrl(raw)) urls.add(raw);
	}
	// 行内 HTML：图片与锚点都收
	for (const match of text.matchAll(/<(?:img|a)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gi)) {
		const raw = String(match[1] ?? match[2] ?? "").trim();
		if (isHttpUrl(raw)) urls.add(raw);
	}

	return [...urls];
}

function stripAngles(value: string): string {
	const trimmed = String(value ?? "").trim();
	return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

/**
 * 挑出"笔记里指向别处、还没进你自己存储"的图片作为候选。
 *
 * ## 判定**不在这里另写一套**
 *
 * 每一张图都交给 `decideExternalCache` —— 也就是"看笔记时按需缓存"那条链路用的
 * **同一个判定**。于是这些性质自动一致：功能关掉就不碰、自己的存储地址不当外链、
 * 回环/链路本地地址一律不碰、存储没配好时不出现在清单里。
 *
 * ## ⭐ `wait` 也算候选（这是"默认不缓存"那一档能用的前提）
 *
 * 候选的判据是 `isCacheableExternal`（"**能不能**搬"），**不是**"这次就该搬"。
 * 否则用户把默认设成「什么都不做」之后，这条命令与选择器会列出一份空清单 ——
 * 两个显式入口等于不存在。`wait` 的语义是"等你来挑"，不是"不许碰"。
 *
 * ## 授权不在这里做
 *
 * 判定只回答"能不能搬"。**真正的授权是两个显式动作**：
 * 这条命令的确认框（点确认 = 同意去访问列出来的那些站点），
 * 以及「选择要缓存的外链图片」里的勾选。红线仍然是
 * **「没有用户的显式动作，站外图永不下载」**。
 */
export function selectExternalUploadCandidates(
	notes: readonly NoteTextLike[],
	options: ExternalCandidateOptions
): ExternalSelection {
	const candidates: ExternalCandidate[] = [];
	const bySite = new Map<string, ExternalSiteSummary>();
	const reasons = new Map<string, number>();

	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const note of notes ?? []) {
		const path = typeof note?.path === "string" ? note.path.trim() : "";
		if (!path) continue;

		// 同一篇笔记里同一个地址写两遍只产生一个候选 —— 去重**在 `externalFileUrlsIn` 里**已经做了
		//（它按地址去重）。这里曾经还有一层"按笔记 + 地址"的去重，**变异验证证明它永远走不到**：
		// `getMarkdownFiles()` 不会给出重复路径，而每篇笔记的地址表本来就已去重。
		// 与其留一段看起来在防什么、实际防不住的代码，不如删掉并把"去重来自哪里"写清楚。
		for (const url of externalFileUrlsIn(note?.text ?? "")) {
			const decision = decideExternalCache({
				src: url,
				settings: options.settings,
				configured: options.configured,
				blockedHost: options.blockedHost,
			});

			if (!isCacheableExternal(decision)) {
				// 跳过的**原因**照实记下来（诊断用）。判定层给的就是那句原因，不需要我再猜。
				if (decision.action === "ignore") bump(decision.reason);
				continue;
			}

			const host = decision.host;
			candidates.push({ url, notePath: path, host });

			const summary = bySite.get(host);
			if (summary) summary.count += 1;
			else bySite.set(host, { host, count: 1 });
		}
	}

	// 站点排序固定（按主机名）：输出稳定，断言与展示都不会因为读目录的顺序而变
	const sites = [...bySite.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));

	return {
		candidates,
		sites,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}
