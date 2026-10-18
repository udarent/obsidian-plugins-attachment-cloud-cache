/**
 * 「连接状态」—— 你的存储现在允许谁打开笔记里那条链接，以及本机该怎么取字节。
 *
 * ## 这一层为什么存在
 *
 * 笔记里写下的是一条**普通地址**（`s3/client.ts::publicUrlFor` 的产物）。它能不能被打开，
 * 取决于**桶的权限**——用户在存储服务商那边配的东西，我们改不了也不该改。
 * 于是同一条链接有两种命运，而**取字节的手段也必须是两种**：
 *
 * | 桶 | 别人打开链接 | 我们怎么显示图 |
 * |---|---|---|
 * | 允许匿名读 | ✅ 打得开（粘到别的平台也能用） | 保持远端地址即可（浏览器自己会取） |
 * | 私有 | ❌ 403 | **带签名取回**（`S3Client.getObject`）→ 落成本地副本 → 用 `app://` 显示 |
 *
 * 1.6.0 及以前一律假定桶是公开的 ⇒ 私有桶的用户看到**一屏坏图**，而 `<img>` 的 403
 * 不弹任何提示（只有控制台一条），用户只会以为"插件把我的图弄丢了"。
 *
 * ## ⭐ 2026-10-18：不再让用户选档，改成**探测出来的状态**
 *
 * 曾经有一个「笔记里的链接谁打得开」的三档设置（`auto` / `public` / `private`）。
 * 它的问题：用户既不知道自己的桶是什么样，也不该为这件事做决定 —— 那是一个**事实**，
 * 不是偏好。现在只有一件事要做：**探测它**，并把结果显示出来。
 *
 * | 状态 | 含义 | 本机怎么取缺副本的图 |
 * |---|---|---|
 * | `checking` | 还没问出来（刚启动 / 网络慢） | 按私有处理（安全方向） |
 * | `public` | 匿名读得到 ⇒ 别人也能打开 | 远端地址直连 |
 * | `private` | 拒绝匿名，但有密钥的我们取得到 | 取回本地副本 / 短时签名地址 |
 * | `unreachable` | 匿名与签名都取不到 ⇒ 连接不通 | 按私有处理（能补就补） |
 *
 * ⚠️ **状态从不持久化**：每次加载都从 `checking` 重新问（不问"昨天是什么"，因为桶的权限
 * 可能在存储那边被改过）。启动探测会**先问公开**，问不到才落到私有 —— 也就是"从公开开始，
 * 用事实纠正"。
 *
 * ## 三条判据都在这里，别处不许再写一遍
 *
 * 1. {@link displayPathFor} —— 缺副本的图走哪条路（{@link requiresLocalCopy} / {@link usesSignedUrls} 都调它）；
 * 2. {@link stateAfterProbe} —— 自动探测的结论 ⇒ 状态；
 * 3. {@link stateAfterRoundTrip} —— 「测试连接」那一轮回路的实测 ⇒ 状态。
 *
 * 分成两处写的后果在本项目已经见过太多次：一处硬、一处软，两侧都不报错。
 *
 * ## ⭐ 链接地址与这个模块**无关**（这是刻意的）
 *
 * `publicUrlFor` 只认端点 / 桶 / 公开前缀，**不读**这里的状态。所以状态怎么变，
 * 笔记里那条地址**一个字符都不会变**（`test-link-access.mjs` 有一条断言钉住这件事）。
 * 变的是"它对外能不能打开"，以及"我们本机需不需要先取回字节"。
 *
 * 反过来说：**不要**用"切换状态"去改写已有链接（例如改成签名 URL）。签名 URL 有有效期，
 * 写进笔记等于给用户埋一批会过期的死链 —— 那才是真正不可逆的操作。
 *
 * ## 降级：不知道时按**私有**处理
 *
 * | 探测结果 | 走哪条 | 为什么 |
 * |---|---|---|
 * | `ok`（2xx） | 公开 | 匿名都能取到，链接在别处也打得开 |
 * | `forbidden`（401/403） | 私有 | 这就是"桶是私有的"这个事实本身 |
 * | `missing`（404） | **不改判** | 地址通、对象不在 ⇒ 既证明不了公开，也证明不了私有 |
 * | `unreachable`（网络失败 / 超时） | 无法访问 | 连接本身有问题 |
 * | 还没测过（`checking`） | 私有 | 见下 |
 *
 * "按私有处理"的实际含义是：**缺副本的图会被取回本地**（多下一次）。它比另一个方向安全得多——
 * 另一个方向（按公开处理）在桶其实是私有时会留下**没有兜底的坏图**，而那正是我们要修的病。
 * 多下一次并不会挡住任何人：取不回来时图仍旧按远端地址显示（见 `render/render-hook.ts`）。
 *
 * ⚠️ 反过来，状态**只影响我们自己的取字节方式，不影响用户的桶**：我们从不
 * 尝试去改桶的 ACL（那需要 `s3:PutBucketAcl`，也超出了这个插件的授权范围）。
 */

import { isCacheDisabled } from "./types";
import { probePublicLink, publicUrlFor } from "./s3/client";

/**
 * 匿名探测的结论。
 *
 * ⚠️ 与 `ui/settings-logic.ts` 的 `PublicLinkKind` **是同一套取值**：那边是"给人看的一句话"，
 * 这里是"给判定用的一格"。合并成一套而不是各写一份，因为两者必须永远一致 ——
 * 界面上说"桶私有"，判定层却当成公开，是最难查的那种分叉。
 */
export type PublicReachKind =
	/** 匿名取得到（2xx）。 */
	| "ok"
	/** 地址通、但拒绝匿名（401/403）。 */
	| "forbidden"
	/** 地址通、对象不在（404）。 */
	| "missing"
	/**
	 * 2xx，但回的是**网页**而不是对象（网关 / WAF / 身份校验页 / 反向代理的兜底页）。
	 *
	 * ⚠️ 这一类**不能**算"公开"：它证明的是"这个地址上有个东西会回 200"，
	 * 不是"别人能打开你的对象"。2026-10-18 的误判就出在这里 —— 见 `classifyPublicReach`。
	 */
	| "webpage"
	/**
	 * 同一轮里**两次匿名检查结论不一致**（一次能读到、一次读不到）。
	 *
	 * ⚠️ 2026-10-18 真机实测：同一个桶，连续 5 轮里有 1 轮匿名字节读得回来、其余 4 轮 403；
	 * 而立刻用 curl / Node / 页面各测 8 次又全是 403。⇒ 这是**服务端侧的间歇**（反向代理后面
	 * 多个后端策略不一致、或缓存/负载均衡），不是"稳定公开"。
	 * 判成 public 等于把一次偶然当成事实；判成 private 又抹掉了那条线索 ⇒ 单独一类，**不改判**，
	 * 并在界面上说清"响应不稳定"，让用户去查网关。
	 */
	| "unstable"
	/** 网络层失败（DNS / TLS / 连不上 / 超时）。 */
	| "unreachable"
	/** 其余状态码。 */
	| "other";

/** 一次探测的结果（纯数据，可存、可比较、可打印）。 */
export interface AccessProbe {
	kind: PublicReachKind | "unknown";
	/** HTTP 状态码；网络层失败为 `null`。 */
	status: number | null;
	/** 探测时刻（毫秒时间戳）；`0` = 从没探测过。 */
	at: number;
	/** 响应头里的 `content-type`（拿不到为 `null`）；判定"回的是不是网页"要用它。 */
	contentType?: string | null;
	/**
	 * 2xx 时：**取回来的字节与写进去的一致吗**（只有「测试连接」的回路会填）。
	 *
	 * `false` ⇒ 这个地址上回的不是我们的对象（中间层缓存 / 网关兜底页 / 前缀指错）。
	 * `undefined` ⇒ 没有内容级证据（自动探测只发 HEAD，不下载对象）。
	 */
	bodyMatches?: boolean;
	/**
	 * 是不是**超时**放弃的（而不是对端明确给了状态码）。
	 *
	 * 只用于界面上把话说准（"超时"与"连不上"对用户是两件事：前者常常是网络慢，
	 * 后者常常是地址写错，修法不同）。判定层不看它。
	 */
	timedOut?: boolean;
}

/** 从没探测过。 */
export const UNKNOWN_ACCESS_PROBE: AccessProbe = { kind: "unknown", status: null, at: 0 };

/**
 * 存储的连接状态。**运行时的事实，不是用户的偏好**，所以从不写进 `data.json`。
 *
 * - `checking`：刚启动 / 还没问出来。缺副本的图按**私有**处理（安全方向：多下一次，
 *   而不是在"其实私有"时留下一屏没有兜底的坏图）。
 * - `public`：匿名读得到 —— 别人也能打开笔记里那条链接。
 * - `private`：拒绝匿名，但有密钥的我们取得到。
 * - `unreachable`：匿名与签名都取不到（网络 / 地址 / 凭据）。
 */
export type ConnectionState = "checking" | "public" | "private" | "unreachable";

/** 每次加载的初值：**不知道**，于是按私有处理（见上面那张表）。 */
export const INITIAL_CONNECTION_STATE: ConnectionState = "checking";

/**
 * 匿名可达性的归类。**全库唯一一处**（设置页的文案也走它）。
 *
 * 每一类的**修法不同**，所以不能都归成"打不开"：
 * - `forbidden` ⇒ 桶私有（想对外分享就开匿名读，或配一个公开访问前缀）；
 * - `missing` ⇒ 地址通但对象不在（多半前缀写错，例如少了桶名）；
 * - `unreachable` ⇒ 地址本身不对，或网络根本到不了。
 */
export function classifyPublicReach(
	status: number | null,
	contentType?: string | null,
	bodyMatches?: boolean
): PublicReachKind {
	if (status === null) return "unreachable";
	if (status >= 200 && status < 300) {
		// ⭐ 最强的判据：**取回来的字节对不对**（2026-10-18 真机复现：同一个桶、同一时刻，
		// 固定 key 的匿名 HEAD 偶发 200，而内容哈希 key 稳定 403 ⇒ 2xx 可能来自中间层缓存 /
		// 网关兜底页，不代表「别人能读到你的字节」）。只有拿回同样的字节才算公开。
		if (bodyMatches === false) return "webpage";
		// ⭐ **2xx 不等于"打开的是你的对象"**（2026-10-18 的误判）：
		// 网关 / WAF / 身份校验页 / 反代兜底页会在路径不存在或请求被拦时回一个 **200 的网页**。
		// 只看状态码的话，这种回应会被读成"桶是公开的"——而笔记里那条链接照样打不开，
		// 用户还会因为"测试说公开"而把私有桶当成可以对外分享。
		// ⇒ 2xx 还要求**回的不是网页**。
		return isWebPageType(contentType) ? "webpage" : "ok";
	}
	if (status === 401 || status === 403) return "forbidden";
	if (status === 404) return "missing";
	return "other";
}

/**
 * 这个 `content-type` 是不是"网页"。
 *
 * ⚠️ 只认 HTML（含 XHTML），**不认 `application/xml`**：S3 的错误页确实是 XML，
 * 但用户也可能真的传了一个 `.xml` 附件 —— 把 XML 一律算"网页"会误伤那种对象。
 * 而 HTML 基本不可能是一个附件（本项目也从不接受网页，见 README 的隐私一节）。
 */
function isWebPageType(contentType: string | null | undefined): boolean {
	const type = String(contentType ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	return type === "text/html" || type === "application/xhtml+xml";
}

/**
 * 「自动探测」的结论 ⇒ 状态。
 *
 * ⚠️ `missing` / `other` **不改判**（返回 `previous`）：一次"地址通但对象不在"
 * 说明不了桶公开不公开，拿它去翻状态只会把界面弄成"时好时坏"。
 */
export function stateAfterProbe(previous: ConnectionState, probe: AccessProbe | null | undefined): ConnectionState {
	switch (probe?.kind) {
		case "ok":
			return "public";
		case "forbidden":
			return "private";
		case "unreachable":
			return "unreachable";
		default:
			return previous;
	}
}

/**
 * 「测试连接」那一轮回路的实测 ⇒ 状态。**用户点按钮时唯一的一处判定**。
 *
 * 规则（按顺序）：
 * 1. 匿名读得到 ⇒ **公开**（别人打得开，别的都不重要）；
 * 2. 匿名读不到、但有密钥的我们取得到 ⇒ **私有**；
 * 3. 两者都取不到 ⇒ **无法访问**。
 *
 * ⚠️ 匿名探测返回 `missing`（404）时**不改判**（返回 `null`）：那说明探针对象在公开地址上
 * 不存在（多半是公开前缀写错了）。此时"匿名读不到"并不是"桶私有"的证据 ——
 * 界面会给出"前缀可能写错"的提示，状态沿用上一次的结论（而不是猜一个）。
 *
 * @param signedReadOk 带签名把**同一个对象**读回来成功了吗（`GetObject` 权限 + 字节可取）
 */
export function stateAfterRoundTrip(input: {
	anonymous: AccessProbe;
	signedReadOk: boolean;
}): ConnectionState | null {
	switch (input.anonymous.kind) {
		case "ok":
			return "public";
		case "missing":
			return null;
		case "forbidden":
		case "unreachable":
		case "other":
			return input.signedReadOk ? "private" : "unreachable";
		default:
			return null;
	}
}

/**
 * **缺本地副本的这张图，靠什么显示**。
 *
 * 三选一，互斥且都能落地（这是刻意的：两个布尔会产出四种组合，其中至少两种说不清）：
 *
 * | 取值 | 什么时候 | 用户看到 |
 * |---|---|---|
 * | `remote-url` | 状态 = 公开 | 远端地址直接显示；要不要顺手存副本听「自动下载」开关 |
 * | `local-copy` | 非公开 + 保留副本 | 取回 → `app://`；**离线可用** |
 * | `signed-url` | 非公开 + **不留副本** | 给 `<img>` 一条预签名地址；**磁盘不落文件**，但每次打开从存储读一遍 |
 *
 * ⭐ `signed-url` 这一档回答的正是用户 2026-10-17 的追问：
 * 「仅内部就必须把图下载下来吗？不能像图床那样，S3 存着、本地不留？」
 * —— 能。私有桶的裸地址必然 403，但**带签名的临时地址**浏览器自己就能取，
 * 于是"不公开"与"不落盘"可以同时成立。代价是**离线看不到**（那是"不落盘"的定义）。
 *
 * ⚠️ 唯一的例外是**已经存在的副本**：渲染判定先查索引，有副本就用副本
 *（零网络、离线可用）。"不再往里写"与"已经有的不用"是两件事。
 */
export type DisplayPath = "remote-url" | "local-copy" | "signed-url";

/**
 * 一个已上传对象在**当前状态**下该走哪种显示方式。
 *
 * ⭐ 这是全库唯一一处回答"缺副本的图怎么显示"的判据。三个调用方必须给出同一答案：
 * 渲染判定（`render/render-target.ts`）、下载闸门（`core/download.ts`）、
 * 以及预签名那条路（`main.ts` 的 `signedUrlFor`）。
 * 分成两处写的后果本项目见过太多次：一处硬、一处软，两侧都不报错。
 *
 * @param settings 只要 `localCopy` 一项（不必传整个设置对象）
 * @param state 当前连接状态（`null`/`undefined` 当 `checking`）
 */
export function displayPathFor(
	settings: { localCopy?: unknown },
	state: ConnectionState | null | undefined
): DisplayPath {
	if (state === "public") return "remote-url";
	// 非公开：能不落盘就不落盘（用户说了「不留副本」），否则只能靠本地副本。
	return isCacheDisabled(settings.localCopy) ? "signed-url" : "local-copy";
}

/**
 * 缺副本的图**是否必须取回本地副本**。
 *
 * 两件事要说清：
 *
 * 1. **「不留副本」档压过一切**（`isCacheDisabled`）。那不是"能不能下载"的问题，
 *    而是用户对**文件是否留在库里**的明确表态 —— 为了让他看见一张图就往他库里写文件，
 *    是拿他的数据策略换热图。这一档下改走预签名（见 {@link DisplayPath}），
 *    图照样显示，只是**磁盘上没有文件**。
 * 2. 其余情况下非公开 ⇒ 必须取回。哪怕用户关掉了「缺本地副本时自动下载」也一样：
 *    那个开关的含义是"**省事**（省流量/省空间）"，而私有桶下不下载就**什么都看不到** ——
 *    把"省事"执行成"看不到"不是用户的本意。
 */
export function requiresLocalCopy(
	settings: { localCopy?: unknown },
	state: ConnectionState | null | undefined
): boolean {
	return displayPathFor(settings, state) === "local-copy";
}

/** 缺副本的图是否该改用**预签名地址**（私有存储 + 不留副本 = 图床式用法）。 */
export function usesSignedUrls(
	settings: { localCopy?: unknown },
	state: ConnectionState | null | undefined
): boolean {
	return displayPathFor(settings, state) === "signed-url";
}

/** 超时默认值：够慢网络走完一次 HEAD，又不至于让设置页的"测试"卡住。 */
export const ACCESS_PROBE_TIMEOUT_MS = 5000;

export interface AccessProbeDeps {
	/** 超时（毫秒）。**必须短于**用户的耐心，不是"尽量久"。 */
	timeoutMs?: number;
	/** 取当前时间（毫秒）。注入它才能在测试里断言 `at`。 */
	now?: () => number;
	/**
	 * 真正的匿名请求。默认是 `s3/client.ts::probePublicLink`（**不带签名**的 HEAD）。
	 *
	 * ⚠️ 注入点在这里而不是在客户端上：探测**不能用带凭据的客户端**做 ——
	 * 拿"我自己能打开"冒充"别人能打开"，这条检查会永远绿、什么都证明不了。
	 */
	probe?: (url: string) => Promise<{ status: number | null; contentType?: string | null }>;
}

/** 等待 `promise`，超过 `ms` 就放弃（**不取消**那个请求，只是不再等它）。 */
function withinTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: boolean; value?: T }> {
	// 与源码其它地方一致：计时器走 `window`（宿主是 WebView；`prefer-window-timers` 也是这条纪律）。
	let timer: number | null = null;
	const timeout = new Promise<{ timedOut: boolean }>((resolve) => {
		timer = window.setTimeout(() => resolve({ timedOut: true }), ms);
	});
	return Promise.race([
		promise.then((value) => ({ timedOut: false, value })),
		timeout,
	]).finally(() => {
		if (timer !== null) window.clearTimeout(timer);
	});
}

/**
 * 匿名探测一次「别人能不能打开这条链接」。**绝不抛错**。
 *
 * 为什么"绝不抛错"是硬要求：它的两个调用点（插件启动、设置页的按钮）都在用户视线里，
 * 一个冒出来的异常会让整页反馈被吞掉，而这里恰恰要给出**能照着做**的结论。
 * 网络层的问题全部收敛成 `unreachable`（超时另记 `timedOut`）。
 *
 * ⚠️ `requestUrl`（宿主网络栈）**没有超时参数**，所以超时只能在这一层用 `Promise.race`
 * 实现：超时之后那个请求仍在飞（我们不持有它的取消句柄），但**判定不再等它**。
 * 这是可接受的：探测只是一次 HEAD，最坏情况是多花一点流量。
 */
export async function probeAccess(url: string, deps: AccessProbeDeps = {}): Promise<AccessProbe> {
	const now = deps.now ?? (() => Date.now());
	const probe = deps.probe ?? probePublicLink;
	const timeoutMs = deps.timeoutMs ?? ACCESS_PROBE_TIMEOUT_MS;

	try {
		const raced = await withinTimeout(probe(url), timeoutMs);
		if (raced.timedOut) {
			return { kind: "unreachable", status: null, at: now(), timedOut: true };
		}
		const status = raced.value?.status ?? null;
		const contentType = raced.value?.contentType ?? null;
		return { kind: classifyPublicReach(status, contentType), status, at: now(), contentType };
	} catch {
		// 探测实现自己抛错（传输层、解析、权限……）：一律当"到不了"。
		return { kind: "unreachable", status: null, at: now() };
	}
}

/**
 * 由**当前设置**算出要探测的那条地址；算不出来返回 `null`。
 *
 * 用 `publicUrlFor` 而不是自己拼，是刻意的：探测必须试**真的要写进笔记的那个地址**。
 * 另拼一个地址来测，测的就不是用户笔记里那条链接了 —— 本项目刚因为
 * "推导与写入不同源"吃过一次亏（公开前缀根本没传到客户端，谁都没发现）。
 */
export function probeUrlFor(address: Parameters<typeof publicUrlFor>[0], key: string | null | undefined): string | null {
	const cleanKey = typeof key === "string" ? key.trim() : "";
	if (!cleanKey) return null;
	try {
		return publicUrlFor(address, cleanKey);
	} catch {
		// 端点/桶没配全：不是错误，是"现在没什么可探测的"
		return null;
	}
}
