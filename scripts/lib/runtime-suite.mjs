/**
 * 运行时装配（`src/host/runtime.ts`）的断言套件。
 *
 * 这里只测两件在别处测不到的东西：
 *
 * 1. **`makeSerializer`**：索引落盘必须串行（两次并发写会共用同一个临时文件名，
 *    落盘结果可能是半截或错版内容）；
 * 2. **`IndexStore.touch` 的防抖落盘**：它跑在渲染热路径上，只改内存，
 *    真正的写盘是"攒一会儿再来一次"。这套逻辑错掉是**静默**的 ——
 *    要么永远不落盘（重启后"最近使用时间"全丢，轮换退化成按上传时间排），
 *    要么每次都落盘（渲染时持续写盘）。所以用注入的调度器把它钉住。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppMock } from "./mock-obsidian.mjs";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const PLUGIN_DIR = ".obsidian/plugins/acc";

export async function runRuntimeSuite(mod) {
	const { createIndexStore, makeSerializer, DEFAULT_USAGE_FLUSH_DELAY_MS } = mod;
	const { CacheIndex } = mod;

	// ============================================================
	// 1. makeSerializer：串行、失败不堵队、各自拿到自己的结果
	// ============================================================
	{
		const serialize = makeSerializer();
		const order = [];
		const first = serialize(async () => {
			order.push("a开始");
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push("a结束");
			return "a";
		});
		const second = serialize(async () => {
			order.push("b开始");
			order.push("b结束");
			return "b";
		});

		assert.deepEqual(await Promise.all([first, second]), ["a", "b"], "每个任务都要拿到自己的结果");
		assert.deepEqual(order, ["a开始", "a结束", "b开始", "b结束"], "★ 必须严格串行（并发写同一个临时文件会写出半截内容）");
	}
	{
		// 前一个失败不能让后面那个永远排队 —— 否则一次偶发失败就永久堵死索引落盘
		const serialize = makeSerializer();
		const failing = serialize(async () => {
			throw new Error("磁盘满");
		});
		await assert.rejects(failing, /磁盘满/, "失败要如实抛给调用方");

		const after = serialize(async () => "ok");
		// ⚠️ 这里**不能直接 `await after`**：若队列被堵死，那个 promise 要么永远不 settle，
		// 要么直接继承前一个的失败 —— 前者会让"测试失败"退化成**进程卡死**
		//（Node 事件循环一空就带一句 unsettled top-level await 直接退出，
		// 变异运行器只看到一个退出码，说不出原因）。所以两个出口都接住，逐条断言。
		const settled = await Promise.race([
			after.then(
				(value) => ({ value }),
				(error) => ({ error })
			),
			new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 100)),
		]);
		assert.equal(settled.timedOut, undefined, "★ 前一个失败之后，后一个必须照常执行（否则队列被永久堵死）");
		assert.equal(
			settled.error,
			undefined,
			"★ 后一个任务不该继承前一个的失败 —— 队尾没吞掉失败就会把它一路堵死"
		);
		assert.equal(settled.value, "ok", "结果要正常返回");
	}

	// ============================================================
	// 2. IndexStore：读取 / 落盘 / touch 的防抖
	// ============================================================
	const root = await mkdtemp(join(tmpdir(), "acc-runtime-"));
	try {
		const harness = createAppMock(root);
		const app = harness.app;
		const indexPath = `${PLUGIN_DIR}/.cache-index.json`;

		/** 造一个 store，并拿到"被排队的落盘任务"（可以手动触发）。 */
		function makeStore(options = {}) {
			const scheduled = [];
			let clock = options.now ?? NOW;
			const errors = [];
			const store = createIndexStore(app, PLUGIN_DIR, "acc", () => new CacheIndex(), {
				now: () => clock,
				// ⚠️ 注入调度器：不注入的话这段逻辑只能靠"真等一分钟"来验，
				// 那既慢又没法断言"到底排了几次"。
				defer: (task, ms) => {
					scheduled.push({ task, ms });
					let cancelled = false;
					return () => {
						cancelled = true;
					};
				},
				onError: (error) => errors.push(error),
			});
			return {
				store,
				scheduled,
				errors,
				setNow: (value) => {
					clock = value;
				},
				/** 跑掉最新排队的那个任务（模拟"防抖时间到了"）。 */
				async runScheduled() {
					const entry = scheduled[scheduled.length - 1];
					assert.ok(entry, "应当有排队的落盘任务");
					// 任务返回的就是那次落盘 —— await 它，"写完了"才是确定的
					await entry.task();
					return entry;
				},
			};
		}

		const entryFor = (key, lastUsedAt = 0) => ({
			key,
			cachePath: `_attachment-cache/${key}`,
			remoteUrl: `https://img.example.com/${key}`,
			size: 10,
			contentType: "image/png",
			etag: "e",
			uploadedAt: new Date(NOW - 24 * HOUR).toISOString(),
			lastUsedAt,
			sourceName: key,
		});

		// --- 首次加载：文件不存在是正常状态 ---
		const h = makeStore();
		const loaded = await h.store.load();
		assert.equal(loaded.existed, false, "首次加载应报「文件不存在」");
		assert.equal(h.store.index.size, 0, "首次加载为空索引");

		// --- 落盘 / 读回 ---
		h.store.index.set(entryFor("a.png"));
		await h.store.save();
		const raw = JSON.parse(await readFile(join(root, indexPath), "utf8"));
		assert.equal(raw.entries.length, 1, "save() 应把条目写到磁盘上");

		const h2 = makeStore();
		const reloaded = await h2.store.load();
		assert.equal(reloaded.existed, true, "写过之后应报「文件存在」");
		assert.equal(h2.store.index.get("a.png")?.key, "a.png", "应能读回");

		// --- touch：只改内存，排一次防抖落盘 ---
		assert.equal(h2.store.index.get("a.png").lastUsedAt, 0, "初始没有使用时间");
		assert.equal(h2.store.touch("a.png"), true, "★ touch 应更新并返回 true");
		assert.equal(h2.store.index.get("a.png").lastUsedAt, NOW, "内存里立刻生效（渲染路径不能等落盘）");
		assert.equal(h2.scheduled.length, 1, "★ 排了一次防抖落盘");
		assert.equal(
			h2.scheduled[0].ms,
			DEFAULT_USAGE_FLUSH_DELAY_MS,
			"用的是默认延迟（攒一会儿再写）"
		);

		// ⭐ 同一屏几十张图 → 只排一次（否则渲染热路径会持续写盘）
		h2.setNow(NOW + HOUR);
		assert.equal(h2.store.touch("a.png"), true, "过了节流间隔 → 再更新一次");
		assert.equal(h2.scheduled.length, 1, "★ 已经排过一次就复用，不重复排队（一屏图只写一次盘）");

		const queued = await h2.runScheduled();
		assert.equal(queued.ms, DEFAULT_USAGE_FLUSH_DELAY_MS, "延迟来自配置");
		const written = JSON.parse(await readFile(join(root, indexPath), "utf8"));
		assert.equal(
			written.entries[0].lastUsedAt,
			NOW + HOUR,
			"★ 防抖任务真的把「最近使用时间」写到磁盘上了（否则重启后轮换会退化成按上传时间排）"
		);

		// --- 不认识的 key：不更新、不排队 ---
		const before = h2.scheduled.length;
		assert.equal(h2.store.touch("不存在.png"), false, "索引里没有的 key 不该被 touch 到");
		assert.equal(h2.scheduled.length, before, "★ 没更新就不该排队（否则白写一次盘）");
		assert.equal(h2.store.index.size, 1, "不该凭空造出一条记录");

		// --- 节流：同一小时内不动 ---
		h2.setNow(NOW + HOUR + 30 * 60 * 1000);
		const mid = h2.store.index.get("a.png").lastUsedAt;
		assert.equal(h2.store.touch("a.png"), false, "同一小时内不该重复更新");
		assert.equal(h2.store.index.get("a.png").lastUsedAt, mid, "被节流时值不变");

		// --- save() 会取消排队中的那次防抖落盘（否则紧接着重复写一遍）---
		h2.setNow(NOW + 3 * HOUR);
		assert.equal(h2.store.touch("a.png"), true, "过了间隔 → 更新");
		assert.equal(h2.scheduled.length, before + 1, "又排了一次");
		await h2.store.save();
		const afterSave = JSON.parse(await readFile(join(root, indexPath), "utf8"));
		assert.equal(afterSave.entries[0].lastUsedAt, NOW + 3 * HOUR, "save() 写的是最新的值");

		// --- 落盘失败要被记录下来，而不是抛给渲染路径 ---
		{
			const h3 = makeStore();
			h3.store.index.set(entryFor("b.png"));
			// 让写盘失败：把适配器换成会抛错的
			const originalWrite = app.vault.adapter.write;
			app.vault.adapter.write = async () => {
				throw new Error("EACCES: 只读");
			};
			try {
				h3.store.touch("b.png");
				let thrown = null;
				try {
					await h3.runScheduled();
				} catch (error) {
					thrown = error;
				}
				assert.equal(thrown, null, "★ 防抖落盘失败不能抛出去（它由渲染触发）");
				assert.equal(h3.errors.length, 1, "但要记录下来（否则「为什么时间没记住」永远查不出来）");
			} finally {
				app.vault.adapter.write = originalWrite;
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
	}

	return { ok: true };
}
