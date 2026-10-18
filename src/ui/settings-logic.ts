/**
 * 设置界面的**纯逻辑**（不碰 DOM）。
 *
 * 与 `editor-hooks` 同样的理由分开：这些判断决定"界面显示什么"以及
 * "存进去的是什么"，都属于**翻错了不会报错、只会长期困惑**的那类。
 * 拆成纯函数才能穷举，也才能在不用真实 Obsidian 的情况下验证。
 */

import type { ExternalSiteMode, LocalCopyAction, OrphanAskMode } from "../types";
import { CACHE_LIMIT_MB_MAX, EXTERNAL_SITE_MODES, LOCAL_COPY_ACTIONS, ORPHAN_ASK_MODES, isCacheDisabled } from "../types";
import { classifyPublicReach } from "../link-access";
import type { ConnectionState, PublicReachKind } from "../link-access";

/**
 * ⚠️ 公开可达性的归类**不在这里实现**了（1.7.0）：它同时也是一条**判定**（决定走公开读取
 * 还是内部访问，见 `link-access.ts::resolveAccess`），而"给人看的一句话"与"给判定用的一格"
 * 必须是同一套取值 —— 两份实现迟早分叉，分叉的表现是"界面说桶私有，判定却当公开"。
 * 这里只把名字转出去，让设置页的既有调用点不必改。
 */
export { classifyPublicReach as classifyPublicLink };

/**
 * 秘密访问密钥在钥匙串里那条槽位的名字前缀。
 *
 * 用户**看不到**这个名字（界面上是一个普通输入框，值写穿到钥匙串），
 * 但它在系统钥匙串里是可见的 —— 所以前缀要能让人认出"这是哪个插件建的"。
 */
export const SECRET_SLOT_PREFIX = "attachment-cloud-cache-s3-secret";

/**
 * 一条随机串，用作槽位名的随机部分。
 *
 * 放在这里是为了让"生成规则"只有一处；`Math.random().toString(36)` 给出的是
 * 小写字母数字（正是 SecretStorage 允许的字符集）。
 */
export function randomSlotPart(): string {
	return Math.random().toString(36).slice(2, 10);
}

/**
 * 秘密访问密钥的**钥匙串槽位名**：没有就生成一个，已有就原样沿用。
 *
 * ## 为什么要有这么一个槽位名
 *
 * 秘密不能存进设置（`data.json` 是明文，且会随 vault 同步/备份/分享）——
 * 它必须进钥匙串。而钥匙串是**具名**的，所以要有个名字才能取回来。
 *
 * 但这个名字**不该由用户起**：访问密钥 ID 与秘密访问密钥是**成对签发、成对轮换**的
 *（MinIO / AWS 都如此），把其中一个变成"先去钥匙串给条目起个名"，
 * 就等于把一对凭据拆到两个地方去改。让它自动生成、写穿进去，
 * 用户就只需要面对"两个相邻的输入框"。
 *
 * ## ⚠️ 为什么必须**自己净化**传进来的字符
 *
 * `SecretStorage.setSecret` 对非法 ID 会直接**抛错**，而它只接受
 * 「小写字母、数字、短横线」。不能指望调用方给的东西干净 —— 更不能等到
 * `setSecret` 抛错才发现（那时秘密已经丢了）。
 *
 * ## ⚠️ 已有槽位**绝不改名**
 *
 * 改名等于把已经存进钥匙串的秘密孤儿化：设置页里那个框还是满的（我们从钥匙串读回值），
 * 但读取用的名字变了 —— 表现为"凭据被拒"，而一切看起来都配好了。极难归因，
 * 所以"沿用"这条有专门的断言（并且要断言**没有**去调用生成器）。
 *
 * @param existing 当前设置里存的槽位名（可能为空 = 还没存过秘密）
 * @param randomPart 新的随机部分；**调用方必须给非空值**（见 `randomSlotPart`）
 */
export function ensureSecretSlot(existing: string, randomPart: string): string {
	const trimmed = String(existing ?? "").trim();
	if (trimmed !== "") return trimmed;
	// 只留下 SecretStorage 允许的字符：小写字母与数字（短横线由我们自己拼）
	const safe = String(randomPart ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	return `${SECRET_SLOT_PREFIX}-${safe}`;
}

/**
 * 下拉选项：由**类型清单**生成 `{取值: 文案}`（正是 `SettingDropdownControl.options` 的形状）。
 *
 * 从清单生成而不是手写，是为了让"界面上能选的值"与"类型允许的值"只有一处定义 ——
 * 将来加一个取值，它自动出现在界面上；漏了也不会出现"选了但类型不认"的组合。
 */
export function localCopyOptions(labelOf: (value: LocalCopyAction) => string): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of LOCAL_COPY_ACTIONS) options[value] = labelOf(value);
	return options;
}

/** 同上，给「站点名单」那一档用。 */
export function externalSiteModeOptions(
	labelOf: (value: ExternalSiteMode) => string
): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of EXTERNAL_SITE_MODES) options[value] = labelOf(value);
	return options;
}

/** 同上，给「无人引用的附件怎么告诉你」那一档用。 */
export function orphanAskOptions(labelOf: (value: OrphanAskMode) => string): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of ORPHAN_ASK_MODES) options[value] = labelOf(value);
	return options;
}

/**
 * 「连接状态」→ 一句人话 + 语气。
 *
 * ⚠️ 状态是**探测出来的事实**，不是用户能选的东西（2026-10-18 起取消了那个三档设置）。
 * 所以这里只做两件事：选文案 key、选颜色。四个状态缺一不可 ——
 * `checking` 必须能显示（刚启动那一下），否则界面会在"公开/私有"之间凭空挑一个。
 */
export function connectionStateKey(state: ConnectionState): string {
	return `connectionStatus_${state}`;
}

/**
 * 「这一轮的结果里，还需要单独补一行连接状态吗？」
 *
 * ⚠️ 公开 / 私有 / 连不上时**不需要**：`testPublic_ok` / `testPublic_forbidden` /
 * `testPublic_unreachable` 已经把同一件事说了一遍，再补一句「公开访问」就是同一句话说两遍
 * （用户 2026-10-18 报的「提示里出现了两次公开访问」）。
 *
 * 而 `missing` / `webpage` / `other` 那几行说的是「判断不了」，本身不含结论 ——
 * 这时状态行才是唯一的信息来源，必须补。
 */
/**
 * 「这一轮要不要单独解释匿名可达性？」
 *
 * `ok` / `forbidden` 是**已经定论的正常状态**（公开 / 私有），而状态灯就在同一项里写着 ——
 * 再补一行「存储拒绝匿名访问…」既重复、又暴露实现（"我们刚才去匿名问了一次"）。
 * 其余几类（对象不在 / 回的不是你的文件 / 响应不稳定 / 连不上 / 无法判断）说明
 * **结论不成立或地址有问题**，用户需要知道，才单独说。
 */
export function publicReachNeedsAttention(kind: PublicReachKind): boolean {
	return kind !== "ok" && kind !== "forbidden";
}

export function stateLineNeeded(kind: PublicReachKind): boolean {
	return kind === "missing" || kind === "webpage" || kind === "unstable" || kind === "other";
}

/**
 * 语气（也就是那盏灯的颜色）。
 *
 * | 状态 | 语气 | 为什么 |
 * |---|---|---|
 * | `public` | `ok`（绿） | 一切照常 |
 * | `private` | **`accent`（蓝）** | 见下 |
 * | `unreachable` | `error`（红） | 该去改点什么 |
 * | `checking` | `info`（灰） | 还不知道 |
 *
 * ⚠️ **私有不用黄色**（用户 2026-10-18 提的）：黄在几乎所有界面里都读作"警告 / 待处理"，
 * 而"桶是私有的"是一个**正当且稳定**的配置（只给自己用）—— 用户看见黄灯会跑去改一个
 * 没坏的设置，改完反而把链接暴露出去。蓝色读作"受限，但正常"。
 * ⭐ 顺带：绿 / 黄 / 红恰好是红绿色盲最难分的一组，少一档黄就少一处混淆。
 */
export function connectionStateTone(state: ConnectionState): "ok" | "warn" | "error" | "info" | "accent" {
	switch (state) {
		case "public":
			return "ok";
		case "private":
			// 私有是**正当选择**（只给自己用）：既不是错误，也不是警告
			return "accent";
		case "unreachable":
			return "error";
		default:
			return "info";
	}
}

// ⚠️ 1.7.0 当天下架：这里曾有一个 `coherentLocalCopy`，用来把「仅内部访问 + 不留副本」
// 当成**矛盾组合**纠正成「保留副本」。用户在评审时问了一句「仅内部就必须下载吗？
// 不能像图床那样只存在 S3？」—— 于是那个组合不再矛盾，而是**第四种正常用法**：
// 私有存储 + 不留副本 ⇒ 渲染时给 `<img>` 一条预签名地址（磁盘不落文件、离线看不到）。
// 判据见 `link-access.ts::displayPathFor`。**没有这个函数了**，别再把它加回来。

/**
 * ⚠️ 1.2.0（D-17）删掉了 `shouldShowCacheFolder`：那个选项是"选「移入缓存」才显示缓存目录"，
 * 而缓存目录与那个选项**一起去掉了**，于是这条谓词没有任何调用方。
 * 删掉它是死代码纪律的一部分（连同套件断言与变异锚点）—— 别把它当成"以后可能有用"留下。
 */

/**
 * 「缺本地副本时自动下载」这一项要不要显示。
 *
 * ⚠️ 选「不留副本」时那一档**等于关闭缓存**（判定在 `types.ts` 的 `isCacheDisabled`），
 * 这一项永远不会动手 —— 显示一个永远不起作用的开关比不显示更糟。
 *
 * ⚠️ 反过来，这一项**不能**跟着"会不会产生副本"一起藏掉：选「留在附件目录」时副本就在
 * 附件目录里，换设备时正是它把副本补回来。它与「本地副本上限」问的其实是两个问题。
 */
export function shouldShowFallbackDownload(action: unknown): boolean {
	return !isCacheDisabled(action);
}

/**
 * 「本地副本上限」这一项要不要显示。
 *
 * ⚠️ 这一条正是 **P7 的关闭方式**（1.2.0 / D-17）：从前这项只在「移入缓存」档显示，
 * 而后台判定只看 `cacheLimitMb > 0` ⇒ 「留在附件目录」档**看不见的开关却在生效**
 * （与"不起作用的开关不显示"正好相反）。
 *
 * 现在上限的统计范围 = **索引里的所有本地副本**（含附件目录里那两份），于是：
 * - 「保留副本」档：这一档会产生副本 ⇒ 显示，且**确实生效**；
 * - 「不留副本」档：这一档不产生副本（上传后删除、下载也不落盘）⇒ 隐藏，且**确实不起作用**。
 *
 * 判据与 `shouldShowFallbackDownload` 同形（都问"这一档会不会有副本"），
 * 但**刻意不合并成同一个函数**：它们回答的是两个不同的问题
 *（"要不要把副本补回来"与"副本总量该不该有上限"），将来任何一个的判据变化都不该牵动另一个。
 */
export function shouldShowCacheLimit(action: unknown): boolean {
	return !isCacheDisabled(action);
}

/**
 * 「清理本地副本」（F18）在**这一档**下该清到什么程度。
 *
 * ## ⭐ 为什么这是一处定义、两个调用方
 *
 * 设置页的显隐谓词（`shouldShowReleaseSpace`）与流程本身（`release-space-flow` 拿它算目标）
 * 必须**同一个来源**：分成两处必然在某次改动里分叉，而分叉的表现是
 * "按钮在，点了一点动静都没有"或有动静却清错了量 —— 都不报错。
 *
 * | 档位 | 上限 | 目标 | 按钮 |
 * |---|---|---|---|
 * | 不留副本 | （隐藏） | `all`（一份不留）| 显示 —— 这一档的含义**就是**本地不留副本，按钮把它应用到**已有的**那批上（设计 §20.10） |
 * | 保留副本 | > 0 | `limit`（清到上限以内）| 显示 —— 上限是"**总量**"的承诺，手动入口只是"**立刻**执行它"（不比后台多删什么，只是不等那 ≤10 分钟） |
 * | 保留副本 | 0 / 没设 | `none` | **不显示** —— 不限量就谈不上"清到多少" |
 * | 非法值 | 非法值 | `none` | **不显示** |
 *
 * ⚠️ 最后一行是刻意的：坏值**不**落回 `all`。那是三种解释里**最具破坏性**的一种，
 * 而"读不出来的值"没有任何理由触发它（`mergePluginSettings` 已经在入口校验过一遍，
 * 这里只是不让"再往下一层出问题时"变成一次误删）。
 *
 * ⚠️ 1.2.0～1.2.2 的旧口径在这里被**推翻**了：那时这个按钮**只在「不留副本」档显示**，
 * 理由是"在保留档显示它 = 用户刚说要留副本、却给他一个把副本全删掉的按钮，自相矛盾"。
 * 现在按钮在保留档下清的是**用户自己设的上限**（而不是全删）⇒ 那条理由自动消失；
 * 而反过来，旧口径留下的缺口正是用户 2026-10-15 报的那个：**设了上限、想立刻腾空间，
 * 却找不到任何手动入口**（只能等后台那一轮）。
 */
export type LocalCopyCleanupTarget =
	| { kind: "all" }
	| { kind: "limit"; mb: number }
	| { kind: "none" };

/**
 * 档位（+ 上限）→ 清理目标。
 *
 * ⚠️ 上限的口径与 `eviction.ts` 的 `megabytesToBytes` **必须一致**（非数 / 负数 / NaN / 0
 * 都算"不限制"）：两处要是分叉，设置里"500"就会在后台与手动之间变成两个数。
 */
export function localCopyCleanupTarget(action: unknown, cacheLimitMb: unknown): LocalCopyCleanupTarget {
	if (isCacheDisabled(action)) return { kind: "all" };
	const mb =
		typeof cacheLimitMb === "number" && Number.isFinite(cacheLimitMb) ? Math.floor(cacheLimitMb) : 0;
	return mb > 0 ? { kind: "limit", mb } : { kind: "none" };
}

/**
 * 「释放本地空间」（F18）那一项要不要显示。
 *
 * ⚠️ 判据**只**来自 `localCopyCleanupTarget`（见上）—— 别再在这里写第二套条件。
 */
export function shouldShowReleaseSpace(action: unknown, cacheLimitMb?: unknown): boolean {
	return localCopyCleanupTarget(action, cacheLimitMb).kind !== "none";
}

/**
 * 「站点名单」输入框要不要显示。
 *
 * ⚠️ 只在黑名单 / 白名单那两档显示：`off` 那一档下名单**根本不生效**，
 * 显示一个不起作用的输入框比不显示更糟（与「缓存目录」那条同一个纪律）。
 * 用户想填名单，会先把模式改过来 —— 那时框自然出现。
 */
export function shouldShowSiteList(mode: unknown): boolean {
	return mode === "blocklist" || mode === "allowlist";
}

/**
 * 「测试连接」失败的归类。
 *
 * 不直接把 `error.message` 抛给用户：那是给排查用的（可能带一屏 XML），
 * 而这里要给的是**下一步做什么**。所以先归类，再取对应文案。
 *
 * 按 `.kind` 判而不是按 `instanceof`：这个函数要在没有真实 `S3Error` 实例的
 * 测试里也能用，而 `kind` 正是 `errors.ts` 已经定好的稳定契约。
 */
export type ConnectionFailureKind = "auth" | "bucketMissing" | "network" | "throttled" | "server" | "other";

export function classifyConnectionFailure(error: unknown): ConnectionFailureKind {
	const kind =
		typeof error === "object" && error !== null && "kind" in error
			? (error as { kind?: unknown }).kind
			: undefined;

	switch (kind) {
		case "auth":
			return "auth";
		case "notFound":
			// `headBucket` 把 404 处理成 `{exists:false}`，所以走到这里的 404
			// 只可能来自别处；仍归为"桶不存在"最贴近用户的处置动作。
			return "bucketMissing";
		case "network":
			return "network";
		case "throttled":
			return "throttled";
		case "server":
			return "server";
		default:
			return "other";
	}
}

/** 归类 → 文案 key。 */
/**
 * 解析用户在设置里填的缓存上限（MB）。**纯函数**。
 *
 * ## 为什么单独成函数
 *
 * 这个字段的输入来自一个**文本框**（设置页只有文本/开关/下拉三种控件），
 * 所以"用户敲的那串字符"与"设置里那个数字"之间必须有一次翻译。
 * 翻译错了的症状是"改了设置、也保存了，但重启后值又变回去了"——
 * 属于本项目最警惕的那类静默失效，必须有测试钉住。
 *
 * ## 规则：宽松，但**不猜**
 *
 * | 输入 | 结果 |
 * |---|---|
 * | `""`（清空） | `0` = 不限制（清空是有明确意图的动作） |
 * | 纯数字（允许首尾空白） | 该数字，夹在 `[0, CACHE_LIMIT_MB_MAX]` |
 * | 其余（`abc`、`1e9`、`-5`、`1.5GB`） | `null` = **无法理解** |
 *
 * 返回 `null` 时调用方**必须保留原值**（见 `settings-bindings.ts` 的
 * `isWritableValue`）—— 把"看不懂的输入"静默变成"不限制"会让用户以为
 * 自己填过的东西丢了，而那恰恰是他刚做的事。
 *
 * ⚠️ 不接受小数：粒度是 MB，`1.5` 更像"单位写错了"，
 * 与其静默取整不如让框里留着用户敲的那串字符。
 */
export function parseCacheLimitMb(raw: unknown): number | null {
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? clampLimitMb(Math.trunc(raw)) : null;
	}
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (text === "") return 0;
	if (!/^\d+$/.test(text)) return null;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? clampLimitMb(parsed) : null;
}

function clampLimitMb(value: number): number {
	return Math.min(CACHE_LIMIT_MB_MAX, Math.max(0, value));
}

/** 设置里的上限（数字）→ 输入框里的文本。 */
export function formatCacheLimitMb(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0";
	return String(Math.trunc(value));
}

/** 名单（设置里的数组）→ 输入框里的文本：**一行一条**。 */
export function formatSiteListText(stored: unknown): string {
	if (!Array.isArray(stored)) return "";
	return stored.filter((item) => typeof item === "string").join("\n");
}

/**
 * 输入框里的文本 → 名单（设置里的数组）。
 *
 * ⭐ **宽松，但不改写**：按行切、去掉首尾空白与空行，**不做归一化**
 *（大小写、去重、`*.` 通配、整条 URL 都留给判定层的 `normalizeSiteEntry`）。
 * 这里的目标只是"把用户敲进去的东西存成一个干净的数组"，而不是替他整理 ——
 * 在设置页悄悄改写用户填的内容，会让他下次打开时看到一个自己没写过的名单。
 *
 * ⚠️ 空文本 = **空数组**（不是"没填 → 保留原值"）：清空名单是一个明确动作。
 * 它在白名单模式下的后果是"什么都不再自动处理" —— 那是诚实的，不是坏值。
 */
export function parseSiteListText(raw: unknown): string[] {
	if (typeof raw !== "string") return [];
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

export function connectionFailureKey(kind: ConnectionFailureKind): string {
	return `testFail_${kind}`;
}

/**
 * 公开地址探测结果的归类。
 *
 * ⚠️ 与 `classifyConnectionFailure` 是**两个不同的问题**，绝不能合并：
 * 那个问的是「**我**能不能连上存储」，这个问的是「**别人**能不能打开我笔记里那条链接」。
 * 合并了就会出现最坏的那种表现 —— 自己这边一切正常，而发给别人的链接全是死的。
 *
 * 每一类的**修法不同**，所以也不能都归成"打不开"：
 * - `forbidden`：地址对、桶私有 ⇒ 开公开读，或配一个公开访问前缀（CDN / 自定义域名）
 * - `missing`：地址通、对象不在 ⇒ 多半前缀写错（例如少了桶名）
 * - `unreachable`：地址本身不对 ⇒ 前缀写错了
 *
 * ⚠️ 实现见 `link-access.ts::classifyPublicReach`（那里是唯一一份，因为它同时是一条判定）。
 */
export type PublicLinkKind = PublicReachKind;

export function publicLinkKey(kind: PublicLinkKind): string {
	return `testPublic_${kind}`;
}

/**
 * 「探针回路的某一段没成功」→ 一句该怎么说。
 *
 * 回路是**写 → 读 → 删**三段，每一段的失败原因与修法都不同：
 *
 * | 段 | 失败的含义 | 该查什么 |
 * |---|---|---|
 * | `write` | 连接与桶都通，但**写不进去** ⇒ 上传也会这样失败 | 这把密钥的写权限 |
 * | `read` | 写进去了但**读不回来** ⇒ 私有桶取副本 / 离线渲染会坏 | 这把密钥的读权限 |
 *
 * ⚠️ 所以不能拿 `testFail_*` 里那句"服务拒绝了凭据"糊过去（用户会去重填密钥，
 * 而密钥是对的、缺的是某一段的权限），也不能说成"没有可检查的对象"（那是另一回事）。
 * 网络 / 限流两类的**含义与段无关**，仍然沿用原来那两句 —— 换新话只会让用户以为
 * 存储配置有毛病。
 */
export function probeStepFailureKey(step: "write" | "read", error: unknown): string {
	const kind = classifyConnectionFailure(error);
	if (kind === "network") return "testFail_network";
	if (kind === "throttled") return "testFail_throttled";
	// 两段共用一个函数（同一套归类规则），但**结论必须是两句话**
	return step === "write" ? "testFail_probeWrite" : "testFail_probeRead";
}

/**
 * 归类 → 呈现的**语气**（界面上的颜色）。
 *
 * 分三档而不是"对/错"：`forbidden` 是**知道了就好**（桶私有是正当选择，只是链接对外是死的），
 * 而 `missing` / `unreachable` 是**地址配错了**（该去改前缀）。都涂成红色会把两件事混成一件，
 * 用户就不知道该不该动手改。
 */
export function publicLinkTone(kind: PublicLinkKind): "ok" | "warn" | "error" {
	switch (kind) {
		case "ok":
			return "ok";
		case "forbidden":
			return "warn";
		case "webpage":
			// 地址上有个东西回了网页 —— 不是「打不开」，也不是「我们的对象打得开」。
			// 用 warn：该去看前缀，但桶本身未必有问题。
			return "warn";
		case "unstable":
			// 同一轮两次结论不一致 —— 该去看网关 / 反代，不是改桶。
			return "warn";
		default:
			return "error";
	}
}
