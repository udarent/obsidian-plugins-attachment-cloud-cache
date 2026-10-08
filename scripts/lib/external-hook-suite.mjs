/**
 * 站外缓存编排（`src/render/external-hook.ts`）的断言套件。
 *
 * ## 这一层坏掉的症状是"什么都没发生"，不报错
 *
 * - **`inflight` 失败没摘除** → 那个 URL 被永久卡住，用户重试也没反应；
 * - **没有笔记路径却不早退** → 缓存了但链接改不了（图进了存储、笔记还指着别人的服务器）；
 * - **默认行为判反** → 设置里写着「什么都不做」，却在后台偷偷下载上传并改写笔记
 *   （这是最严重的一条：用户的偏好被无视，而且是**静默**的）；
 * - **默认行为没生效** → 设置里写着「直接缓存」，却什么都不做。
 *
 * 所以这里逐条钉住。**执行层是注入的接缝**，于是每条都能单独驱动。
 *
 * ⚠️ 早先这里还有一整套"按站点询问"（`ask` / `remember` / 站点记忆 / 通知）——
 * 已整条拆掉（理由见 `external-hook.ts` 的头注释）。所以这个套件里**没有**
 * 任何"用户答了什么之后怎样"的断言：那条路径不存在了。
 */

import assert from "node:assert/strict";

/** 让 fire-and-forget 的入队链跑完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 内部有 await（等入队链）→ 必须是 async 函数
export async function runExternalHookSuite(mod) {
	const { createExternalHook } = mod;

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
		externalImageDefault: "cache",
		s3: address,
		...overrides,
	});

	const image = (src) => ({ getAttribute: (name) => (name === "src" ? src : null) });
	const container = (srcs) => ({ querySelectorAll: (selector) => (selector === "img" ? srcs.map(image) : []) });
	/**
	 * 与 `container` 的区别：这里收的是**已经造好的元素**。
	 *
	 * ⚠️ 必须区分开 —— 把元素塞进 `container` 会被当成 src 字符串，
	 * 于是 `getAttribute("src")` 返回一个**对象**、地址成了空串，判定直接 ignore：
	 * 断言看上去仍然通过，但它测的根本不是那件事（"没有牙齿"）。
	 */
	const containerOf = (elements) => ({ querySelectorAll: (selector) => (selector === "img" ? elements : []) });
	const ctx = (sourcePath) => (sourcePath === undefined ? {} : { sourcePath });

	/** 造一个可完全控制的编排环境。 */
	function makeHarness(options = {}) {
		const queued = [];
		const errors = [];

		const hook = createExternalHook({
			settings: () => options.settings ?? settingsWith(),
			configured: () => options.configured ?? true,
			cache: async (url, notePath) => {
				queued.push([url, notePath]);
				const behaviour = options.cacheBehaviour;
				// 只让**第一次**失败，用来验证"失败也摘除 inflight"
				if (behaviour === "fail-once" && queued.length === 1) throw new Error("模拟下载失败");
			},
			blockedHost: options.blockedHost,
			onError: (error) => errors.push(error),
		});

		return { hook, queued, errors };
	}

	const A = "https://a.example.net/a.png";
	const B = "https://b.example.net/b.png";
	const NOTE = "notes/mine.md";

	// ============================================================
	// 1. ⭐ 同一 URL 并发只入队一次（渲染会反复跑）
	// ============================================================
	{
		const h = makeHarness();
		const r = h.hook.process(container([A, A, A]), ctx(NOTE));
		assert.equal(r.found, 3, "应看到 3 张图");
		assert.equal(r.queued, 1, "★ 同一个 URL 同时只该发起一次（一屏里同图多次很常见）");
		assert.deepEqual(h.queued, [[A, NOTE]], "入队要带上 URL 与笔记路径");
	}

	// 不同 URL 各入队一次
	{
		const h = makeHarness();
		const r = h.hook.process(container([A, B]), ctx(NOTE));
		assert.equal(r.queued, 2, "两张不同的图应各入队一次");
	}

	// ============================================================
	// 2. ⭐ 执行失败也必须摘除 inflight（否则那个 URL 被永久卡住）
	// ============================================================
	{
		const h = makeHarness({ cacheBehaviour: "fail-once" });
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
	// 3. ⭐ 没有笔记路径 → 什么都不做
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
		assert.equal(r.queued, 0, `★ ${label}：不该缓存`);
		assert.equal(h.queued.length, 0, `★ ${label}：不该调到执行层`);
		assert.equal(r.skipped, 1, `${label}：应记为跳过`);
	}

	// ============================================================
	// 4. 不处理的图（站外之外的）、功能关着、被拦、存储未就绪
	// ============================================================
	{
		const h = makeHarness();
		const r = h.hook.process(container(["app://abc/x.png", "data:image/png;base64,AA", ""]), ctx(NOTE));
		assert.equal(r.found, 3, "三张图都看到了");
		assert.equal(r.queued, 0, "非 http(s) 的图不该被处理");
		assert.equal(r.skipped, 3, "都应记为跳过");
	}
	{
		const h = makeHarness({ settings: settingsWith({ externalImageCache: false }) });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.queued, 0, "★ 功能关着时不该缓存");
		assert.equal(h.queued.length, 0, "也不该调到执行层");
	}
	{
		const h = makeHarness({ blockedHost: () => true });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.queued, 0, "被安全拦截的地址不该缓存");
	}
	{
		const h = makeHarness({ configured: false });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.queued, 0, "★ 存储没配好时不该动手（没有任何客户端可发请求）");
	}

	// ============================================================
	// 5. ⭐⭐ 默认行为：设置说「什么都不做」就真的什么都不做
	//
	// 这是这条链路最容易犯的错：**用户偏好被无视，而且是静默的** ——
	// 他在设置里选了「什么都不做」，插件却在后台把图下载上传、还改了他的笔记。
	// ============================================================
	{
		const h = makeHarness({ settings: settingsWith({ externalImageDefault: "skip" }) });
		const r = h.hook.process(container([A, B]), ctx(NOTE));
		assert.equal(r.queued, 0, "★ 默认「什么都不做」时，渲染路径**一张都不许搬**");
		assert.equal(h.queued.length, 0, "★ 不该调到执行层（那是一次真的下载 + 一次真的文件写入）");
		assert.equal(r.skipped, 2, "两张都记为跳过");
	}

	// 反向：默认「直接缓存」时照常搬（否则那个设置是摆设）
	{
		const h = makeHarness({ settings: settingsWith({ externalImageDefault: "cache" }) });
		const r = h.hook.process(container([A]), ctx(NOTE));
		assert.equal(r.queued, 1, "★ 默认「直接缓存」时要真的入队（否则用户会以为功能坏了）");
		assert.equal(h.queued.length, 1);
	}

	// ============================================================
	// 6. 单张图出问题不能拖垮整次渲染
	// ============================================================
	{
		const h = makeHarness();
		const broken = {
			getAttribute() {
				throw new Error("这个元素的实现有问题");
			},
		};
		const r = h.hook.process(containerOf([broken, image(B)]), ctx(NOTE));
		assert.equal(r.queued, 1, "★ 前一张图抛错，后一张仍要被处理");
		assert.equal(h.errors.length, 1, "出错要被记录");
		assert.equal(r.skipped >= 1, true, "坏掉的那张记为跳过");
	}

	// ============================================================
	// 7. 容器的怪形状不能让它抛错
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
}
