/**
 * 云端空间清理（需求 R17 / 功能 F15）。
 *
 * ## 两条入口，同一套安全线
 *
 * | 入口 | 什么时候 | 用户要做什么 |
 * |---|---|---|
 * | **孤儿出现时询问** | 某个已上传对象**失去最后一个引用**之后（触发在 `maintenance/orphan-watch.ts`） | 选「保留」（默认）/「只删本地副本」/「云端和本地一起删」 |
 * | **「检查未被引用的云端附件…」** | 用户主动跑命令（**重来一次**那次询问） | 同上的三档 —— ⚠️ 自动那次**只出现一次**（冷却），这条是"自己再要一次"的路 |
 *
 * 两条入口的执行都落在本模块（`runCloudCleanup`），判定与询问的接线在 `plugin/orphan-flow.ts`。
 * ⚠️ 命令那条**不吃冷却、也不吃 `never` 档**（两者都是"别主动打扰"的措施，而命令是用户自己按的）。
 *
 * ## ⚠️ 2026-10-16：「清理云端未使用对象…」退役（它曾列**整个桶**）
 *
 * 它唯一的独占能力是"处理**不属于本插件**的对象"（别的设备 / 别的 vault / 别的工具 /
 * 用户手写 URL 指向的）—— 而那与候选的筛除**直接冲突**：那里明写着
 * 「对不属于我们的对象，我们**没有任何处置权** —— 不问，也不删」（`selectOrphanAsks` 的 `not-ours`）。
 * ⚠️ 需求文档里也**查不到**那个诉求。⇒ 候选**只从上传台账产生**（快、不需要 `ListBucket` 权限、
 * 清单完整），并**继承了它唯一的正面贡献**：**站外缓存的对象一律排除**（见下一节）。
 * 一并退役的还有 `listAllObjects`（桶内分页列举）与 `selectCleanupCandidates`。
 *
 * ⚠️ 本模块只管**云端那一半**。三档询问里"本地副本"那一半落在 `maintenance/orphan-removal.ts`
 * （删本地副本，走回收站）、判定落在 `maintenance/orphan-watch.ts`、询问界面在 `ui/cloud-delete-modal.ts`。
 * （历史提醒：那次询问原先挂在"删除本地文件"上，那个动作选错了 —— 见设计 §6.2.1。）
 *
 * ## ⭐ 这一层最难的地方：多设备盲区（需求里点名的约束）
 *
 * 对象是**按内容寻址**的，所以"同一个对象"可能同时被**本库其他笔记**、
 * **同一个库的其他设备**、甚至**用户没告诉过我们的另一个 vault** 使用。
 * 而插件**只能看到本设备此刻的引用**。于是：
 *
 * - 删除云端永远是**用户显式表态**的结果（默认保守，见那三档的选项顺序）；
 * - 判定"没人用"时**宁可多留**：凡是我们认不出的、来自站外缓存的、被引用的，
 *   一概不进候选；
 * - 文案必须如实说明"只能看到本设备的引用情况"（原则⑥：如实告知）。
 *
 * ## 为什么"站外缓存"要整体排除
 *
 * 它们的链接改写失败时，笔记里留着的是**原来的站外地址** —— 而那是别人的域名，
 * 我们的引用判据（按 URL 回算 key）根本认不出它。见 `CacheEntry.origin` 的说明。
 * ⚠️ 这条判据在 `plugin/orphan-flow.ts` 筛候选时施加（`selectOrphanAsks` 的 `isExternal`）。
 * ⚠️ 它只管**云端那一半**（D-77）：同一批对象的**本地副本**现在可以清
 * （`local-orphans.ts` 的 `cachedPaths`，删了不碰云端、下次显示重新下载）。
 *
 * 本模块 = **两个 key 工具** + **一个薄执行器**：执行只做"删 + 摘索引 + 如实汇报"。
 */

import type { CacheIndex } from "../cache/index";
import type { S3Client } from "../s3/client";

/**
 * 把"笔记里引用着的 URL"换算成**对象 key** 集合。
 *
 * 由调用方注入的 `keyFromUrl` 负责（它就是渲染判定用的那个回算函数）——
 * 于是"哪些对象算被引用"与"渲染时认不认这个 URL"**永远是同一套规则**。
 */
export function referencedKeysFromUrls(
	urls: Iterable<string>,
	keyFromUrl: (url: string) => string | null
): Set<string> {
	const keys = new Set<string>();
	for (const url of urls ?? []) {
		const key = keyFromUrl(url);
		if (key) keys.add(key);
	}
	return keys;
}

/** 索引里标记为「站外缓存」的 key 集合。 */
export function externalKeysOf(index: CacheIndex | null | undefined): Set<string> {
	const keys = new Set<string>();
	const entries = index?.toArray?.() ?? [];
	for (const entry of entries) {
		if (entry?.origin === "external" && typeof entry.key === "string" && entry.key !== "") {
			keys.add(entry.key);
		}
	}
	return keys;
}

export interface CloudCleanupDeps {
	client: Pick<S3Client, "deleteObject">;
	index: () => CacheIndex;
	persistIndex: () => Promise<void>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
	/**
	 * 每**确实删掉**（或服务端回 404）一个对象时回调一次 —— 供接线层**留痕**。
	 *
	 * ⚠️ 只在"对象真的不在了"时回调：删除失败的不算（它还在桶里，日志里写它
	 * 会让事后排查以为"那个已经删了"）。见 `maintenance/delete-log.ts`。
	 */
	onRemoved?: (record: { key: string; name: string; outcome: "deleted" | "alreadyGone" }) => void;
	/**
	 * 每个对象**处理完**时回调一次（界面据此画进度）。
	 *
	 * ⚠️ 与 `onRemoved` **不是一回事**，两个都要留着：
	 * - `onRemoved` 是**留痕**（只在"对象真的不在了"时），写进删除日志；
	 * - 这个是**进度**（成功 / 跳过 / 失败都算一件事结束了）。
	 * 合并会让删除日志里出现"删失败"的记录，或者让进度停在失败的那一件上。
	 */
	onItem?: (event: { key: string; status: "done" | "skipped" | "failed" }) => void;
}

export interface CloudCleanupResult {
	/** 真的删掉的对象数。 */
	deleted: number;
	/**
	 * 服务端回 **404**（对象本来就不存在）的数量。
	 *
	 * ⚠️ 与 `deleted` 分开计数是刻意的：把"本来就没有"算进"已删除"会让提示语撒谎。
	 * 但它**不是失败** —— `deleteObject` 的契约就是"404 → `false`（本来就不存在），其它错误照抛"，
	 * 目标状态已经达成，所以索引记录**照摘**（那条记录指向的对象确实不在了；
	 * 留着会让 audit / 淘汰把它当有效记录 —— 症状是"明明删了，占用统计还在涨"）。
	 *
	 * ⚠️ 两条入口此前对同一个 `false` 给了**相反**的解释（入口 A 当"已完成"、这里当"失败"），
	 * 见审计报告 P2 / 2026-10-11 已统一。
	 */
	alreadyGone: number;
	/** 删除失败的对象数（如实汇报，绝不静默）。 */
	failed: number;
	/** 顺带摘掉的索引记录数（见 `maintenance/run.ts` 里"删完要摘记录"的同一条理由）。 */
	unindexed: number;
}

/**
 * 执行清理：逐个删对象，**成功一个就摘一条索引记录**。
 *
 * ## 为什么删成功才摘索引
 *
 * 索引记录的用途是"按 URL 找本地副本"，而它同时记着"远端有这么个对象"。
 * 删掉了却不摘 ⇒ `audit`/淘汰会拿着一个 404 的对象当有效记录（症状是
 * "明明删了，占用统计还在涨"）。反过来，**删失败却摘了**更糟：
 * 那条记录消失之后，渲染时会以为"远端也没有"，于是把这条 URL 当成站外图
 * （不下载、离线看不到）—— 明明对象还在。
 *
 * ⚠️ 所以**只有失败不摘**：`deleteObject` 返回 `false` 表示服务端回了 404
 * （对象本来就不存在），那是"目标状态已达成"，不是失败 —— 同样要摘。
 * 单独计进 `alreadyGone`，免得提示语把"本来就没了"说成"删掉了"。
 *
 * ## 本地副本一律不动
 *
 * 删的是**云端**对象。本地副本还在 ⇒ 那张图照常显示；下次缓存清理按孤儿规则
 * 自然回收（语义自洽，见需求 R17 里"与缓存清理拉开风险等级"那一条）。
 */
export async function runCloudCleanup(
	deps: CloudCleanupDeps,
	keys: readonly string[]
): Promise<CloudCleanupResult> {
	const result: CloudCleanupResult = { deleted: 0, alreadyGone: 0, failed: 0, unindexed: 0 };
	const removed: string[] = [];
	/** 台账有没有被改动（与 `removed` 分开记：两者会不一致，见下面那段说明）。 */
	let forgotLedger = false;

	for (const key of keys ?? []) {
		if (typeof key !== "string" || key === "") continue;
		try {
			const ok = await deps.client.deleteObject(key);
			if (ok) {
				result.deleted += 1;
			} else {
				// 404 ⇒ 本来就不存在 ⇒ 目标状态已达成（见上面那段说明）
				result.alreadyGone += 1;
			}
			// ⭐ 云端对象没了 ⇒ **上传台账也要忘掉它**（台账的语义是
			// "我们经手过、且它还在云端"；对象没了就没什么可认领的了）。
			//
			// ⚠️ 只在**这一支**里忘：删除失败时对象还在云端，忘掉它会让下一次
			// 孤儿判定把它当成"不是我们的"—— 那就从"少问一次"变成了"管不了它"。
			const store = deps.index();
			// ⚠️ 名字要在**摘记录之前**读（摘掉之后就没地方取了），留痕要用它
			const name = store.get(key)?.sourceName ?? "";
			if (store.remove(key)) removed.push(key);
			if (store.forgetUploaded(key)) forgotLedger = true;
			deps.onRemoved?.({ key, name, outcome: ok ? "deleted" : "alreadyGone" });
			// 404 也算这一件走完了：目标是"它不在云端"，而它已经不在
			deps.onItem?.({ key, status: "done" });
		} catch (error) {
			// 单个对象失败不能中断整批（用户要的是"把能清的清掉"），但必须计数
			result.failed += 1;
			deps.onItem?.({ key, status: "failed" });
			void error;
		}
	}

	// 条目与台账的改动都要落盘：它们平时同进同退（有副本才有条目），
	// 但「不留副本」档只会有台账改动 ⇒ 只判 `removed` 会漏掉落盘。
	if (removed.length > 0 || forgotLedger) {
		result.unindexed = removed.length;
		try {
			await deps.persistIndex();
		} catch (error) {
			// 摘记录失败要说出来（否则下次启动看到幽灵记录，查不出原因）
			deps.notify(deps.t("cloudCleanupPersistFailed", { error: String(error) }));
		}
	}

	return result;
}
