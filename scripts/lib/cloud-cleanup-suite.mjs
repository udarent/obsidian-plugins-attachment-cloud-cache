/**
 * 云端空间清理（`src/maintenance/cloud-cleanup.ts`）的断言套件 —— **需求 R17 / F15**。
 *
 * ## 这套断言守的是什么
 *
 * 这一层唯一的"输出"是**一份删除清单**，而删错的方向只有一个：**删掉还在用的**。
 * 所以断言的重心全在"什么**不**该进候选"上：
 *
 * - 仍被笔记/画布引用的；
 * - 站外缓存（它的引用可能写在别处，`CacheEntry.origin`）；
 * - 认不出形状的（宁可不动）；
 * - 列举**没读全**时（提前停下）不能假装清单是完整的。
 *
 * 另一头（`runCloudCleanup`）守的是"删成功才摘索引"与"一次失败不中断整批"：
 * 这两条错了都不会报错，只会让人在很久之后发现"占用统计对不上"。
 */

import assert from "node:assert/strict";

export async function runCloudCleanupSuite(mod) {
	const {
		selectCleanupCandidates,
		referencedKeysFromUrls,
		externalKeysOf,
		listAllObjects,
		runCloudCleanup,
	} = mod;

	// ============================================================
	// 1. ⭐ 候选挑选：三条排除线
	// ============================================================
	{
		const selection = selectCleanupCandidates({
			objects: [
				{ key: "used.png", size: 10 },
				{ key: "external.png", size: 20 },
				{ key: "orphan-a.png", size: 30 },
				{ key: "orphan-b.png", size: 40 },
				{ key: "", size: 5 },
			],
			referencedKeys: new Set(["used.png"]),
			externalKeys: new Set(["external.png"]),
		});

		assert.deepEqual(
			selection.candidates.map((object) => object.key),
			["orphan-a.png", "orphan-b.png"],
			"只挑既没被引用、也不是站外缓存的对象"
		);
		assert.equal(selection.bytes, 70, "总字节数要如实算出来（确认框要显示能腾出多少）");
		const reasons = Object.fromEntries(selection.excluded.map((entry) => [entry.reason, entry.count]));
		assert.equal(reasons["仍被笔记或画布引用"], 1, "被引用的要排除并计数");
		assert.equal(reasons["站外缓存（不动）"], 1, "★ 站外缓存整体排除（它的引用可能写在别处）");
		assert.equal(reasons["key 为空（不认识的形状）"], 1, "认不出的形状要跳过，而不是当成空 key 去删");
	}

	// 空输入 / 坏输入都要安全
	{
		const empty = selectCleanupCandidates({
			objects: [],
			referencedKeys: new Set(),
			externalKeys: new Set(),
		});
		assert.deepEqual(empty, { candidates: [], bytes: 0, excluded: [] }, "空桶 ⇒ 空清单");

		const messy = selectCleanupCandidates({
			objects: [{ key: "a.png", size: Number.NaN }],
			referencedKeys: new Set(),
			externalKeys: new Set(),
		});
		assert.equal(messy.candidates.length, 1, "size 坏掉不该把整个对象丢掉");
		assert.equal(messy.bytes, 0, "坏掉的 size 当 0（宁可显示得保守，也不要显示一个错数字）");
	}

	// ============================================================
	// 2. URL → key 的换算（"仍被引用"判据的来源）
	// ============================================================
	{
		const keyOf = (url) => (url.includes("ours") ? url.split("/").pop() : null);
		const keys = referencedKeysFromUrls(["https://x/ours/a.png", "https://other/b.png"], keyOf);
		assert.deepEqual([...keys], ["a.png"], "只收**我们自己的**地址换算出的 key");
		assert.equal(referencedKeysFromUrls([], keyOf).size, 0, "空输入 ⇒ 空集合");
		assert.equal(referencedKeysFromUrls(["https://x/ours/a.png"], () => null).size, 0, "换算不出来就不收");
	}

	// ============================================================
	// 3. 站外缓存的 key 集合（只看 `origin`）
	// ============================================================
	{
		const index = {
			toArray: () => [
				{ key: "mine.png", origin: undefined },
				{ key: "cached.png", origin: "external" },
				{ key: "", origin: "external" },
				// ⚠️ 只认**恰好**是 external 的值：脏值不能让对象被排除掉方向搞反
				{ key: "weird.png", origin: "External" },
			],
		};
		assert.deepEqual([...externalKeysOf(index)], ["cached.png"], "只有标记为 external 的才算站外缓存");
		assert.equal(externalKeysOf(null).size, 0, "没有索引时返回空集合（不抛错）");
	}

	// ============================================================
	// 4. ⭐ 分页列举：到底要停，页数上限要**如实标记**
	// ============================================================
	{
		const pages = [
			{ objects: [{ key: "a.png", size: 1 }], nextToken: "a.png" },
			{ objects: [{ key: "b.png", size: 2 }], nextToken: null },
		];
		let call = 0;
		const client = {
			listObjects: async (options) => {
				const page = pages[call] ?? { objects: [], nextToken: null };
				call += 1;
				assert.equal(options?.continuationToken ?? undefined, call === 1 ? undefined : "a.png", "第二页要带上第一页给的 token");
				return page;
			},
		};
		const result = await listAllObjects(client);
		assert.deepEqual(result.objects.map((object) => object.key), ["a.png", "b.png"], "要把所有页拼起来");
		assert.equal(result.truncated, false, "到底了就不该标记截断");

		// 无限翻页的桶 ⇒ 到页数上限就停，并且**如实说清单可能不全**
		let endless = 0;
		const truncated = await listAllObjects(
			{
				listObjects: async () => {
					endless += 1;
					return { objects: [{ key: `k${endless}.png`, size: 1 }], nextToken: `k${endless}.png` };
				},
			},
			{ maxPages: 3 }
		);
		assert.equal(endless, 3, "页数上限要生效（否则桶里有几十万个对象时会把内存打满）");
		assert.equal(truncated.truncated, true, "★ 提前停下必须标记，绝不假装清单是完整的");
	}

	// ============================================================
	// 5. ⭐ 执行：删成功才摘索引；一次失败不中断整批
	// ============================================================
	{
		const removed = [];
		const persisted = [];
		const notified = [];
		const deleted = [];
		const result = await runCloudCleanup(
			{
				client: {
					deleteObject: async (key) => {
						deleted.push(key);
						if (key === "boom.png") throw new Error("500");
						return true;
					},
				},
				index: () => ({ remove: (key) => (removed.push(key), true) }),
				persistIndex: async () => {
					persisted.push(true);
				},
				notify: (message) => notified.push(message),
				t: (key) => key,
			},
			["a.png", "boom.png", "b.png"]
		);

		assert.deepEqual(deleted, ["a.png", "boom.png", "b.png"], "★ 中间一个失败不能中断整批");
		assert.equal(result.deleted, 2, "成功数要如实统计");
		assert.equal(result.failed, 1, "失败数也要如实统计");
		assert.deepEqual(removed, ["a.png", "b.png"], "★ 只有**删成功**的对象才摘索引（失败的摘了会以为远端也没有）");
		assert.equal(result.unindexed, 2, "摘掉的记录数要报出来");
		assert.equal(persisted.length, 1, "整批结束**只落盘一次**（不是每删一个写一次索引）");
		assert.equal(notified.length, 0, "都成功了就不该打扰用户");
	}

	// 5b. 删除返回 false（服务端 404：对象本来就不在桶里）⇒ **目标状态已达成**，不是失败
	//
	// ⚠️ 这一节在 2026-10-11 被**改写过**。原断言是"算失败、且不摘索引"，理由写着
	// "对象不在、笔记里的 URL 还在，那条记录让渲染能认出「这是我们存储的地址」"。
	// 复查时发现那个理由**与候选公式矛盾**：能走进 `runCloudCleanup` 的 key 已经排除了
	// "仍被引用"与"站外缓存"（见第 1 节），所以"URL 还在笔记里"这种情形**到不了这里**。
	// 反过来的代价是实打实的：`false` 记成失败 ⇒ 用户看到"有一个没删掉"（其实早就没了），
	// 而那条指向 404 的记录会被 audit / 淘汰当成**有效记录**（"明明删了，占用还在涨"）。
	// ⇒ 现在与入口 A 的解释统一（入口 A 从来就没检查过这个返回值）：404 = 已完成，并摘掉记录。
	{
		const removed = [];
		const result = await runCloudCleanup(
			{
				client: { deleteObject: async () => false },
				index: () => ({ remove: (key) => (removed.push(key), true) }),
				persistIndex: async () => {},
				notify: () => {},
				t: (key) => key,
			},
			["gone.png"]
		);
		assert.equal(result.deleted, 0, "★ 本来就不存在的，不能算进「已删除」（提示语不许撒谎）");
		assert.equal(result.alreadyGone, 1, "★ 要单独计数：用户需要知道「有一个本来就不在」");
		assert.equal(result.failed, 0, "★ 404 不是失败 —— 目标状态已经达成（两个入口的解释必须一致）");
		assert.deepEqual(removed, ["gone.png"], "★ 对象确定不在 ⇒ 记录照摘（留着会被 audit/淘汰当有效记录）");
	}

	// 5c. 摘索引之后落盘失败：**必须说出来**（否则重启后看到幽灵记录，查不出原因）
	{
		const notified = [];
		const result = await runCloudCleanup(
			{
				client: { deleteObject: async () => true },
				index: () => ({ remove: () => true }),
				persistIndex: async () => {
					throw new Error("磁盘满");
				},
				notify: (message) => notified.push(message),
				t: (key) => key,
			},
			["a.png"]
		);
		assert.equal(result.deleted, 1, "删除本身是成功的");
		assert.equal(notified.length, 1, "★ 落盘失败必须提示");
		assert.ok(notified[0].includes("cloudCleanupPersistFailed"), `实际提示：${notified[0]}`);
	}

	// 5d. 空清单 ⇒ 什么都不做（不发请求、不落盘）
	{
		let asked = 0;
		const result = await runCloudCleanup(
			{
				client: {
					deleteObject: async () => {
						asked += 1;
						return true;
					},
				},
				index: () => ({ remove: () => true }),
				persistIndex: async () => {
					throw new Error("不该落盘");
				},
				notify: () => {},
				t: (key) => key,
			},
			[]
		);
		assert.equal(asked, 0, "空清单不该发任何请求");
		assert.deepEqual(
			result,
			{ deleted: 0, alreadyGone: 0, failed: 0, unindexed: 0 },
			"空清单的统计全为 0"
		);
	}

	return { cases: 11 };
}
