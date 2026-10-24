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
 * - ⭐ **只挑「确实被笔记引用着」的**（`referencedPaths`）：命令跑完会把它们的**链接改写成远端地址**
 *   （⚠️ 2026-10-15 更正：1.2.0 / D-17 起**没有缓存目录、什么都不搬** —— 文件留在原处**就地当本地副本**）。
 *   这个前提是"改了链接之后，那张图仍然显示得出来"。
 *   用户放在附件目录里、**没有任何笔记引用**的文件一概不碰（既不传也不动）——
 *   那种文件多半是废弃的旧图，动了只会让人以为丢东西。
 * - ⭐ 1.1.0 起**不再按类型白名单挑**，而是**排除制**：排除"笔记/画布/数据库"这三种
 *   宿主自己的文本文件（它们不是附件），其余一律可处理（需求 R15：**附件**类型不再要白名单）。
 *   ⚠️ 这条把候选面从"十来个图片后缀"放大到"库里每一个文件"，所以**排除列表是硬要求**，
 *   测试逐项钉住（没有它，一条命令会把整个库搬空）；
 * - 跳过**已经在索引里**的（同一个 key = 同一份内容，重复上传没有意义，
 *   而且会让"哪些是新的"变得难以解释）；
 * - 跳过尺寸为 0 的（多半是同步中的占位文件，读出来是空的 ——
 *   上传一个空文件比跳过更糟：远端会多一个坏对象）。
 */

import type { PluginSettings } from "../types";
import type { CacheIndex } from "../cache/index";
import { decideExternalCache } from "../render/external-decide";
import type { ExternalCachePurpose } from "../render/external-decide";
// ⭐ 本机文件（`file:///D:/…`）的判定 —— 与站外那份**并列**，不是套在它里面（两者的判据不同，
// 一个看主机/站点名单，一个看平台/扩展名；混成一个函数会让两边的 reason 说不清是谁给的）。
import { decideLocalFile, localPathFromUrl } from "../local-file";
import type { LocalFileProbe } from "../local-file";
import { NOTE_LIKE_REASON, isNoteLikeExtension } from "../vault-files";
import { EMBED_TAGS, htmlAttributeTargets, markdownLinks } from "./references";

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
	 * 只有在这个集合里的文件才会被选上 —— 因为这条命令跑完会把这些文件**当成本地副本**
	 * （⚠️ 留在原处、不搬）并把笔记里的链接改写成远端地址；"改了链接之后那张图还显示得出来"正是它的前提
	 * （见文件头）。集合外的文件一概不碰。
	 *
	 * 取值的来源是宿主的链接索引（`metadataCache.resolvedLinks`），而不是我们自己扫正文：
	 * 宿主认识所有链接形态（`![[图.png]]`、`![](attachments/图.png)`、别名、子路径……），
	 * 我们重写一遍只会得到一个更窄的近似 —— 而这里的判据是"能不能安全地把它搬走"，
	 * **漏判的代价是死链**，必须用宿主自己的解析结果。
	 */
	referencedPaths: ReadonlySet<string>;
	/**
	 * 要不要把**没有被任何引用的文件**也收进候选（`D-68`）。**默认 `false`**。
	 *
	 * ⚠️⚠️ 默认必须是 `false`，不是 `true`：这条路有两个调用方，方向相反 ——
	 * - **「上传附件」命令**（`plugin/upload-existing-flow.ts`）传 `true`：用户在那里逐项勾选，
	 *   而"没引用的也传"是他明确要的（D-68）；
	 * - **自动接管**（`maintenance/attach-watch.ts`）**绝不传**：它处理的是"刚进库、链接还没写进笔记"
	 *   的文件 —— 那一刻它当然"没有被任何引用"。收进来就会**抢在链接写进去之前上传并搬走**，
	 *   而随后写进来的那条链接指向的是旧位置 ⇒ **死链**（这条在 `attach-watch` 的套件里钉着）。
	 * ⇒ 谁要"连没引用的也传"，谁显式开口子；默认按旧行为走。
	 */
	includeUnreferenced?: boolean;
	/**
	 * 其中「笔记/画布文本里那条链接**还是本地的**」的那些（`referenceSnapshot().rewritable`）。
	 *
	 * ## ⭐ 它只有一个用途：让"已经传过的"能被**重修**
	 *
	 * ⚠️⚠️ 2026-10-21 用户实测报的：对象早就传上去了，而笔记里那条链接还是本地路径
	 *（当时是改写没认出来 —— D-56 的括号截断）。他想到的修法就是**再跑一次「上传附件」**，
	 * 而旧判据按"已经在缓存索引里"把那个文件跳过了 ⇒ **重跑永远修不好它**，
	 * 用户唯一的出路是手工改笔记。所以这条输入就是为此加的：
	 * 索引里**有**记录、而正文里**仍**写着本地路径 ⇒ 那不是"处理过了"，是"只做了一半"。
	 *
	 * ## 为什么不能直接用 `referencedPaths` 顶上
	 *
	 * 那是"有人指着它"，稳态下**永远为真**：画布的 `file` 节点只能指向库内文件
	 *（宿主限制，永远不会被改成 URL）⇒ 拿它当"待修"，每个摆在画布上的附件每轮都会
	 * 被列一遍、还要读一遍字节。而这个集合**只收能改写的写法**（笔记正文 + 画布文本节点），
	 * 见 `notes-query.ts::ReferenceSnapshot.rewritable`。
	 *
	 * ⚠️ 必填而不是可选：可选会让"忘了传"变成"永远不修"（静默的方向），
	 * 而这条判据的缺失症状正是用户已经报过一次的那个。
	 */
	repairablePaths: ReadonlySet<string>;
}

export interface CandidateSelection {
	/**
	 * 要上传的文件路径（**全部**：被引用的 ＋ 没有被任何引用的）。
	 *
	 * ⚠️ 2026-10-22（D-68）：未引用的那些**也在这里** —— 它们同样要传，只是不会被改写
	 *（没有链接可改）。`unreferencedPaths` 是它们的子集，用来区分"这一份传完就完事了"
	 * 与"这一份传完还要改笔记"。
	 */
	paths: string[];
	/**
	 * 其中**没有被任何笔记 / 画布引用**的那些（D-68）。
	 *
	 * ⚠️ 单独列出来有三个用途，都不是"可选"的：
	 * ① 清单里要标出来（默认**不勾**：传上去只是备份，不会出现在任何笔记里）；
	 * ② 执行层**不许**为它们生成改写规则（会平白扫一遍全库，几百份就是几百遍）；
	 * ③ 确认框要如实说清"这些没有任何笔记引用"。
	 */
	unreferencedPaths: string[];
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
	/**
	 * 其中「**早就传过、只是笔记里那条链接还是本地的**」那些（D-57 的重修）。
	 *
	 * ⚠️ 2026-10-22（D-71）：从"只有个数"改成**路径集合** —— 这条信息从摘要**下沉到了行内**
	 * （用户反馈"上部文案太长，信息改到列表上面/里面去"）：那几行的勾选框旁边要标「只改链接」，
	 * 用户才不会以为命令在重传一遍。
	 * ⚠️ 不给个数：个数就是 `repairPaths.length`，两个字段说同一件事迟早分叉。
	 */
	repairPaths: string[];
}

/** 挑出要批量上传的文件。 */
export function selectUploadCandidates(files: readonly VaultFileLike[], options: CandidateOptions): CandidateSelection {
	const paths: string[] = [];
	const unreferencedPaths: string[] = [];
	const repairPaths: string[] = [];
	const reasons = new Map<string, number>();
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const file of files) {
		if (!file || typeof file.path !== "string" || file.path.trim() === "") {
			bump("路径为空");
			continue;
		}

		const extension = String(file.extension ?? "").replace(/^\./, "").toLowerCase();
		if (isNoteLikeExtension(extension)) {
			bump(NOTE_LIKE_REASON);
			continue;
		}

		// 索引里已经有指向这个路径的副本 ⇒ 它已经被处理过了。
		//
		// ⚠️⚠️ **除非**笔记里那条链接还是本地的（`repairablePaths`）：那说明上一次只做了一半
		//（字节传上去了、链接没改 —— 2026-10-21 的 D-56 就是这么暴露的），
		// 或者用户是先传后补的链接。这时必须让它重新进候选，否则「再跑一次」永远修不好它
		// —— 而用户能想到的修法恰恰就是"重新上传附件"。
		// ⚠️ 代价可控：只有"索引里有、正文里仍写着本地路径"的那些会再读一遍字节；
		// 稳态下（链接都改过了）这个集合是空的。
		//
		// ⚠️⚠️ **这一步必须排在"有没有被引用"之前**（2026-10-22 审计修的）。
		// 原来它在后面，于是**已经迁移好的**文件会先撞上"没有被任何笔记引用"：
		// 那份文件的正文引用早就被改写成**远端 URL** 了，而 `referencedPaths` 只装
		// **本地路径** ⇒ 它必然不在里面 ⇒ 用户看到「另有 N 个文件没有被任何笔记引用」，
		// 而**同一批文件在「查看缓存占用」里是"在用"、在「检查未引用的云端附件」里也不问**
		// —— 三条命令对同一件事说了三种话（探针实测 2 个文件就这么被说反了）。
		// ⇒ 顺序换成"先问处理过没有，再问有没有引用"：前者的答案在任何阶段都成立，
		// 后者只在"还没处理过"的文件上才有意义。
		if (options.index.findByCachePath(file.path)) {
			if (!options.repairablePaths.has(file.path)) {
				bump("已经在缓存索引里");
				continue;
			}
			paths.push(file.path);
			repairPaths.push(file.path);
			continue;
		}

		// 尺寸为 0：多半是同步中的占位文件。传上去会得到一个坏对象，
		// 而"跳过它、等下次"没有任何损失。
		// ⚠️ 这一关对**两类都**适用（被引用 / 没有被引用），所以放在引用判定**之前**。
		if (typeof file.stat?.size === "number" && file.stat.size <= 0) {
			bump("文件为空（可能是同步中的占位）");
			continue;
		}

		// ⭐⭐ 2026-10-22（D-68，用户明确要求）：**没有被任何引用的附件也要处理**。
		//
		// 原来的口径是"只动被引用的那些"（理由：命令会改写链接，没引用的传上去只是白占空间）。
		// 用户推翻了它 —— 他要的是"一条命令把库里该传的都传了"，包括那些暂时没人引用、但
		// 他想一起备份上去的。⇒ 进候选，但**单独标出来**：
		// - 清单里默认**不勾**（传上去不会出现在任何笔记里，得他自己决定）；
		// - 执行层不为它们生成改写规则（没有链接可改，生成规则只会平白扫全库）。
		// ⚠️ 这里的"引用"是**本地路径**那一半（远端 URL 引用意味着"已经处理过"，上面那一关就退出了）。
		if (!options.referencedPaths.has(file.path)) {
			// ⚠️ 默认**不收**（见 `includeUnreferenced` 的说明）：自动接管那条路处理的是
			// "链接还没写进笔记"的文件，收它就会抢在链接之前搬走、留下死链。
			if (options.includeUnreferenced !== true) {
				bump("没有被任何笔记引用");
				continue;
			}
			unreferencedPaths.push(file.path);
		}

		paths.push(file.path);
	}

	return {
		paths,
		unreferencedPaths,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
		unreferenced: unreferencedPaths.length,
		repairPaths,
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
	/**
	 * ⭐ 是不是**本机文件**（`file:///D:/…`）。
	 *
	 * ⚠️ 界面据此说话：它的 `url` 是一条**本机绝对路径**，所以列表里必须**原样显示**它 ——
	 * 用户 2026-10-15 定的边界是"只走显式入口 + 不加目录白名单"，于是"逐份勾选"就是那次同意，
	 * 而**看得见路径**是那次同意能成立的前提（只显示文件名＝让人在看不见风险的情况下点确认）。
	 */
	local: boolean;
}

export interface ExternalCandidateOptions {
	settings: PluginSettings;
	/** 存储是否就绪（调用方同步算好）。 */
	configured: boolean;
	/** 安全拦截的可替换接缝；默认 `isBlockedHost`。 */
	blockedHost?: (host: string) => boolean;
	/**
	 * ⭐ 当前是不是桌面端（`file:///D:/…` 那条路要它：手机拿不到本机绝对路径）。
	 *
	 * ⚠️ **由装配点算好传进来**（`main.ts` 的 `isDesktopHost()`）—— 这一层保持**纯**：
	 * 不 import 宿主、不看 `Platform`，于是"谁去问平台"全库只有一处。详见 `local-file.ts` 模块头。
	 */
	isDesktop: boolean;
	/**
	 * ⭐ 站外候选**要不要受设置里的开关与站点名单约束**（必填，2026-10-24）。
	 *
	 * - `"auto"`：**按设置走** —— 功能关着就一个都不收，名单（白 / 黑）照样生效。
	 *   ⚠️ 这是「上传全部附件」现在用的档：那条链已经**没有清单**了，用户看不到
	 *   "会访问哪台主机"，于是"要不要碰站外"只能靠**事前**设置表达
	 *   （打开「站外文件」开关 ＋ 配好名单）。用户 2026-10-24 定的口径。
	 * - `"manual"`：无视开关与名单（这是清单形态的语义：勾选本身即同意）。
	 *
	 * ⚠️ **必填**：漏传等于静默地把开关作废（本项目最警惕的失败形态）——
	 * 而这条一旦静默，表现是"用户关掉了站外功能，插件照样去别人的服务器拉图"。
	 */
	purpose: ExternalCachePurpose;
	/**
	 * 本机文件（`file:///…`）要不要算候选（必填，2026-10-24）。
	 *
	 * ⚠️ 与站外那条**分开**：它们的授权来源不同。站外受"站外开关 ＋ 名单"约束，
	 * 本机受 {@link PluginSettings.uploadLocalFiles} 约束 —— 两件事，两个开关。
	 */
	includeLocalFiles: boolean;
	/**
	 * 只看**这些笔记**（范围过滤，2026-10-22）。缺省 = 全部笔记。
	 *
	 * ⚠️ 用途只有一个：「上传附件」的清单可以勾选「只看当前笔记」。
	 * 过滤放在**这一层**而不是调用方去筛结果 —— 站点汇总（`sites`）与跳过统计都按
	 * 同一批笔记重算，于是"另有 N 个文件托管在站外，来自 M 个站点"不会与清单对不上。
	 * 调用方自己筛一遍的结果里，`sites` 仍然写着全库的数字（两句话各说各的）。
	 */
	notePaths?: ReadonlySet<string>;
}

export interface ExternalSelection {
	/** 要处理的（URL, 笔记）对。同一张图出现在多篇笔记里就会有多个条目。 */
	candidates: ExternalCandidate[];
	/** 站点汇总，按主机名排序（顺序稳定，便于断言与展示）。 */
	sites: ExternalSiteSummary[];
	/**
	 * ⭐ 候选里**本机文件**的条数。
	 *
	 * ⚠️ 单独一个数而不是并进 `sites`：本机路径**没有主机**，硬塞一个伪主机名会让
	 * "来自 N 个站点"那句话变成假话（它会把本机路径数成一个站点）。
	 */
	localFiles: number;
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
 * 把**已经不在了**的本机文件候选摘掉（`file:///…` 指着的那个东西没了）。
 *
 * ## 为什么需要这一步（2026-10-16 用户实测报的）
 *
 * `decideLocalFile` 是**纯**判据（不碰磁盘），所以"文件还在不在"它答不上来 ⇒
 * 临时目录里的东西（WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存）天天在消失，
 * 用户看到的是一行**没有缩略图、点了一定失败**的条目。他的原话：
 * 「没有缩略图的文件实际上已经不存在了，**不应该上传，即便上传也会失败**」。
 *
 * ## 分工（与 `decideLocalFile` 一样是"纯的那半"）
 *
 * "读得到吗"**由调用方注入**（`LocalFileProbe`）—— 这一层不碰磁盘，
 * 只按探测结果把候选分成"留着"和"没了"两拨。于是判据可穷举、I/O 只有一处。
 *
 * ⚠️ **站外候选一律保留**：它们的"在不在"要联网才知道，那是执行层的事
 *（那时会如实报"该地址返回 404 / 不是附件"）。
 * ⚠️ 本机路径解析不出来时按"没了"处理（`decideLocalFile` 保证这走不到，
 * 但分流函数不该因为一个坏输入把整批拖垮）。
 */
export async function dropMissingLocalCandidates(
	candidates: readonly ExternalCandidate[],
	probe: LocalFileProbe
): Promise<{ kept: ExternalCandidate[]; missing: ExternalCandidate[] }> {
	const kept: ExternalCandidate[] = [];
	const missing: ExternalCandidate[] = [];
	for (const candidate of candidates ?? []) {
		if (!candidate) continue;
		if (!candidate.local) {
			kept.push(candidate);
			continue;
		}
		const path = localPathFromUrl(candidate.url);
		if (!path || !(await probe(path))) {
			missing.push(candidate);
			continue;
		}
		kept.push(candidate);
	}
	return { kept, missing };
}

/**
 * 一处地址 + 它在笔记里是**被显示**还是**只被指向**。
 *
 * ⚠️ 这个区分不是"锦上添花"：判定层那两道形状判据（"尾巴得像文件名"+"后缀得像文件类型"）
 * **只对"指向"的地址施加** —— 笔记在**显示**一个资源时（`![]()` / `<img>`），
 * 那个地址长什么样与"它是不是文件"无关（图片 CDN 的令牌形状地址、`/photo?id=5` 都很常见，
 * 而它们**确实是文件**）。少了这个字段，那类图会在候选清单里**静默消失**。
 */
export interface ExternalUrlEntry {
	url: string;
	/**
	 * 笔记是在**显示**它（`![]()` / `<img>` / `<video>`）还是只**指向**它（`[]()` / `<a>` / `<iframe>`）。
	 * ⚠️ 同一个地址出现多次时，**任一次是"显示"就算显示** —— 笔记确实在显示它。
	 */
	embedded: boolean;
}

/**
 * 找出笔记里**指向站外文件或本机文件**的地址，**并带上"它是不是被显示"**。
 *
 * 1.1.0 起不再只认图片（需求 R15）—— 音频、视频、PDF、压缩包同样可以缓存。
 * 收这四种写法：
 * - `![说明](https://…)`（**显示**，可带尖括号与标题）
 * - `[说明](https://…)`（**指向** —— 它可能是 PDF、也可能是网页）
 * - `<img src="https://…">` 之类（标签名决定，见 `references.ts::EMBED_TAGS`）
 * - `<a href="https://…">`（**指向**）
 *
 * ## 为什么现在敢收普通链接
 *
 * 以前不收，是因为下载端只接受图片：收进来只会换来一串"不是图片"的失败。
 * 现在下载端接受**任意文件**（仍拒收网页，见 `isAttachmentResponse`），
 * 而 `[说明](url)` 正是 PDF / 音频 / 压缩包最常见的写法 —— 不收它，
 * "支持所有格式"就只覆盖用户用 `![]` 写的那部分。
 *
 * ⚠️ 一个**网页**链接同样会被收进来（这里只判「是不是 http(s) 地址」），
 * 但它**不会变成候选** —— 判定层有三道闸门，各自对应一次实测（2026-10-16 连着五次）：
 * - **网页**（后缀是页面 / 页面程序：`…/player.html`、`…/pd.jsp?id=172`）—— **两路都拦**；
 * - **形状**（只对"指向"的地址）：尾巴得有点（`…/wiki/资料归档管理规定` 没有），
 *   且那个后缀得像文件类型（`…/tree/5.1-translation_terms` 的点后面是分支名、
 *   `…/tree/v1.2.3` 是纯数字 —— 那都是版本号 / 分支名的形状）。
 *（三处说明都在 `decideExternalCache`。）
 * ⇒ 这个函数的产物是「**可能是文件的地址**」，不是「候选」：候选由判定层定，
 * 这里只负责「从正文里挑出地址、并记下笔记是显示它还是指向它」。
 *
 * wikilink（`![[…]]`）不可能是外链（它指的是库内路径），所以不用管。
 */
export function externalUrlEntriesIn(text: string): ExternalUrlEntry[] {
	if (typeof text !== "string" || text === "") return [];
	// 两桶分开收：http 那一路与 `file:` 那一路的**分界规则不同**（见下面），
	// 但两桶都要保序、去重、并合并"是否被显示"。`true` 覆盖 `false`：任一次显示就算显示。
	const http = new Map<string, boolean>();
	const local = new Map<string, boolean>();
	const add = (bucket: Map<string, boolean>, raw: string, embedded: boolean) => {
		const seen = bucket.get(raw);
		if (seen === undefined || (embedded && !seen)) bucket.set(raw, embedded);
	};

	// Markdown：嵌入与普通链接都收 —— **不需要**判 `!?` 前缀两次：`markdownLinks`
	// 已经给出 `embed`（`![a](url)` 与 `[a](url)` 都收）。
	//
	// ⚠️⚠️ **位置来自 `references.ts::markdownLinks`，不在这里另写正则**（2026-10-21）：
	// 各写一份的代价是同一个缺陷修一处、另一处继续截断 —— 用户那条 `… 4年(1).pdf`
	// 修好之后，站外/本机这一路照样按"第一个 `)`"截成 `… 4年(1`：
	// `https://…/Foo_(bar).pdf` 会拿半截地址去下载（404 或者下到别的东西），
	// 而 `file:///D:/tmp/报告(1).pdf` 更糟 —— `localFileExists` 说"不在"，
	// `dropMissingLocalCandidates` 就把它**静默摘掉**，用户永远等不到这一条被处理。
	//
	// 分界**仍然分两路**（这是业务规则，不是位置）：http 地址里不可能有空格 ⇒ 按第一个空白切；
	// 本机路径常带空格（`D:/My Documents/…`）⇒ 只在标题引号处切。
	for (const link of markdownLinks(text)) {
		const raw = httpTargetOf(text.slice(link.start, link.end));
		if (!isHttpUrl(raw)) continue;
		add(http, raw, link.embed);
	}
	// 行内 HTML：标签属性里的地址 —— ⚠️ 正则与解析层**共用一份**（`references.ts` 的
	// `HTML_ATTRIBUTE`）：各写一遍迟早分叉成"改写认得、候选不认得"（而且不报错）。
	// 标签集因此也一致（img / a / video / audio / source 这类带 src|href 的都算）——
	// 而"哪个标签是显示"由 `EMBED_TAGS` 一处定。
	for (const { value, tag } of htmlAttributeTargets(text)) {
		if (isHttpUrl(value)) add(http, value, EMBED_TAGS.has(tag));
	}

	// ⭐ 本机文件（`file:///D:/…`）—— 与上面两段**刻意分开**，因为分界规则不同：
	// 本机路径**常带空格**（`D:/My Documents/…`），而 http 那一路按第一个空白切
	//（截断出来的路径指向**另一样东西** —— 与 D-25「含空格的 Markdown 目标被截断」同一类坑）。
	// 所以这一路允许空格，只切掉 Markdown 的标题尾巴。位置同样来自 `markdownLinks`。
	for (const link of markdownLinks(text)) {
		const raw = localTargetOf(text.slice(link.start, link.end));
		// 只认 `file:`（http 那一路由上面的规则管，两边的分界规则不同，不能混着用）
		if (!/^file:/i.test(raw)) continue;
		add(local, raw, link.embed);
	}
	// 行内 HTML 里的本机路径：`<img src="file:///D:/…">`（引号形状本就允许空格，与上面共用一条规则）
	for (const { value, tag } of htmlAttributeTargets(text)) {
		if (/^file:/i.test(value)) add(local, value, EMBED_TAGS.has(tag));
	}

	// 顺序照旧：http 那一路在前、`file:` 那一路在后（两桶各自保序）。
	return [
		...[...http].map(([url, embedded]) => ({ url, embedded })),
		...[...local].map(([url, embedded]) => ({ url, embedded })),
	];
}

/** 只要地址（`externalUrlEntriesIn` 的薄包装，供既有调用点与诊断用）。 */
export function externalFileUrlsIn(text: string): string[] {
	return externalUrlEntriesIn(text).map((entry) => entry.url);
}

/**
 * 切掉 Markdown 链接的标题尾巴（`path "标题"` / `path '标题'`）。
 *
 * ⚠️ 只给本机路径那一路用：http 那一路的分界规则天然在空格处停下（见 `httpTargetOf`），
 * 而本机路径允许带空格 ⇒ 标题就得自己切。
 */
function stripMarkdownTitle(value: string): string {
	const trimmed = String(value ?? "").trim();
	const at = trimmed.search(/\s+["']/);
	return (at >= 0 ? trimmed.slice(0, at) : trimmed).trim();
}

/**
 * Markdown 目标的**两路切法**（业务规则，位置由 `references.ts::markdownLinks` 给）。
 *
 * - {@link httpTargetOf}：http 地址里不可能有空格 ⇒ 到第一个空白为止，
 *   但**尖括号形式**（`<https://…/c d.png>`）整段算目标 —— 那种写法就是为了装空格；
 * - {@link localTargetOf}：本机路径允许空格 ⇒ 只切标题（`"…"` / `'…'`）。
 *
 * ⚠️ 尖括号都按 `>` 切，**不是** `stripAngles` 那种"两端都得是尖括号"：
 * 带标题的写法 `<x> "标题"` 里，后者会原样返回（于是 `file:` 前缀判定落在 `<` 上 ⇒ 整条漏掉）。
 */
function httpTargetOf(body: string): string {
	const angle = angleValueOf(body);
	if (angle !== null) return angle;
	const trimmed = body.trim();
	return trimmed.split(/\s/)[0] ?? "";
}

function localTargetOf(body: string): string {
	const angle = angleValueOf(body);
	if (angle !== null) return angle;
	return stripMarkdownTitle(body);
}

/** 尖括号形式里的那段（`<…>`）；不是尖括号形式返回 `null`。 */
function angleValueOf(body: string): string | null {
	const trimmed = String(body ?? "").trim();
	if (!trimmed.startsWith("<")) return null;
	const close = trimmed.indexOf(">");
	return close > 0 ? trimmed.slice(1, close) : null;
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
 * ## ⭐ 授权从哪来：由 `purpose` 决定（2026-10-24 改）
 *
 * 同一个函数服务两种授权模型，**必须是调用方表态**（`ExternalCandidateOptions.purpose`）：
 *
 * | 档 | 开关 / 名单 | 谁在用 |
 * |---|---|---|
 * | `"manual"` | **都不管** | 清单形态（勾选 = 同意）。⚠️ 现在没有生产调用方了 |
 * | `"auto"` | **按设置走** | 「上传全部附件」—— 它没有清单，授权只能来自**事前**设置 |
 *
 * ⚠️ 为什么一键链必须是 `"auto"`：那条链**一次确认、不列清单**，用户看不到"会访问哪台主机"，
 * 于是把它接成 `"manual"` 就等于"关掉站外开关之后，插件照样去别人的服务器拉图"。
 * 用户 2026-10-24 的原话：站外图可以用设置里的「站外文件是否上传云端」来确定。
 *
 * ## 本机文件是**另一个**开关
 *
 * `file:///D:/…` 的授权不来自站外那一组设置，而是 `PluginSettings.uploadLocalFiles`
 *（默认关）。分开的理由：站外是"别人的服务器"，本机是"这台电脑上的绝对路径" ——
 * 风险形状不同，用户会想分别决定。
 */
export function selectExternalUploadCandidates(
	notes: readonly NoteTextLike[],
	options: ExternalCandidateOptions
): ExternalSelection {
	const candidates: ExternalCandidate[] = [];
	const bySite = new Map<string, ExternalSiteSummary>();
	const reasons = new Map<string, number>();
	/** ⭐ 本机文件（`file:///D:/…`）的条数 —— 它们没有主机，不进 `sites`（见 `ExternalSelection`）。 */
	let localFiles = 0;

	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const note of notes ?? []) {
		const path = typeof note?.path === "string" ? note.path.trim() : "";
		if (!path) continue;
		// ⭐ 范围过滤（见 `ExternalCandidateOptions.notePaths`）：只扫点名的那些笔记。
		// ⚠️ 放在这里而不是循环外先 `filter` 一遍：调用方递进来的就是全库正文（那份要复用），
		// 这里只跳过不看的，不额外造一份数组。
		if (options.notePaths && !options.notePaths.has(path)) continue;

		// 同一篇笔记里同一个地址写两遍只产生一个候选 —— 去重**在 `externalUrlEntriesIn` 里**已经做了
		//（它按地址去重）。这里曾经还有一层"按笔记 + 地址"的去重，**变异验证证明它永远走不到**：
		// `getMarkdownFiles()` 不会给出重复路径，而每篇笔记的地址表本来就已去重。
		// 与其留一段看起来在防什么、实际防不住的代码，不如删掉并把"去重来自哪里"写清楚。
		for (const { url, embedded } of externalUrlEntriesIn(note?.text ?? "")) {
			// ⭐ 两类地址**各有各的判定，但都在判定层里** —— 这里只负责分流，不另写一套。
			// `not-mine` = 不是本机文件写法 ⇒ 交给站外那份判定。
			const localDecision = decideLocalFile({ src: url, isDesktop: options.isDesktop });
			if (localDecision.action === "ignore") {
				// 跳过的**原因**照实记下来（诊断用）。判定层给的就是那句原因，不需要我再猜。
				bump(localDecision.reason);
				continue;
			}
			if (localDecision.action === "read") {
				// 本机文件：没有主机 ⇒ `host` 留空、不进 `sites`，界面显示的是**那条绝对路径**
				//（见 `ExternalCandidate.local`）。注意**只收桌面端**：手机上这一步就是 `ignore`。
				// ⚠️ 过了平台判据还要过**设置**这一关（2026-10-24）：判定层只回答"读得到吗"，
				// "要不要读库外的东西"是用户的决定（`uploadLocalFiles`，默认关）。
				// 两句分开写：平台判据是"做不到"，设置是"没允许" —— 诊断时要能分得清。
				if (!options.includeLocalFiles) {
					bump("设置里没有允许上传本机文件");
					continue;
				}
				candidates.push({ url, notePath: path, host: "", local: true });
				localFiles += 1;
				continue;
			}

			const decision = decideExternalCache({
				src: url,
				settings: options.settings,
				configured: options.configured,
				// ⭐ 由调用方表态（见 `ExternalCandidateOptions.purpose`）：
				// `"auto"` = 按设置走（「上传全部附件」用它）；`"manual"` = 无视开关与名单。
				// ⚠️ 与 purpose **无关**的是那两道形状判据：它们挂在"这条地址是不是被显示"上
				//（`embedded`，采集层刚算好），因为要问的是"像不像文件"，不是"谁在问"。
				purpose: options.purpose,
				// ⭐ 而"要不要过那两道形状判据"由**这条地址是不是被显示**决定 —— 采集层刚算好
				//（`![]()` / `<img>` 是显示，`[]()` / `<a>` 只是指向）。
				embedded,
				blockedHost: options.blockedHost,
			});

			if (decision.action === "ignore") {
				// 跳过的**原因**照实记下来（诊断用）。判定层给的就是那句原因，不需要我再猜。
				bump(decision.reason);
				continue;
			}

			const host = decision.host;
			candidates.push({ url, notePath: path, host, local: false });

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
		localFiles,
		skipped: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}
