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
	attachmentFolder: "",
	localCopy: "cache",
	cacheFolder: "_attachment-cache",
	fallbackDownload: true,
	externalImageCache: false,
	externalImageDefault: "skip",
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

	return { cases: 9 };
}
