/**
 * 入口验收：加载**真实构建产物**、跑 `onload()`，并真的驱动一次粘贴。
 *
 * ## 这条测试要防的是什么
 *
 * 本项目实际发生过一次：八个模块（上传编排、缓存索引、粘贴判定、路径推导……）
 * 全都有测试且全绿，而入口只注册了设置页 —— 装进 vault 的插件除了设置界面
 * 什么都不会做。当时没有任何测试会失败，因为：
 *
 * 1. 十三个套件都是"直接 import 模块 + 手动拼 deps"，**没有一个实例化入口**；
 * 2. 宿主替身的 `workspace.on()` 返回空对象，**静默吞掉注册**。
 *
 * 两条合起来，"接线的最后一公里"整段落在覆盖之外。所以这里补两条：
 * 替身开始记账（见 `mock-obsidian.mjs`），这条测试读账。
 *
 * ## 判据：删掉入口里那行注册代码，它必须变红
 *
 * 因此断言分三层，一层比一层强：
 *
 * 1. **注册**：`editor-paste` / `editor-drop` 各有处理器挂上（读替身的账）；
 * 2. **真的跑通**：触发一次粘贴 → 断言"恰好 1 次 PUT、缓存落盘、链接插入编辑器、
 *    索引写进磁盘"——这一步**加载的是 `main.js`**，不是 TS 源码，
 *    所以它同时验证了打包格式、external 处理与真正的依赖装配；
 * 3. **失败方向**：未配置时**不得**接管（图要留给宿主保存），且必须给出提示。
 *
 * ## 为什么 `requestUrl` 由这里提供而不是改替身
 *
 * `mock-obsidian` 的 `requestUrl` 是**故意**抛错的（"替身未实现"），
 * 那条注释的理由是：一个会用固定响应糊弄过去的替身，会让人误以为网络路径验证过了。
 * 这里做的是另一回事 —— 它不是"假响应"，而是**真的发一次 HTTP** 到本地 mock S3。
 * 所以这个替换只在本测试里生效，不污染其它套件对"未实现"的诚实。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

import { cleanupInBackground } from "./cleanup.mjs";
import * as mockObsidian from "./mock-obsidian.mjs";
import { installHostGlobals } from "./host-globals.mjs";
import { createMockS3 } from "./mock-s3.mjs";

// ⚠️ 真实产物会用到浏览器全局（`window.crypto` / `window.setTimeout`），
// 而 `vm.compileFunction` 只是把代码放进当前 global —— 不会凭空造出 `window`。
// 少了这一步，症状是"上传都还没开始，先在**本地保存**那一步失败"
// （`Could not save the file locally either: window is not defined`），
// 看起来像文件系统问题，其实是环境缺一个全局。TS 套件由 `load-ts.mjs`
// 自动装了，这条测试加载产物、不走那条路，所以要自己装一次。
installHostGlobals();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "acceptance-bucket";

/**
 * ⭐ 公开访问前缀**故意与端点不同** —— 真实场景就是这样（CDN、自定义域名、R2 的公开域名）。
 *
 * 为什么值得单独解释：早先这里填的是 `${endpoint}/${BUCKET}`，恰好等于"**省略**这个设置
 * 时的回退值"。于是"配置的前缀有没有真的被用上"**无法从断言里看出来** —— 传了、没传，
 * 生成的链接一模一样。一个真 bug（前缀根本没传到客户端、链接一直退回对象地址）
 * 就这样躲过了端到端验收，直到有人问"这个参数能不能省略"才被发现。
 *
 * **夹具必须让因果可区分**：两个值相同时，那条断言什么都证明不了。
 */
const PUBLIC_BASE = "https://cdn.example.com";


/** 刻意含 0x00 / 0xFF / 非法 UTF-8：文本通道会悄悄改掉这些字节。 */
const HOSTILE_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f, 0xed, 0xfd,
]);

/**
 * 用真 `fetch` 实现宿主的 `requestUrl`。
 *
 * 形状必须与客户端期望的一致（`status` / `headers` / `arrayBuffer`，见
 * `client.ts` 的 `obsidianTransport`），并且要容忍它传的 `throw: false`。
 *
 * ## 为什么走"替换替身的实现"而不是给 bundle 传一个替身
 *
 * 两条加载路径的 `obsidian` 模块来源不同：
 * 产品路径（CJS `main.js`）由本文件自己造 shim，而**变异路径**用的是
 * `load-ts.mjs` 写好的 shim（转发到 `mock-obsidian`）—— 后者在 suite 运行前
 * 就已经落盘，改不了。所以只有一条通道是两边都通的：
 * 换掉 `mock-obsidian` 里那一门 `requestUrl` 的实现（见 `setRequestUrlImpl`）。
 * 上一版正是踩了这个坑，症状是"变异路径下上传全部失败"，
 * 而报错是替身自己那句"未实现"。
 *
 * 宿主的 `requestUrl` 与 `fetch` 的差异（CORS 豁免、走宿主网络栈）不在本测试的
 * 验证范围内 —— 那些只有真机能确认。这里要证明的是**链路真的发出去了、
 * 而且服务端独立重算的签名认了**。
 */
async function realRequestUrl(options) {
	const { url, method = "GET", headers, body } = options;
	// 站外图床按主机名拦下（理由见 `externalImageResponse` 的说明）
	const stubbed = externalImageResponse(url);
	if (stubbed) return stubbed;
	const response = await fetch(url, {
		method,
		headers,
		body,
		signal: AbortSignal.timeout(15000),
	});
	const out = {};
	response.headers.forEach((value, name) => {
		out[name.toLowerCase()] = value;
	});
	return { status: response.status, headers: out, arrayBuffer: await response.arrayBuffer() };
}

/**
 * 站外图床的假响应。
 *
 * ## 为什么在这里模拟，而不是起一个本地 HTTP 服务
 *
 * 起在 `127.0.0.1` 上的话，会被产品**正确地**拦下来 —— 回环/链路本地地址一律不碰
 * （见 `external-decide.ts` 的 `isBlockedHost`）。要么为此在生产代码上开一个
 * "关掉安全检查"的后门，要么把假图床放在一个**不是回环**的主机上。
 * 后者显然更好。
 *
 * 而"网络边界"在宿主里就是 `requestUrl` —— 它本来就是我们这一侧唯一发请求的地方，
 * 所以在这里按主机名拦下那一个假域名，是最贴近真实的做法：
 * 其余的请求（包括发给 mock S3 的那些）照常走真实 HTTP。
 *
 * ⚠️ 代价如实写在这里：这条路径**没有**验证真实 HTTP（超时、防盗链、字节形状）。
 * 那些由 `external-cache-suite` 用真实服务与真实磁盘覆盖；本套件负责的是
 * "入口有没有把这条链路接上"。
 */
const EXTERNAL_HOST = "images.example.test";
const EXTERNAL_IMAGE_URL = `https://${EXTERNAL_HOST}/a.png`;
/**
 * 等「启动那一轮定时器」要用多久。
 *
 * 必须**大于** `main.ts` 里那个启动延迟（3 秒）—— 这一轮的意义是把它**让过去**，
 * 而不是与它抢：抢到了会被节流（那是产品的正确行为），测试就成了偶发失败。
 */
const STARTUP_WINDOW_MS = 3500;

/** 站点决定记忆的落盘位置（与 `createSiteStore` 的推导一致）。 */
const SITE_MEMORY_PATH = ".obsidian/plugins/attachment-cloud-cache/.site-decisions.json";
const EXTERNAL_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

/** 记下"站外图床"被请求过几次 —— 用来断言"只下载一次"。 */
const externalHostRequests = [];

function externalImageResponse(url) {
	if (!String(url).includes(EXTERNAL_HOST)) return null;
	externalHostRequests.push(String(url));
	if (String(url).includes("/a.png")) {
		return { status: 200, headers: { "content-type": "image/png" }, arrayBuffer: EXTERNAL_IMAGE_BYTES.buffer };
	}
	if (String(url).includes("/blocked.png")) {
		return { status: 403, headers: { "content-type": "text/html" }, arrayBuffer: new ArrayBuffer(0) };
	}
	return { status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0) };
}

/**
 * 加载真实构建产物（`main.js`，CJS）。
 *
 * ## 为什么不用 `require()` + `Module._load` 打补丁
 *
 * `main.js` 是 CJS（esbuild 的 production 输出），但仓库的 `package.json` 写着
 * `"type": "module"` —— 于是 Node 把 `.js` 当 ESM 解析，`require("main.js")`
 * 会走 `importSyncForRequire` 并在产物内部报
 * `ReferenceError: module is not defined in ES module scope`。
 *
 * 改用 `vm.compileFunction` **显式**求值：把 `module` / `exports` / `require`
 * 三个 CJS 变量直接喂进去（这正是 CJS 的调用约定），产物照旧跑，
 * 而"我们向宿主提供哪些成员"变成**看得见的一行** ——
 * 比给整个进程挂一张假模块表可控得多。
 *
 * 那个 `require` 垫片只拦 `obsidian` 一个标识符，其余照旧交给 Node 解析
 * （产物目前没有别的 external，但将来加了也不会静默失败）。
 */
function loadBuiltBundle() {
	const require = createRequire(import.meta.url);
	const source = readFileSync(join(ROOT, "main.js"), "utf8");
	const moduleObject = { exports: {} };

	const factory = compileFunction(source, ["module", "exports", "require"], {
		filename: join(ROOT, "main.js"),
	});
	factory(moduleObject, moduleObject.exports, (id) => (id === "obsidian" ? mockObsidian : require(id)));

	return moduleObject.exports;
}

/** 磁盘上是否存在（用来断言删掉了/没动它）。 */
async function existsOnDisk(root, vaultPath) {
	try {
		await stat(join(root, vaultPath));
		return true;
	} catch {
		return false;
	}
}

/** 轮询等待一个条件成立（比固定 sleep 更稳，也更快）。 */
async function waitFor(predicate, what, timeoutMs = 10000, diagnose = () => "") {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() > deadline) {
			// ⚠️ 现场信息**必须与主消息同一行**：变异运行器只打印报错的第一行
			// （`message.split("\n")[0]`），多行的诊断在那边会被整段吞掉 ——
			// 于是"基线未通过"后面什么都不剩，等于没有信息。
			throw new Error(`等待超时：${what} ｜ ${diagnose()}`);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** 一个够用的假 `<img>`：记录每一次赋值（用于断言"远端地址是否被写过"）。 */
function makeFakeImage(src) {
	return {
		attrs: { src },
		getAttribute(name) {
			return name === "src" ? (this.attrs.src ?? null) : null;
		},
		setAttribute(name, value) {
			if (name === "src") this.attrs.src = value;
		},
		addEventListener() {},
	};
}

/** 只有 querySelectorAll 的容器替身。 */
function makeFakeContainer(images) {
	return { querySelectorAll: (selector) => (selector === "img" ? images : []) };
}

/**
 * 在 `globalThis` 上装一个假的 `HTMLImageElement`。
 *
 * ⚠️ `src` 必须定义在**原型上、且是访问器**（getter/setter）：
 * 被替换成普通属性的假元素会让被测代码里的 prototype 拦截无从生效
 * （`Object.getOwnPropertyDescriptor` 拿不到 setter，patch 会静默跳过）——
 * 于是"实时预览可用"成了一句空话，而测试仍然全绿。
 */
function installFakeImageElement() {
	const proto = {
		get src() {
			return this._src;
		},
		set src(value) {
			this._src = value;
		},
		getAttribute(name) {
			return name === "src" ? this._src ?? null : null;
		},
		setAttribute(name, value) {
			if (name === "src") this._src = value;
		},
		addEventListener() {},
	};
	const ctor = function HTMLImageElement() {};
	ctor.prototype = proto;
	globalThis.HTMLImageElement = ctor;
}

/** 一个够用的编辑器替身：记录插入了什么、插到哪。 */
function makeEditor() {
	return {
		cursor: { line: 3, ch: 7 },
		replaced: [],
		rangeCalls: [],
		replaceSelection(text) {
			this.replaced.push(text);
		},
		replaceRange(text, from, to) {
			this.rangeCalls.push({ text, from, to });
			this.replaced.push(text);
		},
		getCursor() {
			return this.cursor;
		},
	};
}

/** 一次"粘贴了这些文件"的事件替身。默认带文本 ⇒ 判定层会放行，所以默认不带。 */
function makePasteEvent(files, { withText = false } = {}) {
	let prevented = false;
	return {
		preventDefault() {
			prevented = true;
		},
		get defaultPrevented() {
			return prevented;
		},
		clipboardData: {
			files,
			items: files.map(() => ({ kind: "file" })),
			getData: (type) => (withText && type === "text/plain" ? "一段文字" : ""),
		},
	};
}

/** 造一个最小可用的 File（要有 `arrayBuffer`，原型 getter 上的 name/size 一并给全）。 */
function makeFile(name, bytes, type = "image/png") {
	return {
		name,
		size: bytes.length,
		type,
		lastModified: 1_700_000_000_000,
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	};
}

/**
 * 跑一遍入口验收。
 *
 * @param {{ loadPluginClass?: () => any }} [options]
 *   `loadPluginClass` 默认加载**真实构建产物** `main.js`。
 *   **变异验证**会传另一个实现（用被改坏的 TS 现场打出的 ESM bundle），
 *   因为变异改的是 `src/`，而 `main.js` 是上次构建的产物 —— 不换加载方式，
 *   变异就改不到被测代码，"全部被捕获"会是假的。
 *   注意这条差异：默认路径验的是**产物**，变异路径验的是**同一入口的源码 bundle**；
 *   前者额外覆盖打包格式，后者只覆盖"入口有没有把东西接上"。
 */
export async function runLoadAcceptance(options = {}) {
	const loadPluginClass = options.loadPluginClass ?? loadBuiltBundle;

	// 让宿主那一门 `requestUrl` 真的发 HTTP。**两条加载路径共用这一处** ——
	// 见 `realRequestUrl` 的说明（产品路径与变异路径的 obsidian 模块来源不同）。
	mockObsidian.setRequestUrlImpl(realRequestUrl);
	const root = await mkdtemp(join(tmpdir(), "acc-accept-"));
	const harness = mockObsidian.createAppMock(root);
	const app = harness.app;

	const server = createMockS3({
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: "auto",
		bucket: BUCKET,
	});
	const endpoint = await server.start();

	const bundle = loadPluginClass();
	const PluginClass = bundle.default ?? bundle;

	// ⚠️ 实时预览的 `src` 拦截靠 `window.HTMLImageElement.prototype` ——
	// 而 `installHostGlobals()` 把 `window` 指到 `globalThis`，那里**没有**这类 DOM 构造器。
	// 不装一个假的，入口就会走"拿不到 prototype → 静默跳过"那条路，
	// 于是"实时预览离线可用"这件事在验收里**根本没被验证**（而它看起来是绿的）。
	installFakeImageElement();

	// ── 插件实例 ──
	const plugin = new PluginClass(app, { id: "attachment-cloud-cache", dir: ".obsidian/plugins/attachment-cloud-cache" });
	// 设置由测试给定（指向本地 mock S3）。⚠️ 绝不能读真实 vault 的 data.json ——
	// 那会把图上传到用户的真实对象存储。
	plugin.loadData = async () => ({
		autoUpload: true,
		enabledExtensions: ["png", "jpg"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		s3: {
			endpoint,
			region: "auto",
			bucket: BUCKET,
			publicUrlBase: PUBLIC_BASE,
			// ⚠️ 这里填的是访问密钥 ID 的**值**（明文标识符），不是钥匙串条目的名字 ——
			// 早期版本这里写的是 `accessKeyIdRef: "acc-test-ak"`（一个名字），
			// 改成明文之后若照抄那个名字，签名就会拿 "acc-test-ak" 去算，
			// 于是得到 403 SignatureDoesNotMatch（而原因只在 mock 服务端那句
			// "Access Key ID 不匹配"里看得出来）。
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKeyRef: "acc-test-sk",
			forcePathStyle: true,
			objectKeyTemplate: "{hash}.{ext}",
		},
	});
	// 只有**秘密**进钥匙串（替身的 SecretStorage 是内存 Map）。
	// 访问密钥 ID 不再进钥匙串 —— 那是标识符，且 Obsidian 的密钥 ID 不允许大写。
	app.secretStorage.setSecret("acc-test-sk", SECRET_ACCESS_KEY);

	// ── 询问接缝 ──
	//
	// ⚠️ 真通知在测试里点不了，所以这里覆写入口暴露的那个接缝。
	// 它也是这条链路**唯一**能被端到端驱动的地方：不覆写就永远只测到"没询问"。
	const askCalls = [];
	let askDecision = "cache";
	plugin.askExternalCache = async (info) => {
		askCalls.push(info);
		return askDecision;
	};

	// ── 兜住"插件忘了登记清理函数" ──
	//
	// ⚠️ 套件自己记录 `onload` 期间创建的定时器，收尾时**不管有没有被 `register` 登记**都清掉。
	// 少了这一步，一个"忘了 register 定时器"的回归会让进程一直有活着的定时器 ⇒
	// **测试断言全绿却卡住**，被外层超时杀掉（日志里什么都没有 —— 最难查的一种）。
	// 有了它，那种回归会老老实实变成一条"清理回调少了一个"的断言失败。
	//
	// ⚠️ 这两个变量必须声明在 `try` **外面**：收尾的 `finally` 里要用它们，
	// 而 `try` 块里的 `const` 在 `finally` 里是看不见的。
	const realSetTimeout = window.setTimeout;
	const realSetInterval = window.setInterval;
	const createdTimers = [];
	window.setTimeout = (...args) => {
		const id = realSetTimeout(...args);
		createdTimers.push(["timeout", id]);
		return id;
	};
	window.setInterval = (...args) => {
		const id = realSetInterval(...args);
		createdTimers.push(["interval", id]);
		return id;
	};

	try {
		/** 现场快照：失败时能看到"提示了什么、发了什么请求"。**单行**，见 `waitFor`。 */
		const diagnose = () =>
			[
				`提示=${mockObsidian.Notice.instances.map((n) => n.message).join(" / ") || "(无)"}`,
				`请求=${server.requests.map((r) => r.method).join(",") || "(无)"}`,
				`注册=${plugin.registrations.map((r) => r.detail).join(",") || "(无)"}`,
			].join(" ｜ ");

		// ============================================================
		// 1. 加载：onload 不得抛错，且必须**注册**该注册的东西
		// ============================================================
		await plugin.onload();
		/** `onload` 完成的时刻 —— 用来等"启动那一轮定时器"跑完（见 8c）。 */
		const loadedAt = Date.now();

		assert.ok(plugin.settingTabs.length >= 1, "★ 设置页必须被注册（否则用户连配置入口都没有）");

		// ⭐ 后台自动轮换必须**真的接上了**：
		// 轮换器存在（忘了 new 就等于没有这个功能），而且注册过清理函数 ——
		// prototype 补丁 + 启动定时器 + 周期定时器共三个。
		// 少了定时器的那两个，症状是"设了上限却永远不会自动轮换"，而界面上毫无痕迹。
		assert.ok(plugin.rotation, "★ 入口必须装配缓存轮换器（否则上限设了也不会生效）");
		const cleanups = plugin.registrations.filter((r) => r.kind === "register").length;
		assert.ok(
			cleanups >= 3,
			`★ 至少要登记 3 个清理回调（prototype 补丁 + 启动定时器 + 周期定时器），实际 ${cleanups}`
		);


		// 注册了不等于**能用**：设置页若在取定义时抛错，用户点齿轮只会看到报错。
		// 这里直接从产物里把定义取一遍 —— 声明式设置页的核心就是这个方法。
		const tab = plugin.settingTabs[0];
		const definitions = tab.getSettingDefinitions?.();
		assert.ok(Array.isArray(definitions), "设置页应返回定义数组（声明式 API）");
		assert.ok(definitions.length >= 4, `设置页应至少有 4 个分组，实际 ${definitions.length}`);
		const itemCount = definitions.reduce((sum, group) => sum + (group.items?.length ?? 0), 0);
		assert.ok(itemCount >= 10, `设置项总数应 ≥10（实际 ${itemCount}）—— 少了说明有分组被漏掉`);

		const pasteHandlers = app.workspace.registered.get("editor-paste") ?? [];
		const dropHandlers = app.workspace.registered.get("editor-drop") ?? [];
		assert.equal(pasteHandlers.length, 1, "★ 必须注册**恰好一个**粘贴处理器（多了会重复处理一次粘贴）");
		assert.equal(dropHandlers.length, 1, "★ 必须注册**恰好一个**拖拽处理器");
		assert.equal(typeof pasteHandlers[0], "function", "粘贴处理器必须是函数");
		assert.equal(typeof dropHandlers[0], "function", "拖拽处理器必须是函数");

		// ============================================================
		// 2. 真的驱动一次粘贴：走完整链路（真实 HTTP + 真实磁盘）
		// ============================================================
		const editor = makeEditor();
		const event = makePasteEvent([makeFile("shot.png", HOSTILE_BYTES)]);
		const info = { file: { path: "notes/未命名.md" } };

		const handled = app.workspace.trigger("editor-paste", event, editor, info);
		assert.equal(handled, 1, "事件应被触发到那一个处理器上");
		assert.equal(event.defaultPrevented, true, "★ 接管后必须 preventDefault，否则宿主会再存一份");

		await waitFor(() => editor.replaced.length > 0, "粘贴后链接被插入编辑器", 5000, diagnose);
		// 上传与索引落盘在插入之后 —— 等索引真的写到磁盘上
		await waitFor(
			async () => {
				try {
					await stat(join(root, ".obsidian/plugins/attachment-cloud-cache/.cache-index.json"));
					return true;
				} catch {
					return false;
				}
			},
			"缓存索引写入磁盘",
			5000,
			diagnose
		);

		const put = server.countByMethod("PUT");
		assert.equal(put, 1, `★ 恰好 1 次 PUT（实际 ${put} 次）`);
		assert.equal(server.countByMethod("GET"), 0, "上传路径上不该有 GET");

		const text = editor.replaced[0];
		assert.match(text, /^!\[.*\]\(https?:\/\//, `插入的应是远端图片链接，实际：${text}`);
		assert.ok(
			text.includes(`${PUBLIC_BASE}/`),
			`★ 链接必须用**配置的公开前缀**（${PUBLIC_BASE}），实际：${text}`
		);
		// 反向一起断言，才**区分得出因果**：只查"包含前缀"的话，
		// 万一前缀恰好等于回退值（曾经的夹具就是这样）就永远通过。
		assert.ok(
			!text.includes(`${endpoint}/${BUCKET}/`),
			`★ 配了公开前缀时就不该退回对象地址 —— 那会让图片在别人那里 404：${text}`
		);

		// 缓存副本真的落盘，且是**逐字节**一致
		const indexRaw = JSON.parse(
			await readFile(join(root, ".obsidian/plugins/attachment-cloud-cache/.cache-index.json"), "utf8")
		);
		assert.equal(indexRaw.entries.length, 1, "索引里应有 1 条记录");
		const entry = indexRaw.entries[0];
		const cached = await readFile(join(root, entry.cachePath));
		assert.deepEqual(
			new Uint8Array(cached),
			HOSTILE_BYTES,
			"★ 缓存副本必须与原始字节逐字节一致（文本通道会改掉 0x00/0xFF）"
		);
		assert.equal(entry.remoteUrl, text.slice(text.indexOf("http"), text.indexOf(")")));

		// 同一份内容再粘一次：命中缓存 ⇒ **零** PUT（这是"不重复上传"的核心承诺）
		const before = server.countByMethod("PUT");
		const editor2 = makeEditor();
		app.workspace.trigger("editor-paste", makePasteEvent([makeFile("again.png", HOSTILE_BYTES)]), editor2, info);
		await waitFor(() => editor2.replaced.length > 0, "第二次粘贴插入链接", 5000, diagnose);
		assert.equal(
			server.countByMethod("PUT"),
			before,
			"★ 内容相同应命中缓存，不得再 PUT 一次"
		);

		// ============================================================
		// 3. 渲染路径 A：阅读视图（后处理器）
		//
		// ⭐ 这是 P0 #4「断网后图片仍能解码、且对远端零请求」在**接线层面**的证据：
		// 用一个指向 mock 服务的 `<img>` 走一遍真正注册的那个后处理器，
		// 断言 `src` 被换成本地资源、且**一次 GET 都没有**。
		// ============================================================
		const getsBeforeRender = server.countByMethod("GET");
		const remoteImg = makeFakeImage(entry.remoteUrl);
		for (const processor of plugin.postProcessors) {
			processor(makeFakeContainer([remoteImg]), { sourcePath: "notes/未命名.md" });
		}
		assert.ok(plugin.postProcessors.length >= 1, "★ 必须注册渲染后处理器（否则阅读视图不享受本地副本）");
		assert.equal(
			remoteImg.getAttribute("src"),
			`app://local/${entry.cachePath}`,
			"★ 阅读视图里的图片应改用本地副本（断网也看得到）"
		);
		assert.equal(
			server.countByMethod("GET"),
			getsBeforeRender,
			"★ 渲染时不该发出任何请求 —— 本地副本已经在磁盘上"
		);

		// 站外图一个字都不该动（红线：不碰别人的图）
		const foreignImg = makeFakeImage("https://third-party.example.net/x.png");
		for (const processor of plugin.postProcessors) processor(makeFakeContainer([foreignImg]), {});
		assert.equal(
			foreignImg.getAttribute("src"),
			"https://third-party.example.net/x.png",
			"★ 站外图必须原样保留（既不下载也不改写）"
		);
		// ⭐ 而且**连问都不该问**：站外缓存默认关闭，一个没打开的插件不该来打扰用户。
		assert.equal(
			askCalls.length,
			0,
			`★ 默认关闭时不该为站外图询问（实际问了 ${askCalls.length} 次）`
		);

		// ============================================================
		// 4. 渲染路径 B：实时预览（`src` setter 拦截）
		//
		// 这一层是"编辑态离线可用"的关键：Live Preview 的 `<img>` 是编辑器自己造的，
		// 后处理器碰不到。断言"赋进去的是远端地址、元素上留下的是本地地址"。
		// ============================================================
		const { HTMLImageElement } = globalThis;
		assert.equal(typeof HTMLImageElement, "function", "（测试环境应已装上假的 HTMLImageElement）");
		const previewImg = new HTMLImageElement();
		previewImg.src = entry.remoteUrl;
		assert.equal(
			previewImg.getAttribute("src"),
			`app://local/${entry.cachePath}`,
			"★ 实时预览里赋远端地址，元素上应当是本地地址（远端地址从未进入元素）"
		);

		// ============================================================
		// 5. 反向：已被别的插件处理过的载荷，我们**不得**再接管
		// ============================================================
		const taken = makePasteEvent([makeFile("x.png", HOSTILE_BYTES)]);
		taken.preventDefault(); // 模拟另一个插件先处理了
		const editor3 = makeEditor();
		app.workspace.trigger("editor-paste", taken, editor3, info);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(editor3.replaced.length, 0, "★ 别人已处理的事件不得重复插入链接");

		// ============================================================
		// 6. 未配置：**放行**（图留给宿主保存）+ 给出提示
		// ============================================================
		plugin.settings.s3.bucket = "";
		mockObsidian.Notice.instances.length = 0;
		const unconfigured = makePasteEvent([makeFile("y.png", HOSTILE_BYTES)]);
		const editor4 = makeEditor();
		app.workspace.trigger("editor-paste", unconfigured, editor4, info);
		await new Promise((r) => setTimeout(r, 30));

		assert.equal(unconfigured.defaultPrevented, false, "★ 未配置时不得接管 —— 图必须留给宿主保存");
		assert.equal(editor4.replaced.length, 0, "未接管时不该插入任何链接");
		assert.ok(
			mockObsidian.Notice.instances.some((n) => /桶名|bucket/i.test(n.message)),
			`应给出"桶名未填"的明确提示，实际提示：${mockObsidian.Notice.instances.map((n) => n.message).join(" | ")}`
		);
		// 提示里要说明"文件已照常保存"，否则用户会以为图丢了
		assert.ok(
			mockObsidian.Notice.instances.some((n) => /保存|saved/i.test(n.message)),
			"提示必须说明文件已被照常保存，否则用户会以为图丢了"
		);

		// ⚠️ 把桶名恢复回去：上面这一节故意清空了它来验证"未配置"路径，
		// 而后续的维护命令需要能真的连上（不恢复的话，批量上传会以
		// "not set up yet" 失败，看起来像功能坏了）。
		plugin.settings.s3.bucket = BUCKET;
		app.secretStorage.setSecret("acc-test-ak", ACCESS_KEY_ID);
		app.secretStorage.setSecret("acc-test-sk", SECRET_ACCESS_KEY);

		// ============================================================
		// 8. 维护命令（P1 #8/#9/#10）：注册 + 真的在真实磁盘上跑一遍
		//
		// ⚠️ 这些命令会**删文件**与**改笔记**，所以在验收里也要真的跑，
		// 而不是只断言"命令注册了"。确认框通过 `confirmMaintenance` 这个
		// 可替换接缝自动确认 —— 真弹窗点不了，而那正是"确认后执行"这条路径。
		// ============================================================
		const commandIds = plugin.commands.map((command) => command.id).sort();
		assert.deepEqual(
			commandIds,
			["audit-cache", "clean-cache", "repair-index", "upload-attachments"],
			"★ 四条维护命令都要注册（少一条就是「功能写了但用户找不到」）"
		);

		const runCommand = (id) => {
			const command = plugin.commands.find((c) => c.id === id);
			assert.ok(command, `命令 ${id} 应存在`);
			command.callback?.();
		};

		// ⚠️ 先把粘贴产生的链接**真的写进一篇笔记**。
		// 之前这一步缺失，于是"引用扫描"看到的是一个没有任何笔记引用的副本 ——
		// 清理把它删掉是**正确行为**，而我的断言以为它不该被删。
		// 补上这篇笔记之后，这条断言才在验"引用扫描真的生效"（而不是在验一个错前提）。
		const noteWithLink = "notes/未命名.md";
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, noteWithLink), `这是笔记\n\n${text}\n`);
		await harness.refreshPathCache();

		// 造一个孤儿文件（磁盘上有、索引里没有）—— 它是"可清理"的那一类
		const orphanVaultPath = "_attachment-cache/orphan.png";
		await mkdir(join(root, "_attachment-cache"), { recursive: true });
		await writeFile(join(root, orphanVaultPath), Buffer.from([1, 2, 3]));
		// 让宿主的文件索引看到它（`refreshPathCache` 模拟 Obsidian 重新索引）
		await harness.refreshPathCache();

		const referencedCopy = entry.cachePath; // 仍被笔记引用的那份

		// 记下确认框里到底写了什么。**这是必要的**：确认框是用户按下那个不可逆按钮前
		// 唯一读到的安全信息。缓存清理只有一种方式（直接删除），所以它必须说清
		// "删了就没法撤销" —— 说"可以还原"会让用户以为删错也能找回。
		// 不记下来的话，这段话没有任何断言看着，改错了也没人知道。
		const confirms = [];
		const captureConfirm = (result) => async (options) => {
			confirms.push(options);
			return result;
		};

		const beforeCleanTrash = harness.calls.trash.length;
		const beforeCleanDelete = harness.calls.delete.length;

		plugin.confirmMaintenance = captureConfirm(true); // 自动确认（"确认后执行"这条路径）
		mockObsidian.Notice.instances.length = 0;
		runCommand("clean-cache");
		// 等**提示**（它在清理之后才发）而不是等文件消失 —— 后者会在命令还没收尾时就返回
		await waitFor(
			() => mockObsidian.Notice.instances.some((n) => /Cleaned|清理/.test(n.message)),
			"清理完成并给出汇报",
			5000,
			diagnose
		);

		assert.ok(await existsOnDisk(root, orphanVaultPath) === false, "★ 孤儿文件应当被拿掉");
		assert.ok(
			harness.calls.delete.includes(orphanVaultPath),
			"★ 缓存清理必须用 Vault.delete（它是唯一能立刻腾出空间的原语）"
		);
		// ⭐ 这条是"回收站那个备选已被去掉"在端到端层的钉子。它与 `test-remove.mjs` 的
		// 静态守卫分工不同：静态守卫盯着"代码里还有没有回收站"，这条盯着
		// "**跑起来**会不会走回收站" —— 而它的后果是可感知的：
		// 走了回收站，磁盘空间就不会释放，用户会以为清理没生效。
		assert.equal(
			harness.calls.trash.length,
			beforeCleanTrash,
			"★ 缓存清理不许走回收站（回收站不释放物理空间，与「空间有限」的动机直接矛盾）"
		);
		assert.ok(harness.calls.delete.length > beforeCleanDelete, "删除调用应当增加");
		assert.ok(
			await existsOnDisk(root, referencedCopy),
			"★ 仍被笔记引用的副本**绝不能**被清理（那是离线可用的依赖）"
		);

		// ⭐ 确认框必须说清"无法撤销" —— 那是这个不可逆动作的唯一安全信息。
		// 两种语言各留一条正则：套件不该假设界面语言。
		const cleanConfirm = confirms[confirms.length - 1];
		assert.ok(cleanConfirm, "清理应当先弹确认框");
		assert.ok(
			/cannot be undone|无法撤销/.test(cleanConfirm.lines.join(" ")),
			`★ 直接删除时确认框必须说清「无法撤销」（实际：${cleanConfirm.lines.join(" / ")}）`
		);
		assert.ok(
			/Delete permanently|彻底删除/.test(cleanConfirm.cta),
			`★ 按钮文案要说清这是删除（实际：${cleanConfirm.cta}）`
		);

		// 取消时不执行任何清理 —— 这条路径最容易被漏测（用户点错命令时全靠它）
		const secondOrphan = "_attachment-cache/orphan2.png";
		await writeFile(join(root, secondOrphan), Buffer.from([4, 5, 6]));
		await harness.refreshPathCache();
		plugin.confirmMaintenance = captureConfirm(false); // 用户取消
		runCommand("clean-cache");
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(
			await existsOnDisk(root, secondOrphan),
			"★ 用户取消时**一个文件都不能动**（否则确认框等于没有）"
		);

		// ⚠️ 它已经完成使命（证明"取消不动"），必须**清掉**，否则会漏进后面的小节。
		//
		// 这不是洁癖：批量上传是**全库扫描**（按扩展名 + 大小 + 不在索引里筛候选），
		// 于是这个 `.png` 孤儿会被当成一个**上传候选**，让下面那条
		// "批量上传应恰好 PUT 一次"数出 2 次 —— 而它想验的是**附件**被传上去，
		// 与缓存目录里的杂物无关。这类"计数断言被别的东西满足/破坏"的坑，
		// 在这个套件里已经踩过第二次（第一次是被另一个孤儿满足的）。
		// 手法就是：让每一条断言只面对自己造出来的现场。
		await rm(join(root, secondOrphan), { force: true });
		await harness.refreshPathCache();
		assert.ok(await existsOnDisk(root, secondOrphan) === false, "（清理现场：这条孤儿不该留在后面）");

		// 批量上传：把 `attachments/pic.png` 传上去，并改写笔记里的本地链接
		const attachmentPath = "attachments/pic.png";
		await mkdir(join(root, "attachments"), { recursive: true });
		// ⚠️ 这份内容**必须与粘贴那份（`HOSTILE_BYTES`）不同**。
		// 上传是**内容寻址**的：一模一样的字节会命中同一个对象，于是这次批量上传
		// 合理地走"远端已存在 → 复用"，**一个 PUT 都不发**。那样下面那条
		// "恰好 PUT 一次"就不再是"批量上传真的传了"，而是被**别的东西**满足的 ——
		// 实测它当时是被一个恰好躺在缓存目录里的孤儿文件满足的（内容寻址的去重
		// 让这条断言看着在守一件事，其实守的是另一件）。
		const BATCH_BYTES = new Uint8Array([...HOSTILE_BYTES, 0x7a, 0x7b]);
		await writeFile(join(root, attachmentPath), Buffer.from(BATCH_BYTES));
		// 用**另一篇**笔记：上面那篇里的引用是 clean-cache 那条断言的依据，不能覆盖掉
		const notePath = "notes/待迁移.md";
		await writeFile(join(root, notePath), `![[pic.png]]\n\n![x](attachments/pic.png)\n`);
		await harness.refreshPathCache();

		const putsBefore = server.countByMethod("PUT");
		plugin.confirmMaintenance = async () => true;
		mockObsidian.Notice.instances.length = 0;
		runCommand("upload-attachments");
		await waitFor(
			async () => (await readFile(join(root, notePath), "utf8")).includes("http"),
			"笔记里的链接被改写成远端地址",
			5000,
			diagnose
		);

		assert.equal(server.countByMethod("PUT"), putsBefore + 1, "★ 批量上传应恰好 PUT 一次");
		const noteText = await readFile(join(root, notePath), "utf8");
		assert.ok(noteText.includes(`${PUBLIC_BASE}/`), `链接应指向配置的存储（公开前缀）：${noteText}`);
		assert.ok(
			!noteText.includes("attachments/pic.png"),
			`★ 两条本地链接都应被改写（短名与完整路径都要认）：${noteText}`
		);
		assert.ok(
			await existsOnDisk(root, attachmentPath),
			"★ 原文件必须保留（这条命令刻意不删任何东西）"
		);
		// ⭐ 附件目录里**不得**多出中转副本（`pic 1.png`）。
		// 迁移时字节本来就在库里；把"先落盘再上传"照搬到这条路径上，会在附件目录里
		// 凭空多出一个文件（搬移失败时永久残留）—— 而用户的意图只是"把老图传上去"。
		assert.equal(
			await existsOnDisk(root, "attachments/pic 1.png"),
			false,
			"★ 批量上传不得在附件目录里留下中转副本"
		);

		// ============================================================
		// ============================================================
		// 8b. 站外图：开启后「询问 → 下载 → 上传 → 改写链接」
		//
		// ⚠️ 这是全库唯一会下载**别人的图**、也是唯一会**改写用户笔记**的链路，
		// 所以它必须在接线层面被走一遍（而不是只靠单元套件间接推断）。
		// ============================================================
		{
			const externalUrl = EXTERNAL_IMAGE_URL;
			const notePath = "notes/站外.md";
			const originalNote = `# 站外图\n\n![x](${externalUrl})\n`;

			await mkdir(join(root, "notes"), { recursive: true });
			await writeFile(join(root, notePath), originalNote, "utf8");
			await harness.refreshPathCache();

			// 打开功能（默认是关的），并让接缝回答「缓存」
			plugin.settings.externalImageCache = true;
			askCalls.length = 0;
			askDecision = "cache";
			externalHostRequests.length = 0;
			const putsBefore = server.countByMethod("PUT");

			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}

			assert.equal(askCalls.length, 1, "★ 开启后遇到站外图应询问一次");
			assert.equal(askCalls[0].host, EXTERNAL_HOST, `询问要带上站点（实际 ${JSON.stringify(askCalls[0])}）`);

			// ⚠️ 等的是**改写完成**，不是 PUT 完成：这条链是"下载 → 上传 → 改写"，
			// 所以 PUT 结束时笔记还没改（等早了会读到一个还没改写的笔记）。
			await waitFor(
				async () => !(await readFile(join(root, notePath), "utf8")).includes(externalUrl),
				"站外图被下载、上传，并且笔记里的链接被改写",
				10000,
				diagnose
			);

			assert.equal(server.countByMethod("PUT"), putsBefore + 1, "★ 恰好一次 PUT");

			// 决定必须**落盘**：不落盘的话，用户下次启动还要重新回答一遍 ——
			// 而他会以为自己已经答过了（记忆只活在内存里的症状就是这样）。
			await waitFor(
				async () => {
					try {
						return (await readFile(join(root, SITE_MEMORY_PATH), "utf8")).includes(EXTERNAL_HOST);
					} catch {
						return false;
					}
				},
				"站点决定被写进记忆文件",
				5000,
				diagnose
			);

			const rewritten = await readFile(join(root, notePath), "utf8");
			assert.equal(rewritten.includes(externalUrl), false, "★ 笔记里的站外链接必须被改写");
			assert.equal(rewritten.includes(PUBLIC_BASE), true, "★ 换上的是自己存储的公开地址（配置的前缀）");
			assert.equal(rewritten.includes("# 站外图"), true, "★ 笔记的其它内容必须原样保留");
			assert.equal(externalHostRequests.length, 1, "★ 站外图只该下载一次");

			// ⭐ 再渲染一次：这个站点已被记住 → 不该再问（渲染会因滚动、切视图反复发生）
			const askedSoFar = askCalls.length;
			const downloadsSoFar = externalHostRequests.length;
			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}
			assert.equal(askCalls.length, askedSoFar, "★ 答过之后不该再问（否则每个站点都会被反复打扰）");
			assert.equal(
				externalHostRequests.length,
				downloadsSoFar,
				"（这条路径上要清理的是记忆，而不是重新下载）"
			);

			plugin.settings.externalImageCache = false;
		}

		// ============================================================
		// 8c. 缓存上限：超过后自动淘汰「最久没用过」的副本
		//
		// 这一轮验的是**入口有没有把这条链路接上**：设了上限之后，
		// 后台轮换真的会去看一眼、真的会淘汰、并且真的只淘汰该淘汰的。
		// 判定细节（挑谁、宽限期、腾不到目标怎么报）在 `test-rotation.mjs` 与
		// `test-eviction.mjs` 里穷举。
		// ============================================================
		{
			// ⚠️ 先等"启动那一轮定时器"跑掉。它此刻**没有上限**、会立刻返回，
			// 也不会占用节流；但若让它插在"设上限"与"触发轮换"之间，这一轮就会被节流挡掉
			//（那是产品的正确行为，不是缺陷），测试于是变成偶发失败。显式等它才是确定性的。
			const sinceLoad = Date.now() - loadedAt;
			if (sinceLoad < STARTUP_WINDOW_MS) {
				await new Promise((resolve) => setTimeout(resolve, STARTUP_WINDOW_MS - sinceLoad));
			}

			// 造一份够大的副本：1 MB 的上限之下必须**有东西可腾**，
			// 而缓存目录里现有的那些都只有几十字节。
			const bigBytes = new Uint8Array(2 * 1024 * 1024);
			bigBytes.set(HOSTILE_BYTES);
			const pastedBefore = editor.replaced.length;
			app.workspace.trigger("editor-paste", makePasteEvent([makeFile("big.png", bigBytes)]), editor, {
				file: { path: "notes/上限.md" },
			});
			await waitFor(() => editor.replaced.length > pastedBefore, "大图上传后链接被插入", 20000, diagnose);

			// ⚠️ 必须让宿主的文件索引看到刚写下的缓存副本。
			// 替身**刻意**让文件索引滞后于磁盘（那是真实行为：Obsidian 扫描有延迟），
			// 而淘汰在"拿不到删除凭据"时会**跳过**（绝不退化为底层删除）——
			// 不刷新的话，这一轮只会淘汰旧文件，刚上传的那份要等下一轮才轮得到。
			await harness.refreshPathCache();

			const index = plugin.indexStore.index;
			const inserted = editor.replaced[pastedBefore] ?? "";
			const uploadedUrl = /https?:\/\/[^\s)]+/.exec(inserted)?.[0] ?? "";
			const entry = uploadedUrl ? index.findByRemoteUrl(uploadedUrl) : undefined;
			assert.ok(entry, `★ 刚上传的图应登记进索引（插入的内容：${JSON.stringify(inserted)}）`);

			// ⭐ 把全部条目的「最近使用」回拨两小时。
			// 刚上传的副本落在宽限期内（10 分钟），轮换**故意**不动它们 —— 那是正确行为
			//（避免"刚下载完就删掉"），但那样这条场景就永远只测到"什么都没发生"。
			// 回拨等于告诉它"这些是两小时前用的"。
			//
			// ⚠️ 这里直接改字段，而不是走 `touch()`：`touch` 的语义是"刚被用到"，
			// **有意**不允许把时间往回拨（试过 —— 回拨会被它拒掉，于是条目仍留在宽限期内，
			// 整条场景变成"什么都没发生"）。测试要构造的正是"两小时前用过"这个状态。
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
			for (const key of index.keys()) {
				const record = index.get(key);
				if (record) record.lastUsedAt = twoHoursAgo;
			}

			const entriesBefore = index.size;
			const deletedBefore = harness.calls.delete.length;
			const trashedBefore = harness.calls.trash.length;
			mockObsidian.Notice.instances.length = 0;

			// 把上限调到 1 MB 并保存 —— 保存设置会触发一轮检查
			plugin.settings.cacheLimitMb = 1;
			await plugin.saveSettings();

			await waitFor(() => !index.has(entry.key), "超限后自动淘汰了最久没用过的副本", 20000, diagnose);

			assert.equal(await existsOnDisk(root, entry.cachePath), false, "★ 被淘汰的副本要真的离开磁盘");
			// ⭐ 缓存清理只有一种方式：`Vault.delete` ⇒ 磁盘空间**立刻**释放。
			// 这条断言的意义就是"上限真的解决了空间问题"：走回收站的话文件会离开 vault，
			// 但那份空间仍然占着，于是"设了上限，磁盘还是满的"。
			assert.ok(
				harness.calls.delete.includes(entry.cachePath),
				"★ 自动淘汰也必须用 Vault.delete（立刻释放空间才是设上限的目的）"
			);
			assert.equal(
				harness.calls.trash.length,
				trashedBefore,
				"★ 自动淘汰也不许走回收站（空间不会释放，而那正是设上限要解决的）"
			);
			assert.ok(index.size < entriesBefore, `索引条目数应减少（${entriesBefore} → ${index.size}）`);
			assert.ok(harness.calls.delete.length > deletedBefore, "删除调用应当增加");
			// ⚠️ 提示是"淘汰之后"才发出的（执行层先返回、编排层再算实际回收量并提示），
			// 而上面那个 waitFor 看到的是**索引被摘掉**那一刻 —— 两者之间隔着一次 await。
			// 所以这里也要"等"而不是"直接断言"，否则就是一个偶发失败。
			await waitFor(
				() => mockObsidian.Notice.instances.some((n) => /MB/.test(n.message)),
				"淘汰之后给出了提示（腾了多少 MB）",
				5000,
				diagnose
			);

			// 关掉上限，免得影响后面的场景
			plugin.settings.cacheLimitMb = 0;
		}

		// ============================================================
		// 9. 卸载：事件引用必须能被宿主注销（否则热重载后每粘一次插两条）
		// ============================================================
		for (const ref of plugin.eventRefs) app.workspace.offref(ref);
		assert.equal(
			(app.workspace.registered.get("editor-paste") ?? []).length,
			0,
			"注销后不应还有粘贴处理器"
		);

		return {
			registrations: plugin.registrations.map((r) => r.kind),
			putCount: server.countByMethod("PUT"),
		};
	} finally {
		// 模拟卸载：真实宿主在卸载时会调用这些清理函数。
		//
		// ⚠️ 这**不只是**为了"干净"：周期定时器（10 分钟）不清掉的话，本进程会一直
		// 有一个活着的定时器 ⇒ Node 不肯退出 ⇒ 表现是"测试全绿却卡住"，
		// 最后被外层超时杀掉。而那种卡死最难查（日志里什么都没有）。
		for (const cleanup of [...(plugin.cleanups ?? [])].reverse()) {
			try {
				cleanup();
			} catch {
				// 清理失败不该影响测试结论
			}
		}
		// 再兜一层：连"没被 register 登记"的定时器也清掉（理由见套件开头那段）
		window.setTimeout = realSetTimeout;
		window.setInterval = realSetInterval;
		for (const [kind, id] of createdTimers) {
			if (kind === "interval") window.clearInterval(id);
			else window.clearTimeout(id);
		}
		// 恢复默认（抛错）—— 否则同一进程里后续套件会意外走真实网络。
		mockObsidian.setRequestUrlImpl(null);
		await server.close();
		// ⚠️ 删临时目录**必须容错、而且不能在本进程里等**：Windows 上 `rm -r` 偶发
		// 会卡住不返回（现场只剩未完成的 fs 请求，套件其实早已跑完）—— 症状是
		// "**测试全绿但进程退不出去**"，被外层超时杀掉，日志里什么都没有。
		// 交给分离的子进程之后，卡住也只卡它自己。理由详见 `cleanup.mjs`。
		cleanupInBackground(root);
	}
}
