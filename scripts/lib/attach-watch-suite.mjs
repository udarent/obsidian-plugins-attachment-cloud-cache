/**
 * 「新增附件自动接管」的断言套件（正式测试与变异验证共用）。
 *
 * ## 这一层为什么值得单独穷举
 *
 * 它挂在 `vault.on("create")` 上 —— 全库**所有**新文件都会经过它。判错的两种代价都很大：
 *
 * - **误接管**：把一个不是用户附件的文件（我们自己落的缓存副本、别人的插件导出的东西）
 *   上传到用户的存储，还会把引用它的笔记改写成远端地址；
 * - **漏接管**：手机上把图片加进笔记，结果什么都没发生 —— 这正是用户报上来的那条
 *   （宿主回形针走的是 `app.saveAttachment`，全程没有粘贴/拖拽事件）。
 *
 * 而其中最要紧的一条是**时序**：`vault.on("create")` 触发时，笔记里**还没有**那条链接
 * （宿主的 `replaceSelection` 在这次 create 之后才跑）。所以"没看到引用"必须被当成
 * **还没到时候**，而不是**不是候选** —— 后者会让这条入口彻底静默失效。
 * 下面 `retry` 的真值表就是钉这件事的。
 *
 * ## 为什么用假时钟
 *
 * 退避重试是这个模块的核心行为（1.2s → 3s → 6s → 10s）。真等它，一次套件要 20 秒，
 * 而且没法精确断言"第几档、几次"。所以调度器是注入的：`schedule` / `cancel` 换成
 * 手动队列，测试同步驱动。
 */

import assert from "node:assert/strict";

const CACHE = "attachments-cache";

/** 一条索引记录（形状照 `CacheEntry`）。 */
function entry(key, cachePath) {
	return {
		key,
		cachePath,
		remoteUrl: `https://img.example.com/${key}`,
		size: 100,
		contentType: "image/png",
		etag: "",
		uploadedAt: "2026-10-06T00:00:00.000Z",
	};
}

/** 一份可用的设置（`selectUploadCandidates` 会读它）。 */
const SETTINGS = {
	autoUpload: true,
	attachmentFolder: "",
	localCopy: "cache",
	cacheFolder: CACHE,
	fallbackDownload: true,
	externalImageCache: false,
	externalImageDefault: "ask",
	cacheLimitMb: 0,
	s3: {
		endpoint: "https://s3.example.com",
		region: "auto",
		bucket: "b",
		publicUrlBase: "https://img.example.com",
		accessKeyId: "",
		secretAccessKeyRef: "",
		forcePathStyle: true,
		objectKeyTemplate: "{hash}.{ext}",
	},
};

/** 造一个"库里的文件"（`TFile` 的形状子集）。 */
function file(path, size = 120) {
	return { path, extension: path.split(".").pop(), stat: { size } };
}

export async function runAttachWatchSuite(mod) {
	const { CacheIndex, decideAdoptCreatedFile, createAttachWatcher, createSelfWriteLedger } = mod;
	for (const [name, value] of Object.entries({
		decideAdoptCreatedFile,
		createAttachWatcher,
		createSelfWriteLedger,
		CacheIndex,
	})) {
		assert.equal(typeof value, "function", `入口必须导出 ${name}`);
	}

	const cases = { decision: 0, ledger: 0, scheduling: 0 };

	// ───────────────────────── 判定层（纯函数） ─────────────────────────

	/** 判定夹具：默认"设置开着、不在缓存目录、不是自写、没有索引记录、没有任何引用"。 */
	const decide = (target, options = {}) =>
		decideAdoptCreatedFile({
			file: target,
			autoUpload: true,
			cacheFolder: CACHE,
			isSelfWrite: false,
			index: new CacheIndex([]),
			settings: SETTINGS,
			referencedPaths: new Set(),
			...options,
		});

	// ① 正常情形：刚被引用的一张图 ⇒ 接管
	assert.deepEqual(
		decide(file("attachments/new.png"), { referencedPaths: new Set(["attachments/new.png"]) }),
		{ adopt: true, reason: "ok", retry: false },
		"被笔记引用着的新附件必须接管"
	);
	cases.decision += 1;

	// ② ⭐⭐ 时序：create 时链接还没写进笔记 ⇒ 不能当成"不是候选"，要**再等一轮**
	const notYetReferenced = decide(file("attachments/new.png"));
	assert.equal(notYetReferenced.adopt, false, "还没被引用时不许动手（搬走会留死链）");
	assert.equal(notYetReferenced.retry, true, "「还没被引用」只是还没到时候 ⇒ retry 必须为真");
	cases.decision += 1;

	// ③ ⭐ 反向断言：**除了「还没被引用」，其余每一种跳过都是终局**。
	//
	// 每一种都把路径放进引用集合里 —— 于是"不接管"只能由那道闸门解释，
	// `retry` 也就必须是 false。少了这条，把 `retry` 写成恒真会静默通过
	//（表现为"一个文件挂在攒批里反复求引用集合，直到退避用尽"）。
	const terminal = [
		["自动上传关着", { autoUpload: false }],
		["文件在缓存目录里", { file: file(`${CACHE}/abc.png`) }],
		["是我们自己刚落下的中转文件", { isSelfWrite: true }],
		["是笔记/画布/数据库文件", { file: file("notes/a.md") }],
		["是空文件（同步中的占位）", { file: file("attachments/empty.png", 0) }],
		[
			"已经在缓存索引里",
			{ index: new CacheIndex([entry("cached.png", "attachments/cached.png")]), file: file("attachments/cached.png") },
		],
	];
	for (const [label, options] of terminal) {
		const target = options.file ?? file("attachments/new.png");
		const verdict = decide(target, { ...options, referencedPaths: new Set([target.path]) });
		assert.equal(verdict.adopt, false, `${label}：不该接管`);
		assert.equal(verdict.retry, false, `${label}：这是终局判定，再等也不会变`);
		cases.decision += 1;
	}

	// ④ 形状不对的输入：不接管、不进重试、不抛（它跑在宿主的文件事件里）
	for (const junk of [null, undefined, {}, { path: 42 }, { path: "   " }]) {
		const verdict = decide(junk);
		assert.equal(verdict.adopt, false, "形状不对的输入一律不接管");
		assert.equal(verdict.retry, false, "形状不对时没有可等的对象 ⇒ 不进重试");
	}
	cases.decision += 1;

	// ⑤ 缓存目录要按**路径段**认：名字相近的目录不是缓存目录（前缀判断会把它误杀，
	//    于是用户放在 `attachments-cache-notes/` 里的真附件永远不上传）
	assert.equal(
		decide(file("attachments-cache-other/abc.png"), {
			referencedPaths: new Set(["attachments-cache-other/abc.png"]),
		}).adopt,
		true,
		"名字相近但不是缓存目录 ⇒ 仍然要接管"
	);
	cases.decision += 1;

	// ⑥ 任何类型都算附件（需求 R15：排除制，不是白名单）
	assert.equal(
		decide(file("attachments/backup.zip", 999), { referencedPaths: new Set(["attachments/backup.zip"]) }).adopt,
		true,
		"任何类型的附件都要接管（需求 R15）"
	);
	cases.decision += 1;

	// ───────────────────────── 自写台账 ─────────────────────────

	let now = 1000;
	const ledger = createSelfWriteLedger({ ttlMs: 500, now: () => now });
	ledger.note("attachments/Pasted image 1.png");
	assert.equal(ledger.has("attachments/Pasted image 1.png"), true, "刚落盘的中转文件必须认得出来");
	assert.equal(ledger.has("attachments/other.png"), false, "没记过的路径不认");
	cases.ledger += 1;

	now += 600;
	assert.equal(
		ledger.has("attachments/Pasted image 1.png"),
		false,
		"过期之后不能再认 —— 否则用户将来真有同名附件时会被永远当成自写文件、永不上传"
	);
	assert.equal(ledger.size(), 0, "过期条目要被清掉，台账不能无限长");
	cases.ledger += 1;

	ledger.note("");
	ledger.note(null);
	assert.equal(ledger.size(), 0, "空路径不记（脏输入不进台账）");
	cases.ledger += 1;

	// ───────────────────────── 攒批与退避（编排） ─────────────────────────

	/** 手动时钟：调度只入队，测试自己决定"何时走到下一拍"。 */
	function makeClock() {
		const queue = [];
		let scheduledCount = 0;
		let cancelledCount = 0;
		return {
			schedule(run, delayMs) {
				scheduledCount += 1;
				const handle = { run, delayMs, cancelled: false };
				queue.push(handle);
				return handle;
			},
			cancel(handle) {
				if (handle) {
					handle.cancelled = true;
					cancelledCount += 1;
				}
			},
			scheduledCount: () => scheduledCount,
			cancelledCount: () => cancelledCount,
			next() {
				const index = queue.findIndex((handle) => !handle.cancelled);
				return index < 0 ? null : queue.splice(index, 1)[0];
			},
		};
	}

	/** 造一个接线好的接管器 + 各种记录口。 */
	function makeWatcher(overrides = {}) {
		const clock = makeClock();
		const notices = [];
		const adoptCalls = [];
		const logs = [];
		const files = new Map();
		const referenced = new Set();
		const index = overrides.index ?? new CacheIndex([]);
		const watcher = createAttachWatcher({
			autoUpload: () => overrides.autoUpload ?? true,
			cacheFolder: () => CACHE,
			isSelfWrite: (path) => overrides.selfWrites?.has(path) ?? false,
			index: () => index,
			settings: () => SETTINGS,
			lookup: (path) => files.get(path) ?? null,
			referencedPaths: overrides.referencedPaths ?? (async () => new Set(referenced)),
			adopt:
				overrides.adopt ??
				(async (paths) => {
					adoptCalls.push([...paths]);
					return { uploaded: paths.length, reused: 0, failed: 0, linksRewritten: paths.length };
				}),
			notify: (message) => notices.push(message),
			t: (key, params) => (params ? `${key}(${params.count})` : key),
			schedule: clock.schedule,
			cancel: clock.cancel,
			retryDelaysMs: overrides.retryDelaysMs ?? [100, 200, 400],
			log: (message) => logs.push(message),
		});
		/** 走到下一拍：先跑排队的调度，再把它触发的那次 flush 等完。 */
		const advance = async () => {
			const handle = clock.next();
			if (!handle) return null;
			await handle.run();
			await watcher.flush();
			return handle.delayMs;
		};
		return { watcher, clock, notices, adoptCalls, logs, files, referenced, index, advance };
	}

	// S1 ⭐ 等引用 → 接管一次（这是用户报的那条缺陷的正面判据）
	const f1 = makeWatcher();
	f1.files.set("attachments/new.png", file("attachments/new.png"));
	f1.watcher.onCreated({ path: "attachments/new.png" });
	assert.equal(f1.watcher.pending(), 1, "库里新增文件要被记住");
	assert.equal(f1.adoptCalls.length, 0, "时刻表第一档之前不该动手");
	assert.equal(await f1.advance(), 100, "第一档延迟要按时刻表来");
	assert.equal(f1.adoptCalls.length, 0, "此刻笔记里还没有链接 ⇒ 必须继续等（否则搬走就是一条死链）");
	f1.referenced.add("attachments/new.png");
	assert.equal(await f1.advance(), 200, "第二轮走下一档延迟");
	assert.deepEqual(f1.adoptCalls, [["attachments/new.png"]], "看到引用后接管，且只接管一次");
	assert.deepEqual(f1.notices, ["attachAutoUploaded(1)"], "接管成功要有用户可见的交代");
	assert.equal(f1.watcher.pending(), 0, "接管过的文件不再重复处理");
	cases.scheduling += 1;

	// S2 「拷进库但没在笔记里引用」：退避等满后**静默**丢弃
	const f2 = makeWatcher({ retryDelaysMs: [10, 20] });
	f2.files.set("attachments/copied.png", file("attachments/copied.png"));
	f2.watcher.onCreated({ path: "attachments/copied.png" });
	await f2.advance();
	await f2.advance();
	assert.equal(f2.adoptCalls.length, 0, "没被引用就不该上传（搬走只会让人以为丢东西）");
	assert.deepEqual(f2.notices, [], "「拷进库但没引用」是正常操作，不该弹通知");
	assert.equal(f2.watcher.pending(), 0, "等满后要丢掉，不能一直挂在内存里");
	cases.scheduling += 1;

	// S3 攒批：连着来的几个文件**只执行一次**
	const f3 = makeWatcher();
	for (const name of ["a.png", "b.png", "c.png"]) {
		f3.files.set(`attachments/${name}`, file(`attachments/${name}`));
		f3.referenced.add(`attachments/${name}`);
		f3.watcher.onCreated({ path: `attachments/${name}` });
	}
	assert.equal(f3.clock.scheduledCount(), 1, "连着来的几次 create 只排一次调度（攒批）");
	await f3.advance();
	assert.equal(f3.adoptCalls.length, 1, "同一批只执行一次 —— 逐个执行会重复扫全库、并发改写同一篇笔记");
	assert.deepEqual(
		f3.adoptCalls[0].slice().sort(),
		["attachments/a.png", "attachments/b.png", "attachments/c.png"],
		"整批一起交给执行层"
	);
	assert.deepEqual(f3.notices, ["attachAutoUploaded(3)"], "一次通知报整批的数量");
	cases.scheduling += 1;

	// S4 文件已经不在了（粘贴那条路的中转文件会被搬走）+ 脏输入
	const f4 = makeWatcher();
	f4.watcher.onCreated({ path: "attachments/gone.png" });
	f4.watcher.onCreated(null);
	f4.watcher.onCreated({});
	f4.watcher.onCreated({ path: 7 });
	assert.equal(f4.watcher.pending(), 1, "只有形状正确的那个被记住");
	await f4.advance();
	assert.equal(f4.adoptCalls.length, 0, "文件已经不在了 ⇒ 什么都不做");
	assert.equal(f4.watcher.pending(), 0, "并把它丢掉，别一直等");
	cases.scheduling += 1;

	// S5 等待期间新报上来的文件**不能被一起清掉**
	//
	// 收尾那段只该删「这一批里放弃的那些」：直接清空整个攒批会把等待期间新来的文件吞掉
	//（表现为"用户加了第二张图，永远不上传"）。
	const late = { fired: false };
	let f5;
	f5 = makeWatcher({
		retryDelaysMs: [10],
		referencedPaths: async () => {
			if (!late.fired) {
				late.fired = true;
				// 模拟"这一轮 flush 正求引用集合时，宿主又报了一个新增文件"
				f5.watcher.onCreated({ path: "attachments/late.png" });
			}
			return new Set();
		},
	});
	f5.files.set("attachments/never.png", file("attachments/never.png"));
	f5.watcher.onCreated({ path: "attachments/never.png" });
	await f5.advance();
	assert.equal(f5.watcher.pending(), 1, "等待期间新来的文件必须留在攒批里，不能被一起清掉");
	assert.equal(f5.adoptCalls.length, 0, "两个都还没被引用 ⇒ 一个都不该上传");
	cases.scheduling += 1;

	// S6 卸载：取消已排的调度、之后不再攒
	const f6 = makeWatcher();
	f6.files.set("attachments/x.png", file("attachments/x.png"));
	f6.watcher.onCreated({ path: "attachments/x.png" });
	assert.equal(f6.clock.scheduledCount(), 1, "先有一拍排在队里");
	f6.watcher.dispose();
	assert.equal(f6.clock.cancelledCount(), 1, "卸载必须取消已排的调度（否则卸载后还会去改用户笔记）");
	assert.equal(f6.watcher.pending(), 0, "卸载要清空攒批");
	f6.watcher.onCreated({ path: "attachments/y.png" });
	assert.equal(f6.watcher.pending(), 0, "卸载之后不能再攒");
	assert.equal(f6.clock.scheduledCount(), 1, "卸载之后不能再排调度");
	cases.scheduling += 1;

	// S7 执行层抛错：不往外抛（它跑在宿主的文件事件里）+ 一条用户可见的交代
	const f7 = makeWatcher({
		adopt: async () => {
			throw new Error("boom");
		},
	});
	f7.files.set("attachments/x.png", file("attachments/x.png"));
	f7.referenced.add("attachments/x.png");
	f7.watcher.onCreated({ path: "attachments/x.png" });
	await f7.advance();
	assert.deepEqual(f7.notices, ["attachAutoFailed(1)"], "执行抛错也要有用户可见的交代");
	assert.equal(f7.watcher.pending(), 0, "抛错的那批不重试（重试的正确入口是那条命令）");
	cases.scheduling += 1;

	// S8 求引用集合失败：当作"还没被引用"（保守的一侧），不抛
	const f8 = makeWatcher({
		retryDelaysMs: [10, 20],
		referencedPaths: async () => {
			throw new Error("元数据不可用");
		},
	});
	f8.files.set("attachments/x.png", file("attachments/x.png"));
	f8.referenced.add("attachments/x.png");
	f8.watcher.onCreated({ path: "attachments/x.png" });
	await f8.advance();
	assert.equal(f8.adoptCalls.length, 0, "求引用失败时必须当作「还没被引用」（宁可晚，不可错）");
	assert.ok(
		f8.logs.some((message) => message.includes("引用集合")),
		"求引用失败要留下日志"
	);
	await f8.advance();
	assert.equal(f8.watcher.pending(), 0, "退避用尽后丢弃");
	cases.scheduling += 1;

	return cases;
}
