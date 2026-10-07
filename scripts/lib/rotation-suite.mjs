/**
 * 后台自动轮换的编排（`src/maintenance/rotation.ts`）断言套件。
 *
 * ## 这一层坏掉的方式是「白干活」或「该干不干」
 *
 * - 门槛失效 → 每次上传、每个周期都去列目录 + **读全库笔记**（在大库里就是卡顿）；
 * - 节流失效 → 连粘 20 张图触发 20 轮，每轮都量磁盘删文件；
 * - 并发标志写错 → 两轮同时删同一批文件，结果没法解释；
 * - 出错抛出去 → 后台任务把异常抛进插件的生命周期里（用户看到的是插件报错）。
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

function diskFor(path, bytes) {
	return { path, bytes };
}

export async function runRotationSuite(mod) {
	const { createCacheRotator, isRotationDue, DEFAULT_ROTATION_MIN_INTERVAL_MS } = mod;

	const settingsWith = (overrides = {}) => ({
		cacheFolder: "_attachment-cache",
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
		const calls = { collect: 0, scan: 0, evict: 0 };
		const notices = [];
		const errors = [];
		const plans = [];
		let clock = options.now ?? NOW;
		/**
		 * 让 `collectFiles` 能一直挂着（用来构造「上一轮还没跑完」的情形）。
		 *
		 * ⚠️ 用**数组**收集所有挂起的 resolve，而不是只留最后一个：
		 * 万一并发标志失效（变异），两轮会**同时**挂在这里，
		 * 而只释放最后一个会让另一轮永远挂着 —— 那时测试不是"断言失败"而是**卡死**
		 * （Node 事件循环一空就会带一句 unsettled top-level await 直接退出，
		 * 变异运行器只看到一个语焉不详的退出码）。让它老老实实断言失败要好得多。
		 */
		let pendingCollect = [];

		const deps = {
			settings: () => options.settings ?? settingsWith(),
			index: () => ({ toArray: () => options.entries ?? [] }),
			collectFiles: async () => {
				calls.collect += 1;
				if (options.collectThrows) throw new Error("列目录失败");
				if (options.collectHangs) {
					await new Promise((resolve) => {
						pendingCollect.push(resolve);
					});
				}
				return options.files ?? [];
			},
			scanReferencedKeys: async () => {
				calls.scan += 1;
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
			setNow: (value) => {
				clock = value;
			},
			/** 放行**所有**挂起的列目录调用（见 `pendingCollect` 的说明）。 */
			release: () => {
				const waiting = pendingCollect;
				pendingCollect = [];
				for (const resolve of waiting) resolve();
			},
		};
	}

	// 一个「超限」的公共场景：索引记 2 MB，磁盘上也是 2 MB，上限 1 MB
	const overLimit = {
		settings: settingsWith({ cacheLimitMb: 1 }),
		entries: [entryFor("big.png", { size: 2 * MB, lastUsedAt: NOW - 10 * HOUR })],
		files: [diskFor("_attachment-cache/big.png", 2 * MB)],
	};

	// ============================================================
	// 3. ⭐ 没设上限 → 什么都不做（连索引都不读）
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, settings: settingsWith({ cacheLimitMb: 0 }) });
		assert.equal(await h.rotator.maybeRotate("startup"), null, "0 = 不限制 → 不跑");
		assert.equal(h.calls.collect, 0, "★ 不限制时连磁盘都不该碰（默认就是状态，不能有代价）");
		assert.equal(h.calls.scan, 0, "更不该扫笔记");
		assert.deepEqual(h.notices, [], "什么都不该提示");
	}

	// ============================================================
	// 4. ⭐ 门槛 ①：索引字节没超 → 不列目录（这是「每次上传都跑」的成本所在）
	// ============================================================
	{
		const h = makeHarness({
			...overLimit,
			entries: [entryFor("small.png", { size: 0.1 * MB })],
			files: [diskFor("_attachment-cache/small.png", 0.1 * MB)],
		});
		assert.equal(await h.rotator.maybeRotate("growth"), null, "索引没超 → 不跑");
		assert.equal(h.calls.collect, 0, "★ 便宜的门槛挡住时**不该列目录**（这是每次上传都会走的路径）");
		assert.equal(h.calls.scan, 0, "也不该扫笔记");
	}

	// ============================================================
	// 5. ⭐ 门槛 ②：磁盘上没超 → 不扫笔记（最贵的一步）
	// ============================================================
	// 约定：`null` 只表示「根本没去量」（没设上限 / 被便宜门槛挡住 / 被节流 / 并发 / 出错）；
	// 一旦量过磁盘，就给出一份结果 —— 哪怕是「没超、什么都没做」，
	// 因为"量到的真实占用"本身就是排查时要看的东西。
	{
		const h = makeHarness({
			...overLimit,
			// 索引记的比上限大（触发了门槛①），但磁盘上其实只有一点点
			entries: [entryFor("stale.png", { size: 5 * MB })],
			files: [diskFor("_attachment-cache/stale.png", 200 * 1024)],
		});
		const summary = await h.rotator.maybeRotate("growth");
		assert.ok(summary, "量过磁盘了 → 要给出结果（`null` 只表示「根本没去量」）");
		assert.equal(summary.totalBytes, 200 * 1024, "结果里带上量到的**真实**占用");
		assert.equal(summary.evicted, 0, "磁盘上没超 → 一份都不淘汰");
		assert.equal(h.calls.collect, 1, "这一层要量磁盘才知道到底超没超");
		assert.equal(h.calls.scan, 0, "★ 磁盘也没超时**不该扫笔记**（读全库笔记是这条链上最贵的一步）");
		assert.equal(h.calls.evict, 0, "更不该动文件");
		assert.deepEqual(h.notices, [], "什么都没删 → 不提示");
	}

	// ============================================================
	// 6. 真的超了 → 淘汰并如实汇报
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
		assert.equal(h.notices.length, 1, "★ 真的淘汰了才提示，且只提示一次");
		assert.match(h.notices[0], /cacheEvicted /, `应用「已腾出」那条文案（实际 ${h.notices[0]}）`);
		assert.match(h.notices[0], /2\.0/, "提示里要带上腾出了多少 MB");
	}

	// 仍然超出（例如执行时被跳过）→ 必须报出来，不能假装成功
	{
		const h = makeHarness({
			...overLimit,
			evictOutcome: { evicted: 1, freed: 0.5 * MB, skipped: [{ path: "x", reason: "宿主的索引滞后" }] },
		});
		const summary = await h.rotator.maybeRotate("growth");
		assert.equal(summary.skipped, 1, "被跳过的要计数");
		assert.equal(summary.overBy, 0.5 * MB, "★ 「还超多少」要用**实际**回收量算，而不是计划里的数字");
		assert.match(h.notices[0], /cacheEvictedPartial /, "还超出时应换一条文案，把「仍超出」说出来");
	}

	// ============================================================
	// 7. ⭐ 全在宽限期内 → 不动手，也不打扰
	// ============================================================
	{
		const h = makeHarness({
			...overLimit,
			entries: [entryFor("fresh.png", { size: 2 * MB, lastUsedAt: NOW - 1 * MINUTE })],
			files: [diskFor("_attachment-cache/fresh.png", 2 * MB)],
		});
		const summary = await h.rotator.maybeRotate("growth");
		assert.ok(summary, "量过了，所以要给出结果（而不是含糊地返回 null）");
		assert.equal(summary.evicted, 0, "在宽限期内 → 一份都不淘汰");
		assert.equal(summary.overBy, 1 * MB, "★ 要如实报出「仍然超出多少」");
		assert.equal(h.calls.evict, 0, "没得淘汰时不该调执行层");
		assert.deepEqual(h.notices, [], "★ 什么都没删就不该提示（后台任务不该插嘴）");
	}

	// ============================================================
	// 8. ⭐ 启动那一轮不看索引（索引坏掉时上限不能形同虚设）
	// ============================================================
	{
		// 索引是空的（`loadCacheIndex` 遇到坏 JSON 就是这样），但缓存目录里有一堆文件
		const h = makeHarness({
			settings: settingsWith({ cacheLimitMb: 1 }),
			entries: [],
			files: [diskFor("_attachment-cache/orphan.png", 2 * MB)],
		});
		const summary = await h.rotator.maybeRotate("startup");
		assert.ok(summary, "★ 启动时必须去量磁盘 —— 索引空不等于缓存是空的");
		assert.equal(h.calls.collect, 1, "启动那一轮要列目录");
		assert.equal(summary.evicted, 1, "★ 孤儿也要被淘汰（它们一样占着用户的磁盘）");
		assert.equal(h.plans[0].evict[0].key, "", "挑中的是孤儿（没有 key）");
	}

	// 反过来：同一份数据用 growth 触发，会被门槛①挡住 → 这正是那个刻意的取舍
	{
		const h = makeHarness({
			settings: settingsWith({ cacheLimitMb: 1 }),
			entries: [],
			files: [diskFor("_attachment-cache/orphan.png", 2 * MB)],
		});
		assert.equal(await h.rotator.maybeRotate("growth"), null, "非启动触发会被便宜的门槛挡住（索引记 0 字节）");
		assert.equal(h.calls.collect, 0, "因此不列目录 —— 这是刻意的取舍：那类情况由启动那一轮兜住");
	}

	// ============================================================
	// 9. 节流与并发
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, minIntervalMs: 5 * MINUTE });
		assert.ok(await h.rotator.maybeRotate("growth"), "第一轮该跑");
		assert.equal(h.calls.evict, 1, "跑了一轮");

		assert.equal(await h.rotator.maybeRotate("growth"), null, "★ 紧接着的第二轮要被节流挡住");
		assert.equal(h.calls.evict, 1, "★ 连粘多张图不该触发多轮淘汰");
		assert.equal(h.calls.collect, 1, "连节点目录都不该再发生");

		h.setNow(NOW + 5 * MINUTE);
		assert.ok(await h.rotator.maybeRotate("interval"), "过了最短间隔 → 该跑");
		assert.equal(h.calls.evict, 2, "第二轮真的跑了");
	}

	{
		// 上一轮还挂在 collectFiles 里 → 这一轮必须让路，而不是也去删同一批文件
		const h = makeHarness({ ...overLimit, collectHangs: true });
		const first = h.rotator.maybeRotate("growth");
		// 让第一轮走到 collectFiles 之后
		await new Promise((resolve) => setTimeout(resolve, 0));

		// ⚠️ 这里**不能** `await` 第二轮再放行：万一并发标志失效，
		// 第二轮也会挂在 collectFiles 上，而 `release()` 在 await 之后 —— 死锁，
		// 于是"测试失败"退化成了"进程卡死"（变异运行器只能看到一个退出码，说不出原因）。
		// 所以先拿到 promise、给它机会去抢跑、断言、再放行。
		const second = h.rotator.maybeRotate("interval");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(h.calls.collect, 1, "★ 并发时只跑一轮（不能两轮同时删同一批文件）");

		h.release();
		assert.ok(await first, "第一轮照常完成");
		assert.equal(await second, null, "★ 已经有一轮在跑 → 这一轮让路");
	}

	// ============================================================
	// 10. 出错必须被吞住（后台任务不能把异常抛给调用方）
	// ============================================================
	{
		const h = makeHarness({ ...overLimit, collectThrows: true });
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
		const h = makeHarness({ ...overLimit, collectThrows: true, minIntervalMs: 5 * MINUTE });
		await h.rotator.maybeRotate("growth");
		assert.equal(h.calls.collect, 1, "第一次尝试了");
		await h.rotator.maybeRotate("growth");
		assert.equal(h.calls.collect, 1, "★ 出错之后也要计入节流（否则一次失败会变成每个事件都重试）");
	}
}
