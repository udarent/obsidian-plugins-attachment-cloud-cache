/**
 * 批量上传前的「云端已有内容」盘点：列桶 → 反推每个对象的内容哈希。
 *
 * ## 它替代了什么
 *
 * 批量上传要回答「这个文件传过没有」。以前是**逐 key HEAD**（`ingest` 里的 `preflight`
 * 那条路），N 个候选就是 N 次串行往返。现在改成**一次列桶 + 本地查表**：
 * 桶里对象反推成**内容哈希**集合，`ingest` 那里已经算好了 `contentHash`，查它即可 ——
 * 零网络、也不重算哈希。
 *
 * ## 为什么是「哈希」不是「key」
 *
 * key 会随命名规则变（带名 / 纯哈希两代长期共存），哈希才是对象身份。列桶拿到的
 * key 用 {@link hashFromKey} 反推：两代 key 都能取到哈希；声明（`_acc/…`）与第三方
 * 对象取不到，直接跳过 —— 它们本就不该进这个集合。
 *
 * ## 失败方向：不知道 ⇒ 退回逐文件 HEAD
 *
 * 翻不完（超过 {@link LIST_MAX_PAGES} 页）、拿不到 `ListBucket` 权限、网络错，
 * 一律返回 `null`（调用方据此退回 `ingest` 原有的逐文件 HEAD）。⚠️ 与「空桶」必须
 * 分得开：空桶返回**空 Set** —— 那是"列到了、只是没有"，两个语义不能混（空 Set 会让
 * 每个候选都走上传，`null` 会让每个候选都走 HEAD）。
 *
 * ⚠️ 与 `migrate-flow.ts::listAllKeys` 的列桶循环形状相同、产出不同（那边要 key、
 * 这里要哈希）。眼下刻意不合并：迁移是数据敏感链路，不动它；将来要收口，抽一个
 * 「列桶返回 key 集合」的共用底层即可，两侧再各自 map。
 */

import { hashFromKey } from "../object-key";
import type { S3Client } from "../s3/client";

/** 列桶一页多少条（S3 上限；与 `migrate-flow.ts` 的 `LIST_PAGE` 一致）。 */
const LIST_PAGE = 1000;

/** 最多翻几页；超过就算"不知道桶里有什么"（与 `migrate-flow.ts` 的 `LIST_MAX_PAGES` 一致）。 */
const LIST_MAX_PAGES = 10;

/**
 * 列桶，把桶里能反推出内容哈希的对象收集成一个**哈希集合**。
 *
 * 翻不完 / 拿不到权限 / 出错 ⇒ 返回 `null`（= 不知道，调用方退回逐文件 HEAD）。
 */
export async function listRemoteContentHashes(
	client: Pick<S3Client, "listObjects">
): Promise<Set<string> | null> {
	const hashes = new Set<string>();
	let token: string | null = null;
	for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
		let result;
		try {
			result = await client.listObjects({ maxKeys: LIST_PAGE, continuationToken: token ?? undefined });
		} catch {
			// 拿不到 ListBucket / 网络错 / 超时 ⇒ 不知道，退回逐文件 HEAD
			return null;
		}
		for (const object of result.objects) {
			const hash = hashFromKey(object.key);
			if (hash) hashes.add(hash);
		}
		token = result.nextToken;
		if (!token) return hashes;
	}
	// 翻不完 = 不知道（不是"没有"）
	return null;
}
