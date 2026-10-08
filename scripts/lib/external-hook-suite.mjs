/**
 * 站外缓存编排（`src/render/external-hook.ts`）的断言套件。
 *
 * ## 这一层坏掉的症状是"烦"或"什么都没发生"，都不报错
 *
 * - 去重没做 → 同一个站点在**每次重新渲染**时都再问一遍（阅读体验直接毁掉）；
 * - 记忆没写 → 用户答过也白答；
 * - `inflight` 失败没摘除 → 那个 URL 被永久卡住，用户重试也没反应；
 * - 没有笔记路径却不早退 → 缓存了但链接改不了，站点记忆已 allow，成了彻底的半成品。
 *
 * 所以这里逐条钉住。**询问与执行都是注入的接缝**，于是每条都能单独驱动。
 */

import assert from "node:assert/strict";

/** 让微任务链跑完（`ask` 的 Promise 是套件自己控制的）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 内部有 await（等询问的 Promise）→ 必须是 async 函数
export async function runExternalHookSuite(mod) {
	const { createExternalHook } = mod;
	const { SiteDecisions } = mod;

	const address = {
		endpoint: "https://s3.example.com",
		bucket: "my-bucket",
		publicUrlBase: "https://img.example.com",
		forcePathStyle: true,
	};

	const settingsWith = (overrides = {}) => ({
		autoUpload: true,
		enabledExtensions: ["png"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		externalImageCache: true,
		s3: address,
		...overrides,
	});

	const image = (src) => ({ getAttribute: (name) => (name === "src" ? src : null) });
	const container = (srcs) => ({ querySelectorAll: (selector) => (selector === "img" ? srcs.map(image) : []) });
	const ctx = (sourcePath) => (sourcePath === undefined ? {} : { sourcePath });

	/** 造一个可完全控制的编排环境。 */
	function makeHarness(options = {}) {
		const decisions = options.decisions ?? new SiteDecisions();
		const asked = [];
		const queued = [];
		const remembered = [];
		const errors = [];
		const resolvers = [];
		/** 记录"入队那一刻已经记住了几条" —— 用来钉住"先记后做"的顺序。 */
		const rememberedAtCacheTime = [];

		const hook = createExternalHook({
			settings: () => options.settings ?? settingsWith(),
			decisions: () => decisions,
			configured: () => options.configured ?? true,
			ask: (info) =>
				new Promise((resolve, reject) => {
					asked.push(info);
					resolvers.push({ resolve, reject });
				}),
			remember: (host, decision) => {
				remembered.push([host, decision]);
				decisions.set(host, decision);
			},
			cache: async (url, notePath) => {
				rememberedAtCacheTime.push(remembered.length);
				queued.push([url, notePath]);
				const behaviour = options.cacheBehaviour;
				// 只让**第一次**失败，用来验证"失败也摘除 inflight"
				if (behaviour === "fail-once" && queued.length === 1) throw new Error("模拟下载失败");
			},
			blockedHost: options.blockedHost,
			onError: (error) => errors.push(error),
		});

		return { hook, decisions, asked, queued, remembered, rememberedAtCacheTime, errors, resolvers };
	}

	const A = "https://a.example.net/a.png";
	const B = "https://b.example.net/b.png";
	const NOTE = "notes/mine.md";

	// ============================================================
	// 1. ⭐ 同站多张图只问一次（渲染会反复跑，这条是全部体验的前提）
	// ============================================================
	{
		const h = makeHarness();
		const r = h.hook.process(container([A, A, A]), ctx(NOTE));
		assert.equal(r.found, 3, "应看到 3 张图");
		assert.equal(r.asked, 1, "★ 同一站点只该问一次");
		assert.equal(h.asked.length, 1, "★ 只该弹一个询问");

		// 还没答复就再次渲染（用户可能切了视图、滚了动）→ 不能重复弹
		const again = h.hook.process(container([A, A]), ctx(NOTE));
		assert.equal(again.asked, 0, "★ 正在问的站点再次渲染时不该重复弹");

		h.resolvers[0].resolve("cache");
		await flush();
		assert.deepEqual(h.remembered, [["a.example.net", "allow"]], "★ 答复后必须记住这个站点");
		assert.equal(h.queued.length, 1, "★ 答复「缓存」后应发起一次缓存");
		assert.deepEqual(h.queued[0], [A, NOTE], "缓存要带上 URL 与笔记路径");
	}

	// ============================================================
	// 2. 不同站点各问一次
	// ============================================================
	{
		const h = makeHarness();
		const r = h.hook.process(container([A, B]), ctx(NOTE));
		assert.equal(r.asked, 2, "两个站点应各问一次");
		assert.deepEqual(h.asked.map((info) => info.host).sort(), ["a.example.net", "b.example.net"], "询问要带上各自的主机名");
	}

	// ============================================================
	// 3. 答复「不再询问」→ 记 deny，且不缓存
	// ============================================================
	{
		const h = makeHarness();
		h.hook.process(container([A]), ctx(NOTE));
		h.resolvers[0].resolve("never");
		await flush();
		assert.deepEqual(h.remembered, [["a.example.net", "deny"]], "答复「不再询问」要记 deny");
		assert.equal(h.queued.length, 0, "★ 不该缓存");

		// 之后再渲染同一站点：既不再问，也不处理
		const later = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(later.asked, 0, "记过 deny 之后不该再问");
		assert.equal(later.queued, 0, "记过 deny 之后不该缓存");
	}

	// ============================================================
	// 4. 已记 allow → 直接缓存，不问
	// ============================================================
	{
		const decisions = new SiteDecisions([{ host: "a.example.net", decision: "allow" }]);
		const h = makeHarness({ decisions });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.asked, 0, "★ 记过 allow 的站点不该再问");
		assert.equal(r.queued, 1, "应直接发起缓存");
		assert.equal(h.queued.length, 1, "要真的调到执行层");
	}

	// ============================================================
	// 5. ⭐ 顺序：必须**先记住决定，再执行**
	// ============================================================
	// 反过来的话，紧接着的一次渲染会读到一个还没写下的记忆 → 再问一遍。
	{
		const h = makeHarness();
		h.hook.process(container([A]), ctx(NOTE));
		h.resolvers[0].resolve("cache");
		await flush();
		assert.equal(h.rememberedAtCacheTime[0], 1, "★ 执行时必须已经记住了这个决定（否则紧接着的渲染会再问一次）");
	}

	// ============================================================
	// 6. 同一 URL 并发只入队一次
	// ============================================================
	{
		const decisions = new SiteDecisions([{ host: "a.example.net", decision: "allow" }]);
		const h = makeHarness({ decisions });
		h.hook.process(container([A, A, A]), ctx(NOTE));
		assert.equal(h.queued.length, 1, "★ 同一个 URL 同时只该发起一次（一屏里同图多次很常见）");
	}

	// ============================================================
	// 7. ⭐ 执行失败也必须摘除 inflight（否则那个 URL 被永久卡住）
	// ============================================================
	{
		const decisions = new SiteDecisions([{ host: "a.example.net", decision: "allow" }]);
		const h = makeHarness({ decisions, cacheBehaviour: "fail-once" });
		h.hook.process(container([A]), ctx(NOTE));
		await flush();
		assert.equal(h.queued.length, 1, "第一次会失败");
		assert.equal(h.errors.length >= 1, true, "失败要被记录（而不是静默吞掉）");

		// 再渲染一次：必须能**重试**（失败没有把 URL 永久锁死）
		h.hook.process(container([A]), ctx(NOTE));
		await flush();
		assert.equal(h.queued.length, 2, "★ 失败后必须能重试（inflight 要在 finally 里摘除）");
	}

	// ============================================================
	// 8. ⭐ 没有笔记路径 → 什么都不做（连问都不问）
	// ============================================================
	// 这条链路的产出是"改写笔记"；拿不到笔记就改不了，缓存了只是半成品。
	for (const [label, context] of [
		["ctx 为空对象", ctx(undefined)],
		["ctx 为 null", null],
		["sourcePath 是空串", ctx("")],
		["sourcePath 是空白", ctx("   ")],
		["ctx 为 undefined", undefined],
	]) {
		const h = makeHarness();
		const r = h.hook.process(container([A]), context);
		assert.equal(r.asked, 0, `★ ${label}：不该询问`);
		assert.equal(h.queued.length, 0, `★ ${label}：不该缓存`);
		assert.equal(r.skipped, 1, `${label}：应记为跳过`);
	}
	// 即便站点已被记成 allow 也一样（它同样需要改写笔记）
	{
		const decisions = new SiteDecisions([{ host: "a.example.net", decision: "allow" }]);
		const h = makeHarness({ decisions });
		const r = h.hook.process(container([A]), ctx(undefined));
		assert.equal(r.queued, 0, "★ 没有笔记路径时，即使已记 allow 也不该缓存");
		assert.equal(h.queued.length, 0, "不该调到执行层");
	}

	// ============================================================
	// 9. 不处理的图（站外之外的）与功能关着
	// ============================================================
	{
		const h = makeHarness();
		const r = h.hook.process(container(["app://abc/x.png", "data:image/png;base64,AA", ""]), ctx(NOTE));
		assert.equal(r.found, 3, "三张图都看到了");
		assert.equal(r.asked, 0, "非 http(s) 的图不该触发询问");
		assert.equal(r.skipped, 3, "都应记为跳过");
	}
	{
		const h = makeHarness({ settings: settingsWith({ externalImageCache: false }) });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.asked, 0, "★ 功能关着时不该询问");
		assert.equal(h.queued.length, 0, "也不该缓存");
	}
	{
		const h = makeHarness({ blockedHost: () => true });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.asked, 0, "被安全拦截的站点不该询问");
	}

	// ============================================================
	// 10. ⭐ 询问本身失败 → 当作「不做」，绝不当成「同意」
	// ============================================================
	{
		const h = makeHarness();
		h.hook.process(container([A]), ctx(NOTE));
		h.resolvers[0].reject(new Error("UI 出问题"));
		await flush();
		assert.deepEqual(h.remembered, [["a.example.net", "deny"]], "★ 询问失败必须当成「不做」（默认同意是灾难）");
		assert.equal(h.queued.length, 0, "★ 询问失败绝不能去缓存");
		assert.equal(h.errors.length >= 1, true, "要记录这个错误");
	}

	// ============================================================
	// 11. 单张图出问题不能拖垮整次渲染
	// ============================================================
	{
		const decisions = new SiteDecisions([{ host: "b.example.net", decision: "allow" }]);
		const h = makeHarness({ decisions });
		const broken = {
			getAttribute() {
				throw new Error("这个元素的实现有问题");
			},
		};
		const r = h.hook.process({ querySelectorAll: () => [broken, image(B)] }, ctx(NOTE));
		assert.equal(r.queued, 1, "★ 前一张图抛错，后一张仍要被处理");
		assert.equal(h.errors.length, 1, "出错要被记录");
		assert.equal(r.skipped >= 1, true, "坏掉的那张记为跳过");
	}

	// ============================================================
	// 12. 容器的怪形状不能让它抛错
	// ============================================================
	for (const [label, root] of [
		["null", null],
		["undefined", undefined],
		["没有 querySelectorAll", {}],
		["querySelectorAll 返回 null", { querySelectorAll: () => null }],
	]) {
		const h = makeHarness();
		const r = h.hook.process(root, ctx(NOTE));
		assert.equal(r.found, 0, `${label}：应安全返回空结果`);
	}

	// ============================================================
	// 13. ⭐⭐ 清空站点记忆之后必须**重新询问**
	//
	// 「清除站点记忆」这个按钮的语义就是"忘掉我的回答"。可编排层自己还有一张
	// 「已经问过」的表 —— 它若在答复之后**仍然留着**那个站点，清空记忆就**不生效**：
	// 用户清完记忆发现站外图再也不问了，唯一的办法是重启 Obsidian。
	// （**实测踩到**：用户报"清除站点记忆以后，也没有再次询问图片是否上传"。）
	//
	// 抑制重复询问的依据只有两处，且都不是"永久记住"：
	//   · 答复之前 → `asking` 里那个还没落地的 Promise（同站只弹一个）；
	//   · 答复之后 → **记忆本身**（deny → ignore、allow → cache），
	//     而记忆是用户可以清空的。
	// 多存一份"问过就永久记住"的表，就多了一个清不掉的真相来源。
	// ============================================================
	{
		const h = makeHarness();
		h.hook.process(container([A]), ctx(NOTE));
		assert.equal(h.asked.length, 1, "第一次应当询问");
		h.resolvers[0].resolve("never");
		await flush();
		assert.equal(h.decisions.get("a.example.net"), "deny", "答复之后记忆里应当有 deny");

		// 此时再渲染：记忆说 deny ⇒ 既不问也不处理
		const remembered = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(remembered.asked, 0, "记过 deny 之后不该再问");

		// 用户点了设置页里的「清除」（清的就是这份记忆）
		h.decisions.clear();

		const afterClear = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(afterClear.asked, 1, "★ 清空记忆之后必须重新询问（否则用户只能靠重启 Obsidian 才能再被问一次）");
		assert.equal(h.asked.length, 2, "★ 应当真的弹了第二个询问");
	}

	// ⭐ 反向：**正在问**的那段窗口里仍然只弹一个
	//（上面那条修法把"永久记住"去掉了，这条确认没有顺手把"不重复打扰"也去掉）
	{
		const h = makeHarness();
		h.hook.process(container([A]), ctx(NOTE));
		const twice = h.hook.process(container([A, A]), ctx(NOTE));
		assert.equal(twice.asked, 0, "★ 还在等待答复时，同站再次渲染不得重复弹窗");
		assert.equal(h.asked.length, 1, "只该有一个询问在飞");
	}
}
