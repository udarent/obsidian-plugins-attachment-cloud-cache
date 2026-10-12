import assert from "node:assert/strict";

/**
 * 索引自愈（`src/maintenance/self-heal.ts`）。
 *
 * 这一套守的是**误摘的方向**，因为代价不对称：
 * - 多留一条指向不存在文件的记录 ⇒ 只是统计不准；
 * - 误摘一条记录 ⇒ 那张图的**离线可用性被悄悄拿掉**（有网时还会重新下载一次）。
 *
 * 所以每一格都朝"多留"一侧倒，而且**反向钉子与正向一样多**：
 * 查不到（抛错）时**不许摘**、宿主索引与适配器**任一说在就算在**、
 * 只改索引**绝不删文件**（这一层连删文件的入口都没有）。
 */

/** 造一个条目。 */
function entry(key, cachePath) {
	return {
		key,
		cachePath,
		remoteUrl: `https://example.test/${key}`,
		size: 1,
		contentType: "image/png",
		etag: "",
		uploadedAt: "2026-10-11T00:00:00.000Z",
		lastUsedAt: 0,
		sourceName: key,
	};
}

/** 造一组依赖替身，并记录调用。 */
function harness(options = {}) {
	const removed = [];
	const persisted = [];
	const notices = [];
	const errors = [];
	const checkedPaths = [];
	let yields = 0;
	const missing = new Set(options.missing ?? []);
	const throwing = new Set(options.throwing ?? []);

	const deps = {
		entries: () => options.entries ?? [],
		exists: async (path) => {
			checkedPaths.push(path);
			if (throwing.has(path)) throw new Error("适配器炸了");
			return !missing.has(path);
		},
		forget: (key) => {
			removed.push(key);
			return true;
		},
		persist: async () => {
			if (options.persistFails) throw new Error("磁盘满");
			persisted.push(true);
		},
		notify: (message) => notices.push(message),
		t: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
		yieldNow: async () => {
			yields += 1;
		},
		onError: (error) => errors.push(error),
	};

	return {
		deps,
		removed,
		persisted,
		notices,
		errors,
		checkedPaths,
		yields: () => yields,
	};
}

export async function runSelfHealSuite(mod) {
	const { planSelfHeal, runSelfHeal, SELF_HEAL_BATCH } = mod;
	assert.ok(typeof planSelfHeal === "function", "应当导出 planSelfHeal");
	assert.ok(typeof runSelfHeal === "function", "应当导出 runSelfHeal");
	assert.ok(Number.isInteger(SELF_HEAL_BATCH) && SELF_HEAL_BATCH > 0, "应当导出一个正整数批大小");

	// ============================================================
	// 1. planSelfHeal：按路径归组、去重、跳过空白
	// ============================================================
	{
		const plan = planSelfHeal([
			entry("a.png", "_cache/a.png"),
			entry("b.png", "_cache/b.png"),
			// ⭐ 同一个路径挂着两条记录 ⇒ 只检查一次，但**两条都要一起摘**
			entry("a2.png", "_cache/a.png"),
			entry("blank.png", "   "),
			entry("empty.png", ""),
			entry("nokey", "_cache/nokey.png"),
		]);
		assert.deepEqual(
			plan.map((target) => target.path),
			["_cache/a.png", "_cache/b.png", "_cache/nokey.png"],
			"★ 路径去重（同一路径只检查一次），空白路径直接跳过，且保持输入顺序"
		);
		assert.deepEqual(plan[0].keys, ["a.png", "a2.png"], "★ 同一路径名下的记录都要带上（否则一轮修不干净）");
		assert.deepEqual(planSelfHeal([]), [], "空输入 ⇒ 空计划");
		assert.deepEqual(planSelfHeal([null, undefined, entry("x.png", "_cache/x.png")]).length, 1, "坏条目不该让整轮崩掉");
	}

	// ============================================================
	// 2. 全部都在 ⇒ 什么都不做（不落盘、不通知）
	// ============================================================
	{
		const h = harness({ entries: [entry("a.png", "_cache/a.png"), entry("b.png", "_cache/b.png")] });
		const result = await runSelfHeal(h.deps);
		assert.deepEqual(result, { checked: 2, healed: 0, failed: 0 }, "全在 ⇒ 只检查、不修");
		assert.deepEqual(h.removed, [], "没摘任何记录");
		assert.equal(h.persisted.length, 0, "★ 没变化不落盘（否则每次启动都白写一次索引）");
		assert.equal(h.notices.length, 0, "★ 0 条不通知（每轮报一句「没事」就是噪音）");
	}

	// ============================================================
	// 3. 文件不在 ⇒ 摘掉它的记录；只摘它一个
	// ============================================================
	{
		const h = harness({
			entries: [entry("gone.png", "_cache/gone.png"), entry("here.png", "_cache/here.png")],
			missing: ["_cache/gone.png"],
		});
		const result = await runSelfHeal(h.deps);
		assert.deepEqual(result, { checked: 2, healed: 1, failed: 0 }, "如实计数");
		assert.deepEqual(h.removed, ["gone.png"], "★ 只摘失效的那一条");
		assert.equal(h.persisted.length, 1, "改了才落盘，且只落一次");
		assert.equal(h.notices.length, 1, "修了就通知");
		assert.ok(h.notices[0].startsWith("selfHealRepaired"), `通知要用自愈那条文案：${h.notices[0]}`);
		assert.ok(h.notices[0].includes('"count":1'), "★ 通知里的数字要如实（用户据此判断影响面）");
	}

	// 3b. 一个路径两条记录 ⇒ 两条一起摘，计数算 2
	{
		const h = harness({
			entries: [entry("k1.png", "_cache/same.png"), entry("k2.png", "_cache/same.png")],
			missing: ["_cache/same.png"],
		});
		const result = await runSelfHeal(h.deps);
		assert.deepEqual(result, { checked: 1, healed: 2, failed: 0 }, "★ 只检查 1 条路径，但摘掉 2 条记录");
		assert.deepEqual(h.removed, ["k1.png", "k2.png"], "同一路径下的记录都要摘");
		assert.equal(h.checkedPaths.length, 1, "★ 同一路径只查一次（省一次 I/O）");
	}

	// ============================================================
	// 4. ⭐⭐ 查询抛错 ⇒ **不许摘**（本条是这一套最要紧的反向钉子）
	//
	// 误摘的后果不对称：那张图在离线时不显示、有网时重新下载 —— 用户选的"离线可用"被
	// 悄悄拿掉。而"查询出错"恰恰是最不该据以删记录的状态（同步中、权限、适配器抽风）。
	// ============================================================
	{
		const h = harness({
			entries: [entry("flaky.png", "_cache/flaky.png")],
			throwing: ["_cache/flaky.png"],
		});
		const result = await runSelfHeal(h.deps);
		assert.equal(result.healed, 0, "★ 查不到（抛错）时**不许**摘记录");
		assert.equal(result.failed, 1, "出错要单独计数（否则「修了 0 条」会被读成「一切正常」）");
		assert.deepEqual(h.removed, [], "没有摘任何东西");
		assert.equal(h.persisted.length, 0, "没变化不落盘");
		assert.equal(h.notices.length, 0, "没修就不通知");
		assert.equal(h.errors.length, 1, "出错要上报（错误不能静默吞掉）");
	}

	// 4b. 反向：**在**就不用查第二遍、也不摘（宿主的判定是权威的一侧）
	{
		const h = harness({ entries: [entry("here.png", "_cache/here.png")] });
		await runSelfHeal(h.deps);
		assert.equal(h.removed.length, 0, "存在 ⇒ 保留记录（哪怕它看起来可疑）");
	}

	// ============================================================
	// 5. 落盘失败 ⇒ 只说那一句，**不许**说"已修复"
	//
	// 说"修好了"而其实没存下去，就是让用户以为已经好了 —— 下次启动它又回来了。
	// ============================================================
	{
		const h = harness({
			entries: [entry("gone.png", "_cache/gone.png")],
			missing: ["_cache/gone.png"],
			persistFails: true,
		});
		const result = await runSelfHeal(h.deps);
		assert.equal(result.healed, 1, "内存里确实摘掉了");
		assert.equal(h.notices.length, 1, "只说一句");
		assert.ok(h.notices[0].startsWith("maintainPersistFailed"), `★ 落盘失败时说的是失败，不是"已修复"：${h.notices[0]}`);
	}

	// ============================================================
	// 6. 分批让出主线程（大索引不独占界面）
	// ============================================================
	{
		const big = [];
		for (let i = 0; i < SELF_HEAL_BATCH * 2 + 1; i += 1) big.push(entry(`k${i}.png`, `_cache/k${i}.png`));
		const h = harness({ entries: big });
		const result = await runSelfHeal(h.deps);
		assert.equal(result.checked, big.length, "全部都要查到（**不设**硬上限：修一半比慢一点糟）");
		assert.ok(h.yields() >= 2, `★ 超过批大小要让出主线程（实际让出 ${h.yields()} 次）`);

		const small = harness({ entries: [entry("a.png", "_cache/a.png")] });
		await runSelfHeal(small.deps);
		assert.equal(small.yields(), 0, "小索引不必让出（少一次无谓的调度）");
	}

	// ============================================================
	// 7. 后台任务**绝不抛错**（它跑在插件生命周期里，异常没人接）
	// ============================================================
	{
		const h = harness({ entries: [] });
		h.deps.entries = () => {
			throw new Error("索引读崩了");
		};
		let result;
		try {
			result = await runSelfHeal(h.deps);
		} catch (error) {
			assert.fail(`⭐ 自愈绝不能抛错（会让插件生命周期里冒出一个没人接的异常）。实际抛出：${error}`);
		}
		assert.deepEqual(result, { checked: 0, healed: 0, failed: 0 }, "出错时如实返回全 0");
		assert.equal(h.errors.length, 1, "错误要上报");
	}

	// ============================================================
	// 8. ⭐ 这一层**没有删文件的入口**（结构性：只有 forget / persist）
	//
	// 用"接口形状"钉住：自愈只被允许改索引。想删文件必须去**淘汰（轮换）**或 **R17 的询问**那条线，
	// 它们各有自己的确认与边界 —— 混在一起就会出现"只是想修一下索引，结果删了文件"。
	// ============================================================
	{
		const h = harness({ entries: [entry("gone.png", "_cache/gone.png")], missing: ["_cache/gone.png"] });
		await runSelfHeal(h.deps);
		assert.deepEqual(
			Object.keys(h.deps).filter((name) => typeof h.deps[name] === "function").sort(),
			["entries", "exists", "forget", "notify", "onError", "persist", "t", "yieldNow"],
			"★ 依赖面只有这 8 个：没有 delete / remove(file) / trashFile 之类的入口"
		);
	}

	return { cases: 12 };
}
