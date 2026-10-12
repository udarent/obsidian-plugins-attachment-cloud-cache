/**
 * 索引自愈：把"指向的本地副本已经不在"的记录摘掉。
 *
 * ## 它修的是什么
 *
 * 索引记的是「哪条远端 URL 对应哪份本地副本」。而那份副本随时可能消失：
 * 用户删掉了缓存目录、同步工具漏同步了某个文件、`keep` 档下用户自己整理了附件目录。
 * 记录留着指向一个不存在的文件，有两个真实后果：
 * - **占用统计虚高**（"缓存里有多少"会把不存在的文件算进去）；
 * - **回退下载判错**（渲染时以为"本地已有"，于是既不显示、也不去取）。
 *
 * ## ⭐ 三条纪律（每一条都有它防的那件事）
 *
 * ### 1. 只摘记录，**绝不碰文件**
 *
 * 这一层是"账本对不上就改账本"，不是清理。删文件是**淘汰（轮换）**与
 * **R17 的询问**那两条线的事，
 * 它们各有自己的确认与边界。混在一起会出现"只是想修一下索引，结果删了文件"。
 *
 * ### 2. "文件不在"必须**两条路都说不存在**才算，且**查询出错时按"存在"处理**
 *
 * 误摘的代价是**不对称**的：多留一条记录只是统计不准；误摘一条记录，
 * 那张图在离线时就不显示了，有网时还会重新下载一次 —— 用户选的"离线可用"被**悄悄**拿掉。
 * 所以判据朝"多留"一侧倒：
 * - 宿主文件索引（内存查表）与文件适配器**都**说不在，才算不在；
 * - 适配器查询**抛错时按"存在"**处理（⚠️ 与 `core/download.ts` 的 `exists` **默认值相反** ——
 *   那边 `false` 意味着"去下载"，是安全方向；这里 `false` 意味着"摘掉记录"，是不安全方向。
 *   两处**不能合并**，合并会把其中一边的方向弄反）。
 *
 * ### 3. 后台任务**绝不抛错**，且只在**真的修了东西**时才说话
 *
 * 与缓存轮换同一条纪律：它跑在插件生命周期里，异常没人接；而"每轮都报一句没事"
 * 就是噪音。0 条时不通知。
 *
 * ## 为什么**不设**"每轮最多查 N 条"的硬上限
 *
 * 一开始想设一个（怕后台扫太多）。想清楚之后不设，两个理由：
 * ① **它几乎不产生 I/O**：正常情况（文件都在）第一条路——宿主的文件索引——就答"在"，
 *    那是一次内存查表；只有真的少了的那些才落到适配器上；
 * ② 硬上限会**引入一个新缺陷**：每轮都从第一条开始，超过上限的尾部**永远查不到**。
 *    "修一半"比"慢一点"糟得多。
 * 真正做的是**分批让出主线程**（见 `yieldNow`），于是再大的索引也不会卡住界面。
 *
 * ## 与那条命令的关系
 *
 * `repair-index`（「自检并修复本地副本索引」）调的就是这里 —— **只有这一份实现**。
 * 两者唯一的差别：后台跑完只有"修了 N 条"时给一条通知；命令是用户主动发起的，
 * 所以**不管修没修都要回话**（他正等着结果）。
 */

import type { CacheEntry } from "../cache/index";

/**
 * 每轮最多连续查多少条路径就让出一次主线程。
 *
 * 200 是"够快"与"不卡"之间的手感值：宿主索引命中时一次查表是微秒级，
 * 200 条连查也远小于一帧；而真的落到适配器上时，200 次 stat 之后让一次，
 * 界面不会被独占。
 */
export const SELF_HEAL_BATCH = 200;

/** 一批要检查的路径，以及**指向它的所有记录**（同一个路径可能有多条记录）。 */
export interface SelfHealTarget {
	path: string;
	keys: string[];
}

/**
 * 把索引里**值得检查的路径**挑出来（纯函数）。
 *
 * - 同一个路径只检查一次，但**它名下的每条记录都要一起摘**（否则会留下指向同一份
 *   不存在文件的另一条记录，下一轮又查到它 —— 一轮修不干净，还多付一次 I/O）；
 * - 空白路径直接跳过：那种记录连"文件在哪"都答不出来，交给适配器去猜它怎么处理
 *   是在赌一个我们不需要承担的风险（与 `planOrphanLocalRemoval` 同一条纪律）；
 * - 保持输入顺序（`toArray()` 已按 key 排序），让行为可预测、也让测试能穷举。
 */
export function planSelfHeal(entries: readonly CacheEntry[]): SelfHealTarget[] {
	const byPath = new Map<string, string[]>();
	for (const entry of entries ?? []) {
		const path = typeof entry?.cachePath === "string" ? entry.cachePath.trim() : "";
		if (!path) continue;
		const key = typeof entry.key === "string" ? entry.key.trim() : "";
		if (!key) continue;
		const keys = byPath.get(path);
		if (keys) keys.push(key);
		else byPath.set(path, [key]);
	}
	return [...byPath].map(([path, keys]) => ({ path, keys }));
}

export interface SelfHealDeps {
	/** 当前的索引条目（调用方给快照，这一层不持有索引）。 */
	entries: () => readonly CacheEntry[];
	/**
	 * 这个路径存在吗。
	 *
	 * ⚠️ **接线层必须实现成"两条路都说不存在才算 `false`"，且查询出错时返回 `true`**
	 * —— 见模块头注释第 2 条。这一层不自己碰宿主 API，于是这条判据能被套件穷举。
	 */
	exists: (path: string) => Promise<boolean>;
	/** 摘掉一条记录；返回是否真的摘掉了（供如实计数）。 */
	forget: (key: string) => boolean;
	persist: () => Promise<void>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
	/** 让出主线程（注入，套件用立即返回的替身）。 */
	yieldNow: () => Promise<void>;
	/** 查询出错时的上报口（绝不抛给调用方）。 */
	onError?: (error: unknown) => void;
}

export interface SelfHealResult {
	/** 实际检查过的路径数。 */
	checked: number;
	/** 摘掉的记录数（**不是**路径数：一个路径可能挂着多条记录）。 */
	healed: number;
	/** 查询出错的路径数（按"存在"处理，**没有**摘它们）。 */
	failed: number;
}

/**
 * 跑一轮自愈。
 *
 * 顺序写死：**先全部查完，再一次性摘 + 落盘**。理由是"查"与"改"分开之后，
 * 中途失败不会留下"改了一半"的状态；而落盘只发生一次（避免 N 次写索引）。
 */
export async function runSelfHeal(deps: SelfHealDeps): Promise<SelfHealResult> {
	const result: SelfHealResult = { checked: 0, healed: 0, failed: 0 };

	try {
		const targets = planSelfHeal(deps.entries());
		const stale: string[] = [];

		for (let i = 0; i < targets.length; i += 1) {
			if (i > 0 && i % SELF_HEAL_BATCH === 0) await deps.yieldNow();
			const target = targets[i];
			result.checked += 1;
			try {
				if (await deps.exists(target.path)) continue;
				stale.push(...target.keys);
			} catch (error) {
				// ⚠️ 出错按"存在"处理：宁可不摘（见模块头注释第 2 条）
				result.failed += 1;
				deps.onError?.(error);
			}
		}

		if (stale.length === 0) return result;

		for (const key of stale) {
			if (deps.forget(key)) result.healed += 1;
		}
		if (result.healed === 0) return result;

		try {
			await deps.persist();
		} catch (error) {
			// 落盘失败要说出来，而且这时**只说这一句**（少说一句"已修复"）：
			// 说"修好了"而其实没存下去，就是让用户以为已经好了。
			deps.notify(deps.t("maintainPersistFailed", { error: String(error) }));
			return result;
		}

		deps.notify(deps.t("selfHealRepaired", { count: result.healed }));
		return result;
	} catch (error) {
		// 后台任务绝不能把异常抛给调用方（它跑在插件的生命周期里）
		deps.onError?.(error);
		return result;
	}
}
