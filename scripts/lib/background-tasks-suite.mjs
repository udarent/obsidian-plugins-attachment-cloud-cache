/**
 * 后台任务（`src/plugin/background-tasks.ts`）的断言套件。
 *
 * ## 这套断言守的是什么
 *
 * 这个模块的**全部价值**是一条不变量：**"排上的每一条定时器，都会在卸载时被取消"**。
 * 在它之前，那条不变量靠 `onunload` 里手写的四行 `clearTimeout` / `clearInterval` ——
 * 而漏掉一行的后果是具体的：插件卸载后（热重载、切库）那个定时器还会跑，
 * 去改用户的笔记、或弹一个"要不要删云端"。那种缺陷**不报错、只在卸载后发生**，
 * 靠人读 `onload` 三遍是防不住的。
 *
 * 所以断言直接钉在"可数"上：表里有几条 → 就该排上几条 → 就该登记几条取消 → `dispose` 就该取消几条。
 *
 * ## ⚠️ 替身的做法
 *
 * `host-globals.mjs` 把 `window` 指向 `globalThis`，于是 `window.setTimeout` 就是 Node 的。
 * 这套断言**临时替换** `globalThis` 上的四个定时器 API 成"记账版"，
 * 跑完在 `finally` 里还原 —— 因为被测代码本来就调 `window.*`（lint 强制），
 * 换掉它等于换掉"宿主提供的那一层"，而不是给代码开后门。
 *
 * ⚠️ 另一条纪律：**不真的等时间**。这一层只关心"排了没、消了没"，所以回调不执行。
 *
 * 断言在这里（与变异验证共用），入口在 `scripts/test-background-tasks.mjs`。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 轮换的**四个**触发点（写死在这里是刻意的）。
 *
 * 它们与 `RotationReason` 是同一组值，但这里**不 import 那个类型** ——
 * 断言要能在"有人加了第五个触发点却没说谁触发它"时变红，而不是自动跟着一起变绿。
 */
const ALL_ROTATION_REASONS = ["startup", "growth", "settings", "interval"];

/** 装满记账版的定时器，返回 `{ calls, restore }`。 */
function withFakeTimers(fn) {
	const original = {
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
		setInterval: globalThis.setInterval,
		clearInterval: globalThis.clearInterval,
	};
	const calls = { scheduled: [], cleared: [], nextId: 1 };
	globalThis.setTimeout = (handler, delay) => {
		const id = calls.nextId++;
		calls.scheduled.push({ id, kind: "timeout", delay, handler });
		return id;
	};
	globalThis.setInterval = (handler, delay) => {
		const id = calls.nextId++;
		calls.scheduled.push({ id, kind: "interval", delay, handler });
		return id;
	};
	globalThis.clearTimeout = (id) => calls.cleared.push({ id, kind: "timeout" });
	globalThis.clearInterval = (id) => calls.cleared.push({ id, kind: "interval" });
	try {
		return fn(calls);
	} finally {
		Object.assign(globalThis, original);
	}
}

export function runBackgroundTasksSuite(mod) {
	const { backgroundTaskList, startBackgroundTasks, ROTATION_TRIGGER_MATRIX } = mod;

	/** 两个假的 deps：只记账，不做任何事。 */
	function makeDeps() {
		const seen = [];
		return {
			seen,
			deps: {
				rotate: (reason) => seen.push(`rotate:${reason}`),
				selfHeal: () => seen.push("selfHeal"),
			},
		};
	}

	// ============================================================
	// 1. ⭐ 表里的每条都真的被排上（顺序一致），且用对了 API
	// ============================================================
	{
		const { deps } = makeDeps();
		withFakeTimers((calls) => {
			const cleanups = [];
			const tasks = startBackgroundTasks(deps, (cleanup) => cleanups.push(cleanup));

			const expected = backgroundTaskList(deps);
			assert.deepEqual(
				tasks.started,
				expected.map((task) => task.id),
				"表里有几条就该起几条，顺序也要一致（顺序变了说明启动路径分叉了）"
			);
			assert.equal(calls.scheduled.length, expected.length, "排上的定时器数 = 表里的任务数");

			for (const task of expected) {
				const scheduled = calls.scheduled.find((item) => item.delay === task.everyMs && item.kind === task.kind);
				assert.ok(
					scheduled,
					`任务 ${task.id} 没有对应的定时器（期望 ${task.kind} / ${task.everyMs}ms）`
				);
			}
			assert.equal(
				calls.scheduled.filter((item) => item.kind === "interval").length,
				2,
				"周期线是两条（轮换 + 自愈）"
			);
			assert.equal(
				cleanups.length,
				expected.length,
				"★ 每条都要登记取消 —— 否则它在插件卸载后还会跑"
			);
		});
	}

	// ============================================================
	// 2. ⭐⭐ `dispose` 把**每一条**都取消（漏一条就红）
	//
	// 这是这个模块存在的全部理由。取消的方式还必须与排的方式配对：
	// 用 `clearTimeout` 去取消一个 interval 是不生效的（而且不报错）。
	// ============================================================
	{
		const { deps } = makeDeps();
		withFakeTimers((calls) => {
			const tasks = startBackgroundTasks(deps, () => {});
			tasks.dispose();

			const scheduled = calls.scheduled;
			assert.equal(calls.cleared.length, scheduled.length, "★★ 排上几条就该取消几条（漏一条就是卸载后还会跑）");
			for (const item of scheduled) {
				const cleared = calls.cleared.find((entry) => entry.id === item.id);
				assert.ok(cleared, `定时器 ${item.id}（${item.kind}）没有被取消`);
				assert.equal(cleared.kind, item.kind, "★ 取消的 API 必须与排的配对（拿 clearTimeout 消 interval 不生效）");
			}
		});
	}

	// ============================================================
	// 3. 卸载走的是 `register` 登记的那些回调（不是 `onunload` 里手写）
	// ============================================================
	{
		const { deps } = makeDeps();
		withFakeTimers((calls) => {
			const cleanups = [];
			startBackgroundTasks(deps, (cleanup) => cleanups.push(cleanup));
			assert.equal(cleanups.length, calls.scheduled.length, "登记数应等于排上的定时器数");

			for (const cleanup of cleanups) cleanup();
			assert.equal(calls.cleared.length, calls.scheduled.length, "逐条取消之后应当一条不剩");
		});
	}

	// ============================================================
	// 4. 取消是幂等的（`dispose` 与逐条取消可能都发生）
	// ============================================================
	{
		const { deps } = makeDeps();
		withFakeTimers((calls) => {
			const cleanups = [];
			const tasks = startBackgroundTasks(deps, (cleanup) => cleanups.push(cleanup));
			tasks.dispose();
			tasks.dispose();
			for (const cleanup of cleanups) cleanup();
			assert.equal(calls.cleared.length, calls.scheduled.length, "重复取消不该多清（每条只清一次）");
		});
	}

	// ============================================================
	// 5. 回调真的调到注入的 deps（触发点没接错）
	// ============================================================
	{
		const { deps, seen } = makeDeps();
		withFakeTimers((calls) => {
			startBackgroundTasks(deps, () => {});
			// 手动执行每条回调（这一层只测"接对了没有"，不测节流/门槛 —— 那是各自的套件）
			for (const item of calls.scheduled) item.handler();
			assert.deepEqual(
				[...seen].sort(),
				["rotate:interval", "rotate:startup", "selfHeal", "selfHeal"].sort(),
				"四条定时器应当分别打到轮换（startup / interval）与自愈（两次）"
			);
		});
	}

	// ============================================================
	// 6. ⭐ 触发点矩阵：四个触发点都要说清"谁触发、在哪"
	//
	// P8 / N11 那种缺陷的形状是"某个触发点整条线没接上" —— 而它不报错。
	// 这张表把"一共有几个触发点、各自谁来按"变成可读、可数；下面这条断言保证
	// **不会有人加了第五个触发点而不说谁来触发它**。
	// ============================================================
	{
		const reasons = ROTATION_TRIGGER_MATRIX.map((row) => row.reason);
		assert.equal(reasons.length, ALL_ROTATION_REASONS.length, "触发点个数变了 ⇒ 先更新那张矩阵（并想清楚谁触发它）");
		for (const reason of ALL_ROTATION_REASONS) {
			assert.ok(reasons.includes(reason), `★★ 触发点 ${reason} 在矩阵里没有交代（谁触发它？）`);
		}
		for (const row of ROTATION_TRIGGER_MATRIX) {
			assert.ok(row.by && row.by.length > 0, `触发点 ${row.reason} 必须写明"谁按的"`);
		}

		// 矩阵里标着"就在本模块"的那两条，必须真的能在任务表里找到
		const { deps } = makeDeps();
		const ids = backgroundTaskList(deps).map((task) => task.id);
		const here = ROTATION_TRIGGER_MATRIX.filter((row) => row.where === null).map((row) => row.reason);
		assert.deepEqual(here.sort(), ["interval", "startup"], "标着「本模块触发」的应当正好是两条定时线");
		for (const reason of here) {
			assert.ok(ids.includes(`rotation-${reason}`), `矩阵说 ${reason} 在本模块，但任务表里没有 rotation-${reason}`);
		}
	}

	// ============================================================
	// 7. 间隔与文档里的常量一致（改了间隔要同时改文档与断言 —— 这就是那条"文档"）
	// ============================================================
	{
		const { deps } = makeDeps();
		const byId = new Map(backgroundTaskList(deps).map((task) => [task.id, task]));
		assert.equal(byId.get("rotation-startup").everyMs, mod.ROTATION_STARTUP_DELAY_MS);
		assert.equal(byId.get("rotation-interval").everyMs, mod.ROTATION_CHECK_INTERVAL_MS);
		assert.equal(byId.get("self-heal-startup").everyMs, mod.SELF_HEAL_STARTUP_DELAY_MS);
		assert.equal(byId.get("self-heal-interval").everyMs, mod.SELF_HEAL_CHECK_INTERVAL_MS);
		// ⚠️ 自愈那一条**必须晚于**轮换的启动检查：启动后那几百毫秒里还有索引加载、
		// 渲染钩子挂载、引用快照建立要做完，自愈不该抢同一段窗口（改动这一点要先想清楚）。
		assert.ok(
			byId.get("self-heal-startup").everyMs > byId.get("rotation-startup").everyMs,
			"自愈的启动延迟必须晚于轮换那一轮"
		);
		// 每条都要有"为什么是这个触发点"
		for (const task of byId.values()) {
			assert.ok(task.why && task.why.length > 0, `任务 ${task.id} 必须写明它为什么存在`);
		}
	}

	// ============================================================
	// 8. ⭐ 静态守卫：**入口里不许再有周期定时器**
	//
	// 这一层是可数性的来源：只要 `main.ts` 里还能随手写 `setInterval`，
	// "所有定时器都在一张表里"就只是**当前的样子**，而不是一条规矩。
	//
	// ⚠️ 只禁 `setInterval`（"后台任务"的形状）。`setTimeout` 在入口里还有正当用途
	// （例如把一轮异步让出成两段），禁掉它会逼着以后的人绕路。
	// ⚠️ 同时钉"接线还在"：光禁不接，等于把那条链整条删掉而没人发现。
	// ============================================================
	{
		const mainSource = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
		assert.ok(
			!mainSource.includes("window.setInterval"),
			"★★ 入口里不许再排周期定时器 —— 它们属于 plugin/background-tasks.ts 的那张表"
		);
		assert.ok(
			mainSource.includes("startBackgroundTasks("),
			"★ 入口必须真的把那张表启动起来（禁掉 setInterval 却忘了接线 = 整个后台兜底消失）"
		);
	}

	return { cases: 8 };
}
