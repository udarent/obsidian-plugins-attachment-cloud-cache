/**
 * 云端盘点（列桶 → 内容哈希集合）的断言套件。
 *
 * 与其它套件同一条纪律：被**正式测试**与**变异验证**共用 —— 变异被抓住，
 * 证明的正是你日常跑的那批断言，而不是变异脚本自带的一套。
 */

import assert from "node:assert/strict";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);

export async function runRemoteInventorySuite(mod) {
	const { listRemoteContentHashes } = mod;

	/** 用「一叠响应」喂一个假 listObjects：每次调用弹一张，弹完回空页。 */
	const clientWith = (pages) => ({
		listObjects: async () => pages.shift() ?? { objects: [], nextToken: null },
	});

	// 1. 空桶 ⇒ 空 Set，**不是** null（"列到了、只是没有"与"列不到"必须分得开）
	{
		const hashes = await listRemoteContentHashes(clientWith([{ objects: [], nextToken: null }]));
		assert.ok(hashes instanceof Set, "空桶应返回 Set（不是 null）");
		assert.equal(hashes.size, 0, "空桶应返回空 Set");
	}

	// 2. 混合 key：只收能反推哈希的，声明与第三方对象跳过
	{
		const hashes = await listRemoteContentHashes(
			clientWith([
				{
					objects: [
						{ key: `${H1}.png` },
						{ key: `报告-${H2}.pdf` },
						{ key: "_acc/v1/vault/device/head.json" },
						{ key: "photo.jpg" },
					],
					nextToken: null,
				},
			])
		);
		assert.equal(hashes.size, 2, "应只收能反推内容哈希的对象（声明与第三方不认）");
		assert.ok(hashes.has(H1), "纯哈希 key 应转成哈希");
		assert.ok(hashes.has(H2), "带名 key 也应转成哈希");
	}

	// 3. 分页翻完 ⇒ 合并所有页
	{
		const hashes = await listRemoteContentHashes(
			clientWith([
				{ objects: [{ key: `${H1}.png` }], nextToken: "tok" },
				{ objects: [{ key: `${H2}.png` }], nextToken: null },
			])
		);
		assert.equal(hashes.size, 2, "分页应合并每一页的哈希");
		assert.ok(hashes.has(H2), "第二页的哈希不能丢");
	}

	// 4. 翻不完 ⇒ null（不知道，不是"没有"）
	{
		const endless = { objects: [{ key: `${H1}.png` }], nextToken: "keep-going" };
		const hashes = await listRemoteContentHashes(clientWith(Array(10).fill(endless)));
		assert.equal(hashes, null, "翻不完应返回 null（调用方退回逐文件 HEAD）");
	}

	// 5. 列桶抛错（拿不到 ListBucket / 网络错）⇒ null
	{
		const hashes = await listRemoteContentHashes({
			listObjects: async () => {
				throw new Error("403 AccessDenied");
			},
		});
		assert.equal(hashes, null, "列不到应返回 null（不能把失败当空桶）");
	}

	// 6. 同哈希去重（同一份内容多种命名只记一次）
	{
		const hashes = await listRemoteContentHashes(
			clientWith([
				{
					objects: [
						{ key: `${H3}.png` },
						{ key: `别的名字-${H3}.png` },
					],
					nextToken: null,
				},
			])
		);
		assert.equal(hashes.size, 1, "同哈希多个 key 只应记一次（Set 语义）");
		assert.ok(hashes.has(H3), "哈希应保留");
	}
}
