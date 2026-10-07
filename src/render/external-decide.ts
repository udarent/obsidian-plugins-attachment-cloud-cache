/**
 * 「这张站外图该不该问、要不要自动缓存」的判定（纯函数）。
 *
 * ## 为什么另起一层，而不是扩展 `decideRenderTarget`
 *
 * 那是两个不同的问题：
 * - `decideRenderTarget` 回答"**渲染时该怎么做**"（换本地 / 交给回退下载 / 不动），
 *   它的输出直接决定浏览器会不会联网；
 * - 这里回答"**该不该问用户**"，输出还要经过"问什么、记什么"的编排。
 *
 * 混在一处会让前者的语义漂移（它被 8 条变异钉着），也会让"站外图永不下载"
 * 这条红线的边界变得含混。分开之后，红线这句话可以精确地改写为
 * **「未获用户明确同意前，站外图永不下载」** —— 而"同意"这件事就发生在这一层与询问之间。
 *
 * ## 判定顺序刻意固定
 *
 * 与 `shouldInterceptPaste` 同一个纪律：**先看最便宜、最不会变的开关**，
 * 再看载荷细节。这样"功能被关掉"永远给出同一个原因，不会被别的情况掩盖。
 * 顺序里有两处是安全相关的，不能调换：
 * - **自己的存储优先于"本地地址"**：本地跑 MinIO 的用户，其自有链接必须被认成"本存储"；
 * - **`blockedHost` 优先于站点记忆**：记忆是用户意图，但内网探测是另一回事 ——
 *   即使用户把 `127.0.0.1` 标成过 `allow`（比如手改过文件），也不该放行。
 *
 * ## 一处容易被忽略的事实（写下来而不是含糊过去）
 *
 * `URL` 会把 `https:///x` 解析成主机 `x`（而不是"没有主机"）。这不是错：
 * 这种链接本来就打不开，判定会走 `ask`，用户一句"不再询问"就永远不再打扰。
 * 真正解析不出主机的是 `https://` 这类，它落在 `ignore`。
 */

import type { PluginSettings } from "../types";
import { keyFromUrl, urlPrefixes } from "./render-target";
import { normalizeHost } from "./site-decisions";
import type { SiteDecisions } from "./site-decisions";

/** `urlPrefixes` / `ownHosts` 需要的最小地址形状（`S3Config` 天然满足）。 */
type AddressLike = { endpoint: string; bucket: string; publicUrlBase?: string; forcePathStyle?: boolean };

/**
 * 判定结果。
 *
 * `ask` 与 `cache` 都带 `host` —— 询问文案要显示它，而记忆也要按它写。
 * 让 host 从判定层出来（而不是让调用方再解析一次 URL）可以保证
 * "问的那个站点"与"记的那个站点"**字面上就是同一个键**。
 */
export type ExternalCacheDecision =
	/** 不动：不是我们的、不该管的、或被安全策略拦下的。 */
	| { action: "ignore"; reason: string }
	/** 首次遇到这个站点 —— 该问用户一次。 */
	| { action: "ask"; host: string }
	/** 这个站点已被记成"要缓存" —— 直接处理，不再问。 */
	| { action: "cache"; host: string };

export interface ExternalCacheInput {
	/** `<img>` 上的 `src` 原值。 */
	src: unknown;
	settings: PluginSettings;
	/** 站点决定记忆（**同步内存读** —— 渲染路径上不能有 I/O）。 */
	decisions: SiteDecisions;
	/** 调用方**同步算好**再传进来：`connectionReadiness(...).ready`。 */
	configured: boolean;
	/** 安全拦截的可替换接缝；默认 {@link isBlockedHost}。 */
	blockedHost?: (host: string) => boolean;
}

/**
 * 取 URL 的主机名（含端口，已归一化）。
 *
 * ⚠️ **端口要保留**：`example.com:8443` 与 `example.com` 可能是两个不同的服务，
 * 归并成一条会让"我在本地测试站点上选的「不再询问」"意外作用到生产站点。
 *
 * 取不到时返回**空串**（调用方据此 ignore），而不是抛出。
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
 * 会落进"站外" —— 进而对着**用户自己的 S3 端点**弹"要不要缓存这张站外图"。
 * 那既荒谬，也会让用户对着一堆自己存储的地址挨个点"不再询问"。
 *
 * 主机相同即视为自己的存储：宁可少问，也不要对着自己的基础设施发问。
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
 * （连用户标注过的 `allow` 也不能越过它）。
 *
 * ⚠️ **不拦 RFC1918**（`10.*` / `192.168.*` / `172.16-31.*`）：
 * 家庭 NAS、局域网自建 MinIO 都是**合法**的图床，拦掉会让这些用户的功能静默失效。
 * 这个取舍是刻意的 —— 代价是局域网地址仍会被询问，而用户可以一句"不再询问"结束它。
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
 * 判定一张站外图该怎么处理。**同步、无 I/O** —— 理由见模块头注释。
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

	const remembered = input.decisions.get(host);
	if (remembered === "deny") return { action: "ignore", reason: "该站点已标记不再询问" };
	if (remembered === "allow") return { action: "cache", host };

	// 没配好存储时**不问**：渲染路径上每张图都会走到这里，逐张弹"未配置"会把界面刷爆，
	// 而这件事在粘贴时与设置页里都已经说过了。
	if (!input.configured) return { action: "ignore", reason: "存储未就绪（不打扰）" };

	return { action: "ask", host };
}
