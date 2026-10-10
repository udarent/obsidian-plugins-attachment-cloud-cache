/**
 * 渲染时的目标判定：这张图该用本地副本，还是该用远端地址？
 *
 * ## 为什么判定要独立成一层
 *
 * 这一层的输出直接决定**浏览器会不会去联网**：图片的 `src` 一旦保持远端地址，
 * 渲染引擎就会发请求。而"离线可用"这个定位的全部意义就在于
 * **断网时图片仍然能解码**。所以判定必须是可穷举的纯函数 ——
 * 真跑起来时它被调用的时机（每个 `<img>` 一次、每张图只能有一次机会）不允许出错。
 *
 * ## ⭐ 判定的核心设计：**同步只用内存**
 *
 * 关键约束是**同步**：如果先 `await` 一下（去问磁盘"文件在吗"），
 * 元素可能已经连上 DOM 并开始加载远端图片了 ——
 * 那时再改 `src`，请求已经发出，"零请求"就不成立了。
 *
 * 所以判定只查**内存里的索引**，一次 I/O 都不做。代价是索引可能指向一个
 * 已被用户删掉的缓存文件（缓存目录随时可删，是承诺过的）。
 * 对此的处理不是"渲染前先查一遍磁盘"（那会引入异步），而是：
 * 换成 `app://` 地址之后**挂一个 error 处理器** ——
 * 本地文件真的不在时立刻退回远端地址，让在线用户仍然看得到图。
 * 这样"离线零请求"和"在线不丢图"两个目标同时成立。
 *
 * ## 五种结果，都要能被区分
 *
 * | 情况 | 结果 | 理由 |
 * |---|---|---|
 * | 不是 http(s) 图（已经是 `app://`、data:、blob:、相对路径） | `ignore` | 不是我们的图 |
 * | 索引里有本地副本 | `local` | 零网络，这是离线可用的来源 |
 * | 属于本存储但本地没有 | `fetch` | 交给回退下载（换设备/缓存被清） |
 * | 属于本存储但本地没有，**且是「不留副本」档** | `ignore` | 这一档等于关闭缓存：不为它联网取回副本 |
 * | 站外图 | `ignore` | **永不**下载站外图（否则等于做成了另一个插件的定位） |
 * | 没配存储 | `ignore` | 连"自己的存储"是什么都不知道，不该动任何图 |
 *
 * ## ⭐ 「不留副本」= 关闭缓存（与"用不用已有的副本"是两件事）
 *
 * 用户口径：选「不留副本」就该等价于**关掉缓存功能、只保留常规图床的行为**
 * （上传 → 拿到一条链接）。所以这一档下**不再产生 `fetch`** ——
 * 不为缺副本的图联网、更不会把远端字节写进 vault。
 *
 * ⚠️ 但**索引里已经有的副本仍然走 `local`**：那可能是旧档位留下的，
 * 也可能是用户**显式**把某张站外图缓存进来时留下的（「缓存站外图片」这条链
 * 会强制用 `cache` 档写副本，见 `core/external-cache.ts` 的 `localCopyForExternal`）。
 * 判定顺序因此是"先看有没有副本，再看缓存开不开" —— 反过来会让那个显式动作
 * 白做（搬进来了却不用，且界面上看不出来）。
 *
 * ## ⚠️ 一处已知限制（写下来而不是含糊过去）
 *
 * 判定只有两个信息来源：**当前设置**与**索引**。所以"属于本存储"的判据是
 * 「URL 命中当前的前缀」或「索引里记着这个 URL」。
 *
 * 于是有一种情况认不出来：**用户改掉或清空了 `publicUrlBase`，而那张图
 * 又不在索引里**（换设备、索引被删）—— 旧前缀的链接既不在当前前缀里，
 * 也没被索引记着。此时按"站外图"处理（不下载、原样显示）。
 *
 * 表现是：在线仍然看得到图（就是远端加载），离线看不到。
 * 要做到完全识别需要额外记住"历史上用过哪些前缀"，那是另一个量级的复杂度；
 * 当前的取舍是**宁可少认，不可错认** —— 错认会把别人的图拉进 vault。
 *
 * 顺带一条：**缓存被清空**这种情况不受此限制 —— 索引条目还在（记着 URL），
 * 所以仍然认得出来，走本地副本，等发现文件不在再回退下载。
 */

import type { PluginSettings } from "../types";
import { isCacheDisabled } from "../types";
import type { CacheIndex } from "../cache/index";
import { normalizeEndpoint, requestTargetFor } from "../s3/client";

/** 判定结果。 */
export type RenderTarget =
	/** 不动这张图（不是我们的、或我们不该管）。 */
	| { action: "ignore"; reason: string }
	/** 用本地副本：`localPath` 是 vault 相对路径，调用方负责换成可用的 URL。 */
	| { action: "local"; key: string; remoteUrl: string; localPath: string }
	/** 属于本存储但本地没有副本 —— 交给回退下载。 */
	| { action: "fetch"; key: string; remoteUrl: string };

/** 探测用的固定片段：用来把"前缀"从完整 URL 里切出来。 */
const PROBE_KEY = "acc-probe";

/**
 * 本存储可能出现的 URL 前缀（含尾斜杠）。
 *
 * ## 为什么要算**两个**前缀
 *
 * 图片在笔记里长什么样取决于当时的设置：
 * - 配了 `publicUrlBase`（如 `https://img.example.com`）→ 链接用那个前缀；
 * - 没配 → 链接退回对象地址（`端点/桶/键` 或 virtual-host 形式）。
 *
 * 而用户**随时可以补上或改掉** `publicUrlBase`。若只认当前那一个前缀，
 * 改设置之后所有旧链接都认不出来 —— 表现是"之前离线能看的图，改完设置就看不了了"，
 * 且不会有任何报错。所以两个前缀都认。
 *
 * 复用 `requestTargetFor`（而不是自己拼）是刻意的：那段逻辑处理了
 * path-style 与 virtual-host 两种寻址、以及桶名的百分号编码，
 * 自己再写一遍迟早会与真正发出去的请求分叉。
 */
export function urlPrefixes(address: { endpoint: string; bucket: string; publicUrlBase?: string; forcePathStyle?: boolean }): string[] {
	const out: string[] = [];

	const base = normalizeEndpoint(address.publicUrlBase ?? "");
	if (base) out.push(`${base}/`);

	try {
		const probe = requestTargetFor(address, PROBE_KEY);
		// `requestTargetFor` 会把 key 编码后接在结尾；PROBE_KEY 是纯 ASCII，
		// 编码前后一致，所以直接按长度切掉就是前缀。
		const prefix = probe.url.slice(0, probe.url.length - PROBE_KEY.length);
		if (prefix) out.push(prefix);
	} catch {
		// 端点/桶没配全 → 没有对象地址前缀可用。不是错误：
		// 此时"是不是我们的图"只能靠 publicUrlBase 判断。
	}

	return [...new Set(out)];
}

/**
 * 从远端 URL 反推出对象 key；不属于本存储时返回 `null`。
 *
 * ⚠️ **只解码一次**，且是逐段解码：我们写出链接时用的是逐段百分号编码
 * （见 `sigv4.ts` 的 `encodePath`），所以逐段反解正好得到原始 key。
 * 若图省事对整串 `decodeURIComponent`，key 里含 `/` 的（多段 key）会被
 * 错误地保留成 `%2F` 或反之 —— 那是"链接打得开但缓存永远不命中"的经典成因。
 */
export function keyFromUrl(url: unknown, address: { endpoint: string; bucket: string; publicUrlBase?: string; forcePathStyle?: boolean }): string | null {
	if (typeof url !== "string") return null;
	const trimmed = url.trim();
	if (!trimmed) return null;

	for (const prefix of urlPrefixes(address)) {
		if (!trimmed.startsWith(prefix)) continue;
		const rest = trimmed.slice(prefix.length);
		// 查询串/锚点不属于 key（签名 URL 会带查询串）
		const pathOnly = rest.split("#")[0].split("?")[0];
		if (!pathOnly) continue;

		const segments = pathOnly.split("/");
		try {
			const key = segments.map((segment) => decodeURIComponent(segment)).join("/");
			return key || null;
		} catch {
			// 畸形百分号编码（`%zz`）→ 不是我们写出的链接
			return null;
		}
	}
	return null;
}

/** 判定输入。抽成对象是因为调用点很多，位置参数容易传错顺序。 */
export interface RenderDecisionInput {
	/** `<img>` 上的 `src` 原值。 */
	src: unknown;
	settings: PluginSettings;
	index: CacheIndex;
}

/** 判定一张图该怎么渲染。**同步、无 I/O** —— 理由见本模块头注释。 */
export function decideRenderTarget(input: RenderDecisionInput): RenderTarget {
	const src = typeof input.src === "string" ? input.src.trim() : "";
	if (!src) return { action: "ignore", reason: "没有 src" };
	if (!/^https?:\/\//i.test(src)) {
		return { action: "ignore", reason: "不是 http(s) 图片（本地资源或 data:/blob:）" };
	}

	// ⚠️ 顺序：先查索引（O(1)、覆盖全部已上传的图），再算 key。
	// 反过来也能得到同样结果，但"索引命中"是我们**确知**有本地副本的情形，
	// 让它先短路可以少做一次 URL 解析。
	const known = input.index.findByRemoteUrl(src);
	if (known && known.cachePath) {
		return { action: "local", key: known.key, remoteUrl: known.remoteUrl || src, localPath: known.cachePath };
	}

	// ⭐ 「不留副本」= 关闭缓存：这一档下**不产生 `fetch`** —— 不为缺副本的图联网，
	// 也就更不会把远端字节写进 vault。放在这里（索引之后、算 key 之前）是刻意的：
	// ① 已经存在的副本仍然照常走 `local`（理由见模块头注释）；
	// ② 这一档连"是不是我们的图"都不必算 —— 反正不动它。
	if (isCacheDisabled(input.settings.localCopy)) {
		return { action: "ignore", reason: "「不留副本」档：缓存已关闭，不为缺副本的图取回副本" };
	}

	const key = keyFromUrl(src, input.settings.s3);
	if (key) return { action: "fetch", key, remoteUrl: src };

	return { action: "ignore", reason: "站外图片（不属于本存储，永不下载）" };
}
