/**
 * 「清理已上传附件的本地占用」（F18）纯判定的断言套件（与变异验证共用）。
 *
 * 这一层最要紧的三条：
 * 1. **准入判据缺一不可** —— 少一条就会删掉不该删的东西（或让"云端最后一份"失去本地备份）；
 * 2. ⭐ **"带远端链接"是硬门槛**，且**与 R17 的分工线**就在这里：孤儿不归这里管；
 * 3. ⚠️ `referencedKeys` 的**空集合必须意味着零候选** ——
 *    这与 `eviction.ts` 的默认方向**相反**（那边"不知道"＝当作已引用），是有意的：
 *    淘汰里那样是保守，这里"当作没有链接"才是保守。变异锚点守着这条反向语义。
 */

import assert from "node:assert/strict";

/** 造一条索引条目（只填判定用得到的字段）。 */
function entry(key, cachePath, size) {
	return { key, cachePath, size, remoteUrl: `https://cdn.example.com/${key}`, contentType: "image/png" };
}

export function runReleaseSpaceSuite(mod) {
	const { planReleaseSpace } = mod;

	const path1 = "attachments/报告-aaaaaaaa.png";
	const path2 = "attachments/照片-bbbbbbbb.png";
	const key1 = "报告-aaaaaaaa.png";
	const key2 = "照片-bbbbbbbb.png";

	const everythingPresent = () => true;
	const allReferenced = (...keys) => new Set(keys);
	const allUploaded = (...keys) => new Set(keys);

	// ============================================================
	// 1. 四条判据全过 ⇒ 一个候选，路径/字节都对
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(selection.candidates.length, 1, "四条判据都过就该进候选");
		assert.equal(selection.candidates[0].key, key1, "候选要带上 key（执行层按它复核云端）");
		assert.equal(selection.candidates[0].cachePath, path1, "候选要带上本地路径（执行层按它删）");
		assert.equal(selection.candidates[0].bytes, 100, "字节取自索引");
		assert.equal(selection.bytes, 100, "合计要算出来（确认框里给用户看）");
		assert.equal(selection.missing, 0, "没有失效记录");
	}

	// ============================================================
	// 2. ⭐ 台账没命中 ⇒ 不进候选
	//
	// "索引里有记录"与"这个对象是我们传上去的"是**两件事**：
	// 前者只说明"本地有这么一份文件"。少了台账这道闸门，一个从没上传成功的
	// 本地附件（索引里可能有记录、或者将来某次改动让它有）就会被当成"删了随时能下载"。
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100)],
			uploaded: allUploaded(), // 台账里没有它
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(selection.candidates.length, 0, "★ 台账里没有的对象不得进候选（它未必在云端）");
		assert.equal(selection.bytes, 0, "不进候选就不能算进可释放字节");
	}

	// ============================================================
	// 3. ⭐ 没有远端链接 ⇒ 不进候选（这是与 R17 的分工线）
	//
	// 用户口径："**只清理有远端链接的**"。没有远端链接的副本 = 没人引用了 = 孤儿，
	// 那归 R17 的三档询问（"只删本地"）逐次决定 —— 两类互不重叠。
	// ⚠️ 别把这条放宽成"反正都能重新下载"：那样这条命令会连带处理孤儿，
	// 而孤儿恰恰是**用户可能还想留着**的那一类（笔记删了、图还在）。
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(), // 没有任何笔记引用它
			present: everythingPresent,
		});
		assert.equal(selection.candidates.length, 0, "★ 孤儿不归这条命令管（那是 R17 的活）");
	}

	// ============================================================
	// 4. ⚠️ 引用扫描结果为空 ⇒ 零候选（**方向与 `eviction.ts` 相反**）
	//
	// 淘汰那边把"没扫描引用"当成"一律当作已引用"（宁可少删）；
	// 这里"带远端链接"是**准入条件**：拿不到引用扫描结果就一个都不该删。
	// 两处默认值方向相反是有意的 —— 谁更保守的方向不同。
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100), entry(key2, path2, 200)],
			uploaded: allUploaded(key1, key2),
			referencedKeys: new Set(),
			present: everythingPresent,
		});
		assert.equal(selection.candidates.length, 0, "★ 空引用集合 ⇒ 零候选（拿不到引用就不许清）");
	}

	// ============================================================
	// 5. 磁盘上已经没有 ⇒ 不进候选，但要**单独计数**
	//
	// 没有可删的东西时不该把它算进"可释放字节"（那会让用户以为能腾出空间，
	// 跑完却发现一个都没删）；而那些记录该由自愈去摘（不是这条命令的事）。
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100), entry(key2, path2, 200)],
			uploaded: allUploaded(key1, key2),
			referencedKeys: allReferenced(key1, key2),
			present: (path) => path === path1, // 第二份已经不在了
		});
		assert.equal(selection.candidates.length, 1, "不存在的副本没有可删的东西");
		assert.equal(selection.candidates[0].key, key1, "剩下的那份仍然要能清");
		assert.equal(selection.bytes, 100, "★ 已失效的那条不得计入可释放字节");
		assert.equal(selection.missing, 1, "★ 失效条数要单独计数（如实告知，而不是混进候选）");
	}

	// ============================================================
	// 6. 排序：先大的；同样大时按 key（顺序必须**稳定**）
	//
	// 顺序不稳定 ⇒ 用户每次看到的清单都不一样，没法核对，也没法复现"上次清了哪些"。
	// ============================================================
	{
		const big = "zzz-cccccccc.png";
		const small = "aaa-dddddddd.png";
		const selection = planReleaseSpace({
			entries: [
				entry(small, "attachments/aaa-dddddddd.png", 10),
				entry(big, "attachments/zzz-cccccccc.png", 900),
			],
			uploaded: allUploaded(big, small),
			referencedKeys: allReferenced(big, small),
			present: everythingPresent,
		});
		assert.deepEqual(
			selection.candidates.map((candidate) => candidate.key),
			[big, small],
			"★ 按字节降序（先给最大的，用户一眼看到能腾多少）"
		);

		// 同样大：按 key 字典序 —— 与输入顺序无关
		const e = "ee-eeeeeeee.png";
		const c = "cc-cccccccc.png";
		const stable = planReleaseSpace({
			entries: [entry(e, "attachments/ee-eeeeeeee.png", 50), entry(c, "attachments/cc-cccccccc.png", 50)],
			uploaded: allUploaded(e, c),
			referencedKeys: allReferenced(e, c),
			present: everythingPresent,
		});
		assert.deepEqual(
			stable.candidates.map((candidate) => candidate.key),
			[c, e],
			"★ 同样大时按 key 排 —— 顺序必须与输入顺序无关"
		);
	}

	// ============================================================
	// 7. 同一路径只算一次（字节不得重复计入）
	//
	// 索引理论上不会有两条记录指向同一份文件，但"理论上"不是判据；
	// 而报给用户的字节数一旦重复，他会按一个达不到的数字去期待。
	// ============================================================
	{
		const selection = planReleaseSpace({
			entries: [entry(key1, path1, 100), entry("副本-bbbbbbbb.png", path1, 900)],
			uploaded: allUploaded(key1, "副本-bbbbbbbb.png"),
			referencedKeys: allReferenced(key1, "副本-bbbbbbbb.png"),
			present: everythingPresent,
		});
		assert.equal(selection.candidates.length, 1, "★★ 同一路径只能出现一次");
		assert.equal(selection.bytes, 100, "★★ 同一份文件的字节只能算一次");
	}

	// ============================================================
	// 8. 空输入与坏输入：一律不崩、不猜
	// ============================================================
	{
		const empty = planReleaseSpace({
			entries: [],
			uploaded: allUploaded(),
			referencedKeys: allReferenced(),
			present: everythingPresent,
		});
		assert.deepEqual(empty.candidates, [], "空索引 ⇒ 空候选");
		assert.equal(empty.bytes, 0);

		const badPath = planReleaseSpace({
			entries: [entry(key1, "", 100)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(badPath.candidates.length, 0, "★ 空路径不得进候选（别拿空串去问宿主）");

		// 索引里的 size 坏掉时不能变成负数（负数字节会被"合计"抹掉别的量）
		const badSize = planReleaseSpace({
			entries: [entry(key1, path1, -5)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(badSize.candidates[0].bytes, 0, "★ 坏字节数收敛到 0，而不是把别的数抹掉");
	}
}
