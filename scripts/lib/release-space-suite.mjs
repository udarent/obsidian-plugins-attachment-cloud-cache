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

	/** 判定用的"现在"（注入是为了可穷举 —— 宽限期与 `Date.now()` 没法一起测）。 */
	const NOW = 1_700_000_000_000;

	/**
	 * **存量档**（「不留副本」：目标 = 一份不留）的输入。
	 *
	 * ⚠️ 2026-10-15 起 `planReleaseSpace` 多了一个**必填**的 `keepBytes`（目标）：
	 * 同一个按钮在两种档位下问的是两个问题（全清 / 清到上限以内），
	 * 所以夹具必须**说明自己站在哪一档**，不能再靠默认值蒙混。
	 * 老用例全都是存量档 ⇒ 一律走这个帮手；上限档的用例直接调 `planReleaseSpace`。
	 */
	const planStock = (input) =>
		planReleaseSpace({
			keepBytes: 0,
			now: NOW,
			// 老用例都不涉及「笔记**直接指着**这份本地文件」那一类（2026-10-15 新增的否决）
			referencedPaths: new Set(),
			...input,
		});

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
		const selection = planStock({
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
		const selection = planStock({
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
		const selection = planStock({
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
		const selection = planStock({
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
		const selection = planStock({
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
		const selection = planStock({
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
		const stable = planStock({
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
		const selection = planStock({
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
		const empty = planStock({
			entries: [],
			uploaded: allUploaded(),
			referencedKeys: allReferenced(),
			present: everythingPresent,
		});
		assert.deepEqual(empty.candidates, [], "空索引 ⇒ 空候选");
		assert.equal(empty.bytes, 0);

		const badPath = planStock({
			entries: [entry(key1, "", 100)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(badPath.candidates.length, 0, "★ 空路径不得进候选（别拿空串去问宿主）");

		// 索引里的 size 坏掉时不能变成负数（负数字节会被"合计"抹掉别的量）
		const badSize = planStock({
			entries: [entry(key1, path1, -5)],
			uploaded: allUploaded(key1),
			referencedKeys: allReferenced(key1),
			present: everythingPresent,
		});
		assert.equal(badSize.candidates[0].bytes, 0, "★ 坏字节数收敛到 0，而不是把别的数抹掉");
	}

	// ============================================================
	// 9. ⭐⭐ 上限档：目标是"清到上限以内"，**不是全清**
	//
	// 用户 2026-10-15 报的原话："设置上限 500，清理副本，应该要留下 500，而不是全清"。
	// 上限档的输入多一个 `keepBytes`，其余判据一个字都不放宽。
	// ============================================================
	{
		/** 一条上限档用的条目（`lastUsedAt` 决定谁先走）。 */
		const aged = (key, path, size, hoursAgo) => ({
			...entry(key, path, size),
			lastUsedAt: NOW - hoursAgo * 60 * 60 * 1000,
			uploadedAt: "2020-01-01T00:00:00.000Z",
		});

		// ── ① 只清超出的那部分，不多删 ──
		const three = [
			aged("a-aaaaaaaa.png", "attachments/a-aaaaaaaa.png", 100, 100),
			aged("b-bbbbbbbb.png", "attachments/b-bbbbbbbb.png", 100, 50),
			aged("c-cccccccc.png", "attachments/c-cccccccc.png", 100, 1),
		];
		const trim = planReleaseSpace({
			entries: three,
			uploaded: allUploaded(...three.map((item) => item.key)),
			referencedKeys: allReferenced(...three.map((item) => item.key)),
			present: everythingPresent,
			referencedPaths: new Set(),
			keepBytes: 150, // 总量 300，目标 150 ⇒ 只需腾 150 ⇒ 两份
			now: NOW,
		});
		assert.equal(trim.candidates.length, 2, "★ 只清超出的那部分（目标 150，总量 300 ⇒ 两份就够）");
		assert.equal(trim.bytes, 200, "★ 可释放量按挑中的那几份算");
		assert.equal(trim.totalBytes, 300, "总量要如实给出来（界面要拿它说'清完约剩多少'）");
		assert.equal(trim.projectedBytes, 100, "★ 清完之后预计剩余（≤ 目标）");
		assert.deepEqual(
			trim.candidates.map((candidate) => candidate.key),
			["a-aaaaaaaa.png", "b-bbbbbbbb.png"],
			"★ 最久没用过的先走（用户的承诺是'保留最近用到的'）"
		);

		// ── ② 已经在上限以内 ⇒ 一份都不清 ──
		const under = planReleaseSpace({
			entries: three,
			uploaded: allUploaded(...three.map((item) => item.key)),
			referencedKeys: allReferenced(...three.map((item) => item.key)),
			present: everythingPresent,
			referencedPaths: new Set(),
			keepBytes: 1024,
			now: NOW,
		});
		assert.deepEqual(under.candidates, [], "★ 没超上限 ⇒ 没有该清的东西（按钮那边会说'已经在上限以内'）");
		assert.equal(under.projectedBytes, 300, "一份不删 ⇒ 预计剩余 = 现有总量");

		// ── ③ ⭐⭐ 上限档**也不动**没人引用的副本（用户 2026-10-15 特意排除） ──
		//
		// 理由：没人引用的副本可能还要**连云端对象一起删**（R17 三档询问会问用户 "只删本地 /
		// 一起删 / 保留"）—— 那是另一个决定；而这里只是腾空间。
		// ⚠️ 这条**与后台淘汰不同**（后台是容量机制，它先淘汰没人引用的）；
		// 差别是刻意的，两边各有断言钉着。
		const orphan = aged("orphan-aaaaaaaa.png", "attachments/orphan-aaaaaaaa.png", 100, 999);
		const linked = aged("linked-bbbbbbbb.png", "attachments/linked-bbbbbbbb.png", 100, 10);
		const withOrphan = planReleaseSpace({
			entries: [orphan, linked],
			uploaded: allUploaded(orphan.key, linked.key),
			referencedKeys: allReferenced(linked.key), // ← 只有 linked 被引用
			present: everythingPresent,
			referencedPaths: new Set(),
			keepBytes: 1, // 目标极小 ⇒ 若孤儿在池里，被删的必然是最旧的它（它也更旧）
			now: NOW,
		});
		assert.deepEqual(
			withOrphan.candidates.map((candidate) => candidate.key),
			[linked.key],
			"★★ 上限档只清'带远端链接'的那批 —— 没人引用的那份要留给'连云端一起清'那条流程"
		);
		assert.equal(withOrphan.totalBytes, 100, "★ 目标只按**这批**算（孤儿不进总量，否则会误判超限）");
		assert.equal(
			withOrphan.unlinkedBytes,
			100,
			"★ 孤儿那部分要**单独报出来**（否则用户会问'我设了上限，怎么还占着'）"
		);

		// ── ④ 刚用过的这一轮不动（与后台同一道宽限期）──
		const fresh = aged("fresh-aaaaaaaa.png", "attachments/fresh-aaaaaaaa.png", 100, 0);
		const freshTrim = planReleaseSpace({
			entries: [fresh, linked],
			uploaded: allUploaded(fresh.key, linked.key),
			referencedKeys: allReferenced(fresh.key, linked.key),
			present: everythingPresent,
			referencedPaths: new Set(),
			keepBytes: 100,
			now: NOW,
		});
		assert.deepEqual(
			freshTrim.candidates.map((candidate) => candidate.key),
			[linked.key],
			"★ 10 分钟内用过的副本不动（刚删掉它、下次渲染又会下回来 ⇒ 用户看到'清了又回来'）"
		);
		assert.equal(
			freshTrim.projectedBytes,
			100,
			"★ 因为宽限没清到目标时，预计剩余要如实给出来（界面据此说明'为什么还剩这么多'）"
		);

		// ── ⑤ 坏目标 ⇒ 一个候选都不给（**不崩、也不猜**）──
		for (const bad of [Number.NaN, undefined, "300"]) {
			const broken = planReleaseSpace({
				entries: [entry(key1, path1, 100)],
				uploaded: allUploaded(key1),
				referencedKeys: allReferenced(key1),
				present: everythingPresent,
				referencedPaths: new Set(),
				keepBytes: bad,
				now: NOW,
			});
			assert.deepEqual(
				broken.candidates,
				[],
				`★ 目标读不出来（${String(bad)}）⇒ 什么都不删 —— "读不出目标"最安全的解释就是"这次别动"`
			);
		}
	}

	// ============================================================
	// ⑥ ⭐⭐ 笔记**直接指着**这份本地文件（库内链接）⇒ 两档都不许删
	//
	// 现场（2026-10-15 真机）：一张 `.png` 被笔记用 `![](../企业微信截图_….png)` 指着，
	// 而占用报告说它「没有任何笔记引用」。两条判据问的是**两个问题**：
	// 「笔记还写着**云端地址**吗」（`referencedKeys`）与「笔记**直接指着这份文件**吗」
	// （`referencedPaths`）。后者命中的副本是**笔记正在显示的那一份** ——
	// 删了那张图就没了，而本流程承诺的'下回显示时重新下载'对它不成立。
	// ============================================================
	{
		/** 一条条目 + 明确的"多久以前用过"（上限档要它决定谁先走）。 */
		const agedHere = (key, path, size, hoursAgo) => ({
			...entry(key, path, size),
			lastUsedAt: NOW - hoursAgo * 60 * 60 * 1000,
			uploadedAt: "2020-01-01T00:00:00.000Z",
		});
		// 两档都要钉：一份不留（`planStock`）与清到上限（直接调）
		const stock = planStock({
			entries: [entry(key1, path1, 100), entry(key2, path2, 200)],
			uploaded: allUploaded(key1, key2),
			referencedKeys: allReferenced(key1, key2),
			referencedPaths: new Set([path2]),
			present: everythingPresent,
		});
		assert.deepEqual(
			stock.candidates.map((candidate) => candidate.key),
			[key1],
			"★ 一份不留那一档也不许删被库内链接指着的（删了笔记里那张图就没了）"
		);

		const trimmed = planReleaseSpace({
			entries: [agedHere(key1, path1, 100, 100), agedHere(key2, path2, 100, 1)],
			uploaded: allUploaded(key1, key2),
			referencedKeys: allReferenced(key1, key2),
			referencedPaths: new Set([path2]),
			present: everythingPresent,
			keepBytes: 50,
			now: NOW,
		});
		assert.deepEqual(
			trimmed.candidates.map((candidate) => candidate.key),
			[key1],
			"★ 上限档同理（那一份虽然最久没用过，但笔记正显示着它）"
		);
		// ⚠️ 但它**仍算在这批的占用里**：目标那笔账要把不能删的也算进去，才算得出诚实的结果
		assert.equal(trimmed.totalBytes, 200, "★ 不能删的那份也要算进'这批'的总量（否则会报一个达不到的目标）");

	// ============================================================
	// 10. 同一份文件只算一次 —— 另外两处（上限档 / 台账外占用）也要成立
	//
	// ⚠️ 这一组放在**最后**：它断言的是"上限档 / 台账外占用"，而那几处各自已有变异锚点
	// （目标没传、时间没传、上限档退化成全清…）。放在前面会**抢先红**，把那些变异的
	// `expect` 全部顶掉 —— 症状是"原因不符"，不是"漏过"，很容易误判成套件变松。
	// 判据本体只有一处：`eviction.ts::uniqueByPath`（淘汰 / 上限档 / 台账外占用共用）。
	// ============================================================

		// ⭐ 上限档走的是 `buildEvictionCandidates`（另一条路），同一个判据也要成立 ——
		// 否则"清到上限"会按虚高的占用去挑人，多清一份真实副本。
		const keep = planReleaseSpace({
			keepBytes: 150,
			now: NOW,
			referencedPaths: new Set(),
			entries: [entry(key1, path1, 100), entry("副本-bbbbbbbb.png", path1, 900), entry(key2, path2, 100)],
			uploaded: allUploaded(key1, "副本-bbbbbbbb.png", key2),
			referencedKeys: allReferenced(key1, "副本-bbbbbbbb.png", key2),
			present: everythingPresent,
		});
		// 池里其实只有**两份文件**（200 字节），超 50 字节 ⇒ 清一份就够。
		// 若按记录算，占用会是 1100 ⇒ 超出 950 ⇒ **两份都清光**。
		assert.equal(keep.candidates.length, 1, "★★ 上限档同样按**文件**算 ⇒ 只需清一份（按记录算会把两份都清掉）");
		assert.equal(keep.candidates[0].cachePath, path1, "★ 清的就是那份超出的文件（稳定挑选：同一个 key）");
		assert.equal(keep.totalBytes, 200, "★★ 上限档的总占用也按文件算（100 + 100，不是 100 + 900 + 100）");

		// ⭐ 「另外还有 N MB 没算进这批」那句数字同样只算一次
		const unlinked = planStock({
			entries: [entry(key1, path1, 100), entry("副本-bbbbbbbb.png", path1, 900)],
			// 在台账里、但笔记里已经不提它的云端地址 ⇒ 算「这批清不到、但确实占着磁盘」
			uploaded: allUploaded(key1, "副本-bbbbbbbb.png"),
			referencedKeys: allReferenced(),
			present: everythingPresent,
		});
		assert.equal(
			unlinked.unlinkedBytes,
			100,
			"★★ 这批清不到的占用也只按文件算一次（重复计入会让那句「另外还有」虚高）"
		);
	}
}