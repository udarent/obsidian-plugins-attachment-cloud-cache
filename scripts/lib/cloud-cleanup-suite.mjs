/**
 * 云端空间清理（`src/maintenance/cloud-cleanup.ts`）的断言套件 —— **需求 R17 / F15**。
 *
 * ⚠️ 2026-10-16：「清理云端未使用对象…」命令退役 ⇒ **候选挑选**（`selectCleanupCandidates`）
 * 与**分页列举**（`listAllObjects`）随之下线，**第 1 节与第 4 节已整段删除**（编号保留原样，
 * 免得与别处的交叉引用对不上）。候选改由**上传台账**产生，那条判据 —— 含
 * **站外缓存整体排除** —— 现在住在 `maintenance/orphan-watch.ts::selectOrphanAsks`
 * ⇒ **测在 `orphan-watch-suite` 里**（不要在本文件里再补一份）。
 *
 * ## 本套件现在守的是什么
 *
 * - 两个 key 工具：`referencedKeysFromUrls`（"谁被引用"的来源）与 `externalKeysOf`
 *   （站外缓存的 key 集合 —— `plugin/orphan-flow.ts::presentOrphans` 拿它做 `isExternal`）；
 * - `runCloudCleanup`：**删成功才摘索引**、**一次失败不中断整批**、**台账变了也要落盘**，
 *   以及"404 = 目标状态已达成"。这些错了都不会报错，只会让人在很久之后
 *   发现"占用统计对不上"。
 */

import assert from "node:assert/strict";

export async function runCloudCleanupSuite(mod) {
	const {
		referencedKeysFromUrls,
		externalKeysOf,
		runCloudCleanup,
	} = mod;

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
	// 5. ⭐ 执行：删成功才摘索引；一次失败不中断整批
	// ============================================================
	{
		const removed = [];
		const forgotten = [];
		const persisted = [];
		const notified = [];
		const deleted = [];
		const recorded = [];
		const result = await runCloudCleanup(
			{
				client: {
					deleteObject: async (key) => {
						deleted.push(key);
						if (key === "boom.png") throw new Error("500");
						return true;
					},
				},
				// ⚠️ 这个替身要**真的**反映"记录被摘掉"：`remove` 之后 `get` 必须返回 undefined，
				// 否则"名字在摘记录之后才读"这个缺陷会被**替身**掩盖（变异验证实测抓到过：
				// 那时这条锚点是"漏过"的 —— 测试无牙，而不是代码没问题）。
				index: () => {
					const gone = new Set();
					return {
						remove: (key) => (removed.push(key), gone.add(key), true),
						forgetUploaded: (key) => (forgotten.push(key), true),
						get: (key) =>
							!gone.has(key) && key === "a.png"
								? { key, sourceName: "报告,1.png", cachePath: "c/a.png" }
								: undefined,
					};
				},
				persistIndex: async () => {
					persisted.push(true);
				},
				notify: (message) => notified.push(message),
				t: (key) => key,
				// 留痕：只有"对象真的不在了"才回调（失败的不算 —— 它还在桶里）
				onRemoved: (record) => recorded.push(record),
			},
			["a.png", "boom.png", "b.png"]
		);

		assert.deepEqual(deleted, ["a.png", "boom.png", "b.png"], "★ 中间一个失败不能中断整批");
		assert.equal(result.deleted, 2, "成功数要如实统计");
		assert.equal(result.failed, 1, "失败数也要如实统计");
		assert.deepEqual(removed, ["a.png", "b.png"], "★ 只有**删成功**的对象才摘索引（失败的摘了会以为远端也没有）");
		assert.deepEqual(
			forgotten,
			["a.png", "b.png"],
			"★ 上传台账同样只在删成功时忘掉（失败时对象还在云端，忘掉就等于以后不再认领它）"
		);
		// ⭐ 留痕：**名字要在摘记录之前读到**（摘掉之后就没地方取了），
		// 且失败的那个（`boom.png`）**不许出现**在留痕里 —— 它还在桶里。
		assert.deepEqual(
			recorded.map((record) => record.key),
			["a.png", "b.png"],
			"★ 留痕只记真的不在桶里的对象（失败的那个还在，记它会让人以为已经删了）"
		);
		assert.equal(recorded[0].name, "报告,1.png", "★ 名字要在摘记录**之前**读到（含逗号的也要原样带出来）");
		assert.equal(recorded[0].outcome, "deleted", "真的删掉了");
		assert.equal(recorded[0].key, "a.png", "key 原样带出（留痕要能对上对象）");
		assert.equal(result.unindexed, 2, "摘掉的记录数要报出来");
		assert.equal(persisted.length, 1, "整批结束**只落盘一次**（不是每删一个写一次索引）");
		assert.equal(notified.length, 0, "都成功了就不该打扰用户");
	}

	// 5b. 删除返回 false（服务端 404：对象本来就不在桶里）⇒ **目标状态已达成**，不是失败
	//
	// ⚠️ 这一节在 2026-10-11 被**改写过**。原断言是"算失败、且不摘索引"，理由写着
	// "对象不在、笔记里的 URL 还在，那条记录让渲染能认出「这是我们存储的地址」"。
	// 复查时发现那个理由**与候选公式矛盾**：能走进 `runCloudCleanup` 的 key 已经排除了
	// "仍被引用"与"站外缓存"（那两条判据在 `orphan-watch.ts::selectOrphanAsks`），
	// 所以"URL 还在笔记里"这种情形**到不了这里**。
	// 反过来的代价是实打实的：`false` 记成失败 ⇒ 用户看到"有一个没删掉"（其实早就没了），
	// 而那条指向 404 的记录会被 audit / 淘汰当成**有效记录**（"明明删了，占用还在涨"）。
	// ⇒ 现在与入口 A 的解释统一（入口 A 从来就没检查过这个返回值）：404 = 已完成，并摘掉记录。
	{
		const removed = [];
		const result = await runCloudCleanup(
			{
				client: { deleteObject: async () => false },
				index: () => ({
					remove: (key) => (removed.push(key), true),
					forgetUploaded: () => true,
					get: () => undefined,
				}),
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

	// 5e. ⭐ 台账单独变化也要落盘
	//
	// 为什么单独立一条：条目与台账平时同进同退（有副本才有条目），但**「不留副本」那一档
	// 只有台账**（没有副本 ⇒ 没有条目）。若落盘条件只判"摘掉了条目"，那一档的云端删除
	// 就永远不落盘 ⇒ 下次启动台账又把那些对象认回来 —— 表现为"删了，重启后又问你一遍"。
	{
		const persisted = [];
		const result = await runCloudCleanup(
			{
				client: { deleteObject: async () => true },
				index: () => ({ remove: () => false, forgetUploaded: () => true, get: () => undefined }),
				persistIndex: async () => persisted.push(true),
				notify: () => {},
				t: (key) => key,
			},
			["no-local-copy.png"]
		);
		assert.equal(result.deleted, 1, "云端删掉了");
		assert.equal(result.unindexed, 0, "这一档没有条目可摘");
		assert.equal(persisted.length, 1, "★ 台账变了也必须落盘（否则那一档的删除下次启动就被忘掉了）");
	}

	// 5c. 摘索引之后落盘失败：**必须说出来**（否则重启后看到幽灵记录，查不出原因）
	{
		const notified = [];
		const result = await runCloudCleanup(
			{
				client: { deleteObject: async () => true },
				index: () => ({ remove: () => true, forgetUploaded: () => true, get: () => undefined }),
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
				index: () => ({ remove: () => true, forgetUploaded: () => true, get: () => undefined }),
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

	return { cases: 8 };
}
