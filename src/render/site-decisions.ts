/**
 * 按**站点**记住用户的决定（纯数据 + 纯函数）。
 *
 * ## 为什么单独成一层，而不是塞进设置
 *
 * 设置里放的是**用户的偏好**（"默认怎么处理"）；这里放的是**用户对某个具体站点的回答**
 * （"这一个站点别再问我了"）。两者的生命周期完全不同：设置是用户主动去改的，
 * 而这份记忆是**在渲染路径上被读取、被询问流程写入**的 —— 它必须能同步读（零 I/O），
 * 所以实际使用时它是**内存里的一份**，由 `host/site-store` 负责落盘与恢复。
 *
 * 把它单独成一层还有个直接好处：**归一化与降级可以穷举**。
 * 这两件事都极易写错，而写错的症状都很隐蔽：
 * - 归一化漏了 → 同一站点被记成两条 → 用户选了「不再询问」却仍然被问；
 * - 读坏数据抛错 → 插件在启动时挂掉（为一份记忆付出这个代价毫无道理）。
 *
 * ## 一条纪律：**不认识的一律跳过，绝不抛错**
 *
 * 记忆文件在 `.obsidian/plugins/` 下，用户可以手改、其它工具可以碰、同步可能冲突。
 * 所以 `fromJSON` 对任何形状的输入都返回一份可用的记忆 ——
 * 坏条目跳过，好条目留下（一条坏记录不该毁掉整份记忆）。
 */

/** 用户对一个站点的回答。 */
export type SiteDecision =
	/** 该站点的图直接缓存，不再询问。 */
	| "allow"
	/** 该站点不再询问，也不处理。 */
	| "deny";

/** 落盘格式的版本号。将来改格式时要靠它做迁移。 */
export const SITE_DECISIONS_VERSION = 1;

/** 一条记忆。 */
export interface SiteDecisionRecord {
	host: string;
	decision: SiteDecision;
}

export function isSiteDecision(value: unknown): value is SiteDecision {
	return value === "allow" || value === "deny";
}

/**
 * 把主机名归一化成查询用的键。
 *
 * 归一化三件事，每一件都对应一个真实会遇到的输入：
 * 1. **大小写** —— URL 解析出来的 host 是小写，但记忆文件可能是人手写的；
 * 2. **末尾的点** —— `example.com.` 是 FQDN 的合法写法，与 `example.com` 是同一站点；
 * 3. **首尾空白** —— 手改过的文件里很常见。
 *
 * ⚠️ **端口要保留**：`example.com:8080` 与 `example.com` 可能是两个完全不同的服务，
 * 把它们合并会让"我在本地测试站点上选的「不再询问」"意外作用到生产站点。
 *
 * 无法归一的输入返回**空串**（而不是抛出或 `String(value)`）——
 * 后者会得到一个 `[object Object]` 这样的"主机名"，反而能和别的坏输入撞成同一条。
 */
export function normalizeHost(host: unknown): string {
	if (typeof host !== "string") return "";
	return host.trim().toLowerCase().replace(/\.+$/, "");
}

export class SiteDecisions {
	/** 用 Map 而不是数组：查询发生在渲染路径上，必须 O(1)。 */
	private readonly byHost: Map<string, SiteDecision>;

	constructor(entries: Iterable<SiteDecisionRecord> = []) {
		this.byHost = new Map();
		for (const entry of entries) {
			// 构造时也走同一条校验：坏条目静默跳过，而不是让整份记忆作废。
			this.set(entry?.host, entry?.decision);
		}
	}

	get size(): number {
		return this.byHost.size;
	}

	get(host: unknown): SiteDecision | undefined {
		const key = normalizeHost(host);
		return key ? this.byHost.get(key) : undefined;
	}

	/**
	 * 写入一条决定。返回**是否真的写进去了**。
	 *
	 * 返回值有意义：调用方（设置页那次"导入/恢复"）会据此决定要不要汇报"跳过了几条"。
	 * 参数取 `unknown` 是因为数据来源可能是手改过的 JSON —— 校验放在这里，
	 * 调用方就不必每处都先验一遍。
	 */
	set(host: unknown, decision: unknown): boolean {
		const key = normalizeHost(host);
		if (!key || !isSiteDecision(decision)) return false;
		this.byHost.set(key, decision);
		return true;
	}

	/** 删除；返回**是否真的删掉了**（调用方据此如实汇报，而不是一律说"已清除"）。 */
	remove(host: unknown): boolean {
		const key = normalizeHost(host);
		return key ? this.byHost.delete(key) : false;
	}

	/** 清空；返回清掉的条数（用户想知道"清了几条"，而"已清除"什么都没说）。 */
	clear(): number {
		const count = this.byHost.size;
		this.byHost.clear();
		return count;
	}

	/**
	 * 按 host 排序后的条目 —— **落盘顺序必须稳定**。
	 *
	 * 不排序的话，Map 的顺序取决于写入历史（哪些站点先被访问），
	 * 于是每次落盘的 diff 都在变，用户把它放进 git 就会看到莫名其妙的改动。
	 */
	toArray(): SiteDecisionRecord[] {
		return [...this.byHost.entries()]
			.map(([host, decision]) => ({ host, decision }))
			.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
	}

	toJSON(): { version: number; decisions: SiteDecisionRecord[] } {
		return { version: SITE_DECISIONS_VERSION, decisions: this.toArray() };
	}

	/**
	 * 从任意 JSON 恢复。**任何形状的输入都不抛错**（理由见模块头注释）。
	 *
	 * 版本号目前只写不读：读到更高的版本时不拒绝、也不清空 ——
	 * 逐条校验本来就能跳过不认识的条目，而"因为版本新就丢掉用户的全部回答"会更糟。
	 */
	static fromJSON(value: unknown): SiteDecisions {
		if (!value || typeof value !== "object") return new SiteDecisions();
		const decisions = (value as { decisions?: unknown }).decisions;
		if (!Array.isArray(decisions)) return new SiteDecisions();
		return new SiteDecisions(
			decisions.map((item) => {
				const record = (item ?? {}) as { host?: unknown; decision?: unknown };
				return { host: record.host as string, decision: record.decision as SiteDecision };
			})
		);
	}
}
