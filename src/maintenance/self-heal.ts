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
 * ### 4. **"这一轮不在"不算数，上一轮也不在才摘**（`createAbsenceConfirmer`）
 *
 * "文件现在不在"有两种：真的没了、**还在路上**（换设备、同步工具正在拉）。
 * 单轮就摘会把后者也当成失效 —— 而新设备上这可能是**整份索引**：
 * 索引文件随 `.obsidian` 先到、附件还没到 ⇒ 所有记录一次判"不在" ⇒ 全摘掉 ⇒
 * 文件随后到了也认不出（要走一次回退下载才恢复）。
 * ⇒ 两轮确认；文件一出现就清痕迹。命令那条线例外（**显式动作**，单轮即摘）。
 *
 * ## ⭐⭐ 它不是"正确性"的前提（别再把正确性押在它身上）
 *
 * 曾经的理由是"留着失效记录会让渲染误判'本地已有'，于是既不显示也不去取"。
 * 那条**已经不成立了**：`render/render-hook.ts` 的 `deferLocalCopy` 在拿不到
 * `app://` 地址时会先按远端显示、同时去把副本取回来（而且回退下载会**回写索引**：
 * `core/download.ts` 的 `store.set(...)`）⇒ **只要那张图被看到，记录就被修好**。
 *
 * 另一条"统计虚高会让上限多删"也已由**淘汰侧**自己兜住（总量只算磁盘上还在的副本，
 * 见 `eviction.ts`）—— 那才是正确性该待的地方：**消费侧免疫 > 指望账本及时**。
 * ⇒ 自愈现在的定位是**卫生**：别让统计长期偏高、别让下次看到时白下一次。
 * 这也决定了误摘的代价是"可恢复的浪费"而非数据问题 —— 两轮确认这种轻量防护就够。
 *
 * ## 触发线（三条，由接线层决定）
 *
 * | 触发 | 时机 | 作用 |
 * |---|---|---|
 * | 启动 | 布局就绪后 8 秒 | 覆盖"插件没运行时发生的消失"（换设备、同步带来的差异） |
 * | 周期 | 每 10 分钟 | 兜底：运行中的消失（用户整理附件目录、外部工具先删后写） |
 * | 命令 `repair-index` | 用户主动 | "我现在就想核一遍"，**唯一**单轮即摘的入口 |
 *
 * ⚠️ 刻意**没有**"挂 `vault.on("delete")` 立刻摘"：它的价值（统计准确）已被上面两条兜住，
 * 而代价最高 —— 插件自己删文件（淘汰 / F18 / R17）走的是同一个事件，
 * 要幂等、要节流、还要自辩"这次不是我删的"。周期线够用。
 * ⚠️ 也刻意**没有**"渲染时就地摘"：渲染遇到缺失副本会去**重新下载并登记**，
 * 在那里摘等于"摘了又加"，净多一次落盘。
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
 * 「这份副本确实不在」的确认器（**后台**用）。
 *
 * ## 为什么"现在不在"还不够
 *
 * 索引里记着文件在哪，而"现在不在"有两种：**真的没了**（用户删了）、
 * **还在路上**（换设备、同步工具正在拉、外部工具先删后写）。单轮就摘会把后一种
 * 也当成失效 —— 记录一摘，文件到了也认不出（要等一次回退下载才恢复），
 * 而新设备上这可能是**整份索引**。
 *
 * ⇒ 判据改成"**上一轮也不在**"才算数；某一轮报告它在，痕迹立刻清掉。
 *
 * ## ⚠️ 状态在**进程内**，重启即重置
 *
 * 重置是**安全方向**：代价只是"再确认一轮"（记录多留一会儿 = 统计偏高，
 * 而统计偏高已由淘汰侧"总量只算存在的副本"兜住，不会多删 —— 见 `eviction.ts`）。
 * 反过来（把可疑名单持久化到索引里）会让"派生数据"多一份要维护的状态，
 * 换来的只是"少等一轮"。不值。
 *
 * ⚠️ 也不记录时间戳：那需要持久化才跨得过重启，而一旦持久化就回到上面那个取舍。
 * "两轮"这件事只需要一个集合。
 */
export function createAbsenceConfirmer(): (path: string, absent: boolean) => boolean {
	const suspects = new Set<string>();
	return (path, absent) => {
		if (!absent) {
			suspects.delete(path);
			return false;
		}
		if (suspects.has(path)) return true;
		suspects.add(path);
		return false;
	};
}

/**
 * 命令那条线用的确认器：**单轮即摘**。
 *
 * 用户显式点「自检并修复」时他正等着结果，让他再点一次才是坏体验；
 * 而那是**显式动作**，命令会如实报出修了几条（几秒前刚开同步的人自己看得见）。
 * ⚠️ 它只会在"确实不在"时被问到，所以返回恒 `true` 是安全的。
 */
export const CONFIRM_IMMEDIATELY = (): boolean => true;

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
	/**
	 * "这份副本确实不在"的确认器 —— 见 {@link createAbsenceConfirmer}。
	 *
	 * - `absent: false`（这一轮它在）⇒ 清掉该路径的痕迹，返回值被忽略；
	 * - `absent: true`（这一轮它不在）⇒ 返回 `true` 表示**上一轮也不在**，这才允许摘。
	 *
	 * ⚠️ 查询**出错**时既不问它、也不摘（按"存在"处理）：出错是"不知道"，
	 * 而"不知道"不该消耗掉一次确认，也不该清掉已有的确认。
	 */
	confirmAbsent: (path: string, absent: boolean) => boolean;
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
				if (await deps.exists(target.path)) {
					// 它还在（或又回来了）⇒ 清掉"可疑"痕迹：上次那次缺席只是暂时的
					deps.confirmAbsent(target.path, false);
					continue;
				}
				// ⭐ 只有**上一轮也不在**才算数 —— 否则会摘掉"还在路上"的记录（换设备/同步中）
				if (deps.confirmAbsent(target.path, true)) {
					stale.push(...target.keys);
				}
			} catch (error) {
				// ⚠️ 出错按"存在"处理：宁可不摘，也**不消耗**已经攒下的那次确认（见 deps 说明）
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
