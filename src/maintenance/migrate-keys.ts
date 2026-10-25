/**
 * 存量对象名的统一（R25 / CR-15）—— **纯逻辑**：预检分档、改写规则、复核判据。
 *
 * ## 它解决的问题
 *
 * 1.2.0 起单桶档的 key 是 `<名字>-<完整哈希>.<ext>`，共享桶档（CR-14）是 `<sha256>.<ext>`。
 * 于是桶里会**长期两代并存**，而且带来一个删不掉的死结：
 *
 * > 同一份内容的老 key 与新 key 在清理链里是**两个 key、同一个 hash**，
 * > 而跨库判据按 hash 查表 ⇒ 只要还有一台设备记着老 key，两条都会被"按 hash 否决"。
 * > **唯一出口就是这一步**（把老的搬成新的、然后删掉老的）。
 *
 * ## 五个阶段与两阶段提交
 *
 * | 阶段 | 做什么 | 中断后果 |
 * |---|---|---|
 * | A copy | 逐对象复制成新 key（已存在则跳过），COPY 后 HEAD 核长度 | 多一份新对象，续跑复用 |
 * | B relink | 逐篇改写笔记/画布里的链接（**每片 20 篇**） | 旧对象还在，两边链接都可用 |
 * | C verify | 全库扫"旧 key 还在不在" ＋ 每个新 key HEAD 复核 | **不全绿就不进 D** |
 * | D delete | 逐条删旧 key，写留痕（`scope: "migration"`） | 已改的链接都指向新 key |
 * | E ledger | 台账与索引条目换 key（`remoteUrl` 一起换） | 下次启动自愈重算 |
 *
 * A–C 是**第一阶段**：做完之前一个旧对象都不删，所以任意时刻中断都不会出现"链接指向不存在的对象"。
 * 这就是这一层没有任何"回滚"代码的原因 —— 回滚是**不需要**，而不是没做。
 *
 * ## 这一层为什么全是纯函数
 *
 * 它是本项目**第一次批量改用户笔记**的地方。能穷举的部分（怎么分档、改哪几处、什么时候算全绿）
 * 全放在这里由套件逐条钉住；真正碰网络与磁盘的只剩 `plugin/migrate-flow.ts` 的编排。
 */

import { displayNameForKey, hashFromKey, objectKeyFor } from "../object-key";
import type { MigrationState } from "../types";

/** 一条旧 key 的处置档位。四档各自对应一种"下一步做什么"。 */
export type MigrationBucket =
	/** 还要复制一份新对象（桶里没有新 key）。 */
	| "copy"
	/** 新 key 已经在了（上次跑到一半 / 另一台设备搬过）⇒ 只需要改链接。 */
	| "relink"
	/** 全库没有任何引用 ⇒ 不用复制、也不用改链接，直接删旧的。 */
	| "drop"
	/** 算不出新 key（`hashFromKey` 认不出的模板时代 key）⇒ **跳过并如实报告**。 */
	| "unknown";

/** 一条候选。`unknown` 档的 `newKey` / `hash` 是空串。 */
export interface MigrationCandidate {
	readonly oldKey: string;
	readonly newKey: string;
	readonly hash: string;
	readonly bucket: MigrationBucket;
	/** 展示名（旧 key 里的原名）；纯哈希 key 为空串。 */
	readonly name: string;
	/** 小写扩展名，不含点；没有就是空串。 */
	readonly ext: string;
}

/** 预检的四个数（判据里要求它们出现在界面上）。 */
export interface MigrationCounts {
	readonly copy: number;
	readonly relink: number;
	readonly drop: number;
	readonly unknown: number;
}

export interface MigrationPlan {
	/** 只含**需要处置**的旧 key（已经是纯哈希形状的不在里）。 */
	readonly candidates: readonly MigrationCandidate[];
	readonly counts: MigrationCounts;
}

export interface MigrationInput {
	/**
	 * 上传台账里的 key —— **唯一的归属依据**。
	 *
	 * 不用"桶里列出来的所有 key"：桶可能被别的库/别的工具共用，
	 * 那些对象不归我们改名（改了别处的链接就断了）。
	 */
	readonly ledgerKeys: readonly string[];
	/**
	 * 桶里此刻已有的 key；`null` = 没列举（拿不到 `ListBucket` 或不想多一次往返）。
	 *
	 * `null` 时**全部按 `copy` 处理**：COPY 到已存在的 key 是幂等的（多一次网络往返，
	 * 不会覆盖坏数据），而反方向（把 `relink` 猜成 `copy` 之外的别的档）会漏复制。
	 */
	readonly cloudKeys: ReadonlySet<string> | null;
	/** 全库正文（含画布）里**出现过**的 key —— 判断"有没有人引用"的唯一依据。 */
	readonly referencedKeys: ReadonlySet<string>;
}

/**
 * key 的最后一段的扩展名（小写、不含点）。没有点或点在开头 ⇒ 空串。
 *
 * 只取最后一段：目录名里的点（`v1.2/photo.png`）不该参与扩展名判断。
 */
export function extensionOfKey(key: string): string {
	const segment = key.split(/[\\/]/).pop() ?? "";
	const dot = segment.lastIndexOf(".");
	// `> 0` 而不是 `>= 0`：`.gitignore` 那种"点开头"不是扩展名
	return dot > 0 ? segment.slice(dot + 1).toLowerCase() : "";
}

/**
 * 一个 key **已经是**纯内容寻址形状了吗（`<sha256>.<ext>`）。
 *
 * 判据用 `displayNameForKey` 而不是自己写正则：它会为带名字的形状返回名字、
 * 为纯哈希形状返回空串 —— 与生成侧（`objectKeyFor`）同源，不另造一份规则。
 * ⚠️ 同时要求 `hashFromKey` 认得出：`displayNameForKey` 对**完全认不出**的 key 也返回空串
 *（例如用户手工塞进台账的 `notes/readme.md`），那种 key 不能当成"已统一"而漏报。
 */
export function isContentAddressedKey(key: string): boolean {
	return displayNameForKey(key) === "" && hashFromKey(key) !== null;
}

/**
 * 预检：把台账里的旧 key 分到四个档。
 *
 * ## 三条排他规则（顺序就是这个优先级）
 *
 * 1. **已经是纯哈希** ⇒ 完全不进候选（重复跑必须收敛到 0，判据里有"连跑两次第二次四项为 0"）；
 * 2. **算不出 hash** ⇒ `unknown`（跳过并报告，不谎报完成）；
 * 3. **没有任何引用** ⇒ `drop`（不复制 —— 复制了也没有一条链接会指过去，
 *    反而多出一个"看起来没人用"的新对象要等下一次清理）；
 * 4. 新 key 已在桶里 ⇒ `relink`；否则 `copy`。
 *
 * ## 同内容多份旧 key
 *
 * 两个旧 key 可能**指向同一个新 key**（同内容、不同文件名）。此时只让**第一条**去 `copy`，
 * 后面的记 `relink` —— 否则会并发写同一个新 key（多花流量，且失败判定会因为
 * "对方先写好了"而变得随机）。这条也让"同一批里重名"变得可预测：按台账顺序取第一条。
 */
export function planMigration(input: MigrationInput): MigrationPlan {
	const candidates: MigrationCandidate[] = [];
	const counts = { copy: 0, relink: 0, drop: 0, unknown: 0 };
	/** 本批里已经决定要复制的新 key（决定"第二条同内容记 relink"）。 */
	const willCopy = new Set<string>();
	const done = new Set<string>();

	for (const raw of input.ledgerKeys) {
		const oldKey = typeof raw === "string" ? raw.trim() : "";
		if (oldKey === "" || done.has(oldKey)) continue;
		done.add(oldKey);

		// ① 已经统一过 ⇒ 不进候选
		if (isContentAddressedKey(oldKey)) continue;

		const hash = hashFromKey(oldKey);
		const ext = extensionOfKey(oldKey);
		const name = displayNameForKey(oldKey);
		if (hash === null) {
			candidates.push({ oldKey, newKey: "", hash: "", bucket: "unknown", name, ext });
			counts.unknown += 1;
			continue;
		}

		// 新 key 的**唯一**生成入口（与上传链同一条规则）
		const newKey = objectKeyFor({ hash, ext, filename: name || oldKey }, { contentAddressed: true });
		if (newKey === "") {
			candidates.push({ oldKey, newKey: "", hash, bucket: "unknown", name, ext });
			counts.unknown += 1;
			continue;
		}

		// ② 没人引用 ⇒ 直接删旧的（不复制）
		if (!input.referencedKeys.has(oldKey)) {
			candidates.push({ oldKey, newKey, hash, bucket: "drop", name, ext });
			counts.drop += 1;
			continue;
		}

		// ③ 新 key 已经在桶里（或本批前一条要复制它）⇒ 只改链接
		const alreadyThere = input.cloudKeys ? input.cloudKeys.has(newKey) : false;
		if (alreadyThere || willCopy.has(newKey)) {
			candidates.push({ oldKey, newKey, hash, bucket: "relink", name, ext });
			counts.relink += 1;
			continue;
		}

		willCopy.add(newKey);
		candidates.push({ oldKey, newKey, hash, bucket: "copy", name, ext });
		counts.copy += 1;
	}

	return { candidates, counts };
}

/** 预检里"要动的东西"总共有几件（0 ⇒ 不用跑，界面直接说"已是最新"）。 */
export function pendingTotal(counts: MigrationCounts): number {
	return counts.copy + counts.relink + counts.drop;
}

/**
 * B 阶段要用的改写规则：**旧地址 → 新地址**。
 *
 * ⚠️ `drop` / `unknown` 不产规则：前者没人引用（改了也是空转），后者算不出新 key。
 * ⚠️ 地址推不出来的那对（端点没配好）也跳过 —— 宁可这一条留着旧链接（下次再跑），
 * 也不产出半个地址（那会让笔记里出现一个必然 404 的链接）。
 */
export function migrationRules(
	plan: MigrationPlan,
	urlFor: (key: string) => string | null
): { from: string; to: string; display: string }[] {
	const rules: { from: string; to: string; display: string }[] = [];
	for (const candidate of plan.candidates) {
		if (candidate.bucket !== "copy" && candidate.bucket !== "relink") continue;
		const from = urlFor(candidate.oldKey);
		const to = urlFor(candidate.newKey);
		if (!from || !to || from === to) continue;
		rules.push({ from, to, display: candidate.name });
	}
	return rules;
}

/**
 * C 阶段的复核：还有哪些旧 key **留在正文里**。
 *
 * ## 为什么要连"裸 key"一起比
 *
 * 笔记里的形态不止一种（`![](url)`、`![](url "title")`、属性、画布 `text` 节点、
 * 甚至用户自己贴的裸地址）。只比 URL 会漏掉"URL 被写成别的编码形式"的那些，
 * 而漏掉的代价是**删掉一个还在被引用的对象**。所以判据放宽到
 * "旧 key 这个字符串还在不在" —— 只要在，就**不删**（方向永远是"少删"）。
 *
 * ⚠️ 这条判据故意**不检查新 key 是否出现**：C 阶段只回答"旧的走干净了没有"。
 * 新 key 的存在性由 HEAD 复核（I/O 那一侧）回答，两件事不能混成一条。
 */
export function leftoverOldKeys(input: {
	readonly texts: readonly string[];
	readonly oldKeys: readonly string[];
	readonly urlFor: (key: string) => string | null;
}): string[] {
	const leftovers: string[] = [];
	for (const oldKey of input.oldKeys) {
		const url = input.urlFor(oldKey);
		const hit = input.texts.some(
			(text) => typeof text === "string" && text !== "" && (text.includes(oldKey) || (url !== null && text.includes(url)))
		);
		if (hit) leftovers.push(oldKey);
	}
	return leftovers;
}

/**
 * 能不能进 D 阶段（删旧 key）。
 *
 * 三个条件**同时**成立：① 一篇都没读不到；② 正文里旧 key 全清；③ 每个新 key 都 HEAD 到了
 * 且长度一致。缺一个就一个都不删 —— 这是整个功能唯一不可逆的那一步。
 *
 * ⚠️ **读不到排在最前面**：它是最容易被写成"跳过、继续"的那一条，而"这篇里有没有旧链接"
 * 恰好只能由它回答。把它排在后面，症状会是"删完才发现有一篇读不了"。
 * ⚠️ 单独写成函数而不是内联 `if`：这条判据会被套件与变异锚点直接调用，
 * 内联的话"改坏它"只能靠跑真机发现。
 */
export function canDeleteOldKeys(input: {
	readonly leftovers: readonly string[];
	readonly newKeys: readonly { key: string; ok: boolean }[];
	/** 复核期间读不到的篇数；`undefined` = 全读到了。 */
	readonly unreadable?: number;
}): { ok: boolean; reason: "" | "unreadable" | "leftover" | "new-missing" } {
	if ((input.unreadable ?? 0) > 0) return { ok: false, reason: "unreadable" };
	if (input.leftovers.length > 0) return { ok: false, reason: "leftover" };
	if (input.newKeys.some((item) => !item.ok)) return { ok: false, reason: "new-missing" };
	return { ok: true, reason: "" };
}

/**
 * 改名要不要被拦。
 *
 * 判据是**执行层**的状态位，不是 UI 里那颗灰掉的按钮（§9.5 / CR-16）：
 * 灰按钮挡不住并发触发 —— 命令面板、别的插件、同步回调都可能绕过界面。
 * `running` 与 `interrupted` 都拦：中断的那次迁移还没收口，改一次名就会让
 * B 阶段"按旧名生成的新 key"和声明里的名字对不上。
 */
export function blocksRename(state: MigrationState): boolean {
	return state !== "idle";
}
