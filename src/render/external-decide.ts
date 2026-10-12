/**
 * 「这张站外图该不该搬、以及**现在**动不动手」的判定（纯函数）。
 *
 * ## 为什么另起一层，而不是扩展 `decideRenderTarget`
 *
 * 那是两个不同的问题：
 * - `decideRenderTarget` 回答"**渲染时该怎么做**"（换本地 / 交给回退下载 / 不动），
 *   它的输出直接决定浏览器会不会联网；
 * - 这里回答"**要不要把这张图搬进我自己的存储**"，输出还要经过"谁去搬、什么时候搬"。
 *
 * 混在一处会让前者的语义漂移（它被 8 条变异钉着），也会让"站外文件到底会不会
 * 被自动处理"变成一个要看好几处才答得上的问题。分开之后，这件事只有一个答案：
 * **由用户在设置里事前决定**（打开「把站外文件当普通附件处理」，默认关），
 * 逐张的例外交给「挑选要缓存的文件」—— 显式动作只有这两个来源。
 *
 * ## ⭐ 两个结果，外加一个"谁在问"的维度（1.2.0 改）
 *
 * | 结果 | 含义 |
 * |---|---|
 * | `ignore` | **根本不该处理**：地址形态不对、属于本存储、回环/链路本地、存储未就绪，以及（**仅自动**）功能关着或站点被名单挡住 |
 * | `cache` | 该搬 —— **自动**路径直接入队，**候选**路径把它列进清单 |
 *
 * ⭐ `purpose` 决定"功能开关与站点名单这一次管不管"：
 * - `auto`：渲染路径的**自动**处理 —— 受两者约束；
 * - `manual`：「挑选要缓存的文件」与批量命令的**候选** —— 两者都不管。
 *   判据：勾选、点确认本身就是显式动作，而名单是"**自动搬**的准入"、不是安全边界。
 *
 * ⚠️ 这条正是 1.2.0 把旧「什么都不做」那一档删掉之后**必须显式表达**的东西：
 * 从前"能不能搬"与"默认动不动手"是两个问题（后者由 `wait` 表达）；现在默认就是
 * "动手"，于是只剩"能不能搬"，而**谁在问**改由 `purpose` 说 —— 少了它，
 * 「挑选要缓存的文件」会跟着那个开关一起被关掉（本项目最警惕的那类回归）。
 *
 * ## 判定顺序刻意固定
 *
 * 与 `shouldInterceptPaste` 同一个纪律：**先看最便宜、最不会变的开关**，
 * 再看载荷细节。这样"功能被关掉"永远给出同一个原因，不会被别的情况掩盖。
 * 顺序里有两处是安全相关的，不能调换：
 * - **自己的存储优先于"本地地址"**：本地跑 MinIO 的用户，其自有链接必须被认成"本存储"；
 * - **`blockedHost` 优先于名单**：内网探测是另一回事 —— 即使打开功能、还把该站点
 *   写进白名单，`127.0.0.1` 与云元数据端点也**绝不去碰**（名单越不过这道）。
 *
 * ## 一处容易被忽略的事实（写下来而不是含糊过去）
 *
 * `URL` 会把 `https:///x` 解析成主机 `x`（而不是"没有主机"）。这不是错：
 * 这种链接本来就打不开，判定会给出 `wait` 或 `cache`，而真去下载时会如实报失败。
 * 真正解析不出主机的是 `https://` 这类，它落在 `ignore`。
 */

import type { PluginSettings } from "../types";
import { keyFromUrl, urlPrefixes } from "./render-target";

/** `urlPrefixes` / `ownHosts` 需要的最小地址形状（`S3Config` 天然满足）。 */
type AddressLike = { endpoint: string; bucket: string; publicUrlBase?: string; forcePathStyle?: boolean };

/**
 * 判定结果。
 *
 * `cache` 带 `host` —— 命令的确认框要列出"即将访问哪些站点"
 *（那份名单就是它对外的**披露**），而让 host 从判定层出来可以保证
 * "列出来的站点"与"真去请求的站点"**字面上就是同一个**。
 */
export type ExternalCacheDecision =
	/** 不动：不是我们的、不该管的、被安全策略拦下的、或（**仅自动**）被开关/名单挡住的。 */
	| { action: "ignore"; reason: string }
	/** 该搬。**自动**路径据此入队；**候选**路径据此把它列进清单。 */
	| { action: "cache"; host: string };

/**
 * 这次判定是为**自动处理**、还是为**列候选**。
 *
 * ⚠️ 它不是"要不要做"的开关，而是"**谁在问**"：两种用途的硬性判据完全一样，
 * 差别只在**功能开关与站点名单管不管这一次**（见模块头注释）。
 * 刻意**不给默认值** —— 让每个调用点都必须显式表态，而不是默默继承一个可能是错的语义。
 */
export type ExternalCachePurpose =
	/** 渲染路径的**自动**处理：受功能开关与站点名单约束。 */
	| "auto"
	/** 显式工具（「挑选要缓存的文件」/ 批量命令）的**候选**：两者都不管它。 */
	| "manual";

export interface ExternalCacheInput {
	/** `<img>` 上的 `src` 原值。 */
	src: unknown;
	settings: PluginSettings;
	/** 调用方**同步算好**再传进来：`connectionReadiness(...).ready`。 */
	configured: boolean;
	/** 谁在问 —— 决定功能开关与站点名单这一次生不生效。 */
	purpose: ExternalCachePurpose;
	/** 安全拦截的可替换接缝；默认 {@link isBlockedHost}。 */
	blockedHost?: (host: string) => boolean;
}

/**
 * 把主机名归一化成查询用的键。
 *
 * 归一化三件事，每一件都对应一个真实会遇到的输入：
 * 1. **大小写** —— `URL` 解析出来的 host 是小写，但用户手写的地址不是；
 * 2. **末尾的点** —— `example.com.` 是 FQDN 的合法写法，与 `example.com` 是同一台主机；
 * 3. **首尾空白** —— 从别处粘过来很常见。
 *
 * ⚠️ **端口要保留**：`example.com:8080` 与 `example.com` 可能是两个完全不同的服务，
 * 合并会让"本地测试站点的判断"意外作用到生产站点。
 *
 * 无法归一的输入返回**空串**（而不是抛出或 `String(value)`）——
 * 后者会得到一个 `[object Object]` 这样的"主机名"，反而能和别的坏输入撞成同一条。
 */
function normalizeHost(host: unknown): string {
	if (typeof host !== "string") return "";
	return host.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * 取 URL 的主机名（含端口，已归一化）。取不到时返回**空串**（调用方据此 ignore），
 * 而不是抛出 —— 这个函数跑在渲染路径上。
 */
export function hostOf(url: unknown): string {
	if (typeof url !== "string") return "";
	const trimmed = url.trim();
	if (!trimmed) return "";
	try {
		return normalizeHost(new URL(trimmed).host);
	} catch {
		return "";
	}
}

/**
 * 本存储可能出现的**主机**集合。
 *
 * ## 为什么除了"前缀匹配"还要单独看主机
 *
 * `keyFromUrl` 要求 URL **命中完整前缀**（`https://s3.example.com/my-bucket/`）。
 * 于是换过桶、或手改过链接的旧地址（`https://s3.example.com/other-bucket/k.png`）
 * 会落进"站外" —— 进而被列进「选择要缓存的外链图片」，对着**用户自己的 S3 端点**
 * 问"要不要缓存这张"。那既荒谬，也会让清单里塞满他自己的地址。
 *
 * 主机相同即视为自己的存储：宁可少列，也不要对着自己的基础设施发问。
 */
export function ownHosts(address: AddressLike): Set<string> {
	const hosts = new Set<string>();
	for (const prefix of urlPrefixes(address)) {
		try {
			const host = normalizeHost(new URL(prefix).host);
			if (host) hosts.add(host);
		} catch {
			// 前缀畸形（理论上不会：它由 `requestTargetFor` 拼出）——
			// 跳过这一条，而不是让整个判定崩掉。
		}
	}
	return hosts;
}

/**
 * 从 `URL.host` 里取**主机名**部分（去掉端口）。IPv6 字面量保留方括号。
 *
 * 抽出来是为了让"怎么从 host 里剥出名字"只有一处定义 —— `isBlockedHost` 与
 * 站点名单都要用它，各写一遍的话，其中一处漏掉 IPv6 的方括号规则不会有任何报错，
 * 症状是"某个地址没被拦住"或"某条名单不生效"。
 */
function hostNameOf(host: string): string {
	return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/**
 * 回环 / 链路本地地址 —— 一律不碰。
 *
 * 这些地址指向的要么是本机、要么是云厂商的元数据端点
 * （`169.254.169.254` 上挂着实例凭据）。"把笔记里的一张文件缓存到云存储"
 * 这个动作绝没有理由去请求它们，所以这一层是**无条件**的 ——
 * 连站点**白名单**也越不过它（名单是"自动搬的准入"，这条才是安全边界）。
 *
 * ⚠️ **不拦 RFC1918**（`10.*` / `192.168.*` / `172.16-31.*`）：
 * 家庭 NAS、局域网自建 MinIO 都是**合法**的图床，拦掉会让这些用户的功能静默失效。
 * 这个取舍是刻意的 —— 代价是局域网地址照常会被列进候选，而用户可以选择不去勾。
 */
export function isBlockedHost(host: unknown): boolean {
	const bare = typeof host === "string" ? host.trim().toLowerCase() : "";
	if (!bare) return false;

	const name = hostNameOf(bare);

	if (name === "localhost" || name === "[::1]") return true;
	if (name === "0.0.0.0") return true;
	if (name.startsWith("127.")) return true; // 整个 127.0.0.0/8 都是回环
	if (name.startsWith("169.254.")) return true; // 链路本地（含云元数据端点）
	return false;
}

/**
 * 把名单里的一条**归一化**成一个主机（可能带端口）。
 *
 * 用户会怎么写这一条 —— 每一种都得认得出来：
 * - `example.com` / `Example.COM` / `example.com.`（FQDN 的合法写法）；
 * - `https://cdn.example.com/foo.png`（从地址栏整条粘过来）；
 * - `*.example.com`（想表达"所有子域"；后缀匹配本来就覆盖，去掉 `*` 即可）；
 * - `example.com:8080`（只想管某个端口的服务）。
 *
 * 认不出来的一律返回**空串**（由调用方丢掉），而不是抛错或原样返回 ——
 * 原样返回会让一条畸形条目变成"永远匹配不上"的死规则，而症状是
 * "我明明把它写进名单了，却没有任何效果"，查不出原因。
 */
export function normalizeSiteEntry(entry: unknown): string {
	if (typeof entry !== "string") return "";
	const text = entry.trim().toLowerCase();
	if (!text) return "";

	// 整条地址（带协议）：交给 `URL` 解析，只留主机
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
		try {
			return normalizeHost(new URL(text).host);
		} catch {
			return "";
		}
	}

	// 其余按"主机[:端口]"读：去掉通配前缀 → 切掉路径/查询/锚点 → 去掉末尾的点
	const host = text
		.replace(/^\*\.?/, "")
		.replace(/^\.+/, "")
		.split("/")[0]
		.split("?")[0]
		.split("#")[0];
	return host.replace(/\.+$/, "");
}

/** 归一化后的名单：不带端口的按**后缀**匹配，带端口的**精确**匹配（含端口）。 */
export interface NormalizedSiteList {
	suffixes: string[];
	exact: string[];
}

/**
 * 把设置里的名单逐条归一化并去重。
 *
 * ⚠️ **每次判定现算**，不做缓存：名单是小数组（几条到几十条），
 * 而缓存它就得处理"用户在设置页改了名单、判定层却还拿着旧副本"这件事 ——
 * 那正是本项目最警惕的"改了设置没反应"。
 */
export function parseSiteList(raw: unknown): NormalizedSiteList {
	const suffixes: string[] = [];
	const exact: string[] = [];
	if (!Array.isArray(raw)) return { suffixes, exact };
	for (const item of raw) {
		const host = normalizeSiteEntry(item);
		if (!host) continue;
		const bucket = host.includes(":") ? exact : suffixes;
		if (!bucket.includes(host)) bucket.push(host);
	}
	return { suffixes, exact };
}

/**
 * 这条主机在不在名单里。
 *
 * ⚠️ 不带端口的条目按**域名后缀**匹配：写 `example.com` 会命中 `img.example.com`。
 * 这是刻意的 —— 用户写下一个站点名时，想的是"这个站点"，而不是"恰好这个主机名"，
 * 而图床几乎总把图片放在某个子域上（`i.`、`cdn.`、`img.`）。要求写通配符
 * 只会让大部分人选了黑名单却发现没有效果。带端口的条目则**精确**匹配。
 */
export function matchesSiteList(list: NormalizedSiteList, host: string): boolean {
	if (list.exact.includes(host)) return true;
	const name = hostNameOf(host);
	return list.suffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/**
 * 名单允不允许**自动**处理这个主机。
 *
 * | 模式 | 命中名单 | 不命中 |
 * |---|---|---|
 * | `off` | ✅ | ✅（不过滤） |
 * | `blocklist` | ❌ | ✅ |
 * | `allowlist` | ✅ | ❌（⚠️ 名单为空 ⇒ 一个都不允许） |
 *
 * ⚠️ 只服务**自动**那一路（`purpose === "auto"`）。显式工具不调它 ——
 * 判据见 `decideExternalCache` 与 `types.ts::ExternalSiteMode`。
 * ⚠️ 它**不是安全边界**：回环 / 链路本地由 `isBlockedHost` **无条件**拦下，
 * 白名单越不过那道。
 */
export function siteListAllows(mode: unknown, list: unknown, host: unknown): boolean {
	const normalized = normalizeHost(host);
	// 主机解析不出来时不该走到这里（判定层更早就会 ignore）。真走到了就**放行**：
	// 名单只做"收窄"，不该制造新的失败原因 —— 拒绝由那些结构性判据负责。
	if (!normalized) return true;

	const hit = matchesSiteList(parseSiteList(list), normalized);
	if (mode === "blocklist") return !hit;
	if (mode === "allowlist") return hit;
	return true;
}

/**
 * 判定一张站外文件该怎么处理。**同步、无 I/O** —— 它跑在渲染路径上。
 */
export function decideExternalCache(input: ExternalCacheInput): ExternalCacheDecision {
	// ⭐ 顺序刻意如此：先看最便宜、最不会变的开关 —— 于是"功能被关掉"永远给出
	// 同一个原因，不会被地址形态之类的情况掩盖。
	// ⚠️ 只对**自动**那一路：显式工具（挑选 / 批量）不要求先打开这个开关。
	if (input.purpose === "auto" && !input.settings.externalImageCache) {
		return { action: "ignore", reason: "功能已关闭" };
	}

	const src = typeof input.src === "string" ? input.src.trim() : "";
	if (!src) return { action: "ignore", reason: "没有 src" };
	if (!/^https?:\/\//i.test(src)) return { action: "ignore", reason: "不是 http(s) 地址" };

	const host = hostOf(src);
	if (!host) return { action: "ignore", reason: "无法解析主机名" };

	// 自己的存储：先按完整前缀反推 key（精确），再用主机兜底（换过桶/改过前缀的旧链接）
	if (keyFromUrl(src, input.settings.s3)) {
		return { action: "ignore", reason: "属于本存储（交给渲染判定）" };
	}
	if (ownHosts(input.settings.s3).has(host)) {
		return { action: "ignore", reason: "属于本存储（主机匹配）" };
	}

	const isBlocked = input.blockedHost ?? isBlockedHost;
	if (isBlocked(host)) return { action: "ignore", reason: "本地/链路本地地址（安全）" };

	// 没配好存储：连客户端都没有 ⇒ 搬不了，也就不该出现在候选清单里
	//（列出来只会让用户勾完才发现做不成）
	if (!input.configured) return { action: "ignore", reason: "存储未就绪" };

	// ⭐ 名单只约束**自动**那一路，而且放在最后 —— 于是"被名单挡住"不会被别的原因
	// 掩盖，而显式工具（勾选 / 点确认）永远穿得过它。
	// ⚠️ 它在**安全拦截之后**：白名单不能把回环地址放进来。
	if (
		input.purpose === "auto" &&
		!siteListAllows(input.settings.externalSiteMode, input.settings.externalSiteList, host)
	) {
		return { action: "ignore", reason: "不在站点名单内（仅自动）" };
	}

	return { action: "cache", host };
}
