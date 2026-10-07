/**
 * 渲染钩子（`src/render/render-hook.ts`）的断言套件。
 *
 * ## 这套断言守的是什么
 *
 * P0 #4 的原话是"断网后图片**成功解码**，且**对远端零请求**"。在 Node 里
 * 没有浏览器，所以不能真的去数网络请求 —— 但"零请求"这件事有一个**结构性**判据：
 * **远端地址从来没有被赋给元素**。请求只可能因为 `src` 是远端地址而发出，
 * 所以只要断言"`src` 被替换成了本地地址、且我们改写过的元素上从未出现远端地址"，
 * 就把这条性质钉住了。
 *
 * 用假元素（而不是真 DOM）是因为要穷举边界：索引命中 / 未命中 / 站外图 /
 * 拿不到本地地址 / 本地文件失效 / 重复处理 —— 真 DOM 造这些状态太慢。
 */

import assert from "node:assert/strict";

/** 一个够用的假 `<img>`：记录每一次被赋值，并允许手动触发 error。 */
function fakeImage(src) {
	const listeners = new Map();
	return {
		attrs: { src },
		/** 每一次 `src` 被写入的值，按顺序。用于断言"远端地址是否出现过"。 */
		writes: [],
		getAttribute(name) {
			return name === "src" ? (this.attrs.src ?? null) : null;
		},
		setAttribute(name, value) {
			if (name === "src") {
				this.writes.push(value);
				this.attrs.src = value;
			}
		},
		addEventListener(type, callback) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(callback);
		},
		/** 触发一次 error（模拟本地文件加载失败）。 */
		async fail() {
			for (const callback of listeners.get("error") ?? []) await callback();
		},
		listenerCount(type) {
			return (listeners.get(type) ?? []).length;
		},
	};
}

function fakeContainer(images) {
	return { querySelectorAll: (selector) => (selector === "img" ? images : []) };
}

// 内部有 await（补齐是异步的）→ 必须是 async 函数
export async function runRenderHookSuite(mod) {
	const { processImages, installImageSrcPatch } = mod;
	const { CacheIndex } = mod;

	const BASE = "https://img.example.com";
	const address = { endpoint: "https://s3.example.com", bucket: "b", publicUrlBase: BASE, forcePathStyle: true };
	const settings = {
		autoUpload: true,
		enabledExtensions: ["png"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		s3: address,
	};

	const entry = (key, cachePath) => ({
		key,
		cachePath,
		remoteUrl: `${BASE}/${key}`,
		size: 3,
		contentType: "image/png",
		etag: "",
		uploadedAt: "2026-10-06T00:00:00.000Z",
		// 「最近被用到」的时间 —— 渲染钩子不读它（只由 `touch` 写），
		// 但条目形状要完整，免得将来读它时才发现这个样板里没有。
		lastUsedAt: 0,
		sourceName: key,
	});

	const index = new CacheIndex([entry("cached.png", "_attachment-cache/cached.png")]);

	/** 最小依赖集；各用例按需覆写。 */
	const depsWith = (over = {}) => ({
		settings: () => settings,
		index: () => index,
		resourceUrlFor: (path) => `app://local/${path}`,
		...over,
	});

	// ============================================================
	// 1. ⭐ 索引命中 → 换成本地地址，且**远端地址从未被赋进去**
	// ============================================================
	const touched = [];
	const img1 = fakeImage(`${BASE}/cached.png`);
	const r1 = processImages(fakeContainer([img1]), depsWith({ onLocalCopyUsed: (key) => touched.push(key) }));

	assert.equal(r1.local, 1, "索引里有本地副本应改写一张");
	assert.equal(r1.deferred, 0, "不该进入补齐流程");
	assert.equal(img1.getAttribute("src"), "app://local/_attachment-cache/cached.png");
	assert.deepEqual(
		img1.writes,
		["app://local/_attachment-cache/cached.png"],
		"★ 写入序列里**只有**本地地址 —— 远端地址一旦出现就意味着可能已发出请求"
	);
	// ⭐ 这条是缓存轮换排序的依据：不记的话，轮换只能按"上传时间"排，
	// 于是"天天在看的图"可能比"上传后就没打开过的图"先被淘汰。
	assert.deepEqual(touched, ["cached.png"], "★ 换成副本时要记下「这张图刚被看到」（缓存上限轮换靠它排序）");

	// ============================================================
	// 2. 站外图 / 本地资源 / 空 src 一律不动
	// ============================================================
	for (const [label, src] of [
		["站外图", "https://other.example.net/a.png"],
		["已经是本地资源", "app://local/abc.png"],
		["data URI", "data:image/png;base64,AAAA"],
		["空 src", ""],
	]) {
		const img = fakeImage(src);
		const notTouched = [];
		const result = processImages(fakeContainer([img]), depsWith({ onLocalCopyUsed: (key) => notTouched.push(key) }));
		assert.equal(result.local, 0, `${label} 不该被改写`);
		assert.deepEqual(img.writes, [], `${label} 不该被赋值`);
		assert.equal(img.listenerCount("error"), 0, `${label} 不该挂兜底监听器`);
		assert.deepEqual(
			notTouched,
			[],
			`★ ${label} 更不该被记成「刚被看到」—— 那会让轮换以为它常被使用，于是永远不淘汰它`
		);
	}

	// ============================================================
	// 3. ⭐ 拿不到本地可用地址时**不改**（绝不改成坏链接）
	//
	// 症状对比：不改 → 在线正常、离线看不到（可接受）；改成空/坏地址 →
	// 连在线都看不到（明显更糟）。
	// ============================================================
	const img3 = fakeImage(`${BASE}/cached.png`);
	const r3 = processImages(fakeContainer([img3]), depsWith({ resourceUrlFor: () => null }));
	assert.equal(r3.local, 0, "拿不到可用地址时不该计入改写");
	assert.deepEqual(img3.writes, [], "★ 拿不到可用地址时**一个字都不该写**（不能改成空串或坏地址）");

	// ============================================================
	// 4. 属于本存储但本地没有 → 交给补齐流程；补上后换成本地地址
	// ============================================================
	const img4 = fakeImage(`${BASE}/missing.png`);
	const asked = [];
	const r4 = processImages(
		fakeContainer([img4]),
		depsWith({
			ensureLocalCopy: async (key, remoteUrl) => {
				asked.push([key, remoteUrl]);
				return "_attachment-cache/missing.png";
			},
		})
	);
	assert.equal(r4.deferred, 1, "本地没有副本时应交给补齐流程");
	assert.deepEqual(asked, [["missing.png", `${BASE}/missing.png`]], "补齐要用 key 与远端地址");

	// 补上之后才写 src（异步）—— 等一个微任务
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(img4.getAttribute("src"), "app://local/_attachment-cache/missing.png");
	assert.equal(
		img4.writes[0],
		"app://local/_attachment-cache/missing.png",
		"补齐路径里也不该先写远端地址"
	);

	// 没有补齐能力时：原样保留（在线能用、离线不能用），且不挂监听器
	const imgNoFetcher = fakeImage(`${BASE}/missing.png`);
	const rNoFetcher = processImages(fakeContainer([imgNoFetcher]), depsWith());
	assert.equal(rNoFetcher.deferred, 0, "没有补齐能力时不该计入");
	assert.deepEqual(imgNoFetcher.writes, [], "没有补齐能力时不该动这个元素");

	// ============================================================
	// 5. ⭐ 本地副本其实不在 → 退回远端地址（并报告，供自愈）
	//
	// 场景：用户按 SCOPE 的承诺删掉了缓存目录，索引还记着那些文件。
	// 不做兜底的话，"删缓存"就等于"所有图片都坏了"。
	// ============================================================
	const img5 = fakeImage(`${BASE}/cached.png`);
	const missingKeys = [];
	processImages(fakeContainer([img5]), depsWith({ onLocalCopyMissing: (key) => missingKeys.push(key) }));
	assert.equal(img5.getAttribute("src"), "app://local/_attachment-cache/cached.png");

	await img5.fail();
	assert.deepEqual(missingKeys, ["cached.png"], "本地副本失效要报告出去（供索引自愈）");
	assert.equal(img5.getAttribute("src"), `${BASE}/cached.png`, "★ 退回到远端，让在线用户仍然看得到图");

	// 兜底只该发生一次：退回远端之后再次失败，不能无限互相触发
	await img5.fail();
	assert.equal(missingKeys.length, 1, "兜底只做一次（重复触发会让症状变成'自愈跑了 N 次'）");

	// 失效且有补齐能力 → 补齐成功就换回本地
	const img6 = fakeImage(`${BASE}/cached.png`);
	processImages(
		fakeContainer([img6]),
		depsWith({ ensureLocalCopy: async () => "_attachment-cache/cached.png" })
	);
	await img6.fail();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		img6.getAttribute("src"),
		"app://local/_attachment-cache/cached.png",
		"失效但补齐成功时应换回本地副本"
	);

	// 失效且补齐失败 → 退回远端
	const img7 = fakeImage(`${BASE}/cached.png`);
	processImages(fakeContainer([img7]), depsWith({ ensureLocalCopy: async () => null }));
	await img7.fail();
	assert.equal(img7.getAttribute("src"), `${BASE}/cached.png`, "补齐失败要退回远端");

	// ============================================================
	// 6. 幂等：重复处理同一个元素不会多次挂监听器
	// ============================================================
	const img8 = fakeImage(`${BASE}/cached.png`);
	const deps = depsWith();
	processImages(fakeContainer([img8]), deps);
	processImages(fakeContainer([img8]), deps);
	processImages(fakeContainer([img8]), deps);
	assert.equal(img8.listenerCount("error"), 1, "★ 重复处理只该挂一个监听器（否则自愈会被触发多次）");
	assert.equal(img8.getAttribute("src"), "app://local/_attachment-cache/cached.png");

	// ============================================================
	// 7. 空容器 / 形状不对的输入不抛错（渲染路径抛错会毁掉整篇笔记）
	// ============================================================
	for (const [label, root] of [
		["null", null],
		["undefined", undefined],
		["没有 querySelectorAll", {}],
		["querySelectorAll 返回 undefined", { querySelectorAll: () => undefined }],
		["列表里有 null 元素", fakeContainer([null])],
		["元素没有 getAttribute", fakeContainer([{ setAttribute() {} }])],
	]) {
		let thrown = null;
		try {
			processImages(root, deps);
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown, null, `${label} 不该抛错`);
	}

	// ============================================================
	// 8. 实时预览的 setter 拦截：`src` 被赋成远端地址时，落到元素上的是本地地址
	//
	// 这是"编辑态离线可用"的关键 —— 如果没有这一层，用户在离线时编辑笔记
	// 会看到满屏破图。
	// ============================================================
	const { view, restore } = makeFakeImageElementClass();
	// 补齐结果可切换：既测"补齐成功→换本地"，也测"补齐失败→退回远端"
	let fetchResult = "_attachment-cache/missing.png";
	// 实时预览这条路径也要记"刚被看到"（编辑态里看图是最常见的场景）
	const touchedInPreview = [];
	const patchDeps = depsWith({
		ensureLocalCopy: async () => fetchResult,
		onLocalCopyUsed: (key) => touchedInPreview.push(key),
	});
	const uninstall = installImageSrcPatch(patchDeps, { view });

	const el = new view.HTMLImageElement();
	el.src = `${BASE}/cached.png`;
	assert.equal(
		el.getAttribute("src"),
		"app://local/_attachment-cache/cached.png",
		"★ 实时预览里赋远端地址，元素上应当是本地地址（远端地址从未进入元素）"
	);
	assert.deepEqual(
		touchedInPreview,
		["cached.png"],
		"★ 实时预览换成副本时同样要记下「刚被看到」（否则编辑态看的图永远不会被认为常用）"
	);

	// 站外地址原样通过
	const el2 = new view.HTMLImageElement();
	el2.src = "https://other.example.net/a.png";
	assert.equal(el2.getAttribute("src"), "https://other.example.net/a.png", "站外地址不该被改");

	// 本地地址二次赋值（我们自己写回去的）不该被再改一次
	const el3 = new view.HTMLImageElement();
	el3.src = "app://local/_attachment-cache/cached.png";
	assert.equal(el3.getAttribute("src"), "app://local/_attachment-cache/cached.png", "本地地址应原样通过（幂等）");

	// 属于本存储但本地没有 → 赋值保持远端（用户立刻看得到），后台补齐后再换成 local
	const el4 = new view.HTMLImageElement();
	el4.src = `${BASE}/missing.png`;
	assert.equal(el4.getAttribute("src"), `${BASE}/missing.png`, "缺本地副本时先按远端显示（在线立刻可见）");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(
		el4.getAttribute("src"),
		"app://local/_attachment-cache/missing.png",
		"补齐完成后应换成本地副本"
	);

	// ⭐ 编辑器重渲染会对**同一个元素**再赋一次同样的远端地址 ——
	// 那时 src 不是本地地址，判定仍会命中，所以这条路径**真的需要**"只挂一次"的守卫。
	const el7 = new view.HTMLImageElement();
	el7.src = `${BASE}/cached.png`;
	el7.src = `${BASE}/cached.png`;
	assert.equal(
		el7.listenerCount("error"),
		1,
		"★ 重复赋同一个远端地址只该挂一个兜底（否则一次失败会触发多次自愈）"
	);

	// 失效兜底：本地加载失败 → 退回远端
	fetchResult = null; // 补齐也失败 → 只能退回远端
	const el5 = new view.HTMLImageElement();
	el5.src = `${BASE}/cached.png`;
	await el5.fail();
	assert.equal(el5.getAttribute("src"), `${BASE}/cached.png`, "★ 实时预览路径也要能退回远端");

	// 卸载必须把原 setter 放回去 —— 否则卸载后仍在改全局 prototype
	uninstall();
	const el6 = new view.HTMLImageElement();
	el6.src = `${BASE}/cached.png`;
	assert.equal(el6.getAttribute("src"), `${BASE}/cached.png`, "★ 卸载后不该再改任何地址");
	restore();

	// 环境没有 HTMLImageElement 时不该抛错（某些测试环境/未来宿主）
	let patchThrown = null;
	try {
		installImageSrcPatch(depsWith(), { view: null })();
		installImageSrcPatch(depsWith(), { view: {} })();
	} catch (error) {
		patchThrown = error;
	}
	assert.equal(patchThrown, null, "拿不到 prototype 时应静默跳过，而不是抛错");

	console.log(
		"Render hook passed (index hit → local src with the remote URL never written; third-party/local/data ignored; " +
			"no usable local path → nothing written; missing copy → download then swap; local file gone → fall back to " +
			"remote exactly once; idempotent; preview `src` setter interception with uninstall)."
	);
}

/**
 * 造一个"像浏览器那样"的 `HTMLImageElement` —— **刻意用原型上的访问器**，
 * 而不是普通属性。
 *
 * 理由和"假 File 要用原型 getter"一样：被替换成普通属性的话，
 * 被测代码里对 setter 的拦截就无从验证（`Object.getOwnPropertyDescriptor`
 * 拿不到访问器，patch 会静默跳过），于是"实时预览可用"成了一句空话。
 */
function makeFakeImageElementClass() {
	const listeners = new Map();
	const proto = {
		get src() {
			return this._src;
		},
		set src(value) {
			this._src = value;
			// 浏览器里赋值即开始加载；这里只记录，供断言
			this.assigned = value;
		},
		getAttribute(name) {
			return name === "src" ? this._src ?? null : null;
		},
		setAttribute(name, value) {
			if (name === "src") this._src = value;
		},
		addEventListener(type, callback) {
			const key = `${type}`;
			if (!listeners.has(this)) listeners.set(this, new Map());
			const own = listeners.get(this);
			if (!own.has(key)) own.set(key, []);
			own.get(key).push(callback);
		},
		async fail() {
			for (const callback of listeners.get(this)?.get("error") ?? []) await callback();
		},
		listenerCount(type) {
			return (listeners.get(this)?.get(type) ?? []).length;
		},
	};
	const HTMLImageElement = function HTMLImageElement() {};
	HTMLImageElement.prototype = proto;
	return {
		view: { HTMLImageElement },
		restore() {
			listeners.clear();
		},
	};
}
