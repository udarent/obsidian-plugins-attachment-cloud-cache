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
 * 于是"功能关掉 / 自己的存储 / 回环地址 / 用户标过不再询问"全都自动一致。
 *
 * ## 谨慎的地方：这是唯一会改动**用户笔记**的功能
 *
 * 上传本身不碰笔记；但要让老图真正"搬到图床"，笔记里的本地链接必须换成远端
 * 链接 —— 那一步会重写用户的 `.md` 文件。所以选候选时**宁少不多**：
 *
 * - 只挑**扩展名在启用清单里**的（用户已经声明过"这些才是要处理的图"）；
 * - 跳过**已经在索引里**的（同一个 key = 同一份内容，重复上传没有意义，
 *   而且会让"哪些是新的"变得难以解释）；
 * - 跳过尺寸为 0 的（多半是同步中的占位文件，读出来是空的 ——
 *   上传一个空文件比跳过更糟：远端会多一个坏对象）。
 */

import type { PluginSettings } from "../types";
import type { CacheIndex } from "../cache/index";
import { isExtensionEnabled } from "../settings";
import { decideExternalCache } from "../render/external-decide";
import type { SiteDecisions } from "../render/site-decisions";

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
}

export interface CandidateSelection {
	/** 要上传的文件路径。 */
	paths: string[];
	/** 被跳过的原因统计（让用户看得见"为什么只传了 N 个"）。 */
	skipped: { reason: string; count: number }[];
}

/** 挑出要批量上传的文件。 */
export function selectUploadCandidates(files: readonly VaultFileLike[], options: CandidateOptions): CandidateSelection {
	const paths: string[] = [];
	const reasons = new Map<string, number>();
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const file of files) {
		if (!file || typeof file.path !== "string" || file.path.trim() === "") {
			bump("路径为空");
			continue;
		}

		const extension = String(file.extension ?? "").replace(/^\./, "");
		if (!isExtensionEnabled(extension, options.settings)) {
			bump("扩展名不在启用清单里");
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
	/** 用户**还没答过**这个站点 ⇒ 本次执行前必须拿到授权。 */
	needsConsent: boolean;
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
	/** 站点记忆（**同步内存读**）。用户标过「不再询问」的站点一律跳过。 */
	decisions: SiteDecisions;
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
	/** 有站点需要本次授权（确认框要因此多说明一句）。 */
	needsConsent: boolean;
	/**
	 * 跳过原因统计（诊断用，与库内那部分同一个形状）。
	 *
	 * ⚠️ 刻意**不做**"因为被你标成不再询问而跳过了 N 张"这种展示：
	 * 那个数**算不准** —— 功能关掉、自己的存储地址、回环地址都会**先一步**
	 * 把图挡掉，此时说"被你的不再询问列表跳过"就是假的。
	 * 判定层给的原因是**诊断**（谁挡的、为什么），不是给用户看的分类。
	 */
	skipped: { reason: string; count: number }[];
}

/**
 * 找出笔记里的**外链图片**地址。
 *
 * 只认"图片"的两种写法：
 * - Markdown：`![说明](https://…)`（允许尖括号包住、允许后面跟标题）
 * - 行内 HTML：`<img src="https://…">`
 *
 * ⚠️ **刻意不收普通链接**（`[说明](https://…)`）：它指向的是网页，不是图片。
 * 这条命令的候选是**真的要去下载**的，收进来只会换来一串"不是图片"的失败。
 * 这也与"看笔记时按需缓存"那条链路的范围一致 —— 那边只看得见 `<img>` 元素。
 *
 * wikilink（`![[…]]`）不可能是外链（它指的是库内路径），所以不用管。
 */
export function externalImageUrlsIn(text: string): string[] {
	if (typeof text !== "string" || text === "") return [];
	const urls = new Set<string>();

	for (const match of text.matchAll(/!\[[^\]\n]*\]\(\s*(<[^>)\n]*>|[^)\s\n]+)/g)) {
		const raw = stripAngles(match[1]);
		if (isHttpUrl(raw)) urls.add(raw);
	}
	for (const match of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gi)) {
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
 * 回环/链路本地地址一律不碰、**用户标过「不再询问」的站点直接跳过**。
 * 命令与按需缓存对"该不该处理这张图"永远不会有第二种答案。
 *
 * ## 授权不在这里做
 *
 * 判定只会告诉调用方 `needsConsent`（这个站点用户还没答过）。**真正的授权发生在
 * 命令的确认框里** —— 点确认就是对列出来的那些站点授权，随后它们会被记成
 * 「缓存」。这条链路与按需缓存一样守着那条红线：**未获明确同意前，站外图永不下载**。
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

		// 同一篇笔记里同一张图写两遍只产生一个候选 —— 去重**在 `externalImageUrlsIn` 里**已经做了
		//（它按地址去重）。这里曾经还有一层"按笔记 + 地址"的去重，**变异验证证明它永远走不到**：
		// `getMarkdownFiles()` 不会给出重复路径，而每篇笔记的地址表本来就已去重。
		// 与其留一段看起来在防什么、实际防不住的代码，不如删掉并把"去重来自哪里"写清楚。
		for (const url of externalImageUrlsIn(note?.text ?? "")) {
			const decision = decideExternalCache({
				src: url,
				settings: options.settings,
				decisions: options.decisions,
				configured: options.configured,
				blockedHost: options.blockedHost,
			});

			if (decision.action === "ignore") {
				// 跳过的**原因**照实记下来（诊断用）。用户标过「不再询问」的站点也走这里 ——
				// 判定层给的正是那句原因，不需要我再猜。
				bump(decision.reason);
				continue;
			}

			const host = decision.host;
			candidates.push({ url, notePath: path, host });

			const summary = bySite.get(host);
			if (summary) summary.count += 1;
			else bySite.set(host, { host, count: 1, needsConsent: decision.action === "ask" });
		}
	}

	// 站点排序固定（按主机名）：输出稳定，断言与展示都不会因为读目录的顺序而变
	const sites = [...bySite.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));

	return {
		candidates,
		sites,
		needsConsent: sites.some((site) => site.needsConsent),
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}
