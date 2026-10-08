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
 * 混在一处会让前者的语义漂移（它被 8 条变异钉着），也会让"站外图永不自动下载"
 * 这条红线的边界变得含混。分开之后，红线这句话可以精确地改写为
 * **「没有用户的显式动作，站外图永不下载」** —— 而"显式动作"只有两个来源：
 * 设置里把默认值改成「直接缓存」，或者在「选择要缓存的外链图片」里勾中它。
 *
 * ## ⭐ 三个结果，而不是两个
 *
 * | 结果 | 含义 | 谁在乎 |
 * |---|---|---|
 * | `ignore` | **根本不该处理**：功能关着、地址形态不对、属于本存储、回环地址、存储未就绪 | 渲染路径与命令都跳过，并给出可查的原因 |
 * | `cache` | 可以搬，而且**这次就搬** | 渲染路径直接入队 |
 * | `wait` | 可以搬，但**默认不动手**（设置选了「什么都不做」）| 渲染路径跳过；**命令与选择器的候选收它** |
 *
 * ⭐ 把"能不能搬"与"默认动不动手"分成两件事，是为了让**显式动作**不受默认值影响：
 * 否则用户把默认设成「什么都不做」之后，「选择要缓存的外链图片」会列出一份空清单 ——
 * 那个按钮就不存在了。判据：**`wait` 是"等你来挑"，不是"不许碰"。**
 *
 * ## 判定顺序刻意固定
 *
 * 与 `shouldInterceptPaste` 同一个纪律：**先看最便宜、最不会变的开关**，
 * 再看载荷细节。这样"功能被关掉"永远给出同一个原因，不会被别的情况掩盖。
 * 顺序里有两处是安全相关的，不能调换：
 * - **自己的存储优先于"本地地址"**：本地跑 MinIO 的用户，其自有链接必须被认成"本存储"；
 * - **`blockedHost` 优先于"默认要不要搬"**：内网探测是另一回事 ——
 *   即使设置里选了「直接缓存」，`127.0.0.1` 与云元数据端点也**绝不去碰**。
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
 * `cache` 与 `wait` 都带 `host` —— 命令的确认框要列出"即将访问哪些站点"
 * （那份名单就是它对外的**披露**），而让 host 从判定层出来可以保证
 * "列出来的站点"与"真去请求的站点"**字面上就是同一个**。
 */
export type ExternalCacheDecision =
	/** 不动：不是我们的、不该管的、或被安全策略拦下的。 */
	| { action: "ignore"; reason: string }
	/** 可以搬，而且这次就搬（设置里选了「直接缓存」）。 */
	| { action: "cache"; host: string }
	/** 可以搬，但默认不动手 —— 等用户在「选择要缓存的外链图片」里勾它。 */
	| { action: "wait"; host: string };

/** 可以搬的那两种（都带 `host`）。抽出来是为了让"能不能搬"这个判断**可被类型收窄**。 */
export type CacheableExternalDecision =
	| { action: "cache"; host: string }
	| { action: "wait"; host: string };

/**
 * 这张图**可以被搬**吗（不管默认动不动手）。
 *
 * ⭐ 命令与选择器的候选就用这一条：`wait` 必须算候选，否则"默认不缓存"会让
 * 那两个显式入口变成空操作（判据见模块头注释）。
 */
export function isCacheableExternal(decision: ExternalCacheDecision): decision is CacheableExternalDecision {
	return decision.action !== "ignore";
}

export interface ExternalCacheInput {
	/** `<img>` 上的 `src` 原值。 */
	src: unknown;
	settings: PluginSettings;
	/** 调用方**同步算好**再传进来：`connectionReadiness(...).ready`。 */
	configured: boolean;
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
 * 回环 / 链路本地地址 —— 一律不碰。
 *
 * 这些地址指向的要么是本机、要么是云厂商的元数据端点
 * （`169.254.169.254` 上挂着实例凭据）。"把笔记里的一张图缓存到云存储"
 * 这个动作绝没有理由去请求它们，所以这一层是**无条件**的
 * （连"设置里选了直接缓存"也不能越过它）。
 *
 * ⚠️ **不拦 RFC1918**（`10.*` / `192.168.*` / `172.16-31.*`）：
 * 家庭 NAS、局域网自建 MinIO 都是**合法**的图床，拦掉会让这些用户的功能静默失效。
 * 这个取舍是刻意的 —— 代价是局域网地址照常会被列进候选，而用户可以选择不去勾。
 */
export function isBlockedHost(host: unknown): boolean {
	const bare = typeof host === "string" ? host.trim().toLowerCase() : "";
	if (!bare) return false;

	// IPv6 字面量在 `URL.host` 里是带方括号的（`[::1]`），端口在括号外
	const name = bare.startsWith("[") ? bare.slice(0, bare.indexOf("]") + 1) : bare.split(":")[0];

	if (name === "localhost" || name === "[::1]") return true;
	if (name === "0.0.0.0") return true;
	if (name.startsWith("127.")) return true; // 整个 127.0.0.0/8 都是回环
	if (name.startsWith("169.254.")) return true; // 链路本地（含云元数据端点）
	return false;
}

/**
 * 判定一张站外图该怎么处理。**同步、无 I/O** —— 它跑在渲染路径上。
 */
export function decideExternalCache(input: ExternalCacheInput): ExternalCacheDecision {
	if (!input.settings.externalImageCache) return { action: "ignore", reason: "功能已关闭" };

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

	// ── 到上面为止都只是"能不能搬"；这一句才是"**现在**动不动手" ──
	return input.settings.externalImageDefault === "cache"
		? { action: "cache", host }
		: { action: "wait", host };
}
