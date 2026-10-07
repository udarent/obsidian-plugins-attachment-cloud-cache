/**
 * 站外图搬进自己存储（`src/core/external-cache.ts`）的断言套件。
 *
 * ## 为什么必须真实 HTTP + 真实磁盘 + 真实 S3 替身
 *
 * 这一层要保证的性质没有一条能在 mock 层面成立：
 * - 「**未经同意一个请求都不发**」→ 必须**数真实请求**（连假图床的日志都要看）；
 * - 「密钥/防盗链要能被区分开」→ 必须有真的 403、真的 HTML 回包；
 * - 「字节逐字节落到磁盘」→ 必须真读那个文件；
 * - 「另一个站点的同名图不被误改」→ 必须有真的两串 URL 在同一篇笔记里。
 *
 * ## 边界比功能更重要
 *
 * 这是全库唯一会下载**别人的图**的地方，也是唯一会**改写用户笔记**的地方。
 * 所以断言的重点是"什么情况下它什么都不做"，以及"做了一半时有没有如实报出来"。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cleanupInBackground } from "./cleanup.mjs";
import { createAppMock } from "./mock-obsidian.mjs";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "ext-bucket";
const NOW = new Date("2026-10-07T12:00:00Z");

/** 含合法 PNG 头 + 会被文本通道改掉的字节。 */
const IMAGE_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f,
]);

const sha256Hex = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/**
 * 一个假的"站外图床"，用真实 HTTP 提供各种响应形态。
 *
 * `/slow.png` **永不回包**是用来造超时的 —— 所以关闭时必须先掐掉连接，
 * 否则 `server.close()` 会一直等它。
 */
function createImageHost() {
	const requests = [];
	const sockets = new Set();
	const server = createServer((req, res) => {
		const path = req.url.split("?")[0];
		requests.push(path);

		if (path === "/a.png" || path === "/other/a.png") {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(Buffer.from(IMAGE_BYTES));
			return;
		}
		if (path === "/notype.png") {
			// 刻意不给 content-type：有些图床确实这样，必须靠扩展名兜底
			res.writeHead(200);
			res.end(Buffer.from(IMAGE_BYTES));
			return;
		}
		if (path === "/notype.txt") {
			res.writeHead(200);
			res.end("just text");
			return;
		}
		if (path === "/page.html") {
			// 防盗链的典型回包：200 但给一个 HTML 页
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end("<html><body>hotlink blocked</body></html>");
			return;
		}
		if (path === "/blocked.png") {
			res.writeHead(403, { "content-type": "text/html" });
			res.end("forbidden");
			return;
		}
		if (path === "/missing.png") {
			res.writeHead(404);
			res.end();
			return;
		}
		if (path === "/boom.png") {
			res.writeHead(500);
			res.end("server error");
			return;
		}
		if (path === "/moved.png") {
			res.writeHead(302, { location: "/a.png" });
			res.end();
			return;
		}
		if (path === "/slow.png") {
			return; // 永不回包 → 触发超时
		}
		res.writeHead(404);
		res.end();
	});

	// ⚠️ 显式跟踪连接，收尾时逐个销毁。
	// 光靠 `closeAllConnections()` 不够可靠：`/slow.png` 那条请求永不回包，
	// 挂起的 socket 会让 `server.close()` 一直等下去 —— 表现为"测试全绿但进程不退出"，
	// 而且是否发生取决于时序（偶发），最难查。
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	return {
		requests,
		async start() {
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			return `http://127.0.0.1:${server.address().port}`;
		},
		async close() {
			server.closeAllConnections?.();
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * 用真实 `fetch` 实现宿主的 `requestUrl`（`arrayBuffer` 是**属性**，不是方法）。
 *
 * ⚠️ 这里带一个**真正的超时**（`AbortController`），不是装饰：
 * 被测代码那侧的 `Promise.race` 只是"我们不等了"，**请求本身仍在飞** ——
 * 于是那条永不回包的 socket 会在进程收尾时把事件循环吊住，测试全绿却不退出。
 * 让测试用的传输在超时后**真的取消**请求，这个坑才关得上。
 */
function fetchRequest(options = {}) {
	const timeoutMs = options.timeoutMs ?? 1200;
	return async (request) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(request.url, {
				method: request.method ?? "GET",
				// 刻意不跟随重定向：本项目把 3xx 当失败，跟随之后会得到一个难以解释的结果
				redirect: "manual",
				signal: controller.signal,
			});
			const headers = {};
			response.headers.forEach((value, name) => {
				headers[name.toLowerCase()] = value;
			});
			return {
				status: response.status,
				headers,
				arrayBuffer: await response.arrayBuffer(),
				text: "",
				json: null,
			};
		} finally {
			clearTimeout(timer);
		}
	};
}


export async function runExternalCacheSuite(mod) {
	const {
		MAX_EXTERNAL_BYTES,
		shouldReportExternalFailure,
		localCopyForExternal,
		isImageResponse,
		headerOf,
		mimeFromContentType,
		extensionFromUrl,
		fileNameFromUrl,
		fetchExternalImage,
		createExternalCacher,
	} = mod;
	const { S3Client, CacheIndex } = mod;

	// ============================================================
	// 0. 纯函数先穷举（它们最容易写反，且写反了症状很隐蔽）
	// ============================================================
	assert.equal(headerOf({ "Content-Type": "image/png" }, "content-type"), "image/png", "★ 取头要大小写不敏感");
	assert.equal(headerOf({ "content-type": " image/png " }, "Content-Type"), "image/png", "要 trim");
	assert.equal(headerOf({}, "content-type"), "", "没有该头 → 空串");
	assert.equal(headerOf(null, "content-type"), "", "headers 为 null 不能抛错");
	assert.equal(headerOf({ "content-type": 42 }, "content-type"), "", "非字符串值 → 空串");

	assert.equal(mimeFromContentType("image/png; charset=x"), "image/png", "要去掉参数");
	assert.equal(mimeFromContentType("IMAGE/PNG"), "image/png", "要归一大小写");
	assert.equal(mimeFromContentType(undefined), "", "非字符串 → 空串");

	assert.equal(extensionFromUrl("https://x.com/a.png?v=1#f"), "png", "★ 扩展名要切掉查询串与锚点");
	assert.equal(extensionFromUrl("https://x.com/a.PNG"), "png", "大小写归一");
	assert.equal(extensionFromUrl("https://x.com/a"), "", "没有扩展名");
	assert.equal(extensionFromUrl(null), "", "非字符串");

	assert.equal(fileNameFromUrl("https://x.com/dir/a%20b.png"), "a b.png", "★ 文件名要百分号解码");
	assert.equal(fileNameFromUrl("https://x.com/dir/"), undefined, "只到目录 → 交给调用方兜底");
	assert.equal(fileNameFromUrl("nonsense"), undefined, "不是 URL → 兜底");
	assert.equal(fileNameFromUrl("https://x.com/a%zz.png"), undefined, "★ 畸形编码不能抛错");

	const exts = ["png", "jpg"];
	for (const [label, contentType, url, want] of [
		["image/png", "image/png", "https://x.com/a.png", true],
		["image/svg+xml", "image/svg+xml", "https://x.com/a.svg", true],
		["带参数", "image/webp; q=1", "https://x.com/a.webp", true],
		["HTML（防盗链回包）", "text/html", "https://x.com/a.png", false],
		["有类型但不是图片", "application/octet-stream", "https://x.com/a.png", false],
		["无类型 + 已启用的扩展名", "", "https://x.com/a.png", true],
		["无类型 + 未启用的扩展名", "", "https://x.com/a.webp", false],
		["无类型 + 没有扩展名", "", "https://x.com/a", false],
	]) {
		assert.equal(
			isImageResponse({ contentType, url, imageExtensions: exts }),
			want,
			`isImageResponse（${label}）`
		);
	}

	assert.equal(localCopyForExternal("trash"), "cache", "★ trash 要改成 cache（否则离线看不见，且症状不可见）");
	assert.equal(localCopyForExternal("keep"), "keep", "keep 有本地副本，不必改");
	assert.equal(localCopyForExternal("cache"), "cache", "cache 原样");

	for (const status of ["fetch-timeout", "fetch-network", "fetch-failed", "refused", "unavailable", "cached"]) {
		assert.equal(shouldReportExternalFailure(status), false, `★ ${status} 应静默（离线/没做，不是故障）`);
	}
	for (const status of [
		"fetch-forbidden",
		"fetch-missing",
		"not-image",
		"too-large",
		"upload-failed",
		"cached-no-rewrite",
		"no-note",
	]) {
		assert.equal(shouldReportExternalFailure(status), true, `${status} 应提示（用户能行动，或需要知道只做了一半）`);
	}

	// ============================================================
	// 1. 下载层：对着真实假图床，逐种响应形态
	// ============================================================
	const host = createImageHost();
	const base = await host.start();
	const request = fetchRequest();
	const fetchDeps = { request, imageExtensions: ["png"], timeoutMs: 1500 };

	const ok = await fetchExternalImage(`${base}/a.png`, fetchDeps);
	assert.equal(ok.status, "ok", "正常图片应下载成功");
	assert.deepEqual(ok.bytes, IMAGE_BYTES, "★ 字节要逐字节一致");
	assert.equal(ok.contentType, "image/png", "要带上 MIME（上传时要用）");

	for (const [label, path, want] of [
		["403（防盗链）", "/blocked.png", "forbidden"],
		["404（图没了）", "/missing.png", "missing"],
		["500", "/boom.png", "failed"],
		["302（未跟随重定向一律当失败）", "/moved.png", "failed"],
		["200 但回 HTML", "/page.html", "not-image"],
		["200 但无类型头且扩展名未启用", "/notype.txt", "not-image"],
	]) {
		const result = await fetchExternalImage(`${base}${path}`, fetchDeps);
		assert.equal(result.status, want, `★ ${label} 应判成 ${want}（实际 ${result.status}）`);
	}

	assert.equal(
		(await fetchExternalImage(`${base}/notype.png`, fetchDeps)).status,
		"ok",
		"★ 没有类型头时要靠扩展名兜底（有些图床就是不给）"
	);
	assert.equal(
		(await fetchExternalImage(`${base}/slow.png`, { ...fetchDeps, timeoutMs: 300 })).status,
		"timeout",
		"★ 超时必须能兜住（`requestUrl` 没有 timeout 参数）"
	);
	assert.equal(
		(await fetchExternalImage(`${base}/a.png`, { ...fetchDeps, maxBytes: 4 })).status,
		"too-large",
		"★ 超过上限要拒绝上传"
	);

	// 连不上的端口 → 网络错误（与"图没了"必须区分开：一个静默、一个提示）
	const throwaway = createImageHost();
	const deadBase = await throwaway.start();
	await throwaway.close();
	assert.equal(
		(await fetchExternalImage(`${deadBase}/a.png`, { ...fetchDeps, timeoutMs: 800 })).status,
		"network",
		"★ 连不上应判为 network（离线时的正常表现，要静默）"
	);

	await host.close();

	const liveHost = createImageHost();
	const liveBase = await liveHost.start();

	// ============================================================
	// 2. 执行层：完整环境
	// ============================================================
	//
	// ⚠️ 所有环境共用**一个**临时根目录，各自在它下面开一个子目录。
	//
	// 理由（是实测出来的，不是推测）：收尾时的 `rm -r` 在 Windows 上**偶发**卡住不返回 ——
	// 现场活动句柄只剩一个 `Server` 与未完成的 fs 请求，而套件其实早已跑完；
	// 表现为"测试全绿但进程退不出去"，被外层超时杀掉。**15 个临时目录就有 15 次撞上的机会**，
	// 合成一个之后：从 8~10 秒（且约一半概率挂死）变成稳定 2~4 秒。
	const suiteRoot = await mkdtemp(join(tmpdir(), "acc-ext-"));
	let harnessCount = 0;

	async function makeHarness(options = {}) {
		harnessCount += 1;
		// 每个环境一个子目录 —— 共用一个根目录只是少删几次，**不能**让它们互相看见
		// （否则上一个环境留下的缓存副本会让下一个环境的断言假通过）。
		const root = join(suiteRoot, `h${harnessCount}`);
		await mkdir(root, { recursive: true });
		const harness = createAppMock(root);
		const app = harness.app;

		let pendingInject = null;
		const server = createMockS3({
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			region: "auto",
			bucket: BUCKET,
			intercept: () => {
				const injected = pendingInject;
				pendingInject = null;
				return injected;
			},
		});
		const endpoint = await server.start();
		const client = new S3Client(
			{
				endpoint,
				region: "auto",
				bucket: BUCKET,
				accessKeyId: ACCESS_KEY_ID,
				secretAccessKey: SECRET_ACCESS_KEY,
				forcePathStyle: true,
			},
			{ transport: nodeTransport(), now: () => NOW, sleep: async () => {} }
		);

		const settings = {
			autoUpload: true,
			enabledExtensions: ["png"],
			attachmentFolder: "",
			localCopy: "cache",
			cacheFolder: "_attachment-cache",
			fallbackDownload: true,
			externalImageCache: true,
			...options.settings,
			s3: {
				endpoint,
				region: "auto",
				bucket: BUCKET,
				publicUrlBase: `${endpoint}/${BUCKET}`,
				accessKeyId: "",
				secretAccessKeyRef: "",
				forcePathStyle: true,
				objectKeyTemplate: "{hash}.{ext}",
			},
		};

		const index = new CacheIndex();
		const notices = [];
		let persistCount = 0;

		const cacherDeps = {
			app,
			settings: () => settings,
			client: () => (options.noClient ? null : client),
			index: () => index,
			persistIndex: async () => {
				persistCount += 1;
			},
			notify: (message) => notices.push(message),
			request,
			timeoutMs: options.timeoutMs ?? 2000,
			maxBytes: options.maxBytes,
			now: () => NOW,
			hashBytes: async (bytes) => sha256Hex(bytes),
		};
		// 默认**不**改安全拦截（用生产的那份）；只有明确要求时才放开，
		// 因为测试要指向 127.0.0.1 上的假图床。
		if (!options.strictBlockedHost) cacherDeps.blockedHost = () => false;

		const cache = createExternalCacher(cacherDeps);

		return {
			root,
			app,
			server,
			endpoint,
			index,
			notices,
			settings,
			cache,
			persistCount: () => persistCount,
			imageRequests: () => liveHost.requests.length,
			injectOnce: (payload) => {
				pendingInject = payload;
			},
			async writeNote(relPath, text) {
				await mkdir(join(root, dirname(relPath)), { recursive: true });
				await writeFile(join(root, relPath), text, "utf8");
				// 模拟 Obsidian 重新索引（`getAbstractFileByPath` 是同步的）
				await harness.refreshPathCache();
			},
			readNote: (relPath) => readFile(join(root, relPath), "utf8"),
			async exists(relPath) {
				try {
					await stat(join(root, relPath));
					return true;
				} catch {
					return false;
				}
			},
			async close() {
				// 只关服务；临时目录由套件末尾统一清理（理由见 suiteRoot 的说明）
				await server.close();
			},
		};
	}

	const NOTE = "notes/mine.md";
	const url = `${liveBase}/a.png`;

	// ---------- 2.1 正常路径：下载 → 上传 → 落本地 → 改写 ----------
	{
		const h = await makeHarness();
		try {
			await h.writeNote(NOTE, `# 标题\n\n![x](${url})\n`);
			const outcome = await h.cache(url, NOTE);

			assert.equal(outcome.status, "cached", `应成功（实际 ${outcome.status} / ${outcome.error ?? ""}）`);
			assert.equal(h.server.countByMethod("PUT"), 1, "★ 恰好一次 PUT");
			assert.equal(outcome.remoteUrl.startsWith(h.endpoint), true, "新 URL 应指向自己的存储");
			assert.equal(h.index.size, 1, "索引要登记一条");
			assert.equal(h.index.get(outcome.key).remoteUrl, outcome.remoteUrl, "索引要记得新 URL");
			assert.equal(h.persistCount() >= 1, true, "索引要落盘");

			// 字节逐字节落盘
			const onDisk = new Uint8Array(await readFile(join(h.root, outcome.localPath)));
			assert.deepEqual(onDisk, IMAGE_BYTES, "★ 本地副本要逐字节一致");
			assert.ok(outcome.localPath.startsWith("_attachment-cache/"), "本地副本应进缓存目录");

			// 笔记被改写
			const note = await h.readNote(NOTE);
			assert.ok(!note.includes(url), "★ 原来的站外链接必须被换掉");
			assert.ok(note.includes(outcome.remoteUrl), "★ 必须换上自己存储的地址");
			assert.ok(note.includes("# 标题"), "★ 笔记的其它内容必须原样保留");

			assert.ok(h.notices.includes("externalCached"), `应给出成功提示（实际 ${JSON.stringify(h.notices)}）`);
		} finally {
			await h.close();
		}
	}

	// ---------- 2.2 ⭐ 另一个站点的同名图绝不能被一起改掉 ----------
	{
		const h = await makeHarness();
		try {
			// 两张图的名字（路径末段）完全相同，只有主机不同。
			// 「短名匹配」的写法会把第二条也改成我们的地址 —— 那等于静默把笔记指向了错误的图。
			const otherUrl = "https://other.example.com/a.png";
			await h.writeNote(NOTE, `![a](${url})\n![b](${otherUrl})\n`);
			const outcome = await h.cache(url, NOTE);

			assert.equal(outcome.status, "cached", "要改的那条应改成功");
			const note = await h.readNote(NOTE);
			assert.ok(note.includes(otherUrl), "★ 另一个站点上的同名图绝不能被一起改掉");
			assert.ok(!note.includes(url), "要改的那条要改掉");
			assert.ok(note.includes(outcome.remoteUrl), "换上的是新地址");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.3 各种"什么都不该做"的情形：零请求 + 笔记不动 ----------
	const noteText = `![x](${url})\n`;
	for (const [label, options, notePath, want] of [
		["功能关着", { settings: { externalImageCache: false } }, NOTE, "refused"],
		["拿不到客户端（未配置）", { noClient: true }, NOTE, "unavailable"],
		["没有笔记路径", {}, undefined, "no-note"],
		["笔记不存在", {}, "notes/nope.md", "no-note"],
	]) {
		const h = await makeHarness(options);
		try {
			await h.writeNote(NOTE, noteText);
			const before = liveHost.requests.length;
			const outcome = await h.cache(url, notePath);

			assert.equal(outcome.status, want, `★ ${label} 应判成 ${want}（实际 ${outcome.status}）`);
			assert.equal(liveHost.requests.length, before, `★ ${label} 时一个请求都不该发`);
			assert.equal(h.server.countByMethod("PUT"), 0, `★ ${label} 时不该上传`);
			assert.equal(await h.readNote(NOTE), noteText, `★ ${label} 时笔记必须一个字都不动`);
		} finally {
			await h.close();
		}
	}

	// ---------- 2.4 ⭐ 回环地址：即使用生产的那份安全拦截也要拒绝 ----------
	{
		const h = await makeHarness({ strictBlockedHost: true });
		try {
			await h.writeNote(NOTE, noteText);
			const before = liveHost.requests.length;
			const outcome = await h.cache(url, NOTE); // url 是 127.0.0.1
			assert.equal(outcome.status, "refused", "★ 回环地址必须 refused（不能拿它去请求）");
			assert.equal(liveHost.requests.length, before, "★ 不该请求回环地址");
			assert.equal(await h.readNote(NOTE), noteText, "笔记不动");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.5 属于本存储的 URL 不该走这条路 ----------
	{
		const h = await makeHarness();
		try {
			const ownUrl = `${h.endpoint}/${BUCKET}/existing.png`;
			await h.writeNote(NOTE, `![x](${ownUrl})\n`);
			const outcome = await h.cache(ownUrl, NOTE);
			assert.equal(outcome.status, "refused", "★ 本存储的 URL 应 refused（那是回退下载的活）");
			assert.equal(h.server.countByMethod("PUT"), 0, "不该上传");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.6 防盗链：要提示、不上传、笔记不动 ----------
	{
		const h = await makeHarness();
		try {
			const blocked = `${liveBase}/blocked.png`;
			await h.writeNote(NOTE, `![x](${blocked})\n`);
			const before = liveHost.requests.length;
			const outcome = await h.cache(blocked, NOTE);

			assert.equal(outcome.status, "fetch-forbidden", "★ 403 必须判成防盗链（不能当成功）");
			assert.equal(liveHost.requests.length, before + 1, "确实请求过一次（要能区分「没请求」与「请求被拒」）");
			assert.equal(h.server.countByMethod("PUT"), 0, "★ 下载失败绝不能上传");
			assert.ok(h.notices.includes("externalFetchForbidden"), `★ 要提示防盗链（实际 ${JSON.stringify(h.notices)}）`);
			assert.equal(await h.readNote(NOTE), `![x](${blocked})\n`, "笔记不动");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.7 超时：静默（离线时的正常表现） ----------
	{
		const h = await makeHarness({ timeoutMs: 300 });
		try {
			const slow = `${liveBase}/slow.png`;
			await h.writeNote(NOTE, `![x](${slow})\n`);
			const outcome = await h.cache(slow, NOTE);
			assert.equal(outcome.status, "fetch-timeout", "慢响应应判超时");
			assert.deepEqual(h.notices, [], "★ 超时必须静默（断网/慢网时不该刷屏）");
			assert.equal(h.server.countByMethod("PUT"), 0, "不该上传");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.8 HTML 回包 / 超大：都要拒绝上传 ----------
	for (const [label, target, options, want, key] of [
		["200 回 HTML", `${liveBase}/page.html`, {}, "not-image", "externalNotImage"],
		["超过大小上限", `${liveBase}/a.png`, { maxBytes: 4 }, "too-large", "externalTooLarge"],
	]) {
		const h = await makeHarness(options);
		try {
			await h.writeNote(NOTE, `![x](${target})\n`);
			const outcome = await h.cache(target, NOTE);
			assert.equal(outcome.status, want, `★ ${label} 应判成 ${want}（实际 ${outcome.status}）`);
			assert.equal(h.server.countByMethod("PUT"), 0, `★ ${label} 绝不能上传`);
			assert.ok(h.notices.includes(key), `★ ${label} 要提示（实际 ${JSON.stringify(h.notices)}）`);
			assert.equal(await h.readNote(NOTE), `![x](${target})\n`, "笔记不动");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.9 ⭐ 「上传了但没改成」必须如实报出来 ----------
	{
		const h = await makeHarness();
		try {
			// 笔记里没有那串 URL（图可能来自嵌入的别的笔记）→ 改不了
			const text = "# 没有这串链接\n";
			await h.writeNote(NOTE, text);
			const outcome = await h.cache(url, NOTE);

			assert.equal(outcome.status, "cached-no-rewrite", "★ 改不动时必须如实报，绝不能谎报 cached");
			assert.equal(h.server.countByMethod("PUT"), 1, "图确实上传了（代价是存储里多一个对象，而不是丢数据）");
			assert.equal(await h.readNote(NOTE), text, "★ 笔记必须原样（宁可少改，不可改错）");
			assert.ok(h.notices.includes("externalCachedNoRewrite"), "要提示「只做了一半」");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.10 读不到笔记 → 不下载（不白花带宽） ----------
	{
		const h = await makeHarness();
		try {
			await h.writeNote(NOTE, noteText);
			const originalRead = h.app.vault.read;
			h.app.vault.read = async () => {
				throw new Error("EBUSY: 文件被占用");
			};
			const before = liveHost.requests.length;
			let outcome;
			try {
				outcome = await h.cache(url, NOTE);
			} finally {
				h.app.vault.read = originalRead;
			}

			assert.equal(outcome.status, "no-note", "★ 读不到笔记应判 no-note");
			assert.equal(liveHost.requests.length, before, "★ 读不到就**不该下载**（否则白花带宽还留下没人引用的对象）");
			assert.equal(h.server.countByMethod("PUT"), 0, "不该上传");
			assert.equal(await h.readNote(NOTE), noteText, "★ 读失败时绝不能写回（modify 是整文件覆盖）");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.11 上传失败：字节留在本地，笔记不动 ----------
	{
		const h = await makeHarness();
		try {
			await h.writeNote(NOTE, noteText);
			h.injectOnce({ status: 403, code: "AccessDenied" });
			const outcome = await h.cache(url, NOTE);

			assert.equal(outcome.status, "upload-failed", "★ 上传失败要如实报");
			assert.equal(h.server.countByMethod("PUT"), 1, "确实试过上传");
			assert.ok(outcome.localPath, "★ 字节必须留在本地（绝不丢图）");
			assert.equal(await h.exists(outcome.localPath), true, "本地副本真的在磁盘上");
			assert.ok(h.notices.includes("externalUploadFailed"), "要提示上传失败");
			assert.equal(await h.readNote(NOTE), noteText, "笔记不动");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.12 ⭐ localCopy=trash 也要留下本地副本 ----------
	{
		const h = await makeHarness({ settings: { localCopy: "trash" } });
		try {
			await h.writeNote(NOTE, noteText);
			const outcome = await h.cache(url, NOTE);

			assert.equal(outcome.status, "cached", "应成功");
			assert.ok(outcome.localPath, "★ 用户点的是「缓存」—— 即便设了 trash 也要留下本地副本");
			assert.equal(await h.exists(outcome.localPath), true, "★ 本地副本要真的在磁盘上（否则离线看不见，且症状完全不可见）");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.13 行内 HTML 写法也要能改 ----------
	{
		const h = await makeHarness();
		try {
			await h.writeNote(NOTE, `<img src="${url}" width="200">\n`);
			const outcome = await h.cache(url, NOTE);
			assert.equal(outcome.status, "cached", "行内 HTML 里的 URL 也是字面文本，应能改");
			const note = await h.readNote(NOTE);
			assert.ok(note.includes(`<img src="${outcome.remoteUrl}" width="200">`), "★ 应保持行内 HTML 结构，只换地址");
		} finally {
			await h.close();
		}
	}

	// ---------- 2.14 改写到一半抛错 → 也只能报「没改成」 ----------
	{
		const h = await makeHarness();
		try {
			await h.writeNote(NOTE, noteText);
			const originalModify = h.app.vault.modify;
			h.app.vault.modify = async () => {
				throw new Error("EACCES: 只读");
			};
			let outcome;
			try {
				outcome = await h.cache(url, NOTE);
			} finally {
				h.app.vault.modify = originalModify;
			}

			assert.equal(outcome.status, "cached-no-rewrite", "★ 改写失败时必须如实报，绝不能谎报 cached");
			assert.equal(h.server.countByMethod("PUT"), 1, "图已经上传了（代价是多一个对象，不是丢数据）");
			assert.ok(h.notices.includes("externalCachedNoRewrite"), "要提示只做了一半");
			assert.equal(await h.readNote(NOTE), noteText, "笔记必须原样");
		} finally {
			await h.close();
		}
	}

	await liveHost.close();
	cleanupInBackground(suiteRoot);
}
