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
		// ⚠️ 默认 `() => true` = **单轮即摘**：这一套的大多数用例验的是"摘与落盘的机制"，
		// 两轮确认另有专门一节（用真的 `createAbsenceConfirmer` 驱动）。
		confirmAbsent: options.confirmAbsent ?? (() => true),
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
	const { planSelfHeal, runSelfHeal, SELF_HEAL_BATCH, createAbsenceConfirmer } = mod;
	assert.ok(typeof planSelfHeal === "function", "应当导出 planSelfHeal");
	assert.ok(typeof runSelfHeal === "function", "应当导出 runSelfHeal");
	assert.ok(Number.isInteger(SELF_HEAL_BATCH) && SELF_HEAL_BATCH > 0, "应当导出一个正整数批大小");
	assert.ok(typeof createAbsenceConfirmer === "function", "应当导出 createAbsenceConfirmer");
	// ⚠️ 这里曾经还断言 `CONFIRM_IMMEDIATELY`（命令那条线的"单轮即摘"确认器）——
	// 2026-10-16「自检并修复本地副本索引」命令退役后它**没有生产者**，已从源码删除。

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
	// 2b. ⭐⭐ 两轮确认：第一次判"不在"只标记，下一轮仍不在才摘
	//
	// 为什么：「现在不在」有两种 —— 真的没了，和**还在路上**（换设备、同步工具正在拉）。
	// 单轮就摘会把后者也当失效；而新设备上那可能是**整份索引**
	//（索引文件随 `.obsidian` 先到、附件还没到）。⇒ 判据 = "上一轮也不在"。
	// ============================================================
	{
		const confirmer = createAbsenceConfirmer();
		assert.equal(confirmer("_cache/a.png", true), false, "★ 第一次判不在 ⇒ 只标记，不摘");
		assert.equal(confirmer("_cache/a.png", true), true, "★ 第二次仍不在 ⇒ 才确认");

		const back = createAbsenceConfirmer();
		back("_cache/a.png", true);
		assert.equal(back("_cache/a.png", false), false, "文件又出现了 ⇒ 不摘");
		assert.equal(back("_cache/a.png", true), false, "★★ 痕迹被清掉 ⇒ 重新数两轮（不累计历史缺席）");

		// 端到端：同一个依赖面、同一个确认器，跑**两轮**
		{
			const h = harness({
				entries: [entry("a.png", "_cache/a.png")],
				missing: ["_cache/a.png"],
				confirmAbsent: createAbsenceConfirmer(),
			});
			const first = await runSelfHeal(h.deps);
			assert.equal(first.healed, 0, "★★ 第 1 轮：文件不在也**不摘**（它可能还在路上）");
			assert.deepEqual(h.removed, [], "★ 第 1 轮一条都不许摘");
			assert.equal(h.persisted.length, 0, "★ 没改东西就不落盘");

			const second = await runSelfHeal(h.deps);
			assert.equal(second.healed, 1, "★★ 第 2 轮仍不在 ⇒ 摘掉");
			assert.deepEqual(h.removed, ["a.png"], "摘的正是那条记录");
			assert.equal(h.persisted.length, 1, "真改了才落盘（一次）");
		}

		// 反向：文件在第 2 轮之前到了 ⇒ 两轮都不摘（这正是换设备/同步中的场景）
		{
			const missing = new Set(["_cache/a.png"]);
			const h = harness({ entries: [entry("a.png", "_cache/a.png")], confirmAbsent: createAbsenceConfirmer() });
			h.deps.exists = async (path) => !missing.has(path);
			await runSelfHeal(h.deps);
			missing.clear();
			const second = await runSelfHeal(h.deps);
			assert.equal(second.healed, 0, "★★ 文件到了 ⇒ 一轮都不摘");
			assert.deepEqual(h.removed, []);
		}

		// ⚠️ 查询**出错**那轮不该清掉已经攒下的确认（否则永远攒不满两轮）
		{
			const h = harness({
				entries: [entry("a.png", "_cache/a.png")],
				missing: ["_cache/a.png"],
				confirmAbsent: createAbsenceConfirmer(),
			});
			const honest = h.deps.exists;
			await runSelfHeal(h.deps); // 第 1 轮：标记
			h.deps.exists = async () => {
				throw new Error("适配器炸了");
			};
			const failedRound = await runSelfHeal(h.deps);
			// ⚠️ 先断"不摘"再断计数：出错最要紧的是**别摘**（计数只是记账）。
			assert.equal(failedRound.healed, 0, "出错按「存在」处理 ⇒ 不摘");
			assert.equal(failedRound.failed, 1, "出错的路径记进 failed");
			h.deps.exists = honest;
			const fourth = await runSelfHeal(h.deps);
			assert.equal(fourth.healed, 1, "★ 回到「不在」⇒ 仍能确认（出错那轮没把标记清掉）");
		}
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
			["confirmAbsent", "entries", "exists", "forget", "notify", "onError", "persist", "t", "yieldNow"],
			"★ 依赖面只有这 9 个：没有 delete / remove(file) / trashFile 之类的入口"
		);
	}

	return { cases: 13 };
}
