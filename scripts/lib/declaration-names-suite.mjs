/**
 * 「改名待补队列」套件（`src/maintenance/declaration-names.ts`，CR-16）。
 *
 * 这一层只影响**别设备看到的名字**，所以它的失败形态都是"静默"的：
 * 队列无限膨胀、同一个 hash 留着旧名字、结清时把没补的也丢掉。
 * 每条断言都按这些后果写名字。
 */

import assert from "node:assert/strict";

/** 造一个合法哈希。 */
const hash = (n) => n.toString(16).padStart(64, "0");

export async function runDeclarationNamesSuite(mod) {
	const { enqueueName, settleNames, backlogRefs, backlogCount, nameOfPath, BACKLOG_LIMIT } = mod;

	// ============================================================
	// 1. 入队：新键加进去；同一个 hash **只留最后一次**
	// ============================================================
	{
		let backlog = enqueueName({}, hash(1), "旧名字.png", "png", "2026-10-25T00:00:00.000Z");
		assert.equal(backlogCount(backlog), 1, "一条待补");
		assert.equal(backlog[hash(1)].name, "旧名字.png", "名字存下来了");

		backlog = enqueueName(backlog, hash(1), "新名字.png", "png", "2026-10-25T01:00:00.000Z");
		assert.equal(backlogCount(backlog), 1, "★ 同一个 hash 只留最后一次（声明是状态，不是流水账）");
		assert.equal(backlog[hash(1)].name, "新名字.png", "留下的是最新的名字");
		assert.equal(backlog[hash(1)].at, "2026-10-25T01:00:00.000Z", "`at` 也要刷新（淘汰按它排序）");
	}

	// ============================================================
	// 2. 非法输入不入队（否则队列会被垃圾填满，真正要补的反而被淘汰）
	// ============================================================
	{
		assert.deepEqual(enqueueName({}, "not-a-hash", "x.png", "png", "t"), {}, "非法 hash 不入队");
		assert.deepEqual(enqueueName({}, hash(1), "   ", "png", "t"), {}, "空名字不入队");
		assert.deepEqual(enqueueName({}, hash(1), "x.png", "png", "t"), { [hash(1)]: { name: "x.png", ext: "png", at: "t" } }, "扩展名会被规范化");
		assert.deepEqual(
			enqueueName({}, hash(1), "x.PNG", "PNG", "t")[hash(1)].ext,
			"png",
			"扩展名转小写（与 key 的生成口径一致）"
		);
	}

	// ============================================================
	// 3. 上限：超了就淘汰**最旧的**
	// ============================================================
	{
		let backlog = {};
		for (let i = 0; i < BACKLOG_LIMIT + 1; i += 1) {
			// at 递增：第 0 条最旧
			backlog = enqueueName(backlog, hash(i + 1), `f${i}.png`, "png", `2026-10-25T00:00:${String(i).padStart(2, "0")}.000Z`);
		}
		assert.equal(backlogCount(backlog), BACKLOG_LIMIT, "不超过上限");
		assert.equal(backlog[hash(1)], undefined, "★ 超上限时淘汰最旧的那条（留着最近的改名才有意义）");
		assert.ok(backlog[hash(BACKLOG_LIMIT + 1)], "最新的那条还在");
	}

	// ============================================================
	// 4. 结清：只删点名的，其余（含没补成功的）必须留着
	// ============================================================
	{
		const backlog = {
			[hash(1)]: { name: "a.png", ext: "png", at: "t1" },
			[hash(2)]: { name: "b.png", ext: "png", at: "t2" },
		};
		const after = settleNames(backlog, [hash(1)]);
		assert.deepEqual(Object.keys(after), [hash(2)], "★ 只结清点名的那些（整份清空会丢掉没补的）");
		assert.deepEqual(settleNames(backlog, []), backlog, "没点名 ⇒ 原样返回");
		assert.deepEqual(Object.keys(settleNames(backlog, [hash(9)])), [hash(1), hash(2)], "未知 hash 不影响任何东西");
	}

	// ============================================================
	// 5. 摊平顺序：最旧的先补
	// ============================================================
	{
		const backlog = {
			[hash(2)]: { name: "b.png", ext: "png", at: "2026-10-25T02:00:00.000Z" },
			[hash(1)]: { name: "a.png", ext: "png", at: "2026-10-25T01:00:00.000Z" },
		};
		assert.deepEqual(
			backlogRefs(backlog).map((ref) => ref.hash),
			[hash(1), hash(2)],
			"最旧的先补（只能补一部分时，先补用户最早改的那个）"
		);
		assert.equal(backlogRefs(backlog)[0].name, "a.png", "名字一起带出来");
	}

	// ============================================================
	// 6. 路径 → 名字与扩展名
	// ============================================================
	{
		assert.deepEqual(nameOfPath("attachments/照片.PNG"), { name: "照片.PNG", ext: "png" }, "取最后一段，扩展名转小写");
		assert.deepEqual(nameOfPath("v1.2/photo"), { name: "photo", ext: "" }, "目录里的点不参与扩展名判断");
		assert.deepEqual(nameOfPath("a/b/.hidden"), { name: ".hidden", ext: "" }, "点开头不是扩展名");
		assert.deepEqual(nameOfPath("C:\\vault\\x.txt"), { name: "x.txt", ext: "txt" }, "反斜杠也是分隔符");
	}

	// ============================================================
	// 7. 不可变：入队/结清都不许改入参
	// ============================================================
	{
		const original = { [hash(1)]: { name: "a.png", ext: "png", at: "t" } };
		const frozen = Object.freeze({ ...original });
		enqueueName(frozen, hash(2), "b.png", "png", "t2");
		settleNames(frozen, [hash(1)]);
		assert.deepEqual(Object.keys(frozen), [hash(1)], "★ 入队与结清都返回新对象（改入参会污染调用方手里的快照）");
	}

	return { cases: 7 };
}
