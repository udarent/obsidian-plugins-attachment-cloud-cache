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
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * 1.2.0（D-17）之前的缓存目录名。
 *
 * ⚠️ 插件**自己已经不认识它了**（那个设置项被删掉，任何地方都不许再读它）。
 * 这个常量只在两处当**夹具**用：① 老 `data.json` 里那个遗留键；② "副本躺在
 * 老缓存目录里"这件事 —— 用来证明上限淘汰与索引都**不再按目录判**。
 */
const LEGACY_CACHE_FOLDER = "_attachment-cache";
const EXTERNAL_IMAGE_URL = `https://${EXTERNAL_HOST}/a.png`;
/**
 * 等「启动那一轮定时器」要用多久。
 *
 * 必须**大于** `main.ts` 里那个启动延迟（3 秒）—— 这一轮的意义是把它**让过去**，
 * 而不是与它抢：抢到了会被节流（那是产品的正确行为），测试就成了偶发失败。
 */
const STARTUP_WINDOW_MS = 3500;

/**
 * 缓存索引的落盘位置（与 `createIndexStore` 的推导一致）。
 *
 * ⚠️ 读的是**磁盘上的那个文件**，不是内存里的索引对象 —— 判据要落在"用户能看到的东西"上。
 * （内存里对而磁盘上没写下来，用户下次启动就会发现缓存"不被认识"。）
 */
const CACHE_INDEX_PATH = ".obsidian/plugins/attachment-cloud-cache/.cache-index.json";
const EXTERNAL_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
/**
 * 弹窗那一段（8b4）专用的字节序列。
 *
 * ⚠️ 必须与 {@link EXTERNAL_IMAGE_BYTES} **不同**，否则会踩到内容寻址：
 * 相同的字节就是相同的 key，于是它会命中前面几段已经缓存过的那份副本，
 * "缓存目录里多出一个新文件"根本不会发生 —— 那个断言会以一个**误导人**的理由失败
 *（我第一版就是这么写的，现场是"哪儿都没有新文件"）。
 */
const PICKER_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
/**
 * 8b4 用的一对地址：**路径不同、文件名相同、字节相同** ——
 * 用来制造"这张图其实已经在缓存里了"。
 *
 * ⚠️ 文件名必须相同：1.2.0 起 key = `名字-内容哈希.扩展名`，**文件名是对象身份的一部分**，
 * 换个文件名就是另一个对象。所以"同一份内容换个地址再取"这件事，
 * 只有在**文件名也相同**时才落回同一个 key —— 这条路径要按这个口径钉住。
 * ⚠️ 2026-10-14（D-24）：上传那一侧现在有两条跨名复用的路（名字归一 / 按内容哈希认亲，
 * 见 §19.4），但**下载侧仍按 key 找对象**，这条口径没变。
 */
const PICKER_FRESH_URL = `https://images.example.test/pick-a.png`;
const PICKER_REUSE_URL = `https://images.example.test/deep/pick-a.png`;
/**
 * 8b4 用的第三个地址：**Bing 图片 CDN 那种形状** ——
 * 最后一段自己带一个点，点后面是令牌而不是类型，并且带查询串。
 *
 * ⚠️ 这个形状的字节序列必须与上面两个都不同，否则会命中已缓存的副本，看不到"新文件"。
 */
const TOKEN_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x33, 0x44]);
const TOKEN_SHAPED_URL = `https://images.example.test/th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208&h=169`;

/** 记下"站外图床"被请求过几次 —— 用来断言"只下载一次"。 */
const externalHostRequests = [];

function externalImageResponse(url) {
	if (!String(url).includes(EXTERNAL_HOST)) return null;
	externalHostRequests.push(String(url));
	if (String(url).includes("/a.png")) {
		return { status: 200, headers: { "content-type": "image/png" }, arrayBuffer: EXTERNAL_IMAGE_BYTES.buffer };
	}
	// ⭐ 8b4 用的一对地址：**路径不同、文件名相同、字节相同**。
	// 于是两个地址得到同一个 key，第二个走的是"复用已有副本"。
	// 这条路径要从两端都钉住（见 8b4）。
	if (String(url).includes("/pick-a.png") || String(url).includes("/pick-b.png")) {
		return { status: 200, headers: { "content-type": "image/png" }, arrayBuffer: PICKER_IMAGE_BYTES.buffer };
	}
	// ⭐ 8b4 的"令牌形状"地址：类型只能靠响应头给（URL 里根本没有真扩展名）
	if (String(url).includes("/th/id/OIP-C.")) {
		return { status: 200, headers: { "content-type": "image/png" }, arrayBuffer: TOKEN_IMAGE_BYTES.buffer };
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
function makePasteEvent(files, { withText = false, alsoInItems = false } = {}) {
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
			// ⭐ `alsoInItems` 模拟**真实剪贴板**：同一个文件在 `files` 与 `items` 两处都有，
			// 而 `getAsFile()` 给的是**另一个 File 对象**、时间戳也不同
			//（宿主新建那个对象时取的是"此刻"）。默认那份 items 里没有 `getAsFile`，
			// 所以它一点也没碰这条路径 —— 用户实测报的"一次粘贴出现两张相同图片"正是从这里漏的。
			items: alsoInItems
				? files.map((file) => ({
						kind: "file",
						type: file.type,
						getAsFile: () => ({ ...file, lastModified: 2 }),
					}))
				: files.map(() => ({ kind: "file" })),
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
	/**
	 * 记录 `saveData` 的调用。
	 *
	 * ⚠️ 替身的 `_data` **初始就是 `{}`**，所以"它非空"证明不了任何事 ——
	 * 要判断"设置到底有没有被重写"，只能数调用次数（见下面第 1 条断言）。
	 */
	const saveDataCalls = [];
	const rawSaveData = plugin.saveData.bind(plugin);
	plugin.saveData = async (data) => {
		saveDataCalls.push(data);
		return rawSaveData(data);
	};
	// 设置由测试给定（指向本地 mock S3）。⚠️ 绝不能读真实 vault 的 data.json ——
	// 那会把图上传到用户的真实对象存储。
	plugin.loadData = async () => ({
		autoUpload: true,
		enabledExtensions: ["png", "jpg"],
		// ⚠️ 两个**故意的遗留值**：老用户的 data.json 里就是这样躺着。
		// `"cache"` 是 D-17 取消掉的第三档（读设置时折成 `"keep"`）；
		// `cacheFolder` 是随缓存目录一起删掉的字段（字段表直接丢掉，且**谁都不许再读它**）。
		// 两条都有对应断言钉住 —— 见下面"一次性兼容升级"之后那两行。
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
			// ⚠️ 这一条是**故意的遗留键**（1.2.0 取消了 key 模板）：老用户的 data.json
			// 里就躺着它。它已不参与任何行为，但要能被下面那条"一次性兼容升级"识别并清掉。
			objectKeyTemplate: "{hash}.{ext}",
		},
	});
	// 只有**秘密**进钥匙串（替身的 SecretStorage 是内存 Map）。
	// 访问密钥 ID 不再进钥匙串 —— 那是标识符，且 Obsidian 的密钥 ID 不允许大写。
	app.secretStorage.setSecret("acc-test-sk", SECRET_ACCESS_KEY);

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
	const realClearTimeout = window.clearTimeout;
	const realClearInterval = window.clearInterval;
	const createdTimers = [];
	/** 被清掉过的定时器 id（用于第 9b 节按效果判"清理回调确实有效"）。 */
	const clearedTimers = [];
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
	window.clearTimeout = (id) => {
		clearedTimers.push(id);
		return realClearTimeout(id);
	};
	window.clearInterval = (id) => {
		clearedTimers.push(id);
		return realClearInterval(id);
	};

	try {
		/**
		 * 现场快照：失败时能看到"提示了什么、发了什么请求"。**单行**，见 `waitFor`。
		 *
		 * ⚠️ 索引那一栏必须**容错**（`?.` + 兜底文案）：有一条变异正是"忘了读索引"
		 * （`indexStore` 留在 `null`），而快照自己抛 `TypeError` 会把那条变异的**真实原因**
		 * 盖掉 —— 变异验证于是判"原因不符"（红的是一条与它无关的诊断代码）。
		 * 实测踩到过：`Cannot read properties of null (reading 'index')`。
		 */
		const diagnose = () =>
			[
				`提示=${mockObsidian.Notice.instances.map((n) => n.message).join(" / ") || "(无)"}`,
				`请求=${server.requests.map((r) => r.method).join(",") || "(无)"}`,
				`注册=${plugin.registrations.map((r) => r.detail).join(",") || "(无)"}`,
				`索引=${
					plugin.indexStore?.index
						.toArray()
						.map((e) => `${e.key}@${e.cachePath}`)
						.join(" / ") || "(索引未加载)"
				}`,
			].join(" ｜ ");

		// ============================================================
		// 1. 加载：onload 不得抛错，且必须**注册**该注册的东西
		// ============================================================
		await plugin.onload();
		/** `onload` 完成的时刻 —— 用来等"启动那一轮定时器"跑完（见 8c）。 */
		const loadedAt = Date.now();
		/**
		 * `onload` 期间建的定时器 —— 第 9b 节按效果验"清理回调真的把它们清掉了"。
		 *
		 * ⚠️ 必须是**这个前缀快照**，不能拿整个 `createdTimers` 去比"有没有被 clear 过"：
		 * 后面几条链路（下载超时、索引落盘防抖）也会建短定时器，而它们**自然触发**过、
		 * 从来不需要谁去 clear —— 拿"建过但没被 clear"当判据会把它们全误报成残留
		 *（这一版就是这么红的：一堆 `_idleTimeout: 10` 的已触发定时器被标成"还在"）。
		 */
		const onloadTimers = createdTimers.slice();

		assert.ok(plugin.settingTabs.length >= 1, "★ 设置页必须被注册（否则用户连配置入口都没有）");

		// ⭐ 一次性兼容升级（1.2.0）：上面夹具里那个 `objectKeyTemplate` 是遗留键，
		// 载入时应当把设置**重写一次** —— 遗留键消失、其余字段照旧。
		// ⚠️ "恰好一次"是刻意的：onload 期间除了这次升级，没有别人会写 data.json
		//（唯一的另一处 `saveSettings` 挂在命令里）。数量对不上就说明这条链路没跑到。
		assert.equal(
			saveDataCalls.length,
			1,
			"★ 带遗留 key 模板的 data.json 必须被**重写一次**（否则用户不会知道 key 形状固定了）"
		);
		assert.ok(
			!("objectKeyTemplate" in saveDataCalls[0].s3),
			"★ 重写后的设置里不得再有遗留的 key 模板键（它已不参与任何行为）"
		);

		// ⭐ 1.2.0（D-17）：「本地副本」三态收窄成两态，而夹具里那个 `"cache"` 是
		// 老 data.json 的真实形态 ⇒ 必须在**读设置时**折成 `"keep"`；`cacheFolder`
		// 那个键则从此不存在于设置里（字段表丢掉它）。
		// ⚠️ 两条一起钉：折叠失败会让老用户落进"没有本地副本"的档（**悄悄丢掉离线**），
		// 而字段泄漏回来会让设置页凭空长出一个早已取消的输入框。
		assert.equal(plugin.settings.localCopy, "keep", '★ 老 data.json 里的 "cache" 必须折成 "keep"');
		assert.ok(!("cacheFolder" in plugin.settings), "★ 已取消的 cacheFolder 不得再出现在设置里");

		// ⭐ 后台自动轮换必须**真的接上了**：轮换器存在（忘了 new 就等于没有这个功能），
		// 而它依赖的两个定时器必须**登记了清理回调** —— 后者放在第 9b 节按**效果**验
		//（这里原本是一条 `登记数 >= 3` 的阈值断言，被一次新增 register 撑破而失效，见 9b 的说明）。
		assert.ok(plugin.rotation, "★ 入口必须装配缓存轮换器（否则上限设了也不会生效）");


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
		//
		// ⚠️ 必须用**同一个文件名**：1.2.0 起名字是对象身份的一部分（key = `名字-哈希.扩展名`），
		// 换个名字就是另一个 key、另一份对象 —— 那测的就不是"缓存命中"了。
		const before = server.countByMethod("PUT");
		const editor2 = makeEditor();
		app.workspace.trigger("editor-paste", makePasteEvent([makeFile("shot.png", HOSTILE_BYTES)]), editor2, info);
		await waitFor(() => editor2.replaced.length > 0, "第二次粘贴插入链接", 5000, diagnose);
		assert.equal(
			server.countByMethod("PUT"),
			before,
			"★ 内容相同应命中缓存，不得再 PUT 一次"
		);

		// ⭐⭐ 真实剪贴板的形状：同一个文件在 `files` 与 `items` 两处都有，而 `getAsFile()`
		// 给的是**另一个 File 对象**（时间戳也不同）。这就是用户实测报的那件事 ——
		// "复制粘贴图片的时候，发现出现了两张相同图片"（他那里一次粘贴插了 3 条一模一样的链接）。
		// 判据落在**插入的文本条数**上：一次粘贴只能留下一张图。
		const dupeEditor = makeEditor();
		app.workspace.trigger(
			"editor-paste",
			makePasteEvent([makeFile("dupe.png", HOSTILE_BYTES)], { alsoInItems: true }),
			dupeEditor,
			info
		);
		await waitFor(() => dupeEditor.replaced.length > 0, "重复载荷的粘贴插入链接", 5000, diagnose);
		const dupeLines = dupeEditor.replaced[0].split("\n").filter((line) => line !== "");
		assert.equal(
			dupeLines.length,
			1,
			`★ 一次粘贴只该插一条链接（实际 ${dupeLines.length} 条：${JSON.stringify(dupeEditor.replaced[0])}）`
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
		externalHostRequests.length = 0;
		for (const processor of plugin.postProcessors) processor(makeFakeContainer([foreignImg]), { sourcePath: "notes/任意.md" });
		assert.equal(
			foreignImg.getAttribute("src"),
			"https://third-party.example.net/x.png",
			"★ 站外图必须原样保留（既不下载也不改写）"
		);
		// ⭐ 而且**一个请求都不该发**：站外缓存默认关闭，一个没打开的插件不该去访问别人的站点。
		assert.equal(
			externalHostRequests.length,
			0,
			`★ 默认关闭时不该为站外图发任何请求（实际发了 ${externalHostRequests.length} 次）`
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
		[
			"audit-cache",
			"check-orphans",
			"cleanup-cloud",
			"pick-external-images",
			"repair-index",
			"upload-attachments",
		],
		// ⚠️ 1.2.0（D-17）：从六条变五条 —— `clean-cache` 退役（设计 §20.16 #5）。
		// 它原来的两个职责都有新家：自愈已自动化；删未引用副本由 R17 的询问与 cleanup-cloud 承担。
		// ⚠️ 2026-10-14 又回六条：新增 `check-orphans`（用户报"那次询问被误关后没法重来"）。
		"★ 六条维护命令都要注册（少一条就是「功能写了但用户找不到」）"
	);

		const runCommand = (id) => {
			const command = plugin.commands.find((c) => c.id === id);
			assert.ok(command, `命令 ${id} 应存在`);
			command.callback?.();
		};

		// ⚠️ 先把粘贴产生的链接**真的写进一篇笔记**：否则引用扫描看到的是一个没有引用的副本，
		// 下面那些数字会与"有没有笔记引用"这件事混在一起。
		const noteWithLink = "notes/未命名.md";
		await mkdir(join(root, "notes"), { recursive: true });
		await writeFile(join(root, noteWithLink), `这是笔记

${text}`);
		await harness.refreshPathCache();
		const referencedCopy = entry.cachePath; // 仍被笔记引用的那份

		// ============================================================
		// ⭐⭐ 「查看缓存占用」的口径（1.2.0 / D-17）：**只认索引记过的路径**。
		//
		// 这条口径是"取消缓存目录"之后最容易被静默取消的一处设计（设计 §20.16 #4）：
		// 从前它靠"扫缓存目录"找孤儿；那条目录没了之后，**索引外的文件可能是用户的附件** ——
		// 所以它既不能计入任何数字、更不能被动。
		//
		// ⚠️ 断言用**增量**而不是绝对值：这段跑到现在，索引里早就有前面几节留下的记录了，
		// 写死数字等于把断言绑在现场上（本项目为此吃过好几次亏）。
		// ============================================================
		const trashesBeforeReport = harness.calls.trash.length;
		const deletesBeforeReport = harness.calls.delete.length;
		const readReport = async () => {
			mockObsidian.Notice.instances.length = 0;
			runCommand("audit-cache");
			await waitFor(
				() => mockObsidian.Notice.instances.length > 0,
				"报告给出",
				5000,
				diagnose
			);
			return mockObsidian.Notice.instances.map((n) => n.message).join(" | ");
		};
		// 两个语言各一条正则（套件不该假设界面语言）；取到的那一组里第一个非空数字。
		const firstNumber = (text, pattern) => {
			const match = pattern.exec(text);
			if (!match) return Number.NaN;
			for (const group of match.slice(1)) if (group !== undefined && group !== "") return Number(group);
			return Number.NaN;
		};
		const filesIn = (t) => firstNumber(t, /(?:in (\d+) files|共 (\d+) 个文件)/);
		const unusedIn = (t) => firstNumber(t, /(?:note: (\d+) |引用的 (\d+) 个)/);
		const missingIn = (t) => firstNumber(t, /(?:(\d+) index entr|已不在 (\d+) 条)/);

		const baseline = await readReport();
		assert.ok(Number.isFinite(filesIn(baseline)), `报告应能解析出文件数，实际：${baseline}`);
		const files0 = filesIn(baseline);
		const unused0 = unusedIn(baseline);
		const missing0 = missingIn(baseline);

		// ① 索引外的文件：**三个数字都不许变**（这就是"索引外的文件不参与统计"的钉子）
		const outsideFile = "attachments/用户的图.png";
		await mkdir(join(root, "attachments"), { recursive: true });
		await writeFile(join(root, outsideFile), Buffer.from([1, 2, 3, 4]));
		await harness.refreshPathCache();
		const withOutside = await readReport();
		assert.deepEqual(
			[filesIn(withOutside), unusedIn(withOutside), missingIn(withOutside)],
			[files0, unused0, missing0],
			`★ 索引外的文件不得影响任何数字（它可能是用户的附件）实际：${withOutside}`
		);

		// ② 登记一份**没有笔记引用**的副本 ⇒ 文件数 +1、"没人引用" +1，失效数不变
		const unusedPath = "attachments/没人引用.png";
		await writeFile(join(root, unusedPath), Buffer.from([9, 9, 9, 9, 9]));
		const indexHandle = plugin.indexStore.index;
		indexHandle.set({
			key: "unused-1f.png",
			cachePath: unusedPath,
			remoteUrl: `${PUBLIC_BASE}/unused-1f.png`,
			size: 5,
			contentType: "image/png",
			etag: "",
			uploadedAt: new Date().toISOString(),
			lastUsedAt: Date.now(),
			sourceName: "没人引用.png",
		});
		const withUnused = await readReport();
		assert.equal(filesIn(withUnused), files0 + 1, `★ 索引里多了一条副本 ⇒ 文件数 +1 实际：${withUnused}`);
		assert.equal(unusedIn(withUnused), unused0 + 1, `★ 它没有笔记引用 ⇒"没人引用" +1 实际：${withUnused}`);
		assert.equal(missingIn(withUnused), missing0, `★ 失效数不该动 实际：${withUnused}`);

		// ③ 再登记一条**失效记录**（索引里有、磁盘上没有）⇒ 只有失效数 +1
		indexHandle.set({
			key: "stale-1f.png",
			cachePath: "attachments/已经不在了.png",
			remoteUrl: `${PUBLIC_BASE}/stale-1f.png`,
			size: 7,
			contentType: "image/png",
			etag: "",
			uploadedAt: new Date().toISOString(),
			lastUsedAt: Date.now(),
			sourceName: "已经不在了.png",
		});
		const withStale = await readReport();
		assert.equal(
			missingIn(withStale),
			missing0 + 1,
			`★ 索引指向的文件已不在 ⇒ 失效数 +1（自愈会摘掉这条）实际：${withStale}`
		);
		assert.equal(filesIn(withStale), files0 + 1, `★ 失效那条**不算副本** 实际：${withStale}`);

		// ④ ⭐ 跑一次「自检并修复」⇒ 那条失效记录**真的被摘掉**（不只是被报出来）。
		// ⚠️ 这一层此前只有注释在承诺（上面那句"自愈会摘掉这条"），**没有任何断言** ——
		// 而用户 2026-10-14 在 Android 上正是看到"索引指向的文件已不在 1 条"来报的：
		// 他要的是"这数字会不会自己消失 / 怎么让它消失"，所以这里钉住**命令那条线**。
		// （后台那条线走**两轮确认**，见 `self-heal` 套件与 `createAbsenceConfirmer`。）
		runCommand("repair-index");
		await waitFor(
			async () => missingIn(await readReport()) === missing0,
			"★ 修复命令要把失效记录摘掉（占用报告里的失效数回到基线）",
			5000,
			diagnose
		);
		assert.equal(
			indexHandle.get("stale-1f.png"),
			undefined,
			"★ 那条记录本身也要从索引里消失（否则下一轮又会查到它）"
		);

		// ⭐ 只读性：报告一个文件都不该动（它没有任何确认框，也没有删除路径）
		assert.equal(harness.calls.trash.length, trashesBeforeReport, "★ 报告不许碰回收站（它只读）");
		assert.equal(harness.calls.delete.length, deletesBeforeReport, "★ 报告不许删任何文件（它只读）");
		assert.ok(await existsOnDisk(root, outsideFile), "★ 索引外的文件必须原封不动（它可能是用户的附件）");
		assert.ok(await existsOnDisk(root, referencedCopy), "★ 被引用的副本当然也原封不动");

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
		// 用**另一篇**笔记：上面那篇里的引用是缓存占用报告那几条断言的依据，不能覆盖掉
		const notePath = "notes/待迁移.md";
		await writeFile(join(root, notePath), `![[pic.png]]\n\n![x](attachments/pic.png)\n`);

		// ⭐ 这条命令**只处理被笔记引用着的附件**（跑完会把它们移进缓存目录），
		// 所以"谁被引用"必须由宿主的链接索引（`metadataCache.resolvedLinks`）给出。
		// 真机上那份索引是宿主算出来的，这里把它当**输入**填 —— 见 `setResolvedLinks` 的说明。
		// ⚠️ 另外造一个**没有任何引用**的附件：它必须**一动不动**（既不传、也不搬）。
		const orphanPath = "attachments/没人引用.png";
		await writeFile(join(root, orphanPath), Buffer.from([...BATCH_BYTES, 0x7c]));
		harness.setResolvedLinks({ [notePath]: { [attachmentPath]: 2 } });
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

		// ⚠️ 失败时把 PUT 的对象路径列出来 —— 只说"PUT 了 2 次"没法判断多出来的是哪一个
		//（本项目踩过：计数断言被别的东西满足/破坏）。
		assert.equal(
			server.countByMethod("PUT"),
			putsBefore + 1,
			`★ 批量上传应恰好 PUT 一次（实际这些对象：${JSON.stringify(server.requests.filter((r) => r.method === "PUT").map((r) => r.path))}）`
		);
		const noteText = await readFile(join(root, notePath), "utf8");
		assert.ok(noteText.includes(`${PUBLIC_BASE}/`), `链接应指向配置的存储（公开前缀）：${noteText}`);
		assert.ok(
			!noteText.includes("attachments/pic.png"),
			`★ 两条本地链接都应被改写（短名与完整路径都要认）：${noteText}`
		);
		// ⭐ 1.2.0（D-17）：上传成功后那份原文件**留在原地** —— 它本身就是本地副本，
		// 没有缓存目录可搬（从前这里断言的是"原文件不在了"）。
		assert.equal(
			await existsOnDisk(root, attachmentPath),
			true,
			"★ 原文件应留在原地（副本就是它自己）"
		);
		assert.equal(
			Buffer.compare(await readFile(join(root, attachmentPath)), Buffer.from(BATCH_BYTES)),
			0,
			"★ 留在原地的那份内容必须与原件逐字节一致"
		);
		// ⚠️ 这里**不**断言"缓存目录不存在"：本套件前面几节会主动往缓存目录里放东西
		//（构造"缓存被清""轮换"这些场景），所以那个目录本来就存在。
		// "不再建出缓存目录"由 ingest / download 两个套件在自己的干净环境里钉住。
		// ⭐ 没有任何笔记引用的附件**一动不动**（既不传、也不搬、也不改名）
		assert.ok(
			await existsOnDisk(root, orphanPath),
			"★ 没有被任何笔记引用的文件必须留在原地（这条命令只动被引用的）"
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
		// 8b. 站外图：默认设成「直接缓存」时，打开笔记即「下载 → 上传 → 改写链接」
		//
		// ⚠️ 这是全库唯一会下载**别人的图**、也是唯一会**改写用户笔记**的链路，
		// 所以它必须在接线层面被走一遍（而不是只靠单元套件间接推断）。
		//
		// ⚠️ 早先这里走的是"按站点询问 → 用户答缓存 → 才下载"。询问已经整条拆掉，
		// 现在**显式动作**是"设置里选「直接缓存」"或"在弹窗里勾选"，所以这一段
		// 直接把默认值设成 `cache` 来驱动它。
		// ============================================================
		{
			const externalUrl = EXTERNAL_IMAGE_URL;
			const notePath = "notes/站外.md";
			const originalNote = `# 站外图\n\n![x](${externalUrl})\n`;

			await mkdir(join(root, "notes"), { recursive: true });
			await writeFile(join(root, notePath), originalNote, "utf8");
			await harness.refreshPathCache();

			// 打开功能（默认关）= 用户同意自动处理
			plugin.settings.externalImageCache = true;
			externalHostRequests.length = 0;
			const putsBefore = server.countByMethod("PUT");

			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}

			// ⚠️ 等的是**改写完成**，不是 PUT 完成：这条链是"下载 → 上传 → 改写"，
			// 所以 PUT 结束时笔记还没改（等早了会读到一个还没改写的笔记）。
			await waitFor(
				async () => !(await readFile(join(root, notePath), "utf8")).includes(externalUrl),
				"站外图被下载、上传，并且笔记里的链接被改写",
				10000,
				diagnose
			);

			assert.equal(server.countByMethod("PUT"), putsBefore + 1, "★ 恰好一次 PUT");

			const rewritten = await readFile(join(root, notePath), "utf8");
			assert.equal(rewritten.includes(externalUrl), false, "★ 笔记里的站外链接必须被改写");
			assert.equal(rewritten.includes(PUBLIC_BASE), true, "★ 换上的是自己存储的公开地址（配置的前缀）");
			assert.equal(rewritten.includes("# 站外图"), true, "★ 笔记的其它内容必须原样保留");
			assert.equal(externalHostRequests.length, 1, "★ 站外图只该下载一次");

			// ⭐ 再渲染一次（渲染会因滚动、切视图反复发生）：此时元素上的地址已经是**自己的**
			// 公开地址，判定层认出"属于本存储"⇒ 不该再下载一次。
			const downloadsSoFar = externalHostRequests.length;
			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}
			assert.equal(
				externalHostRequests.length,
				downloadsSoFar,
				"★ 同一个地址不该被下载两次（去重表在这条路径上也要生效）"
			);

			plugin.settings.externalImageCache = false;
		}

		// ============================================================
		// 8b1. ⭐⭐ 站点名单把该站点挡在外面时：一个请求都不发，笔记一个字都不动
		//
		// 1.2.0 之前这里量的是「开着功能但选『什么都不做』」。那个状态已经并进开关了，
		// 于是这一段改量**新**的那道闸门：开关是开的（用户同意自动处理），
		// 但名单把该站点排除在外。名单形同虚设 = "设置改了、没有任何效果"，而且静默。
		// ⚠️ 这里量的是**自动**那一路；显式勾选不受名单约束（见 8b4 段）。
		// ============================================================
		{
			const externalUrl = EXTERNAL_IMAGE_URL;
			const externalHost = new URL(externalUrl).host;
			const notePath = "notes/站外不在范围内.md";
			const originalNote = `# 别动我\n\n![x](${externalUrl})\n`;

			await writeFile(join(root, notePath), originalNote, "utf8");
			await harness.refreshPathCache();

			plugin.settings.externalImageCache = true;
			plugin.settings.externalSiteMode = "blocklist";
			plugin.settings.externalSiteList = [externalHost];
			externalHostRequests.length = 0;
			const putsBefore = server.countByMethod("PUT");

			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}
			// 给 fire-and-forget 一点时间：名单若没被读到，这里就会看到请求
			await new Promise((resolve) => setTimeout(resolve, 500));

			assert.equal(externalHostRequests.length, 0, "★ 被名单挡住的站点，一个字节都不该下载");
			assert.equal(server.countByMethod("PUT"), putsBefore, "★ 也不该上传任何东西");
			assert.equal(
				await readFile(join(root, notePath), "utf8"),
				originalNote,
				"★ 笔记必须逐字符不变（改写别人的笔记是不可逆的）"
			);

			// ⭐ 反向：把名单换成别的站点 ⇒ 立刻照常搬。
			// 少了这一条，"名单"有可能只是**把功能整个关掉**了 —— 那种实现同样能让
			// 上面三条全绿，而用户会发现"名单里填什么都一样"。
			plugin.settings.externalSiteList = ["someone-else.example"];
			externalHostRequests.length = 0;
			for (const processor of plugin.postProcessors) {
				processor(makeFakeContainer([makeFakeImage(externalUrl)]), { sourcePath: notePath });
			}
			await waitFor(
				() => externalHostRequests.length > 0,
				"★ 不在名单里的站点必须照常处理（否则名单等于把功能关掉了）"
			);
			// 让这条链跑完（它还要上传 + 改写笔记）再收尾，免得收尾时它正写到一半
			await new Promise((resolve) => setTimeout(resolve, 500));

			// 收拾干净：这一段造的那篇笔记里**刻意留着**那条站外链接（那正是它的意义），
			// 而它会被后面"命令扫全库"那段算成候选 —— 不删掉就会让那一段的请求计数变成 2。
			// 用完即删，比让后面的断言去"减去它"清楚得多。
			const leftover = app.vault.getAbstractFileByPath(notePath);
			if (leftover) await app.vault.delete(leftover, true);
			await harness.refreshPathCache();

			plugin.settings.externalImageCache = false;
			plugin.settings.externalSiteMode = "off";
			plugin.settings.externalSiteList = [];
		}

		// ============================================================
		// 8b2. ⭐⭐ 批量上传命令也要看到**笔记里的外链图**
		//
		// 这条命令的意图是"把还没进你自己存储的图搬进去"，而指向别处的图同样没进存储
		//（只是它们在别人的服务器上）。用户明确要求：**除了被他标成「不再询问」的站点**，
		// 外链图也要一起处理。
		//
		// ⚠️ 授权红线在这里落地：判定层只会给出"这个站点用户还没答过"，
		// 而**真正的授权发生在命令的确认框里** —— 所以确认框必须把站点列出来。
		// 下面三段分别钉住：确认即授权（且记住）、取消 = 什么都没发生、不再询问 = 一个请求都不发。
		//
		// ⚠️ 这一段与 8b 的区别：8b 走的是"渲染路径自动搬"，这里走的是**命令**（显式动作）——
		// 它必须能找到那些图，**哪怕开关是关的**（1.2.0 起命令不要求先打开开关），
		// 否则"只想手动挑几张"的用户会连这条命令都用不了。
		// ============================================================
		{
			const externalUrl = EXTERNAL_IMAGE_URL;
			const externalNote = "notes/外链待迁移.md";
			// ⭐ 故意**关掉开关**：命令是显式动作，不受它约束
			plugin.settings.externalImageCache = false;
			await writeFile(join(root, externalNote), `# 外链\n\n![x](${externalUrl})\n`, "utf8");
			await harness.refreshPathCache();

			const externalConfirms = [];
			plugin.confirmMaintenance = async (options) => {
				externalConfirms.push(options);
				return true; // 用户点了确认
			};
			externalHostRequests.length = 0;
			mockObsidian.Notice.instances.length = 0;
			runCommand("upload-attachments");

			await waitFor(
				async () => !(await readFile(join(root, externalNote), "utf8")).includes(externalUrl),
				"外链图被下载、上传，笔记里的链接被改写",
				10000,
				diagnose
			);

			assert.equal(externalHostRequests.length, 1, "★ 命令下载这张外链图只该一次");
			const rewrittenExternal = await readFile(join(root, externalNote), "utf8");
			assert.ok(
				rewrittenExternal.includes(`${PUBLIC_BASE}/`),
				`★ 外链应被改写成自己存储的地址：${rewrittenExternal}`
			);
			assert.ok(rewrittenExternal.includes("# 外链"), "★ 笔记的其它内容必须原样保留");

			// ⭐ 确认框必须**列出即将访问的站点** —— 它就是这次下载的授权凭据。
			// 只说"还有 1 张站外图"等于让用户盲签一份许可。
			const externalLines = (externalConfirms.at(-1)?.lines ?? []).join(" ｜ ");
			assert.ok(
				externalLines.includes(EXTERNAL_HOST),
				`★ 确认框必须列出即将访问的站点（那是授权凭据）：${externalLines}`
			);

			// ⭐ 同一张确认框也必须说清"文件留在原地"（1.2.0 / D-17）：用户的预期
			// 来自旧文案"会被搬进缓存目录"，如今什么都不搬 —— 不写清楚，
			// 他跑完发现文件还在会以为命令没生效（或者反过来，以为文件被搬走了）。
			// ⚠️ 判据对**两种语言**都成立（套件不该假设界面语言），所以查
			// "attachments folder" 或 "附件目录" 任一个。
			assert.ok(
				/(?:attachments folder|附件目录)/.test(externalLines),
				`★ 确认框必须说明原文件留在附件目录里（不然用户以为命令没生效）：${externalLines}`
			);

			// ── 取消 = 什么都没发生（一个请求都不发，笔记一个字都不动）──
			const cancelNote = "notes/外链取消.md";
			await writeFile(join(root, cancelNote), `![y](${externalUrl})\n`, "utf8");
			await harness.refreshPathCache();
			externalHostRequests.length = 0;
			plugin.confirmMaintenance = async () => false; // 用户点了取消
			runCommand("upload-attachments");
			await new Promise((resolve) => setTimeout(resolve, 300));

			assert.equal(externalHostRequests.length, 0, "★ 取消之后**不得**下载任何站外图");
			assert.ok(
				(await readFile(join(root, cancelNote), "utf8")).includes(externalUrl),
				"取消之后笔记必须一个字都没动"
			);

			plugin.settings.externalImageCache = false;
		}

		// ============================================================
		// 8b3. ⭐⭐ 改了站外相关设置之后，**当前打开着的**笔记要立刻重新判定
		//
		// 站外那条判定是**渲染时**做的，而改设置不会让已经渲染出来的图重跑 ——
		// 少了这一步，用户打开功能（或改了名单）之后**什么都看不到**，
		// 要等下次重开笔记才生效。这正是本项目一直在防的那类"改了设置没反应"。
		//
		// 这条断言不真的去下载：把**名单**设成拦住这个站点 ⇒ 重看了，却什么都不搬。
		// ============================================================
		{
			plugin.settings.externalImageCache = true;
			plugin.settings.externalSiteMode = "blocklist";
			plugin.settings.externalSiteList = [new URL(EXTERNAL_IMAGE_URL).host];
			const externalUrl = EXTERNAL_IMAGE_URL;
			// 造一个"打开着的笔记视图"：容器里挂着一张站外图。
			// ⚠️ `contains` 不能少 —— 归属解析判的是"这个元素在不在这个视图的容器里"
			//（真实的 `containerEl` 是 DOM 节点，天然有它）。少了它，那张图会被判成
			// "不在任何笔记里"而跳过 —— 这类断言第一次就是因此超时的。
			const displayed = makeFakeImage(externalUrl);
			const fakeLeaf = {
				view: {
					file: { path: "notes/站外.md" },
					containerEl: {
						querySelectorAll: (selector) => (selector === "img" ? [displayed] : []),
						contains: (node) => node === displayed,
					},
				},
			};
			app.workspace.leaves.push(fakeLeaf);
			try {
				// 包一层记账：重看的表现就是"把容器里的图重新丢进 live 队列"
				const queue = plugin.externalLive;
				const originalSee = queue.see.bind(queue);
				const seen = [];
				queue.see = (element) => {
					seen.push(element);
					return originalSee(element);
				};
				try {
					await plugin.saveSettings();
					assert.equal(
						seen.length,
						1,
						`★ 改完设置要立刻重看当前打开的笔记（实际重看了 ${seen.length} 张）—— 否则用户会以为改了没生效`
					);
					assert.equal(seen[0], displayed, "重看的应当就是容器里那张图");
				} finally {
					queue.see = originalSee;
				}
			} finally {
				app.workspace.leaves.pop();
				plugin.settings.externalImageCache = false;
				plugin.settings.externalSiteMode = "off";
				plugin.settings.externalSiteList = [];
			}
		}

		// ============================================================
		// 8b4. ⭐⭐ 弹窗勾选那条路：「缓存站外图片（可挑选）」
		//
		// 为什么单独一段：这条路**从来没有端到端跑过**。宿主的 `Modal` 在 Node 里点不了，
		// 于是单元套件只覆盖了纯逻辑（勾选单位、去重、全选），而"命令入口 → 取候选 →
		// 弹窗 → 逐个执行 → 汇总"这条接线一次都没被驱动过 —— 用户的实测走的正是这条路。
		//
		// 这里把弹窗那一环换成"全选并确认"的替身（它做的正是真弹窗做的事：
		// 调 loader 取候选，再把候选交回去），其余全部是真东西：
		// 真构建产物、真磁盘、真 HTTP、真索引文件。
		//
		// ⚠️ 判据的重点**不是**"笔记被改写了"，而是"**缓存目录里真的多了一个文件、
		// 索引文件里真的多了一条记录**"。用户报的现象恰恰是"说缓存了，但缓存目录没有新文件"，
		// 而只断言笔记被改写的话，那种"传上去了、本地副本却没落下来"的坏法会**全绿地漏过去**
		//（它正是"离线可用"这个主承诺的反面）。
		// ============================================================
		{
			const readIndex = async () => {
				try {
					return JSON.parse(await readFile(join(root, CACHE_INDEX_PATH), "utf8"));
				} catch {
					return { entries: [] };
				}
			};
			// ⭐ 1.2.0（D-17）：本地副本落在**附件目录**（本套件没配附件目录 ⇒ 就是 vault 根），
			// 不再有缓存目录。这一节关心的是"本地副本有没有多出来"，所以列 vault 根下的**文件**。
			const cacheFiles = async () => {
				try {
					const entries = await readdir(root, { withFileTypes: true });
					return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
				} catch {
					return [];
				}
			};
			/** vault 的完整文件清单（诊断用：文件"不见了"时要能看出它落到哪里去了）。
			 *  ⚠️ 必须**同步**：`waitFor` 是在拼错误消息时**同步**调 `diagnose()` 的。 */
			const treeOf = () => {
				const out = [];
				const walk = (dir, prefix) => {
					let list = [];
					try {
						list = readdirSync(join(root, dir), { withFileTypes: true });
					} catch {
						return;
					}
					for (const entry of list) {
						const path = prefix ? `${prefix}/${entry.name}` : entry.name;
						out.push(entry.isDirectory() ? `${path}/` : path);
						if (entry.isDirectory()) walk(path, path);
					}
				};
				walk(".", "");
				return out.join(", ");
			};
			// 造"当前笔记"。⚠️ 替身里 `getActiveFile()` 是硬编码返回 null 的，
			// 而弹窗的**默认范围**就是「当前笔记」（`readActiveNoteText` 读它）——
			// 不把它接上，这一段测的就不是用户实际走的那条路。
			const originalActiveFile = app.workspace.getActiveFile;
			const activate = (vaultPath) => {
				app.workspace.getActiveFile = () => app.vault.getAbstractFileByPath(vaultPath);
			};
			const originalPick = plugin.pickExternalImages;
			/** 弹窗替身 = "用户在默认范围里看到清单、全选、点确认"。 */
			const pickAllFromNote = () => {
				plugin.pickExternalImages = async (load) => load("note");
			};

			// ⭐ 开关**关着**：只让弹窗（显式勾选）那条路动手 —— 1.2.0 起它不受开关约束
			plugin.settings.externalImageCache = false;

			// ── 甲：一张**全新**的外站图，缓存目录与索引都该长出东西来 ──
			const externalUrl = PICKER_FRESH_URL;
			const notePath = "notes/勾选.md";
			await mkdir(join(root, "notes"), { recursive: true });
			await writeFile(join(root, notePath), `# 勾选\n\n![x](${externalUrl})\n`, "utf8");
			await harness.refreshPathCache();
			activate(notePath);
			pickAllFromNote();

			const filesBefore = await cacheFiles();
			const entriesBefore = (await readIndex()).entries.length;
			externalHostRequests.length = 0;

			runCommand("pick-external-images");

			await waitFor(
				async () => !(await readFile(join(root, notePath), "utf8")).includes(externalUrl),
				"弹窗那条路把外链改写成自己存储的地址",
				10000,
				diagnose
			);
			await waitFor(
				async () => (await cacheFiles()).length > filesBefore.length,
				"vault 里真的多了一份本地副本",
				5000,
				() => `vault 里的文件：${treeOf()}`
			);

			assert.equal(externalHostRequests.length, 1, "★ 这张图只该下载一次");

			const afterFiles = await cacheFiles();
			const newFiles = afterFiles.filter((name) => !filesBefore.includes(name));
			assert.equal(newFiles.length, 1, `★ vault 里应恰好多 1 份本地副本（实际 ${JSON.stringify(afterFiles)}）`);

			// 索引文件也要真的落盘 —— 只在内存里对，用户下次启动就会发现缓存"不被认识"
			const afterIndex = await readIndex();
			assert.equal(
				afterIndex.entries.length,
				entriesBefore + 1,
				`★ 索引文件应恰好多 1 条记录（${entriesBefore} → ${afterIndex.entries.length}）`
			);
			const added = afterIndex.entries.find((entry) => entry.cachePath.endsWith(newFiles[0]));
			assert.ok(
				added,
				`★ 新文件必须在索引里有对应记录（索引里的 cachePath：${JSON.stringify(afterIndex.entries.map((e) => e.cachePath))}）`
			);
			assert.equal(added.remoteUrl.startsWith(PUBLIC_BASE), true, "★ 记录里的远端地址应当指向自己的存储");
			// 记录指向的那个文件**真的存在** —— 这正是用户报的那件事
			assert.equal(await existsOnDisk(root, added.cachePath), true, "★ 索引指向的本地副本必须真的在磁盘上");

			const pickedNote = await readFile(join(root, notePath), "utf8");
			assert.equal(pickedNote.includes(externalUrl), false, "★ 笔记里的外链必须被改写");
			assert.equal(pickedNote.includes("# 勾选"), true, "★ 笔记的其它内容必须原样保留");

			// ── 乙：同一份字节、另一个地址（= 这张图其实**已经在缓存里**了）──
			//
			// 内容寻址的必然结果：两个地址只要**文件名**与字节都相同就是**同一个 key**，
			// 于是"没有新的本地副本"是**正确**行为 —— 那份副本早就在了。
			// ⚠️ 文件名不同的话就不成立了（名字是身份的一部分，见常量的说明）——
			// 所以这一对地址的**文件名必须一样**，换了名字这条断言就不再测那件事。
			// 这一条必须钉住，因为用户看到的正是这一幕：它得是**可解释**的
			//（"复用已有副本"），而不是看起来像什么都没做。
			const sameBytesUrl = PICKER_REUSE_URL;
			const reuseNote = "notes/勾选复用.md";
			await writeFile(join(root, reuseNote), `![y](${sameBytesUrl})\n`, "utf8");
			await harness.refreshPathCache();
			activate(reuseNote);
			pickAllFromNote();

			const filesBeforeReuse = await cacheFiles();
			const entriesBeforeReuse = (await readIndex()).entries.length;
			externalHostRequests.length = 0;

			runCommand("pick-external-images");
			await waitFor(
				async () => !(await readFile(join(root, reuseNote), "utf8")).includes(sameBytesUrl),
				"已缓存过的图，勾选后也要把链接改写成自己的存储地址",
				10000,
				diagnose
			);
			// 给它足够的时间"如果它会写文件的话早就写了"
			await new Promise((resolve) => setTimeout(resolve, 300));

			assert.equal(externalHostRequests.length, 1, "（字节要重新取一次才知道是不是同一份内容）");
			assert.deepEqual(
				await cacheFiles(),
				filesBeforeReuse,
				"★ 已缓存过的图不该多出本地副本（复用同一份，不是坏了）"
			);
			assert.equal(
				(await readIndex()).entries.length,
				entriesBeforeReuse,
				"★ 也不该多出索引记录（同一条记录仍然有效）"
			);
			// ⭐ 最要紧的一条：它改写成的地址应当**就是甲那条记录里的地址** ——
			// 这才叫"复用了同一份副本"，而不是"碰巧也没写文件"。
			// ⚠️ 用户看到的正是这一幕：说"已缓存"，而没有新的本地副本出现。
			// 那是**正确**行为（内容寻址：字节相同就是同一份），但它必须可解释 ——
			// 所以这里把"指向的是同一份副本"钉死，好让将来改文案/加提示时有依据。
			const reuseText = await readFile(join(root, reuseNote), "utf8");
			assert.equal(reuseText.includes(added.remoteUrl), true, "★ 复用的应当是甲那份副本的地址（不是又传了一份）");

			// ── 丙：URL 是**令牌形状**（点后面不是类型）—— 缓存下来的副本必须仍叫 `…png` ──
			//
			// 这是用户实测报的那一件事的根子：Bing 图片 CDN 的 URL 最后一段形如
			// `OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA`，按"最后一个点之后"取出来的"扩展名"
			// 是 23 个字符的令牌 ⇒ 缓存副本成了 `<哈希>.spb8lvtxu-zleqgemugctwaaaa`。
			// 而 **Obsidian 默认不显示它认不出的扩展名**，用户在缓存目录里等于"看不到新文件"。
			// ⇒ 判据落在**文件名**上：它必须以 `.png` 结尾，且不能含那串令牌。
			const tokenNote = "notes/勾选令牌.md";
			await writeFile(join(root, tokenNote), `![z](${TOKEN_SHAPED_URL})\n`, "utf8");
			await harness.refreshPathCache();
			activate(tokenNote);
			pickAllFromNote();

			const filesBeforeToken = await cacheFiles();
			runCommand("pick-external-images");
			await waitFor(
				async () => !(await readFile(join(root, tokenNote), "utf8")).includes(TOKEN_SHAPED_URL),
				"令牌形状的 URL 也要被改写成自己存储的地址",
				10000,
				diagnose
			);
			await waitFor(
				async () => (await cacheFiles()).length > filesBeforeToken.length,
				"令牌形状的 URL 也要在缓存目录里落一份副本",
				5000,
				() => `vault 里的文件：${treeOf()}`
			);

			const tokenFiles = (await cacheFiles()).filter((name) => !filesBeforeToken.includes(name));
			assert.equal(tokenFiles.length, 1, `★ 应恰好多 1 个文件（实际 ${JSON.stringify(tokenFiles)}）`);
			assert.equal(
				tokenFiles[0].endsWith(".png"),
				true,
				`★ 缓存副本必须以真实类型结尾（实际 ${JSON.stringify(tokenFiles[0])}）—— 否则 Obsidian 不显示它，用户就以为"没缓存"`
			);
			assert.equal(
				/spb8lvtxu|sbp8lvtxu/i.test(tokenFiles[0]),
				false,
				`★ 那串令牌不该出现在文件名里（实际 ${JSON.stringify(tokenFiles[0])}）`
			);

			plugin.pickExternalImages = originalPick;
			app.workspace.getActiveFile = originalActiveFile;
			plugin.settings.externalImageCache = false;
		}

		// ============================================================
		// 8c. 本地副本上限：超过后自动淘汰「最久没用过」的副本
		//
		// ⚠️ 1.2.0（D-17）改造后这一段的形态变了：候选与统计**一律来自索引**
		//（副本就散在附件目录里，不再有可枚举的缓存目录），而且淘汰前要**逐个 HEAD 复核**
		// "云端现在确实还有它"。所以这里直接**播下**索引记录 + 磁盘文件 + 云端对象，
		// 而不是靠粘贴落进某条目录。
		//
		// 判定细节（挑谁、宽限期、腾不到目标怎么报）在 `test-rotation.mjs` 与
		// `test-eviction.mjs` 里穷举；这里验的是"入口把这条链路接对了"。
		// ============================================================
		{
			// ⚠️ 先等"启动那一轮定时器"跑掉。它此刻**没有上限**、会立刻返回，
			// 也不会占用节流；但若让它插在"设上限"与"触发轮换"之间，这一轮就会被节流挡掉
			//（那是产品的正确行为，不是缺陷），测试于是变成偶发失败。显式等它才是确定性的。
			const sinceLoad = Date.now() - loadedAt;
			if (sinceLoad < STARTUP_WINDOW_MS) {
				await new Promise((resolve) => setTimeout(resolve, STARTUP_WINDOW_MS - sinceLoad));
			}

			// 播两份够大的副本（各 2 MB，上限 1 MB ⇒ 必须有东西可腾）：
			// ① 云端还在的 ⇒ 该被淘汰；② 云端**已经没了**的 ⇒ 绝不能删（新加的安全线）。
			const bigBytes = new Uint8Array(2 * 1024 * 1024);
			bigBytes.set(HOSTILE_BYTES);
			const legacyKey = "legacy-big-1f.png";
			const orphanKey = "legacy-gone-2f.png";
			const legacyPath = `${LEGACY_CACHE_FOLDER}/${legacyKey}`;
			const orphanPath = `${LEGACY_CACHE_FOLDER}/${orphanKey}`;
			await mkdir(join(root, LEGACY_CACHE_FOLDER), { recursive: true });
			await writeFile(join(root, legacyPath), Buffer.from(bigBytes));
			await writeFile(join(root, orphanPath), Buffer.from([...bigBytes, 0x7c]));
			// ⭐ 只有第一份在"云端"（HEAD 复核要能查到它）
			server.objects.set(legacyKey, { body: Buffer.from(bigBytes), contentType: "image/png" });
			await harness.refreshPathCache();

			const index = plugin.indexStore.index;
			index.set({
				key: legacyKey,
				cachePath: legacyPath,
				remoteUrl: `${PUBLIC_BASE}/${legacyKey}`,
				size: bigBytes.length,
				contentType: "image/png",
				etag: "",
				uploadedAt: new Date().toISOString(),
				// ⭐ 回拨两小时：刚写下的条目落在宽限期内，轮换**故意**不动它们
				//（避免"刚下载完就删掉"），那样这条场景就永远只测到"什么都没发生"。
				lastUsedAt: Date.now() - 2 * 60 * 60 * 1000,
				sourceName: legacyKey,
			});
			// 第二份更新一点（更晚被用到）⇒ 排在第一份之后被挑中
			index.set({
				key: orphanKey,
				cachePath: orphanPath,
				remoteUrl: `${PUBLIC_BASE}/${orphanKey}`,
				size: bigBytes.length + 1,
				contentType: "image/png",
				etag: "",
				uploadedAt: new Date().toISOString(),
				lastUsedAt: Date.now() - 1 * 60 * 60 * 1000,
				sourceName: orphanKey,
			});

			const entriesBefore = index.size;
			const deletedBefore = harness.calls.delete.length;
			const trashedBefore = harness.calls.trash.length;
			mockObsidian.Notice.instances.length = 0;

			// ⭐⭐ 先钉住"保存设置这一下，**接线上**真的触发了一轮检查"，再看效果。
			// 为什么不能只看效果（实测踩到过）：`maybeRotate` 有四条触发线
			//（启动 / 周期 / 保存设置 / 索引长大），其中"索引长大"那条在别的场景里
			// 也会被调到 ⇒ 把"保存设置 → 立刻检查"那行调用整条删掉，这一段**依然通过**
			//（变异「★ 保存设置后不触发轮换」因此**漏过**，是本次才发现的无牙锚点）。
			// 所以必须直接盯住那次调用本身，而不是它的间接后果。
			const realRotator = plugin.rotation;
			const rotateReasons = [];
			plugin.rotation = {
				maybeRotate: (reason) => {
					rotateReasons.push(reason);
					return realRotator.maybeRotate(reason);
				},
			};

			// 把上限调到 1 MB 并保存 —— 保存设置会触发一轮检查
			plugin.settings.cacheLimitMb = 1;
			await plugin.saveSettings();
			assert.ok(
				rotateReasons.includes("settings"),
				`★ 保存设置必须立刻触发一轮上限检查（用户刚把上限调小，期待立刻生效）—— 实际收到的触发原因：${
					JSON.stringify(rotateReasons)
				}`
			);

			await waitFor(() => !index.has(legacyKey), "超限后自动淘汰了最久没用过的遗留副本", 20000, diagnose);

			assert.equal(await existsOnDisk(root, legacyPath), false, "★ 被淘汰的副本要真的离开磁盘");
			// ⭐ 缓存清理只有一种方式：`Vault.delete` ⇒ 磁盘空间**立刻**释放。
			// 这条断言的意义就是"上限真的解决了空间问题"：走回收站的话文件会离开 vault，
			// 但那份空间仍然占着，于是"设了上限，磁盘还是满的"。
			assert.ok(
				harness.calls.delete.includes(legacyPath),
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

			// ⭐⭐ 新加的安全线：云端**已经没有了**的那份副本绝不能删
			//（删掉它就是丢数据 —— 那可能是最后一份）。方向是"确认不上就不动手"。
			assert.equal(
				await existsOnDisk(root, orphanPath),
				true,
				"★ 云端确认不上时，本地副本必须留着（宁可上限晚点生效，也不能删掉最后一份）"
			);
			assert.ok(index.has(orphanKey), "★ 那份副本的索引记录也必须留着（否则渲染层以为它不在了）");

			// 关掉上限，免得影响后面的场景
			plugin.settings.cacheLimitMb = 0;
			plugin.rotation = realRotator;
		}

		// ============================================================
		// 8d. ⭐ F18「释放本地空间」（2026-10-12 / D-19，设计 §20.10）
		//
		// 它是「本地副本 = 不留副本」那一档的**存量部分**：切到这一档时问一次，
		// 同意之后把**已上传 + 笔记仍引用着远端地址**的副本**永久删除**。
		//
		// 这一段的判据全部**不可逆**（被清的副本不进回收站），所以除了"该删的删了"，
		// 还要逐一钉住四条边界：
		// ① 删法必须是 `Vault.delete`（走回收站 = 空间不释放 = 这个功能白做）；
		// ② **孤儿不归它管**（没有远端链接的副本必须原封不动 —— 那是 R17 的活）；
		// ③ 云端确认不上就**不删**（那可能是最后一份）；
		// ④ 台账**不动**（云端对象还在）、索引条目**摘掉**（摘了才走"缺副本 ⇒ 重新下载"）。
		// ============================================================
		{
			const attachDir = "attachments";
			await mkdir(join(root, attachDir), { recursive: true });
			const targetKey = "release-target-1f.png";
			const orphanKey = "release-orphan-2f.png";
			const goneKey = "release-gone-3f.png";
			const neverUploadedKey = "release-never-4f.png";
			const targetPath = `${attachDir}/${targetKey}`;
			const orphanCopyPath = `${attachDir}/${orphanKey}`;
			const gonePath = `${attachDir}/${goneKey}`;
			const neverUploadedPath = `${attachDir}/${neverUploadedKey}`;

			const releaseBytes = new Uint8Array(3 * 1024 * 1024);
			releaseBytes.set(HOSTILE_BYTES);
			for (const path of [targetPath, orphanCopyPath, gonePath, neverUploadedPath]) {
				await writeFile(join(root, path), Buffer.from(releaseBytes));
			}
			// ⭐ 云端：目标、**孤儿**、**没传过的那份**都放进替身，只有 `goneKey` 故意不放。
			//
			// ⚠️ 为什么"该被拦下的那两份"也要有云端对象：否则它们会**因为云端确认不上**
			// 而被跳过 —— 于是"判据被改瞎（孤儿的记录被一并删）"这种变异**看不出来**
			//（文件照样在，断言照样过）。夹具必须让**因果可区分**：
			// 有云端对象 ⇒ 只要判据失效，它就会被真的删掉 ⇒ 断言立刻红。
			for (const key of [targetKey, orphanKey, neverUploadedKey]) {
				server.objects.set(key, { body: Buffer.from(releaseBytes), contentType: "image/png" });
			}
			await harness.refreshPathCache();

			const releaseIndex = plugin.indexStore.index;
			for (const [key, cachePath] of [
				[targetKey, targetPath],
				[orphanKey, orphanCopyPath],
				[goneKey, gonePath],
				[neverUploadedKey, neverUploadedPath],
			]) {
				releaseIndex.set({
					key,
					cachePath,
					remoteUrl: `${PUBLIC_BASE}/${key}`,
					size: releaseBytes.length,
					contentType: "image/png",
					etag: "",
					uploadedAt: new Date().toISOString(),
					lastUsedAt: Date.now(),
					sourceName: key,
				});
			}
			// 台账：只有前三份"是我们传上去的"（第四份故意不记 —— 它未必在云端）
			for (const key of [targetKey, orphanKey, goneKey]) releaseIndex.markUploaded(key);
			// 笔记里引用各自的对象：**孤儿那份故意不写进任何笔记**
			const releaseNote = "notes/清理本地占用.md";
			await writeFile(
				join(root, releaseNote),
				`![a](${PUBLIC_BASE}/${targetKey})\n![b](${PUBLIC_BASE}/${goneKey})\n![c](${PUBLIC_BASE}/${neverUploadedKey})\n`
			);
			await harness.refreshPathCache();

			// 切到「不留副本」——这一档的含义就是"本地不留副本"，于是切过来**那一刻问一次**
			const releaseAsks = [];
			plugin.confirmMaintenance = async (options) => {
				releaseAsks.push(options);
				return true;
			};
			const deletesBeforeRelease = harness.calls.delete.length;
			const trashesBeforeRelease = harness.calls.trash.length;
			mockObsidian.Notice.instances.length = 0;
			plugin.settings.localCopy = "trash";
			await plugin.saveSettings();

			// ⭐ 先钉"切档那一刻**问了**一次"（那是 F18 的入口①本身），再看效果 ——
			// 少了这一步，"不问"这种失效只能表现为后面那个超时，报出来的原因不指向入口。
			await waitFor(() => releaseAsks.length === 1, "切档时**问一次**", 10000, diagnose);

			// ⚠️ 等**最后一步**（摘索引记录）而不是等"删除调用出现"：替身是先记账再
			// `rm`，记账那一刻文件还在磁盘上 —— 早先按"调用出现"等，结果紧接着的
			// "文件必须离开磁盘"偶发为真（实测踩到）。摘索引是这一轮的最后一步，
			// 它成立 ⇒ 前面的删除都已经落定。
			await waitFor(
				() => !releaseIndex.has(targetKey),
				"切到「不留副本」后清掉了存量副本（索引记录被摘掉）",
				10000,
				diagnose
			);

			assert.equal(releaseAsks.length, 1, "★ 切档时**问一次**（而且只问这一次，不是每次保存都问）");
			assert.equal(releaseAsks[0].destructive, true, "★ 不可撤销的删除必须标成破坏性按钮");
			assert.ok(
				releaseAsks[0].lines.some((line) => /permanent|永久/.test(line)),
				`★ 确认框必须写明"永久删除"（它不进回收站）：${JSON.stringify(releaseAsks[0].lines)}`
			);
			assert.ok(
				(releaseAsks[0].cards ?? []).some((card) => String(card.id) === targetKey),
				"★ 清单里要列出将被删的那一份（那是用户按下按钮前唯一能核对的东西）"
			);

			// ① 该删的删了，而且**不进回收站**
			assert.equal(await existsOnDisk(root, targetPath), false, "★ 目标副本必须离开磁盘");
			assert.ok(harness.calls.delete.length > deletesBeforeRelease, "删除调用应当增加");
			assert.equal(
				harness.calls.trash.length,
				trashesBeforeRelease,
				"★ 存量清理不许走回收站（回收站不释放磁盘空间，而腾空间正是这个功能的目的）"
			);
			// ④ 索引记录摘掉、台账留着
			assert.equal(releaseIndex.has(targetKey), false, "★ 索引记录要摘掉（摘了才走「缺副本 ⇒ 重新下载」那条路）");
			assert.equal(releaseIndex.wasUploaded(targetKey), true, "★ 台账要留着 —— 云端对象还在，它不属于「没传过」");

			// ②③ 两条"绝不能碰"的边界
			assert.ok(await existsOnDisk(root, orphanCopyPath), "★ 孤儿（没有任何笔记引用）不归它管，必须留着");
			assert.ok(releaseIndex.has(orphanKey), "★ 孤儿的索引记录也要留着");
			assert.ok(await existsOnDisk(root, gonePath), "★ 云端确认不上的那份必须留着（它可能是最后一份）");
			assert.ok(releaseIndex.has(goneKey), "★ 它的索引记录也要留着");
			assert.ok(await existsOnDisk(root, neverUploadedPath), "★ 台账里没有的对象不得删（它未必在云端）");
			assert.ok(releaseIndex.has(neverUploadedKey), "★ 它的索引记录也要留着");

			// ⑥ 再跑一次：**该删的已经删完了**，但"云端确认不上"的那份仍是候选
			//（候选是纯判定、不联网；HEAD 复核在执行时做），所以它会再次出现在确认框里
			// 并在执行时被跳过 —— 结果通知必须**如实**报"删了 0 个、跳过 1 个"，
			// 而且"一个都没删"要另给一句解释（否则用户以为功能坏了）。
			//
			// ⚠️ 先把两条"会把副本补回来"的路径关掉：渲染遇到缺副本会重新下载
			//（外部图那条链在保存设置时会重跑一遍渲染）—— 那样子再跑就又有候选了，
			// 这条断言测到的会是"下载速度"而不是幂等。这是**如实设置前置条件**。
			plugin.settings.fallbackDownload = false;
			plugin.settings.externalImageCache = false;
			await plugin.saveSettings();
			mockObsidian.Notice.instances.length = 0;
			const deletesAfterFirst = harness.calls.delete.length;
			await plugin.freeUpLocalSpace();
			assert.equal(harness.calls.delete.length, deletesAfterFirst, "★ 该删的已经删完 ⇒ 不该再有新的删除");
			assert.ok(
				mockObsidian.Notice.instances.some((notice) =>
					notice.message.includes(plugin.t("releaseSpaceDone", { deleted: 0, mb: "0.0", skipped: 1 }))
				),
				`★ 结果要如实报「删了 0 个、跳过 1 个」：${JSON.stringify(
					mockObsidian.Notice.instances.map((notice) => notice.message)
				)}`
			);
			assert.ok(
				mockObsidian.Notice.instances.some((notice) =>
					notice.message.includes(plugin.t("releaseSpaceNothingDeleted", { skipped: 1 }))
				),
				"★ 「一个都没删」必须另给一句解释（说明在哪一步被拦下），否则用户以为功能坏了"
			);
			// ⚠️ 这一轮**会**再弹确认框（候选非空）—— 如实写在这里，免得下一个人
			// 以为"再跑一次是空操作"成立（它不是：永远确认不上的那份会一直出现）。
			assert.equal(releaseAsks.length, 2, "★ 候选非空就会问一次（云端确认不上的那份仍在候选里）");
		}

		// ============================================================
		// 8d. ⭐⭐ 宿主撞名另落的重复副本：链接改写成功之后**删掉**（D-24 ④）
		//
		// 现场（用户 2026-10-14 Android 直报）：同一张图插第二次时，**宿主自己**把新文件
		// 叫 `照片 1.png`（它的唯一化规矩，我们拦不住）。此前那次改动已经让两份
		// **共用同一个对象、同一个地址**；这一段钉的是**收尾**：那一份重复文件在链接
		// 改写成功之后被删掉，而且**不进回收站**（用户明确要求："不用放回收站"）。
		// ============================================================
		{
			const twinPath = "attachments/dup.png";
			const duplicatePath = "attachments/dup 1.png";
			const DUP_BYTES = new Uint8Array([...BATCH_BYTES, 0x7d]);
			const noteA = "notes/重复甲.md";
			const noteB = "notes/重复乙.md";
			await writeFile(join(root, twinPath), Buffer.from(DUP_BYTES));
			await writeFile(join(root, duplicatePath), Buffer.from(DUP_BYTES));
			await writeFile(join(root, noteA), "![[dup.png]]\n", "utf8");
			await writeFile(join(root, noteB), "![[dup 1.png]]\n", "utf8");
			harness.setResolvedLinks({
				[noteA]: { [twinPath]: 1 },
				[noteB]: { [duplicatePath]: 1 },
			});
			await harness.refreshPathCache();

			const deletesBefore = harness.calls.delete.length;
			const trashesBefore = harness.calls.trash.length;
			mockObsidian.Notice.instances.length = 0;
			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			await waitFor(
				async () => !(await existsOnDisk(root, duplicatePath)),
				"宿主撞名另落的那一份被删掉",
				5000,
				diagnose
			);

			// ⭐ 内容相同 ⇒ **只传一次**（名字归一让两份落到同一个 key 上）
			//
			// ⚠️ 断言必须**只盯这一份内容**：这条命令处理的是全库候选（前面几节留下的
			// 文件也在里面），拿全局 PUT 计数会比出别人的账 —— 那就是"断言被别的东西满足"。
			const dupHash = createHash("sha256").update(Buffer.from(DUP_BYTES)).digest("hex");
			const putPaths = server.requests.filter((r) => r.method === "PUT").map((r) => r.path);
			assert.equal(
				putPaths.filter((path) => path.includes(dupHash)).length,
				1,
				`★ 同一份内容只应 PUT 一次（实际这些对象：${JSON.stringify(putPaths)}）`
			);
			assert.equal(
				server.stored(`dup 1-${dupHash}.png`),
				null,
				"★ 桶里不许出现带「 1」名字的对象（两份必须落在同一个 key 上）"
			);
			assert.ok(server.stored(`dup-${dupHash}.png`) !== null, "★ 那个对象确实在桶里");
			assert.equal(await existsOnDisk(root, twinPath), true, "★ 留下来的那一份必须还在（它才是本地副本）");
			// ⭐ 索引里**不许留下指着那份被删文件的条目**。
			// 用户 2026-10-14 在 Android 上报"索引指向的文件已不在 1 条"，第一件要排除的
			// 就是"我们自己删重复副本时漏摘了条目"（那会让人以为插件把索引弄坏了）。
			assert.equal(
				plugin.indexStore.index.findByCachePath(duplicatePath),
				undefined,
				"★ 删掉那一份之后，索引里不许有指向它的条目"
			);
			const survivingEntry = plugin.indexStore.index.findByCachePath(twinPath);
			assert.ok(
				survivingEntry && survivingEntry.key.includes(dupHash),
				"★ 留下来的那一份仍要被索引记着（它才是本地副本）"
			);
			const urlOf = (text) => text.match(/https?:\/\/\S+/)?.[0] ?? "";
			const urlA = urlOf(await readFile(join(root, noteA), "utf8"));
			const urlB = urlOf(await readFile(join(root, noteB), "utf8"));
			assert.ok(urlA.includes(PUBLIC_BASE), `甲笔记应指向配置的存储：${urlA}`);
			assert.equal(urlA, urlB, "★ 两处引用必须指向**同一个**地址");
			// ⭐⭐ 显示名也必须与**链接目标**一致（用户 2026-10-14 报的第五件事）。
			//
			// 乙笔记改写前那一行是 `![[dup 1.png]]` —— 显示位若沿用宿主给的名字，产出就是
			// `![dup 1.png](…/dup-<哈希>.png)`：同一个链接里两个名字不一样，而那个 ` 1`
			// 是宿主的去重序号、不是用户的东西。所以两篇笔记里那一行应当**逐字相同**。
			const lineA = (await readFile(join(root, noteA), "utf8")).trim();
			const lineB = (await readFile(join(root, noteB), "utf8")).trim();
			// ⚠️ 顺序是挑过的：**静态**那句（显示名对不对）先说。
			// 反过来的话，下面那条带实际值的断言会先报"两行不一样"，而真实原因是
			// "乙笔记的显示位用了宿主的序号名"—— 报出来的话指不到根因。
			assert.ok(
				lineB.startsWith("![dup.png]("),
				"★ 显示名必须用主干名字（宿主的「 1」不许出现在链接文字里）"
			);
			assert.equal(
				lineB,
				lineA,
				`★ 两篇笔记里那一行必须逐字相同（同址 + 同显示名），实际 ${JSON.stringify([lineA, lineB])}`
			);
			// ⭐ 删法：直接删（`remove.ts` 的 `vault.delete`）—— **不进回收站**。
			// 用户 2026-10-14 明确要求这样：同内容的副本进回收站 = 把垃圾从附件目录
			// 挪到回收站，用户还得自己去清一次。
			assert.ok(harness.calls.delete.includes(duplicatePath), "★ 重复副本要被真的删掉");
			// ⭐ 这一趟**只**删掉那一份（`deletesBefore` 从 1.2.0 起一直没被用上 —— 那条
			// "只删该删的"断言在某次改动里丢了。补回来：多删的文件没有任何**别的**断言能发现
			//（`dropRedundantCopies` 的四条前置一旦被绕过，症状是"某个附件悄悄没了"）。
			assert.equal(
				harness.calls.delete.length,
				deletesBefore + 1,
				"★ 这一趟只该删掉那份重复副本（多删的文件没有任何别的断言能发现）"
			);
			assert.equal(harness.calls.trash.length, trashesBefore, "★ 不许把它送进回收站");
			// ⚠️ 这条必须**等**它出现，不能"删完了立刻查提示"：删除发生在 `runBatchUpload`
			// 里面，而这条提示是流程在它**返回之后**才弹的 ⇒ 两者之间有一个真实的缝隙
			//（实测：产物路径上碰巧来得及，源码 bundle 路径上就来不及，断言于是偶发变红）。
			await waitFor(
				async () =>
					mockObsidian.Notice.instances.some((notice) =>
						notice.message.includes(plugin.t("maintainBatchDuplicatesRemoved", { count: 1 }))
					),
				"提示里报出删掉 1 份重复副本（删了必须说一句：清单里少了一个文件）",
				5000,
				() => `实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}`
			);
		}

		// ============================================================
		// 8e. ⚠️ 这一趟**有引用没能改写** ⇒ 一个都不删（宁可留着重复副本）
		//
		// 判据用的是"当场重算的引用集合 + 这一趟有没有写失败/跳过"。画布 `file` 节点
		// 走的是另一条路（`fileRules`），它没改写成功时**引用集合里看不见它** ——
		// 所以这里必须**粗**：一处没改成就全都不删。
		// 代价不对称：少删一份只是多占一点磁盘，错删一份是用户的东西不见了。
		// ============================================================
		{
			const twinPath = "attachments/dup2.png";
			const duplicatePath = "attachments/dup2 1.png";
			const DUP2_BYTES = new Uint8Array([...BATCH_BYTES, 0x7e]);
			const notePath = "notes/重复丙.md";
			await writeFile(join(root, twinPath), Buffer.from(DUP2_BYTES));
			await writeFile(join(root, duplicatePath), Buffer.from(DUP2_BYTES));
			await writeFile(join(root, notePath), "![[dup2 1.png]]\n", "utf8");
			// 坏转义的画布：`\q` 不是合法 JSON 转义 ⇒ 改写器按原则④跳过并计数。
			// ⚠️ 用 `String.raw`：普通字符串里的 `\q` 会被 JS 吃掉那个反斜杠，
			// 于是文件里变成合法内容，"卡住删除"的那条前置就不会成立（测了个不存在的情况）。
			await writeFile(
				join(root, "board.canvas"),
				String.raw`{"nodes":[{"type":"file","file":"attachments/dup2 1.png\q"}],"edges":[]}`,
				"utf8"
			);
			harness.setResolvedLinks({ [notePath]: { [duplicatePath]: 1 } });
			await harness.refreshPathCache();

			const deletesBefore = harness.calls.delete.length;
			mockObsidian.Notice.instances.length = 0;
			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			// 等的是"链接改写好"（这才是"这一趟跑完了"的信号），而不是"文件被删"
			await waitFor(
				async () => (await readFile(join(root, notePath), "utf8")).includes(PUBLIC_BASE),
				"笔记里的链接被改写成远端地址",
				5000,
				diagnose
			);

			// 等"这一趟跑完"再把否定断言说出口：删除与提示都排在那之后（见 8d 的说明）
			await new Promise((resolve) => setTimeout(resolve, 200));

			assert.equal(
				await existsOnDisk(root, duplicatePath),
				true,
				"★ 有引用没能改写（画布里那个值解不开）⇒ 一份都不删 —— 它可能正被看不见的地方指着"
			);
			assert.equal(harness.calls.delete.length, deletesBefore, "★ 这一趟一个文件都不该删");
			assert.ok(
				!mockObsidian.Notice.instances.some((notice) =>
					notice.message.includes(plugin.t("maintainBatchDuplicatesRemoved", { count: 1 }))
				),
				"★ 没删成就不能报'已删掉'"
			);
			// 收尾：把坏画布清掉，免得它影响后面的场景（它只服务这一条断言）
			await rm(join(root, "board.canvas"), { force: true });
			await harness.refreshPathCache();
		}

		// ============================================================
		// 8f. ⚠️ 改写**认不出来**的那种链接仍然算"有人指着它" ⇒ 不删
		//
		// 判"还在不在"用的是与改写**同一套**匹配器（`stillMentionsPath`）。这个夹具是一条
		// **URL 编码**的链接（`dup3%201.png`）：改写器解不开它（规则按路径/短名匹配），
		// 于是它**原样留在正文里** —— 那种情况下必须认定"这一份还被指着"。
		// 反过来（把它当成没人引用）就会删掉一个正文里还看得见的链接目标。
		// ============================================================
		{
			const twinPath = "attachments/dup3.png";
			const duplicatePath = "attachments/dup3 1.png";
			const DUP3_BYTES = new Uint8Array([...BATCH_BYTES, 0x7f]);
			const notePath = "notes/重复丁.md";
			await writeFile(join(root, twinPath), Buffer.from(DUP3_BYTES));
			await writeFile(join(root, duplicatePath), Buffer.from(DUP3_BYTES));
			// 编码形式（空格写成 %20）——改写器不认，它就该被当成"还在"
			await writeFile(join(root, notePath), "![x](attachments/dup3%201.png)\n", "utf8");
			harness.setResolvedLinks({ [notePath]: { [duplicatePath]: 1 } });
			await harness.refreshPathCache();

			const deletesBefore = harness.calls.delete.length;
			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			await waitFor(
				async () => server.requests.filter((r) => r.method === "PUT").length > 0,
				"这一趟跑完（至少发出一次 PUT）",
				5000,
				diagnose
			);
			// 再给它一点时间：删除发生在改写之后（同一趟里），若判据错了它会立刻消失
			await new Promise((resolve) => setTimeout(resolve, 200));

			assert.equal(
				await existsOnDisk(root, duplicatePath),
				true,
				"★ 正文里还留着一处认不出来的引用 ⇒ 不许删（宁可留着，也不能删掉还被指着的东西）"
			);
			assert.equal(harness.calls.delete.length, deletesBefore, "★ 这一趟一个文件都不该删");
			assert.equal(await existsOnDisk(root, twinPath), true, "★ 留下来的那一份当然也在");
		}

		// ============================================================
		// 8g. ⭐⭐ 云端**已经有**那个对象 ⇒ 一个字节都不重传
		//     （用户 2026-10-14 在 Android 上报的第二件事："提示说上传成功，可并不需要上传")
		//
		// 现场：同一张图插第二次，宿主另落 `dup4 1.png`。8d 那一段已经钉住"两份共用同一个
		// 地址"，但**字节仍会被重传一遍** —— 判断"云端有没有"原本只能问本机台账
		// （`CacheIndex.wasContentUploaded`），而台账答不上来（换设备 / 索引被覆盖 / 首装）时
		// 它就退回了 PUT。用户看到的那句"上传成功"正是这一次多余上传。
		//
		// 这一段是**入口接线**的判据：少了 `main.ts` 里那行 `probeRemote`，下面那条
		// "零 PUT"就红 —— 而模块层的套件（`ingest-suite`）单独看还是全绿。
		// ============================================================
		{
			const twinPath = "attachments/dup4.png";
			const duplicatePath = "attachments/dup4 1.png";
			const DUP4_BYTES = new Uint8Array([...BATCH_BYTES, 0x81]);
			const dup4Hash = createHash("sha256").update(Buffer.from(DUP4_BYTES)).digest("hex");
			const remoteKey = `dup4-${dup4Hash}.png`;
			const notePath = "notes/重复戊.md";
			// ⭐ 云端**已经有**它 —— 模拟"这台设备上一次插入已经把它传上去了"。
			// 而插件**本机索引里没有这一笔**（这份内容从没在本机上传过 ⇒ 台账也答不上来）——
			// 这正是真机上那个让"按内容认亲"失效的状态。
			server.objects.set(remoteKey, { body: Buffer.from(DUP4_BYTES), contentType: "image/png" });
			await writeFile(join(root, twinPath), Buffer.from(DUP4_BYTES));
			await writeFile(join(root, duplicatePath), Buffer.from(DUP4_BYTES));
			await writeFile(join(root, notePath), "![[dup4 1.png]]\n", "utf8");
			harness.setResolvedLinks({ [notePath]: { [duplicatePath]: 1 } });
			await harness.refreshPathCache();

			const putsBefore = server.countByMethod("PUT");
			const headsBefore = server.countByMethod("HEAD");
			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			await waitFor(
				async () => !(await existsOnDisk(root, duplicatePath)),
				"这一趟跑完（重复副本在链接改写后被删掉）",
				5000,
				diagnose
			);

			// ⚠️ 断言只盯**这一份内容**：这条命令处理的是全库候选（前面几节留下的文件也在里面），
			// 拿全局 PUT 计数会比出别人的账 —— 那就是"断言被别的东西满足"。
			const putPaths = server.requests.filter((r) => r.method === "PUT").map((r) => r.path);
			assert.equal(
				putPaths.filter((path) => path.includes(dup4Hash)).length,
				0,
				`★ 云端已有的内容**一个字节都不许重传**（实际 PUT：${JSON.stringify(putPaths)}）`
			);
			assert.ok(
				server.countByMethod("HEAD") > headsBefore,
				"★ 判据得是**问云端**（HEAD）拿到的答案，不是猜'名字像重复所以不用传'"
			);
			const text = await readFile(join(root, notePath), "utf8");
			assert.ok(
				text.includes(remoteKey),
				`★ 笔记里的链接要指向那个**已经在云端**的对象：${text}`
			);
			assert.ok(
				server.stored(remoteKey) !== null,
				"★ 那个对象本来就该在桶里（我们没传，但它也没被删）"
			);
			// ⭐ `putsBefore`（同样一直没被用上）补一条**总量**断言：这一趟的 PUT 次数与之前
			// **完全相同** —— 上面那条按"这一份内容"过滤，万一 key 算错了就筛不到东西（假绿）；
			// 总量不变才是"一个字节都没重传"的正面表述。
			assert.equal(
				server.countByMethod("PUT"),
				putsBefore,
				"★ 这一趟的 PUT 总数没有增加（连一次重传都没有）"
			);
		}

		// ============================================================
		// 8h. ⭐⭐ R17 的**接线**：笔记里去掉引用 ⇒ 询问真的会发生
		//
		// ## 为什么以前一条都测不到
		//
		// 孤儿询问 100% 挂在 **vault 事件**上（`modify` / `create` / `delete` / `rename`
		// → 引用快照差分 → 按台账筛候选 → 按档位出声）。而替身的 `vault.on` 一直是
		// `on() { return {}; }`（**静默吞掉注册**）—— 于是这四条接线在套件里一次都没跑过。
		// 后果不只是"测不了"：插件入口若**忘了注册**它们，全套测试照样全绿。
		// 2026-10-14 用户报"删掉最后一个副本后没问要不要删云端"时，本地**无法证伪**，
		// 根因就在这里（覆盖缺口：vault 事件一条都跑不到）。
		//
		// ## 这一段打的是哪一层
		//
		// **决定层之上的那一层**：事件 → 快照差分 → 台账筛选 → 出声。
		// 决定层本身（`selectOrphanAsks` 的候选/冷却规则）在 `orphan-watch` 套件里穷举。
		//
		// ⚠️ 用 `notice` 档而不是 `always` 是**刻意**的：`notice` 的出口是 `Notice`，
		// 替身记得到、断言得了；`always` 那一路要驱动弹窗上的三个按钮
		//（`askOrphanCloudDelete` 直接 `new Modal`，替身里没有真按钮可点）⇒
		// ⚠️ 那条**留作已知缺口**，别在这里假装测了（要测就得先给弹窗做一层可驱动的替身）。
		// ============================================================
		{
			// ⚠️ 先钉"四条接线真的挂上了"。替身以前把 `vault.on` 吞掉 ⇒ 忘注册也看不出来。
			for (const name of ["create", "modify", "delete", "rename"]) {
				assert.ok(
					(app.vault.registered.get(name) ?? []).length > 0,
					`★ vault 的 \`${name}\` 事件必须真的接上线（孤儿询问与"新增附件接管"都挂在它上面）`
				);
			}

			const notePath = "notes/待勾选.md";
			const attachmentPath = "attachments/待勾选.png";
			const ORPHAN_BYTES = new Uint8Array([...BATCH_BYTES, 0x91]);
			await writeFile(join(root, attachmentPath), Buffer.from(ORPHAN_BYTES));
			await writeFile(join(root, notePath), "![[待勾选.png]]\n", "utf8");
			harness.setResolvedLinks({ [notePath]: { [attachmentPath]: 1 } });
			await harness.refreshPathCache();

			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			await waitFor(
				async () => (await readFile(join(root, notePath), "utf8")).includes(PUBLIC_BASE),
				"这一篇的引用被改写成远端地址（于是它才是一个「已上传的对象」）",
				5000,
				diagnose
			);
			const uploadedKey = createHash("sha256").update(Buffer.from(ORPHAN_BYTES)).digest("hex");
			const key = `待勾选-${uploadedKey}.png`;
			assert.equal(
				plugin.indexStore.index.wasUploaded(key),
				true,
				"前提：这个对象必须在上传台账里（孤儿候选的认领判据是**台账**，不是索引条目 —— N11）"
			);

			// ── ① 先让快照记住"这一篇引用着它" ──
			// 没有这一步，第一次 `modify` 只会**登记**这篇笔记（快照里还没有它）而不产出差分，
			// 于是一条永远不会问。真实的宿主也是这样：加载时 warmUp 先建快照。
			app.vault.trigger("create", app.vault.getAbstractFileByPath(notePath));
			await new Promise((resolve) => setTimeout(resolve, 2000)); // > CHECK_DEBOUNCE(1.5s)

			// ── ② 用户**把那条引用删掉**（这正是 R17 的主场景）──
			mockObsidian.Notice.instances.length = 0;
			plugin.settings.orphanAsk = "notice";
			await writeFile(join(root, notePath), "没有任何引用了。\n", "utf8");
			app.vault.trigger("modify", app.vault.getAbstractFileByPath(notePath));

			// 1.5 s（引用重算）+ 4 s（询问防抖）—— 等它自己走完
			await waitFor(
				() =>
					mockObsidian.Notice.instances.some(
						(notice) =>
							notice.message ===
							// ⚠️ 指路指向的是**新那条命令**（"检查未被引用的云端附件…"）：它按同一批
							// 判据再列一次，正是"想再处理一次"该去的地方（`cleanup-cloud` 走列桶，是另一件事）。
							plugin.t("orphanNotice", { count: 1, command: plugin.t("cmdCheckOrphans") })
					),
				"★ 引用消失了 ⇒ 必须出声（`notice` 档：一条通知，且数量如实）",
				9000,
				() => `实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}`
			);
		}

		// ============================================================
		// 8i. ⭐⭐ 命令入口：**自己重来一次**那次询问（用户 2026-10-14 Android 报告）
		//
		// 现场：那个三档弹窗**只自动出现一次**（冷却 `asked` 记住之后不再问），而弹窗还可能被
		// **误关**（点背景 / ESC —— 用户的原话是"点一下边上就不见了"）⇒ 他从此失去那次决定，
		// 云端对象永远留着。⇒ 新增命令 `check-orphans`（"检查未被引用的云端附件…"）。
		//
		// 这一段钉三件事：
		//   ① **接线**在（走真实命令路径 `runCommand`，它顺带断言这条命令真的注册过）；
		//   ② **不吃冷却**（上面那个 key 刚被自动那条问过、已在 `asked` 里）；
		//   ③ 空结果**如实说**（静默会被当成"命令坏了"）。
		// ⚠️ 档位用 `notice`：`always` 那一路要驱动弹窗上的三个按钮（替身里没有真按钮可点），
		// 那是已知缺口，别在这里假装测了（见 §8h 的说明）。
		// ⚠️ 通知按"**含这条命令名**"匹配，不写死候选数量 —— 库里此刻可能还留着前面几节
		// 造出来的其它"已上传但没引用"的对象，写死 1 就是"断言被别的东西满足"的反面。
		// ============================================================
		{
			plugin.settings.orphanAsk = "notice";
			const mentionsCommand = (notice) => notice.message.includes(plugin.t("cmdCheckOrphans"));
			// 上面那个刚被自动那条问过、因而**已经在冷却里**的对象（与 §8h 用同一批字节）。
			const ORPHAN_BYTES = new Uint8Array([...BATCH_BYTES, 0x91]);
			const orphanKey = `待勾选-${createHash("sha256").update(Buffer.from(ORPHAN_BYTES)).digest("hex")}.png`;
			const index = plugin.indexStore.index;

			// ── ① 台账里**只留**它，再跑命令 ⇒ 必须仍然出声 ──
			//
			// ⚠️ "只留它"是**判据的一部分**，不是布景：库里还有前面几节造出来的其它"已上传
			// 但没引用"的对象，只要**任何**候选被问出来通知就会出现 —— 那样的断言
			// 会被别的对象满足，变异（命令也吃冷却）照样通过（第一版就是这么写的，
			// 实测报"漏过：测试无牙"）。唯一候选 + 已在冷却里，才是这条纪律的可判据形态。
			for (const key of index.uploadedKeys()) index.forgetUploaded(key);
			index.markUploaded(orphanKey);
			mockObsidian.Notice.instances.length = 0;
			runCommand("check-orphans");
			await waitFor(
				() => mockObsidian.Notice.instances.some(mentionsCommand),
				"★ 命令必须能**重来一次**那次询问（冷却只管自动那一侧，命令是显式动作）",
				6000,
				() => `实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}`
			);

			// ── ② 台账清空 ⇒ 候选为空 ⇒ 如实说"没有发现"，不能静默 ──
			// 办法：把**上传台账**清空（`forgetUploaded`）—— 那正是"这台设备什么都没上传过"。
			index.forgetUploaded(orphanKey);
			mockObsidian.Notice.instances.length = 0;
			runCommand("check-orphans");
			await waitFor(
				() =>
					mockObsidian.Notice.instances.some(
						(notice) => notice.message === plugin.t("orphanNoneToCheck")
					),
				"★ 没有候选时必须如实说'没有发现'（静默会被当成命令坏了）",
				6000,
				() => `实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}`
			);
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

		// ============================================================
		// 9b. ⭐ 登记的清理回调必须**真的**把 onload 建的定时器清掉
		//
		// 判据刻意是**效果**，不是 `register` 的条数：条数只是阈值断言，
		// 任何一条别的 register 都会把"漏登记了一个定时器"悄悄撑过去。
		// 实测踩到过 —— 一次改动新增了一条 register（站外候选队列的 dispose），
		// 「忘了登记周期定时器」「忘了登记启动定时器」两条变异就**同时漏过**了，
		// 而那时 `登记数 >= 3` 依旧成立。
		//
		// 留下没清的定时器也是**最难查**的一类失效：测试全绿却退不出去、
		// 被外层超时杀掉，日志里什么都没有（套件开头那段正是为它写的）。
		// ============================================================
		assert.ok(
			onloadTimers.length >= 2,
			`onload 期间应至少建两个定时器（启动那一轮 + 周期兜底），实际 ${onloadTimers.length}`
		);
		// 与真实宿主一致：卸载时按登记顺序的反向调用清理回调
		for (const cleanup of [...(plugin.cleanups ?? [])].reverse()) {
			try {
				cleanup();
			} catch {
				// 清理回调抛错不该打断卸载
			}
		}
		// 这两个都是**长**定时器（秒级、分钟级），不可能在这段测试里自然触发过 ——
		// 所以"没被 clear 过"就等价于"还挂着"，判据在这里是准的。
		const stillPending = onloadTimers.map(([, id]) => id).filter((id) => !clearedTimers.includes(id));
		assert.deepEqual(
			stillPending,
			[],
			"★ 登记的清理回调必须把 onload 建的每个定时器都清掉 —— 漏掉的那个会让「设了缓存上限" +
				"却永远不会自动轮换」，而且界面上毫无痕迹"
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
		window.clearTimeout = realClearTimeout;
		window.clearInterval = realClearInterval;
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
