/**
 * 「整批一次写云端声明 ＋ 有限并发」的编排层套件（`src/maintenance/run.ts::runBatchUpload`）。
 *
 * 为什么单独一份：`load-acceptance` 那条完整链只测得到「接线通了」，
 * 而这里守的是**失败方向**——批量声明写不成时必须退回逐文件声明，
 * 否则对象会「传上去了却没有引用保护」（D-86 最警惕的那一侧）；
 * 以及 R14 重评的三条：失败可定位、逐项进度、并发有上限。
 *
 * `ingest` 用替身：默认返回空 `remoteUrl`，于是 `rules` 为空、改写循环整个跳过，
 * 这一份只盯「阶段一攒引用 → 整批声明 → 循环里传集合 → 并发/提交」这一段编排。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppMock } from "./mock-obsidian.mjs";

const ALL_PATHS = "abcdefgh".split("").map((c) => `attachments/${c}.png`);
const DEFAULT_COUNT = 3;
const bytesFor = (i) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, i + 1]);
const hashByName = (name) => `hash-${String(name).replace(/\.png$/, "")}`;

const emptyResult = () => ({
	status: "uploaded",
	key: "",
	ext: "png",
	name: "",
	displayName: "",
	remoteUrl: "",
	localPath: "",
	etag: "",
});

let sharedRoot = null;

/** 每个场景都重建一遍文件（上一轮吃过「用例之间靠共享状态传递」的苦）。 */
async function resetRoot(omit = -1, count = DEFAULT_COUNT) {
	if (sharedRoot === null) {
		sharedRoot = await mkdtemp(join(tmpdir(), "acc-batch-decl-"));
		process.once("exit", () => {
			try {
				rmSync(sharedRoot, { recursive: true, force: true });
			} catch {
				/* 尽力而为：它本来就在系统临时目录里 */
			}
		});
	}
	for (const name of await readdir(sharedRoot).catch(() => [])) {
		await rm(join(sharedRoot, name), { recursive: true, force: true });
	}
	await mkdir(join(sharedRoot, "attachments"), { recursive: true });
	for (let i = 0; i < count; i += 1) {
		if (i === omit) continue;
		await writeFile(join(sharedRoot, ALL_PATHS[i]), Buffer.from(bytesFor(i)));
	}
	return sharedRoot;
}

async function makeHarness(mod, options = {}) {
	const paths = ALL_PATHS.slice(0, options.count ?? DEFAULT_COUNT);
	const root = await resetRoot(options.omit, paths.length);
	const mock = createAppMock(root);
	await mock.refreshPathCache();

	const ingestCalls = [];
	const batchCalls = [];
	const planRef = options.planRef ?? (async (_bytes, request) => ({ hash: hashByName(request.name), name: request.name, ext: "png" }));
	const ingestImpl = options.ingest ?? (async () => emptyResult());
	const deps = {
		app: mock.app,
		settings: () => mod.SETTINGS_DEFAULTS,
		index: () => new mod.CacheIndex(),
		persistIndex: async () => {},
		ingest: async (request) => {
			ingestCalls.push(request);
			return ingestImpl(request);
		},
		referencedPaths: async () => new Set(paths),
		...(options.noPlan ? {} : { planAttachmentRef: planRef }),
		...(options.noBatch ? {} : { declareRefBatch: async (refs) => { batchCalls.push(refs); return options.batchFails === true ? false : true; } }),
	};
	return {
		deps,
		ingestCalls,
		batchCalls,
		paths,
		run: () => mod.runBatchUpload(deps, {
			referencedPaths: new Set(paths),
			repairablePaths: new Set(),
			...(options.onItem ? { onItem: options.onItem } : {}),
		}),
	};
}

/** 记录并发生程度的替身：进来 +1、出去 -1，留峰值。 */
function inflightProbe(delayMs = 5) {
	const probe = { peak: 0, inflight: 0 };
	probe.ingest = async () => {
		probe.inflight += 1;
		probe.peak = Math.max(probe.peak, probe.inflight);
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		probe.inflight -= 1;
		return emptyResult();
	};
	return probe;
}

export async function runBatchDeclarationSuite(mod) {
	// 1. 整批声明成功：一次调用装全部候选，每个 ingest 都收到集合
	{
		const h = await makeHarness(mod);
		await h.run();
		assert.equal(h.batchCalls.length, 1, "★ 整批声明只该调一次");
		assert.equal(h.batchCalls[0].length, 3, "★ 整批声明要装进全部候选");
		assert.equal(h.ingestCalls.length, 3, "★ 三份文件都要照常处理");
		assert.ok(
			h.ingestCalls.every((call) => call.declaredHashes?.has(hashByName(call.name))),
			"★★ 每个 ingest 都要收到含自己哈希的已声明集合"
		);
	}

	// 2. ⭐⭐ 批量声明失败 ⇒ 一个集合都不许传（退回逐文件，不放大失败面）
	{
		const h = await makeHarness(mod, { batchFails: true });
		await h.run();
		assert.equal(h.batchCalls.length, 1, "★ 失败也要先试过整批");
		assert.equal(h.ingestCalls.length, 3, "★ 声明没写成，上传照常（不是整批不传）");
		assert.ok(
			h.ingestCalls.every((call) => call.declaredHashes === undefined),
			"★★ 批量声明失败必须退回逐文件声明"
		);
	}

	// 3. 没有注入（老宿主 / 单文件入口）⇒ 与改动前一字不差
	{
		const h = await makeHarness(mod, { noPlan: true, noBatch: true });
		await h.run();
		assert.equal(h.batchCalls.length, 0, "★ 没注入时一次整批声明都不该发");
		assert.equal(h.ingestCalls.length, 3, "★ 没注入时上传照常");
		assert.ok(
			h.ingestCalls.every((call) => call.declaredHashes === undefined),
			"★ 没注入时退回逐文件声明"
		);
	}

	// 4. 同内容的多份候选只登记一条（声明本来按 hash 索引）
	{
		const h = await makeHarness(mod, { planRef: async () => ({ hash: "same-hash", name: "x.png", ext: "png" }) });
		await h.run();
		assert.equal(h.batchCalls.length, 1, "★ 去重后仍要写一次声明");
		assert.equal(h.batchCalls[0].length, 1, "★ 同内容只登记一条");
	}

	// 5. 阶段一有一份读不动 ⇒ 它不进集合，其它两份照常
	{
		// `omit` 的文件仍在宿主路径缓存里（刚扫过盘），但 `readBinary` 会抛
		const h = await makeHarness(mod, { omit: 2 });
		await h.run();
		assert.equal(h.batchCalls.length, 1, "★ 少一份也要写整批声明");
		assert.equal(h.batchCalls[0].length, 2, "★ 读不动的那份不进整批集合");
		assert.equal(h.ingestCalls.length, 2, "★ 读不动的那份在循环里也确实没被处理");
	}

	// 6. 身份推导抛错 ⇒ 整个阶段当作没做成，退回逐文件（绝不半途传集合）
	{
		const h = await makeHarness(mod, {
			planRef: async () => { throw new Error("hash broken"); },
		});
		await h.run();
		assert.equal(h.batchCalls.length, 0, "★ 算不出哈希就不该写声明");
		assert.equal(h.ingestCalls.length, 3, "★ 身份推导失败不影响上传本身");
		assert.ok(
			h.ingestCalls.every((call) => call.declaredHashes === undefined),
			"★★ 整批阶段异常必须退回逐文件声明"
		);
	}

	// ============================================================
	// 7~10. R14 重评：有限并发 ＋ 三条约束（失败定位 / 逐项进度 / 上限）
	// ============================================================

	// 7. ⭐⭐ 整批声明成功 ⇒ 真的并发，而且有上限（不许一次全放出去）
	{
		const probe = inflightProbe();
		const h = await makeHarness(mod, { count: 6, ingest: probe.ingest });
		await h.run();
		assert.equal(h.ingestCalls.length, 6, "★ 六份都要处理");
		assert.equal(h.batchCalls.length, 1, "★ 并发场景下仍只写一次整批声明");
		assert.ok(probe.peak > 1, "★★ 整批声明成功时必须并发（否则 R14 没落地）");
		assert.ok(probe.peak <= 4, `★★ 并发必须有上限（实际峰值 ${probe.peak}，上限 4）`);
	}

	// 8. ⭐⭐ 退回逐文件声明 ⇒ 必须严格串行（否则并发读-改-写 head.json 会丢引用）
	{
		const probe = inflightProbe();
		const h = await makeHarness(mod, { count: 6, batchFails: true, ingest: probe.ingest });
		await h.run();
		assert.equal(h.ingestCalls.length, 6, "★ 降级时六份也都要处理");
		assert.equal(probe.peak, 1, `★★ 退回逐文件声明必须串行（实际峰值 ${probe.peak}）—— D-86 的并发禁忌`);
	}

	// 9. ⭐⭐ 乱序完成仍按清单顺序逐项报进度（R14「逐项进度」）
	{
		const events = [];
		const h = await makeHarness(mod, {
			count: 3,
			// a 最慢、b/c 快 ⇒ 完成顺序必然乱
			ingest: async (request) => {
				const delay = request.name === "a.png" ? 30 : 1;
				await new Promise((resolve) => setTimeout(resolve, delay));
				return emptyResult();
			},
			onItem: (event) => events.push(event.path),
		});
		await h.run();
		assert.deepEqual(
			events,
			["attachments/a.png", "attachments/b.png", "attachments/c.png"],
			"★★ 完成顺序乱了，进度仍要按清单顺序逐项报（有序提交）"
		);
	}

	// 10. ⭐ 单件抛错被隔离：失败只算它一件，别的不许跟着不算
	{
		const h = await makeHarness(mod, {
			count: 3,
			ingest: async (request) => {
				if (request.name === "b.png") throw new Error("broken");
				return { ...emptyResult(), remoteUrl: `https://example.test/${request.name}` };
			},
		});
		const result = await h.run();
		assert.equal(result.uploaded, 2, "★ 另外两份照常上传");
		assert.equal(result.failed, 1, "★ 抛错的那份只算一件失败（失败仍定位得到具体一件）");
	}

	return { cases: 10 };
}
