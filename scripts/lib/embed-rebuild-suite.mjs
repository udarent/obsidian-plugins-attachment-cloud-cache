/**
 * 非图片可预览附件的**节点重建**（`src/render/embed-rebuild.ts`）的断言套件。
 *
 * ## 这套断言为什么值得单独写
 *
 * 宿主把远端 `![doc.pdf](url)` 渲染成 `<img>`（元素类型本身就是错的），
 * 所以"能不能离线预览 PDF/音频/视频"完全取决于这一层。它坏掉的两类症状都很隐蔽：
 *
 * - **改 `src` 而不是换节点** ⇒ 用户看到一张坏图，而代码里没有任何报错
 *   （这正是 1.1.0 之前的样子）；
 * - **把远端地址写进元素** ⇒ 离线时请求发出去了、图还是不出来，
 *   而"零远端请求"是这个插件的主承诺之一。
 *
 * ⚠️ 所以这里除了"换了没有"，还必须断言**从来没有把 http(s) 值写进元素**。
 */

import assert from "node:assert/strict";

/** 假元素：记下每一次 `setAttribute`，用来断言"远端地址一次都没被写进去"。 */
function makeElement({ src = "", parent = null, mark = null } = {}) {
	const attrs = new Map();
	if (src) attrs.set("src", src);
	if (mark) attrs.set("data-acc-embed", mark);
	const writes = [];
	const element = {
		writes,
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		setAttribute: (name, value) => {
			writes.push([name, String(value)]);
			attrs.set(name, String(value));
		},
		removeAttribute: (name) => attrs.delete(name),
	};
	if (parent) element.parentNode = parent;
	return element;
}

function makeParent(replaced) {
	return {
		replaceChild: (next, old) => {
			replaced.push({ next, old });
			return old;
		},
	};
}

const SETTINGS = {
	autoUpload: true,
	localCopy: "cache",
	fallbackDownload: true,
	externalImageCache: false,
	externalSiteMode: "off",
	externalSiteList: [],
	cacheLimitMb: 0,
	s3: {
		endpoint: "https://s3.example.com",
		region: "auto",
		bucket: "b",
		publicUrlBase: "https://img.example.com",
		accessKeyId: "",
		secretAccessKeyRef: "",
		forcePathStyle: true,
	},
};

/**
 * 索引替身。
 *
 * ⚠️ 判定层要的是 `findByRemoteUrl`（它按 **URL** 找副本），而重建那一层要的是
 * `findByCachePath` —— 两者都要有，否则要么判定抛错、要么读不到副本。
 * 这正是"替身要比被测代码更懂宿主"的反面：替身只实现**真的会被调到的**方法。
 */
function makeIndex(entries = []) {
	return {
		get: (key) => entries.find((entry) => entry.key === key),
		findByCachePath: (path) => entries.find((entry) => entry.cachePath === path),
		findByRemoteUrl: (url) => entries.find((entry) => entry.remoteUrl === url),
		set: () => {},
		remove: () => false,
		size: entries.length,
	};
}

function makeDeps(overrides = {}) {
	const entries = [
		{
			key: "hash.pdf",
			cachePath: "_attachment-cache/hash.pdf",
			remoteUrl: "https://img.example.com/hash.pdf",
			size: 10,
			contentType: "application/pdf",
			etag: "e",
			uploadedAt: "2026-10-09T00:00:00.000Z",
			lastUsedAt: 0,
			sourceName: "doc.pdf",
		},
		{
			key: "hash.png",
			cachePath: "_attachment-cache/hash.png",
			remoteUrl: "https://img.example.com/hash.png",
			size: 10,
			contentType: "image/png",
			etag: "e",
			uploadedAt: "2026-10-09T00:00:00.000Z",
			lastUsedAt: 0,
			sourceName: "pic.png",
		},
	];
	// ⚠️ `index` 单独取：它是**闭包要用的对象**，不能跟着 `...overrides` 一起摊开 ——
	// 直接摊开的话 `overrides.index`（一个对象）会覆盖掉下面这个函数，
	// 而报错会是 "deps.index is not a function"（与"索引内容不对"完全是两回事）。
	const index = overrides.indexEntries ? makeIndex(overrides.indexEntries) : makeIndex(entries);
	let flushFn = null;
	// ⚠️ 可替换的项用**专用键名**（`renderEmbedImpl`），不叫 `renderEmbed`：
	// 同名的话要么被这里的默认值覆盖（测试静默测了错的对象），
	// 要么就得把默认值摊在后面（那 `index` 又会被覆盖成对象）。
	const deps = {
		settings: () => SETTINGS,
		index: () => index,
		resourceUrlFor: (path) => `app://local/${path}`,
		renderEmbed: overrides.renderEmbedImpl ?? (async (path) => ({ tag: "embed", path })),
		schedule: (flush) => {
			flushFn = flush;
		},
		...(overrides.ensureLocalCopy ? { ensureLocalCopy: overrides.ensureLocalCopy } : {}),
		...(overrides.onError ? { onError: overrides.onError } : {}),
		// 1.7.0：私有 + 不留副本那条路（预签名地址 + 自建媒体节点）
		...(overrides.accessProbe ? { accessProbe: overrides.accessProbe } : {}),
		...(overrides.signedUrlFor ? { signedUrlFor: overrides.signedUrlFor } : {}),
		...(overrides.createMediaNode ? { createMediaNode: overrides.createMediaNode } : {}),
	};
	return { deps, runFlush: () => flushFn?.() };
}

export async function runEmbedRebuildSuite(mod) {
	const {
		rebuildKindFor,
		markEmbedForRebuild,
		processEmbeds,
		createEmbedRebuildQueue,
		EMBED_MARK,
		EMBED_PATH_ATTR,
		EMBED_SOURCE_ATTR,
		EMBED_SIGNED_ATTR,
		EMBED_DIRECT_ATTR,
		EMBED_URL_ATTR,
		signedMediaKindFor,
	} = mod;

	// ============================================================
	// 1. ⭐ 判据来自**同一张可嵌入类型表**（与链接生成共用）
	// ============================================================
	assert.equal(rebuildKindFor("_attachment-cache/hash.pdf"), "pdf", "PDF 要重建");
	assert.equal(rebuildKindFor("_attachment-cache/song.mp3"), "audio", "音频要重建");
	assert.equal(rebuildKindFor("_attachment-cache/clip.mp4"), "video", "视频要重建");
	assert.equal(rebuildKindFor("_attachment-cache/pic.PNG"), null, "图片**不**重建（改 src 就够）");
	assert.equal(rebuildKindFor("_attachment-cache/pack.zip"), null, "表外类型不重建（它本来就该是普通链接）");
	assert.equal(rebuildKindFor("_attachment-cache/scan.tiff"), null, "tiff 在宿主里不可嵌入 ⇒ 不重建");
	assert.equal(rebuildKindFor("no-extension"), null, "没有扩展名 ⇒ 不重建");
	assert.equal(rebuildKindFor(null), null, "非字符串安全返回");

	// ============================================================
	// 2. 标记（防递归与"重建所需的两个输入"）
	// ============================================================
	{
		const el = makeElement();
		markEmbedForRebuild(el, "_attachment-cache/hash.pdf", "notes/a.md");
		assert.equal(el.getAttribute(EMBED_MARK), "pdf", "标记上是**类型**（也是防递归的凭据）");
		assert.equal(el.getAttribute(EMBED_PATH_ATTR), "_attachment-cache/hash.pdf", "要记下库内副本路径");
		assert.equal(el.getAttribute(EMBED_SOURCE_ATTR), "notes/a.md", "有归属时也要记下（宿主解析相对路径要用）");

		// 图片 / 表外类型 ⇒ 什么都不标（`processEmbeds` 靠这个把它们排除在外）
		const png = makeElement();
		markEmbedForRebuild(png, "_attachment-cache/hash.png", "notes/a.md");
		assert.equal(png.getAttribute(EMBED_MARK), null, "图片不该被标记");
		assert.equal(png.writes.length, 0, "不该被标记的元素一个属性都不该写");

		const noSource = makeElement();
		markEmbedForRebuild(noSource, "_attachment-cache/hash.pdf", "");
		assert.equal(noSource.getAttribute(EMBED_SOURCE_ATTR), null, "归属为空时不该写空属性");
	}

	// ============================================================
	// 3. ⭐⭐ 阅读视图那一趟：只接管非图片，且**从不写远端地址**
	// ============================================================
	{
		const pdf = makeElement({ src: "https://img.example.com/hash.pdf" });
		const png = makeElement({ src: "https://img.example.com/hash.png" });
		const foreign = makeElement({ src: "https://other.example.com/x.pdf" });
		const marked = makeElement({ src: "https://img.example.com/hash.pdf", mark: "pdf" });
		const root = { querySelectorAll: () => [pdf, png, foreign, marked] };

		const { deps } = makeDeps();
		const queue = createEmbedRebuildQueue(deps);
		const taken = processEmbeds(root, deps, "notes/a.md", queue);

		assert.equal(taken, 1, "只有「我们自己存储里的 PDF」被接管");
		assert.equal(pdf.getAttribute(EMBED_MARK), "pdf", "被接管的元素要打标记");
		assert.equal(queue.pending(), 1, "要交给队列（真正的替换在微任务里做）");
		assert.equal(png.getAttribute(EMBED_MARK), null, "★ 图片**不**在这一层处理（改 src 那条路更便宜）");
		assert.equal(foreign.getAttribute(EMBED_MARK), null, "站外地址不碰");
		assert.equal(marked.getAttribute(EMBED_MARK), "pdf", "已标记的元素保持原样");

		// ⭐⭐ 结构性性质：远端地址**从来没有**被写进元素
		for (const element of [pdf, png, foreign, marked]) {
			for (const [name, value] of element.writes) {
				assert.ok(
					!/^https?:/i.test(value),
					`★ 绝不能把远端地址写进元素（${name}=${value}）—— 那会让离线时也发出请求`
				);
			}
		}
		assert.equal(
			pdf.getAttribute("src"),
			"app://local/_attachment-cache/hash.pdf",
			"接管时写的是**本地**地址（不是远端）"
		);
	}

	// ============================================================
	// 4. 队列：渲染 → 替换节点（在元素有父节点之后）
	// ============================================================
	{
		const replaced = [];
		const el = makeElement({ src: "app://local/_attachment-cache/hash.pdf", parent: makeParent(replaced) });
		const { deps, runFlush } = makeDeps({
			renderEmbedImpl: async (path, sourcePath) => ({ tag: "embed", path, sourcePath }),
		});
		const queue = createEmbedRebuildQueue(deps);
		queue.see(el, "_attachment-cache/hash.pdf", "notes/a.md");
		assert.equal(queue.pending(), 1, "先攒着");
		assert.equal(replaced.length, 0, "微任务之前不该动 DOM");

		runFlush();
		await Promise.resolve();
		await Promise.resolve();

		assert.equal(replaced.length, 1, "要真的替换掉原元素");
		assert.equal(replaced[0].old, el, "替换的是那个元素本身");
		assert.equal(replaced[0].next.path, "_attachment-cache/hash.pdf", "用的是库内副本路径");
		assert.equal(replaced[0].next.sourcePath, "notes/a.md", "归属要透传给渲染器（相对路径解析要用）");
	}

	// ============================================================
	// 5. ⭐ 拿不到父节点 ⇒ **什么都不做**（不许"先删后插"）
	//
	// 赋值那一刻元素常常还没进 DOM（真机实测）。此时若先删掉原元素，
	// 用户会看到"内容消失"的中间态；而保留它，下一轮编辑器重渲染还会再走一遍。
	// ============================================================
	{
		const replaced = [];
		const el = makeElement({ src: "app://local/_attachment-cache/hash.pdf" }); // 没有 parentNode
		const { deps, runFlush } = makeDeps();
		const queue = createEmbedRebuildQueue(deps);
		queue.see(el, "_attachment-cache/hash.pdf", null);
		runFlush();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced.length, 0, "没有父节点时不该替换");
		assert.equal(el.getAttribute("src"), "app://local/_attachment-cache/hash.pdf", "原元素必须原封不动");
	}

	// ============================================================
	// 6. 渲染不出节点 ⇒ **保留原元素**（宁可差一点，也不要空一格）
	// ============================================================
	{
		const replaced = [];
		const el = makeElement({ parent: makeParent(replaced) });
		const { deps, runFlush } = makeDeps({ renderEmbedImpl: async () => null });
		const queue = createEmbedRebuildQueue(deps);
		queue.see(el, "_attachment-cache/hash.pdf", null);
		runFlush();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced.length, 0, "渲染不出来时不得替换成空");
	}

	// 渲染器**抛错**同样只是保留原元素（并且要能被记录到）
	{
		const replaced = [];
		const errors = [];
		const el = makeElement({ parent: makeParent(replaced) });
		const { deps, runFlush } = makeDeps({
			renderEmbedImpl: async () => {
				throw new Error("渲染器炸了");
			},
			onError: (error) => errors.push(String(error)),
		});
		const queue = createEmbedRebuildQueue(deps);
		queue.see(el, "_attachment-cache/hash.pdf", null);
		runFlush();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced.length, 0, "抛错时也要保留原元素");
		assert.ok(errors.length >= 1, "但必须被记下来（否则这类失败永远查不出来）");
	}

	// ============================================================
	// 7. 单个元素失败不拖垮整批
	// ============================================================
	{
		const replaced = [];
		let call = 0;
		const first = makeElement({ parent: makeParent(replaced) });
		const second = makeElement({ parent: makeParent(replaced) });
		const { deps, runFlush } = makeDeps({
			renderEmbedImpl: async (path) => {
				call += 1;
				if (call === 1) throw new Error("第一个炸了");
				return { tag: "embed", path };
			},
		});
		const queue = createEmbedRebuildQueue(deps);
		queue.see(first, "_attachment-cache/hash.pdf", null);
		queue.see(second, "_attachment-cache/hash.pdf", null);
		runFlush();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced.length, 1, "第二个必须照样被重建（一个失败不能拖垮整批）");
	}

	// ============================================================
	// 8. 同批内同一个元素只处理一次；dispose 之后不再做任何事
	// ============================================================
	{
		const replaced = [];
		const el = makeElement({ parent: makeParent(replaced) });
		const { deps, runFlush } = makeDeps();
		const queue = createEmbedRebuildQueue(deps);
		queue.see(el, "_attachment-cache/hash.pdf", null);
		queue.see(el, "_attachment-cache/hash.pdf", null);
		assert.equal(queue.pending(), 1, "同一批里同一个元素只算一次（编辑器重渲染会重复赋值）");
		runFlush();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced.length, 1, "只替换一次");

		queue.see(el, "_attachment-cache/hash.pdf", null);
		queue.dispose();
		runFlush();
		await Promise.resolve();
		assert.equal(replaced.length, 1, "dispose 之后不再替换（插件卸载后不该继续改 DOM）");
	}

	// ============================================================
	// 9. ⭐ "没有本地副本"那一档：先补齐，补上了才标记
	//
	// 换设备 / 缓存被清时走这条。⚠️ 这一步**不写 `src`**：用户看到的是"等一会儿"，
	// 而不是一张坏图，更不会因此去连远端。
	// ============================================================
	{
		const el = makeElement({ src: "https://img.example.com/hash.pdf" }); // 索引里没有这条
		const empty = makeDeps({ indexEntries: [] });
		let asked = 0;
		const deps = {
			...empty.deps,
			ensureLocalCopy: async () => {
				asked += 1;
				return "_attachment-cache/hash.pdf";
			},
		};
		const queue = createEmbedRebuildQueue(deps);
		const taken = processEmbeds({ querySelectorAll: () => [el] }, deps, "notes/a.md", queue);
		assert.equal(taken, 1, "没有副本时也要接管（否则用户永远看不到它）");

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(asked, 1, "要真的去补一次");
		assert.equal(el.getAttribute("src"), "https://img.example.com/hash.pdf", "补齐期间不改 src（保留原状）");
		assert.equal(el.getAttribute(EMBED_MARK), "pdf", "补上之后才标记");
	}

	// 补不上 ⇒ 不标记（保持原样，在线仍可见）
	{
		const el = makeElement({ src: "https://img.example.com/hash.pdf" });
		const empty = makeDeps({ indexEntries: [] });
		const deps = { ...empty.deps, ensureLocalCopy: async () => null };
		const queue = createEmbedRebuildQueue(deps);
		processEmbeds({ querySelectorAll: () => [el] }, deps, "notes/a.md", queue);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(el.getAttribute(EMBED_MARK), null, "补不上就不该标记（免得渲染一个坏节点）");
	}

	// ============================================================
	// 10. ⭐ 1.7.0：私有存储 + 不留副本 ⇒ 音频/视频用**预签名地址**自建节点
	//
	// 用户 2026-10-17 的追问（"S3 不支持远程视频吗？"）之后真机量过：远端 `![]()` 全是 `<img>`，
	// 但自建 `<video src="<签名地址>">` 能真播（真机量过：`loadeddata` 64ms、640x360、能 play）。
	// 这条路的判据与图片那条**同一个**（`usesSignedUrls`）；这里只测"换了什么节点"。
	// ============================================================
	{
		// 判据表：音频/视频能救，PDF 与图片不能
		assert.equal(signedMediaKindFor("clip.mp4"), "video", "mp4 ⇒ 视频");
		assert.equal(signedMediaKindFor("clip.webm"), "video", "webm ⇒ 视频");
		assert.equal(signedMediaKindFor("song.mp3"), "audio", "mp3 ⇒ 音频");
		assert.equal(signedMediaKindFor("voice.m4a"), "audio", "m4a ⇒ 音频");
		assert.equal(signedMediaKindFor("doc.pdf"), null, "★ PDF 救不了（pdf.js 只吃库内路径）");
		assert.equal(signedMediaKindFor("pic.png"), null, "图片不走这条路（改 src 就够）");

		const privateTrash = { ...SETTINGS, linkAccess: "private", localCopy: "trash" };
		const signedUrl = "https://s3.example.com/b/clip.mp4?X-Amz-Signature=abc";
		const made = [];
		const signedCalls = [];

		// ① 视频：标记 + 排队 + 造 <video> + 替换原元素
		const el = makeElement({ src: "https://img.example.com/clip.mp4" });
		const replaced = [];
		el.parentNode = makeParent(replaced);
		const h = makeDeps({
			accessProbe: () => ({ kind: "unknown", status: null, at: 0 }),
			signedUrlFor: async (key) => {
				signedCalls.push(key);
				return signedUrl;
			},
			createMediaNode: (kind, url) => {
				made.push({ kind, url });
				return { tag: kind, url };
			},
		});
		const deps = { ...h.deps, settings: () => privateTrash };
		const queue = createEmbedRebuildQueue(deps);
		const taken = processEmbeds({ querySelectorAll: () => [el] }, deps, "notes/a.md", queue);

		assert.equal(taken, 1, "★ 私有 + 不留副本时，视频那一格要交给重建");
		assert.equal(el.getAttribute(EMBED_SIGNED_ATTR), "1", "★ 要标明这一格走签名（不是库内副本）");
		assert.equal(el.getAttribute(EMBED_PATH_ATTR), "clip.mp4", "记的是 key（没有本地文件）");
		assert.equal(el.getAttribute("src"), "https://img.example.com/clip.mp4", "同步阶段不改 src（远端地址不主动写）");

		h.runFlush();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		assert.deepEqual(signedCalls, ["clip.mp4"], "★ 按 key 签一次");
		assert.deepEqual(made, [{ kind: "video", url: signedUrl }], "★ 造的是 <video>，地址是那条预签名地址");
		assert.equal(replaced.length, 1, "原元素要被替换掉（否则用户只看到坏图）");
		assert.equal(replaced[0]?.next?.tag, "video", "替换上去的是视频节点");

		// ② PDF：同一档下**跳过**（救不了，如实留原样）
		const pdf = makeElement({ src: "https://img.example.com/doc.pdf" });
		pdf.parentNode = makeParent([]);
		const h2 = makeDeps({ accessProbe: () => ({ kind: "forbidden", status: 403, at: 1 }) });
		const deps2 = {
			...h2.deps,
			settings: () => privateTrash,
			signedUrlFor: async () => "https://x/y.pdf?sig=1",
			createMediaNode: () => ({ tag: "video" }),
		};
		const queue2 = createEmbedRebuildQueue(deps2);
		const takenPdf = processEmbeds({ querySelectorAll: () => [pdf] }, deps2, null, queue2);
		assert.equal(takenPdf, 0, "★ PDF 在「不留副本」下救不了 ⇒ 不接管（宁可留个坏图，也不造一个错节点）");
		assert.equal(pdf.getAttribute(EMBED_SIGNED_ATTR), null, "PDF 不该被标记");

		// ③ 签不出来 ⇒ 保留原元素（不替换、不空一格）
		const el3 = makeElement({ src: "https://img.example.com/clip.mp4" });
		const replaced3 = [];
		el3.parentNode = makeParent(replaced3);
		const h3 = makeDeps({
			accessProbe: () => ({ kind: "forbidden", status: 403, at: 1 }),
			signedUrlFor: async () => null,
			createMediaNode: () => ({ tag: "video" }),
		});
		const deps3 = { ...h3.deps, settings: () => privateTrash };
		const queue3 = createEmbedRebuildQueue(deps3);
		processEmbeds({ querySelectorAll: () => [el3] }, deps3, null, queue3);
		h3.runFlush();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(replaced3.length, 0, "★ 签不出来就不替换（保留原元素）");

		// ④ 公开读取下**不许签名**，但仍然要接管音频/视频 —— 用远端地址**直连**。
		// ⭐ 这一格是 2026-10-17 评审时补的：公开桶的字节谁都取得到，宿主的 `<img>`
		// 却播不了视频 ⇒ 不给这条来路，「公开 + 不留副本」的音视频一帧都放不出来。
		{
			const el4 = makeElement({ src: "https://img.example.com/clip.mp4" });
			let signedCalls = 0;
			const made4 = [];
			const h4 = makeDeps({
				accessProbe: () => ({ kind: "ok", status: 200, at: 1 }),
				signedUrlFor: async () => {
					signedCalls += 1;
					return "https://x/y.mp4?sig=1";
				},
				createMediaNode: (kind, url) => {
					made4.push({ kind, url });
					return { tag: kind };
				},
			});
			const deps4 = { ...h4.deps, settings: () => ({ ...SETTINGS, linkAccess: "public", localCopy: "trash" }) };
			const replaced4 = [];
			el4.parentNode = makeParent(replaced4);
			const queue4 = createEmbedRebuildQueue(deps4);
			const taken4 = processEmbeds({ querySelectorAll: () => [el4] }, deps4, null, queue4);
			assert.equal(taken4, 1, "★ 公开 + 不留副本：音频/视频仍要接管（否则播不了）");
			assert.equal(el4.getAttribute(EMBED_DIRECT_ATTR), "1", "★ 标记成**直连**（不是签名那条路）");
			assert.equal(
				el4.getAttribute(EMBED_URL_ATTR),
				"https://img.example.com/clip.mp4",
				"直连要记下笔记里那条地址本身"
			);
			assert.equal(el4.getAttribute(EMBED_SIGNED_ATTR), null, "直连不许同时挂签名标记（两条来路互斥）");

			h4.runFlush();
			for (let i = 0; i < 4; i += 1) await Promise.resolve();
			assert.equal(signedCalls, 0, "★ 公开读取时一次都不许签名（签了只是多一个过期窗口）");
			assert.deepEqual(
				made4,
				[{ kind: "video", url: "https://img.example.com/clip.mp4" }],
				"★ 造节点用的是那条远端地址本身"
			);
			assert.equal(replaced4.length, 1, "原元素要被换掉");
		}

		// ⑤ 同一档下的**图片**不接管：远端 `src` 本来就能显示，换节点是多此一举。
		{
			const el5 = makeElement({ src: "https://img.example.com/pic.png" });
			const h5 = makeDeps({ accessProbe: () => ({ kind: "ok", status: 200, at: 1 }) });
			const deps5 = { ...h5.deps, settings: () => ({ ...SETTINGS, linkAccess: "public", localCopy: "trash" }) };
			const queue5 = createEmbedRebuildQueue(deps5);
			assert.equal(
				processEmbeds({ querySelectorAll: () => [el5] }, deps5, null, queue5),
				0,
				"★ 公开 + 不留副本的图片不进重建（直连只服务音频/视频）"
			);
		}

		// ⑥ PDF 在公开档同样救不了（它要 pdf.js + 库内路径，与签名无关）。
		{
			const el6 = makeElement({ src: "https://img.example.com/doc.pdf" });
			const h6 = makeDeps({ accessProbe: () => ({ kind: "ok", status: 200, at: 1 }) });
			const deps6 = { ...h6.deps, settings: () => ({ ...SETTINGS, linkAccess: "public", localCopy: "trash" }) };
			const queue6 = createEmbedRebuildQueue(deps6);
			assert.equal(
				processEmbeds({ querySelectorAll: () => [el6] }, deps6, null, queue6),
				0,
				"★ 公开 + 不留副本的 PDF 不接管（造一个播不了的东西更糟）"
			);
		}
	}

	return { cases: 10 };
}
