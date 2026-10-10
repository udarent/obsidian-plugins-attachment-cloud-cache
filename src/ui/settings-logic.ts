/**
 * 设置界面的**纯逻辑**（不碰 DOM）。
 *
 * 与 `editor-hooks` 同样的理由分开：这些判断决定"界面显示什么"以及
 * "存进去的是什么"，都属于**翻错了不会报错、只会长期困惑**的那类。
 * 拆成纯函数才能穷举，也才能在不用真实 Obsidian 的情况下验证。
 */

import type { ExternalImageDefault, LocalCopyAction } from "../types";
import { CACHE_LIMIT_MB_MAX, EXTERNAL_IMAGE_DEFAULTS, LOCAL_COPY_ACTIONS, isCacheDisabled } from "../types";

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

/** 同上，给「遇到外链图片时」那一档用。 */
export function externalImageDefaultOptions(
	labelOf: (value: ExternalImageDefault) => string
): Record<string, string> {
	const options: Record<string, string> = {};
	for (const value of EXTERNAL_IMAGE_DEFAULTS) options[value] = labelOf(value);
	return options;
}

/**
 * 「缓存目录」这一项要不要显示。
 *
 * ⚠️ 这是消除"矛盾配置"的**界面侧**手段：只有选了「移入缓存」，
 * 缓存目录才有意义。留着它可见会让用户以为改它有用 ——
 * 而实际上 `planLocalCopy` 在其余两种取值下根本不会用到它。
 * 看不见的字段不会产生矛盾。
 */
export function shouldShowCacheFolder(action: unknown): boolean {
	return action === "cache";
}

/**
 * 「缺本地副本时自动下载」这一项要不要显示。
 *
 * ⚠️ 与缓存目录同一个理由：选「不留副本」时那一档**等于关闭缓存**
 * （判定在 `types.ts` 的 `isCacheDisabled`），这一项永远不会动手 ——
 * 显示一个永远不起作用的开关比不显示更糟。
 *
 * ⚠️ 但**不能**图省事复用 `shouldShowCacheFolder`：选「留在附件目录」时缓存目录确实没用，
 * 而这一项**仍然有用** —— 副本就在附件目录里，换设备时正是它把副本补回来。
 */
export function shouldShowFallbackDownload(action: unknown): boolean {
	return !isCacheDisabled(action);
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
 */
export type PublicLinkKind = "ok" | "forbidden" | "missing" | "unreachable" | "other";

export function classifyPublicLink(status: number | null): PublicLinkKind {
	if (status === null) return "unreachable";
	if (status >= 200 && status < 300) return "ok";
	if (status === 401 || status === 403) return "forbidden";
	if (status === 404) return "missing";
	return "other";
}

export function publicLinkKey(kind: PublicLinkKind): string {
	return `testPublic_${kind}`;
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
		default:
			return "error";
	}
}
