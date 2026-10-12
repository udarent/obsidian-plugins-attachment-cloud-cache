/**
 * 后台自动轮换的编排（`src/maintenance/rotation.ts`）断言套件。
 *
 * ## 这一层坏掉的方式是「白干活」或「该干不干」
 *
 * - 门槛失效 → 每次上传、每个周期都去**读全库笔记**（在大库里就是卡顿）；
 * - 节流失效 → 连粘 20 张图触发 20 轮，每轮都删文件；
 * - 并发标志写错 → 两轮同时删同一批文件，结果没法解释；
 * - 出错抛出去 → 后台任务把异常抛进插件的生命周期里（用户看到的是插件报错）。
 *
 * ## ⭐ 1.2.0（D-17）：门槛从两道变一道（与候选同源）
 *
 * 从前有第二道门槛"列缓存目录 + 逐个 stat"，用来发现"索引记的比磁盘小"。
 * 缓存目录取消之后，候选与统计**都来自索引**，那道门槛没有可看的对象了 ——
 * 而索引之外的文件**绝不能删**（那可能是用户的附件）。所以它被删掉，
 * 代价是"索引不全时上限偏保守"，这正是安全的那一侧（下面有一条断言专门把它写下来）。
 *
 * 所以这里用**注入的假依赖**把每一次调用都数出来，逐条钉住。
 */

import assert from "node:assert/strict";

const MB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-07T12:00:00Z");

/** 造一条索引记录（编排层只用到 `size` / `cachePath` / `lastUsedAt`）。 */
function entryFor(key, options = {}) {
	return {
		key,
		cachePath: options.cachePath ?? `_attachment-cache/${key}`,
		remoteUrl: `https://img.example.com/${key}`,
		size: options.size ?? 0,
		contentType: "image/png",
		etag: "e",
		uploadedAt: new Date(options.uploadedAt ?? NOW - 48 * HOUR).toISOString(),
		sourceName: key,
		lastUsedAt: options.lastUsedAt ?? 0,
	};
}

export async function runRotationSuite(mod) {
	const { createCacheRotator, isRotationDue, DEFAULT_ROTATION_MIN_INTERVAL_MS } = mod;

	const settingsWith = (overrides = {}) => ({
		cacheLimitMb: 1,
		...overrides,
	});

	// ============================================================
	// 1. 节流判定（纯函数）
	// ============================================================
	assert.equal(
		isRotationDue({ now: NOW, lastRunAt: Number.NEGATIVE_INFINITY, minIntervalMs: 60_000 }),
		true,
		"★ 从未跑过 → 该跑（初值用 -Infinity，不需要特判首次）"
	);
	assert.equal(
		isRotationDue({ now: NOW, lastRunAt: NOW - 30_000, minIntervalMs: 60_000 }),
		false,
		"刚跑过一半间隔 → 不跑"
	);
	assert.equal(
		isRotationDue({ now: NOW, lastRunAt: NOW - 60_000, minIntervalMs: 60_000 }),
		true,
		"正好到间隔 → 该跑（边界取闭区间）"
	);
	assert.equal(isRotationDue({ now: NOW, lastRunAt: NOW, minIntervalMs: 0 }), true, "间隔为 0 → 每次都该跑");
	assert.equal(DEFAULT_ROTATION_MIN_INTERVAL_MS > 0, true, "默认间隔必须为正（否则节流等于没有）");

	// ============================================================
	// 2. 环境（把每一次调用都数出来）
	// ============================================================
	function makeHarness(options = {}) {
		const calls = { index: 0, scan: 0, evict: 0 };
		const notices = [];
		const errors = [];
		const plans = [];
		const presentQueries = [];
		let clock = options.now ?? NOW;
		/** 让"扫引用"能一直挂着（用来构造「上一轮还没跑完」的情形）。 */
		let pendingScan = [];

		const deps = {
			settings: () => options.settings ?? settingsWith(),
			index: () => {
				calls.index += 1;
				return { toArray: () => options.entries ?? [] };
			},
			isPresent: (path) => {
				presentQueries.push(path);
				return (options.present ?? (() => true))(path);
			},
			scanReferencedKeys: async () => {
				calls.scan += 1;
				if (options.scanThrows) throw new Error("扫笔记失败");
				if (options.scanHangs) {
					await new Promise((resolve) => {
						pendingScan.push(resolve);
					});
				}
				return options.referencedKeys ?? new Set();
			},
			evict: async (plan) => {
				calls.evict += 1;
				plans.push(plan);
				return options.evictOutcome ?? { evicted: plan.evict.length, freed: plan.reclaimable, skipped: [] };
			},
			notify: (message) => {
				if (options.notifyThrows) throw new Error("提示失败");
				notices.push(message);
			},
			// 假翻译：把键与参数拼成一行，断言里直接看得到
			t: (key, params) => `${key} ${JSON.stringify(params ?? {})}`,
			now: () => clock,
			minIntervalMs: options.minIntervalMs ?? 0,
			onError: (error) => errors.push(error),
		};

		return {
			rotator: createCacheRotator(deps),
			calls,
			notices,
			errors,
			plans,
			presentQueries,
			setNow: (value) => {
				clock = value;
			},
			/**
			 * 放行**所有**挂起的扫引用调用（见 `pendingScan` 的说明）。
			 *
			 * ⚠️ 用**数组**收集，而不是只留最后一个：万一并发标志失效（变异），
			 * 两轮会同时挂在这里，只释放最后一个会让另一轮永远挂着 ——
			 * 那时测试不是"断言失败"而是**卡死**（Node 事件循环一空就会带一句
			 * 语焉不详的退出码直接退出，变异运行器只看到一个说不出原因的退出码）。
			 */
			release: () => {
				const waiting = pendingScan;
				pendingScan = [];
				for (const resolve of waiting) resolve();
			},
		};
	}

	// 「超限」的公共场景：索引记 2 MB，上限 1 MB。
	// ⚠️ 副本放在**附件目录**里 —— 1.2.0 之后那才是常态，而且它照样计入（P7 的关闭依据）。
	const overLimit = {
		settings: settingsWith({ cacheLimitMb: 1 }),
		entries: [
			entryFor("big.png", { cachePath: "attachments/big.png", size: 2 * MB, lastUsedAt: NOW - 10 * HOUR }),
		],
	};

	// ============================================================
	// 3. ⭐ 没设上限 → 什么都不做（连索引都不读）
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, settings: settingsWith({ cacheLimitMb: 0 }) });
		assert.equal(await h.rotator.maybeRotate("startup"), null, "0 = 不限制 → 不跑");
		assert.equal(h.calls.index, 0, "★ 不限制时连索引都不该读（默认就是这个状态，不能有代价）");
		assert.equal(h.calls.scan, 0, "更不该扫笔记");
		assert.deepEqual(h.notices, [], "什么都不该提示");
	}

	// ============================================================
	// 4. ⭐ 门槛：索引字节没超 → 连笔记都不扫（这是「每次上传都跑」的成本所在）
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, entries: [entryFor("small.png", { size: 0.1 * MB })] });
		assert.equal(await h.rotator.maybeRotate("growth"), null, "索引没超 → 不跑");
		assert.equal(h.calls.index, 1, "门槛本身就是一次内存求和");
		assert.equal(h.calls.scan, 0, "★ 便宜的门槛挡住时**不该扫笔记**（读全库笔记是这条链上最贵的一步）");
		assert.equal(h.calls.evict, 0, "更不该动文件");
	}

	// 门槛与候选**同源**：过了门槛就一定有一份能算的总量（不再有"列目录量磁盘"那一步）
	{
		const h = makeHarness({ ...overLimit });
		const summary = await h.rotator.maybeRotate("growth");
		assert.ok(summary, "超限 → 真的跑一轮");
		assert.equal(summary.totalBytes, 2 * MB, "统计口径 = 索引里的字节之和（含附件目录里的副本）");
		assert.equal(h.calls.scan, 1, "真的超了才去扫笔记");
	}

	// ⭐ 索引与磁盘不一致（索引记的比磁盘小）时**不再被发现** —— 把取舍写下来
	{
		const h = makeHarness({
			...overLimit,
			entries: [entryFor("understated.png", { size: 0.1 * MB, lastUsedAt: NOW - 50 * HOUR })],
		});
		assert.equal(await h.rotator.maybeRotate("growth"), null, "索引说没超 → 不跑（不再去量磁盘对照）");
		assert.equal(h.calls.scan, 0, "连笔记都不扫");
		// ⚠️ 反过来（凭磁盘清单猜）会删到索引外的文件 —— 那可能是用户的附件。
		// 所以宁可偏保守：索引不全/记小了 ⇒ 上限晚一点生效。
	}

	// ============================================================
	// 5. 真的超了 → 淘汰并如实汇报
	// ============================================================
	{
		const h = makeHarness(overLimit);
		const summary = await h.rotator.maybeRotate("growth");

		assert.ok(summary, "超限时应真的跑一轮");
		assert.equal(summary.reason, "growth", "结果里要带上触发原因（排查时有用）");
		assert.equal(summary.evicted, 1, "淘汰了 1 份");
		assert.equal(summary.freed, 2 * MB, "回收 2 MB");
		assert.equal(summary.overBy, 0, "腾到上限以内了 → 不该报「仍超出」");
		assert.equal(h.calls.evict, 1, "执行层被调用一次");
		assert.deepEqual(h.presentQueries, ["attachments/big.png"], "候选要问一次「这份副本还在磁盘上吗」");
		assert.equal(h.notices.length, 1, "★ 真的淘汰了才提示，且只提示一次");
		assert.match(h.notices[0], /cacheEvicted /, `应用「已删除」那条文案（实际 ${h.notices[0]}）`);
		assert.match(h.notices[0], /2\.0/, "提示里要带上腾出了多少 MB");
	}

	// 仍然超出（例如执行时被跳过）→ 必须报出来，不能假装成功
	{
		const h = makeHarness({
			...overLimit,
			evictOutcome: { evicted: 1, freed: 0.5 * MB, skipped: [{ path: "x", reason: "云端确认不上" }] },
		});
		const summary = await h.rotator.maybeRotate("growth");
		assert.equal(summary.skipped, 1, "被跳过的要计数");
		assert.equal(summary.overBy, 0.5 * MB, "★ 「还超多少」要用**实际**回收量算，而不是计划里的数字");
		assert.match(h.notices[0], /cacheEvictedPartial /, "还超出时应换一条文案，把「仍超出」说出来");
	}

	// ============================================================
	// 6. ⭐ 全在宽限期内 → 不动手，也不打扰
	// ============================================================
	{
		const h = makeHarness({
			...overLimit,
			entries: [entryFor("fresh.png", { size: 2 * MB, lastUsedAt: NOW - 1 * MINUTE })],
		});
		const summary = await h.rotator.maybeRotate("growth");
		assert.ok(summary, "量过了，所以要给出结果（而不是含糊地返回 null）");
		assert.equal(summary.evicted, 0, "在宽限期内 → 一份都不淘汰");
		assert.equal(summary.overBy, 1 * MB, "★ 要如实报出「仍然超出多少」");
		assert.equal(h.calls.evict, 0, "没得淘汰时不该调执行层");
		assert.deepEqual(h.notices, [], "★ 什么都没删就不该提示（后台任务不该插嘴）");
	}

	// 索引里有、磁盘上没有 → 没有可删的东西，不调执行层
	{
		const h = makeHarness({ ...overLimit, present: () => false });
		const summary = await h.rotator.maybeRotate("growth");
		assert.equal(summary.evicted, 0, "文件不在磁盘上 → 没有可删的东西");
		assert.equal(h.calls.evict, 0, "候选为空时不该调执行层");
	}

	// ============================================================
	// 7. ⭐ 启动那一轮**也只看索引**（与旧实现相反的取舍）
	//
	// 旧实现让启动那轮绕过索引、直接量磁盘：那时"磁盘上有、索引里没有"的东西
	// 都在缓存目录里，删掉是安全的。现在索引外的文件可能是**用户的附件** ——
	// 一律不能自动删 ⇒ 索引不全时上限偏保守，而不是"凭磁盘清单猜"。
	// ============================================================
	{
		const h = makeHarness({ settings: settingsWith({ cacheLimitMb: 1 }), entries: [] });
		assert.equal(await h.rotator.maybeRotate("startup"), null, "★ 索引是空的时候，启动那一轮也什么都不做");
		assert.equal(h.calls.scan, 0, "连笔记都不扫");
		assert.equal(h.calls.evict, 0, "★ 绝不因为「磁盘上还有些文件」就去删 —— 那些可能是用户的附件");
	}

	// ============================================================
	// 8. 节流与并发
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, minIntervalMs: 5 * MINUTE });
		assert.ok(await h.rotator.maybeRotate("growth"), "第一轮该跑");
		assert.equal(h.calls.evict, 1, "跑了一轮");

		assert.equal(await h.rotator.maybeRotate("growth"), null, "★ 紧接着的第二轮要被节流挡住");
		assert.equal(h.calls.evict, 1, "★ 连粘多张图不该触发多轮淘汰");
		assert.equal(h.calls.scan, 1, "连扫笔记都不该再发生");

		h.setNow(NOW + 5 * MINUTE);
		assert.ok(await h.rotator.maybeRotate("interval"), "过了最短间隔 → 该跑");
		assert.equal(h.calls.evict, 2, "第二轮真的跑了");
	}

	{
		// 上一轮还挂在扫引用里 → 这一轮必须让路，而不是也去删同一批文件
		const h = makeHarness({ ...overLimit, scanHangs: true });
		const first = h.rotator.maybeRotate("growth");
		// 让第一轮走到扫引用之后
		await new Promise((resolve) => setTimeout(resolve, 0));

		// ⚠️ 这里**不能** `await` 第二轮再放行：万一并发标志失效，
		// 第二轮也会挂在扫引用上，而 `release()` 在 await 之后 —— 死锁，
		// 于是"测试失败"退化成了"进程卡死"（变异运行器只能看到一个退出码，说不出原因）。
		const second = h.rotator.maybeRotate("interval");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(h.calls.scan, 1, "★ 并发时只跑一轮（不能两轮同时删同一批文件）");

		h.release();
		assert.ok(await first, "第一轮照常完成");
		assert.equal(await second, null, "★ 已经有一轮在跑 → 这一轮让路");
	}

	// ============================================================
	// 9. 出错必须被吞住（后台任务不能把异常抛给调用方）
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, scanThrows: true });
		let thrown = null;
		let summary;
		try {
			summary = await h.rotator.maybeRotate("growth");
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown, null, "★ 后台任务的异常绝不能抛给调用方");
		assert.equal(summary, null, "出错时按「没跑」处理");
		assert.equal(h.errors.length, 1, "但必须留下记录（否则问题永远查不出来）");
	}

	// 提示失败（宿主界面出问题）不该把已经完成的淘汰结果吞掉
	{
		const h = makeHarness({ ...overLimit, notifyThrows: true });
		const summary = await h.rotator.maybeRotate("growth");
		assert.ok(summary, "★ 提示失败不该让结果丢失（文件已经删了，调用方必须知道）");
		assert.equal(summary.evicted, 1, "淘汰照样算数");
		assert.equal(h.errors.length, 1, "提示失败要被记录");
	}

	// 节流时间戳在出错后也要推进：否则出错会变成「每次事件都重试」的死循环
	{
		const h = makeHarness({ ...overLimit, scanThrows: true, minIntervalMs: 5 * MINUTE });
		await h.rotator.maybeRotate("growth");
		assert.equal(h.calls.scan, 1, "第一次尝试了");
		await h.rotator.maybeRotate("growth");
		assert.equal(h.calls.scan, 1, "★ 出错之后也要计入节流（否则一次失败会变成每个事件都重试）");
	}
}
