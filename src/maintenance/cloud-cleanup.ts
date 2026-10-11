/**
 * 云端空间清理（需求 R17 / 功能 F15）。
 *
 * ## 两条入口，同一套安全线
 *
 * | 入口 | 什么时候 | 用户要做什么 |
 * |---|---|---|
 * | **A：删除附件时询问** | 用户删掉一个"已上传过"的本地文件之后 | 选「仅删本地」（默认）/「连同云端一起删」/「取消」 |
 * | **B：清理云端未使用对象…** | 用户主动跑命令 | 看清单、确认、执行 |
 *
 * 两者都要挡住同一件事：**删掉一个还在被用的对象**。
 *
 * ## ⭐ 这一层最难的地方：多设备盲区（需求里点名的约束）
 *
 * 对象是**按内容寻址**的，所以"同一个对象"可能同时被**本库其他笔记**、
 * **同一个库的其他设备**、甚至**用户没告诉过我们的另一个 vault** 使用。
 * 而插件**只能看到本设备此刻的引用**。于是：
 *
 * - 删除云端永远是**用户显式表态**的结果（默认保守，见 {@link 入口A} 的选项顺序）；
 * - 判定"没人用"时**宁可多留**：凡是我们认不出的、来自站外缓存的、被引用的，
 *   一概不进候选；
 * - 文案必须如实说明"只能看到本设备的引用情况"（原则⑥：如实告知）。
 *
 * ## 为什么"站外缓存"要整体排除
 *
 * 它们的链接改写失败时，笔记里留着的是**原来的站外地址** —— 而那是别人的域名，
 * 我们的引用判据（按 URL 回算 key）根本认不出它。见 `CacheEntry.origin` 的说明。
 *
 * 这一层全是**纯函数 + 一个薄执行器**：判定可穷举，执行只做"删 + 摘索引 + 如实汇报"。
 */

import type { CacheIndex } from "../cache/index";
import type { S3Client } from "../s3/client";

/** 桶里的一个对象（清理只用得上这两项）。 */
export interface BucketObject {
	key: string;
	size: number;
}

export interface CleanupReason {
	reason: string;
	count: number;
}

export interface CleanupSelection {
	/** 可以回收的对象。 */
	candidates: BucketObject[];
	/** 它们的总字节数（确认框要显示"能腾出多少"）。 */
	bytes: number;
	/** 被排除的对象数（按原因分组，供诊断与确认框说明）。 */
	excluded: CleanupReason[];
}

export interface CleanupInput {
	objects: readonly BucketObject[];
	/** 笔记/画布里引用着的**对象 key**（由 URL 回算，见 `keysInText`）。 */
	referencedKeys: ReadonlySet<string>;
	/** 索引里标记为「站外缓存」的 key —— 一律不动（见模块头注释）。 */
	externalKeys: ReadonlySet<string>;
}

/**
 * 挑出"本设备看不到引用"的对象（**纯函数**）。
 *
 * ⚠️ 判据是"看不见引用"，**不是**"没人用" —— 多设备这个盲区无法消除，
 * 只能靠默认保守 + 清单确认 + 文案如实说明（需求 R17 的落法）。
 */
export function selectCleanupCandidates(input: CleanupInput): CleanupSelection {
	const candidates: BucketObject[] = [];
	const reasons = new Map<string, number>();
	const bump = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1);

	for (const object of input.objects ?? []) {
		if (!object || typeof object.key !== "string" || object.key === "") {
			bump("key 为空（不认识的形状）");
			continue;
		}
		// ⭐ 站外缓存：即使"看不见引用"也不动（它的引用可能写在别处，见模块头注释）
		if (input.externalKeys.has(object.key)) {
			bump("站外缓存（不动）");
			continue;
		}
		if (input.referencedKeys.has(object.key)) {
			bump("仍被笔记或画布引用");
			continue;
		}
		candidates.push({ key: object.key, size: Number.isFinite(object.size) ? object.size : 0 });
	}

	return {
		candidates,
		bytes: candidates.reduce((sum, object) => sum + object.size, 0),
		excluded: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}

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

export interface ListAllObjectsResult {
	objects: BucketObject[];
	/** 是否因为页数上限而**提前停下**（>0 时调用方要如实说明"清单可能不全"）。 */
	truncated: boolean;
}

/**
 * 分页列出桶里的全部对象。
 *
 * ⚠️ 页数上限是**防御**：桶里放了几十万个对象时，一次命令不该把内存和网络打满。
 * 到上限就停下并**如实标记**（绝不假装清单是完整的 —— 那会让用户以为
 * "剩下的都还有人用"）。
 */
export async function listAllObjects(
	client: Pick<S3Client, "listObjects">,
	options: { prefix?: string; pageSize?: number; maxPages?: number } = {}
): Promise<ListAllObjectsResult> {
	const pageSize = options.pageSize && options.pageSize > 0 ? Math.trunc(options.pageSize) : 1000;
	const maxPages = options.maxPages && options.maxPages > 0 ? Math.trunc(options.maxPages) : 50;

	const objects: BucketObject[] = [];
	let token: string | null = null;

	for (let page = 0; page < maxPages; page += 1) {
		const result = await client.listObjects({
			prefix: options.prefix ?? "",
			continuationToken: token ?? undefined,
			maxKeys: pageSize,
		});
		for (const item of result.objects ?? []) objects.push(item);
		token = result.nextToken;
		if (!token) return { objects, truncated: false };
	}

	return { objects, truncated: true };
}

export interface CloudCleanupDeps {
	client: Pick<S3Client, "deleteObject">;
	index: () => CacheIndex;
	persistIndex: () => Promise<void>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
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
			if (deps.index().remove(key)) removed.push(key);
		} catch (error) {
			// 单个对象失败不能中断整批（用户要的是"把能清的清掉"），但必须计数
			result.failed += 1;
			void error;
		}
	}

	if (removed.length > 0) {
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
