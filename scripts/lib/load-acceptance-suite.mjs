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
	// ⚠️⚠️ **不许往 `module` 上挂 `require`**（2026-10-16 第二次真机实测之后删掉的）。
	//
	// 这里曾经有一行 `moduleObject.require = (id) => require(id);`，注释写着"宿主里就在那儿"——
	// **那是猜的，而且猜错了**：宿主给的 `module` 上并没有 `require` 这个方法
	//（能证明的只有"宿主提供了 `require` 这个标识符"）。那一行让夹具**凭空多出真机没有的东西**，
	// 于是 `src/local-file.ts` 里那句 `module.require(...)` 在套件里跑得通、在真机上抛
	// `TypeError` ⇒ 用户看到的是"点击命令没有反应"，而全套测试是绿的。
	// ⭐ 与本项目"垃圾夹具"那条教训是同一个形状，只是方向相反：**夹具比真机宽容，掩盖了缺陷**。
	// ⇒ 现在只喂 CJS 的调用约定本身（下面那三个参数），产品代码用什么写法，夹具就照什么写法给。

	// ⚠️⚠️ **刻意不给动态 `import` 回调**（2026-10-16 真机确证之后定的）。
	//
	// 产物跑在**宿主的 CJS 环境**里，而**动态 `import()` 在那条路上是不可用的**：
	// 它走浏览器的 ESM 加载器 ⇒ 把 `node:fs/promises` 当 URL fetch ⇒ CORS 拒
	//（`app://` 白名单里没有 `node:`）⇒ 那句 import 必抛，抛出又被 `catch` 吞成"读不到"
	// ⇒ 症状是**每一份本机文件都被报成「已经找不到了」**（用户 2026-10-16 实测）。
	//
	// ⭐ 所以这里**故意**不给回调：`vm` 沙箱默认就没有 ⇒ 产物里一旦再出现动态 `import`，
	// 套件会**当场红**，而不必等人拿真机去撞。
	// ⚠️ 这条是**踩反了两次**才定下来的（记在这里免得再踩）：D-38 那次看到"本机文件全被判成不在"，
	// 我判断成"夹具不够像真机"、于是给加载器**补上**了这个回调，还写了句"真机里 import() 是好的"
	// —— 那句话是**猜的**，而且**猜错了**。⇒ 判据：**修夹具之前先问「真机凭什么是好的？」**，
	// 答不上来就别动夹具，去查产品代码；而且**沙箱里看到的现象不算真机证据**。
	const factory = compileFunction(source, ["module", "exports", "require"], {
		filename: join(ROOT, "main.js"),
	});
	// ⚠️ 第三个参数就是**宿主给的那个 `require` 的替身**（CJS 调用约定里的那一个）——
	// 产品代码只许用它，别的写法在这里会当场红（那正是我们要的）。
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

/**
 * 「**不该发生**的那件事有没有发生」—— 否定式断言必须带一个**窗口**。
 *
 * 与 `waitFor` 正好相反：`waitFor` 等的是"必须发生"（超时 = 失败），
 * 这里等的是"若它会发生、就该在这段时间里发生"（超时 = 通过）。
 *
 * ⚠️ 否定式断言**不能**写成一句直接 `assert`：被测动作多半是**异步启动**的
 * （`void releaseLocalSpace(...)`），那一刻它还没跑到能被观察到的地方 ⇒
 * 断言**恒为真**（"假绿"，比跑失败更糟）。实测踩到过一次：
 * `mutate-load-acceptance` 那条"切回保留副本不该问"第一版就是这么写的，
 * 变异跑出来是"漏过（测试无牙）"。
 *
 * @param settleMs 给它的窗口。取 1.5 s 是相对于被测链条说的：它只做
 *   "读几个文件的 stat + 扫几篇笔记"，本地实测都在几十毫秒内。
 */
async function waitForAbsence(predicate, what, settleMs = 1500) {
	const deadline = Date.now() + settleMs;
	while (Date.now() < deadline) {
		if (await predicate()) throw new Error(`不该发生却发生了：${what}`);
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
	 * 清单式弹窗的替身（2026-10-15 起「上传附件 / 检查未被引用的云端附件 / 检查未引用的云端附件」
	 * 都走它）。真弹窗在 Node 里点不了（宿主的 `Setting.addButton` 是空操作 ⇒ 连按钮都不会建），
	 * 所以这里换成「**全选 + 按主按钮**」—— 与用户「全选 → 确认」是同一条路径。
	 * ⚠️ 它的 `run` 必须**真的跑**：上传/删除/进度都在那里面。
	 */
	const pickAsks = [];
	const pickTasksAll = async (options) => {
		pickAsks.push(options);
		const all = (options.cards ?? []).map((card) => card.id);
		// ⚠️ 必须**尊重 `initiallySelected`**（D-68）：真弹窗只勾那些，而"没有被任何笔记引用"
		// 的文件默认**不勾**。替身全选的话，验收会看到"未引用的也被传了"，于是把
		// 「批量上传恰好 PUT 一次」判成失败 —— 那是**替身与真机不一致**，不是源码的问题
		//（这类坑本项目吃过：夹具多了真机没有的东西，或者少了真机有的一步）。
		const allowed = options.initiallySelected ? new Set(options.initiallySelected) : null;
		const selected = allowed ? all.filter((id) => allowed.has(id)) : all;
		await options.run?.(selected, () => {});
		return { selected, ran: true };
	};
	plugin.pickTasks = pickTasksAll;
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
			"check-orphans",
			"upload-attachments",
		],
		// ⚠️ 这条断言的沿革（每次增删命令都要改这里，历史写下来的目的是别让下一个人猜）：
		// - 1.1.0：六条。1.2.0（D-17）**减到五条** —— `clean-cache` 退役（设计 §20.16 #5）。
		// - 2026-10-14：**回到六条** —— 新增 `check-orphans`（用户报"那次询问被误关后没法重来"）。
		// - 2026-10-16：**先到七条** —— 新增 `release-local-space`（R10 要的"能列出**并清理**"
		//   缺命令入口，那条链此前只挂在设置页按钮上）。
		// - 2026-10-16 同日稍后：**减到四条**，一次撤掉三条 ——
		//   ① `cleanup-cloud` 的候选并入 `check-orphans`：它列**整个桶**，独占能力是"处理不属于
		//      本插件的对象"，与那条链「对不属于我们的对象我们没有处置权」**直接冲突**，
		//      且需求文档里查不到那个诉求（站外缓存那条排除已随之搬进 `selectOrphanAsks`）；
		//   ② `release-local-space` 撤**命令入口**（能力仍在设置页那颗按钮上）；
		//   ③ `repair-index` 撤**命令入口**（只剩后台自检那条线，走两轮确认）。
		// - 2026-10-22（D-68，用户要求）：**减到三条** —— `pick-external-images` 并入
		//   `upload-attachments`。两条链的候选层本来就重叠（库内文件 / 站外 / 本机），
		//   合并后只有**一张**清单：被引用的、没有任何引用的（默认不勾）、站外、本机。
		//   ⚠️ "逐张挑选"的能力没有丢（清单本来就能逐项勾），丢的是"只看当前笔记"这个范围下拉 ——
		//   用户明确要"一个大而全的命令"，而两套清单本身就是分叉的来源。
		// - 2026-10-22（D-75，用户：「取消掉那条单独的查看附件状态的命令」）：**减到两条** ——
		//   `audit-cache`（「查看本地副本占用」）退役。它只报数字、不做任何事，而「哪些副本可以清」
		//   现在由 `check-orphans` 的清单直接给出（D-74 之后那一屏连「没人引用的本地文件」都列了）
		//   ⇒ 两处说同一件事，而数字那处还带「估算」的歧义。
		"★ 两条维护命令都要注册（少一条就是「功能写了但用户找不到」）"
	);

		const runCommand = (id) => {
			const command = plugin.commands.find((c) => c.id === id);
			assert.ok(command, `命令 ${id} 应存在`);
			command.callback?.();
		};

		// ⚠️ 后面几节要往 `notes/` 里写笔记（`writeFile` 不建目录）。
		//
		// ⚠️ 2026-10-22（D-75，用户：「取消掉那条单独的查看附件状态的命令」）：
		// 这里原来还有一大段「查看缓存占用」的口径用例（索引外的文件不进统计 / 字节按磁盘算 /
		// 未引用只在引用扫过时才算 / 两轮自检摘掉失效记录）—— 那条命令退役、`audit.ts` 一起删了，
		// 所以整段随之删除。
		// ⭐ 那些判据没有跟着消失：「索引外的文件一个都不碰」与「引用是两半」
		// 仍由 `release-space` / `eviction` 的套件钉着（同一份口径，那边才是真正会删东西的链）。
		await mkdir(join(root, "notes"), { recursive: true });

		// ============================================================
		// 8a. ⭐⭐ 「索引指向的文件已不在」⇒ 后台自检**两轮之后**自己摘掉
		//
		// （这段原本是借「查看本地副本占用」命令的失效计数来观察的；
		//  2026-10-22（D-75）那条命令退役 ⇒ 判据改成**直接看索引**。更直接，
		//  也不再依赖界面上那句话。）
		//
		// ⭐ 两轮才摘是刻意的（见 `createAbsenceConfirmer`）：换设备 / 同步进行中时
		// 「这一轮读不到」很常见，一次就摘会把**还在路上**的记录一起删掉。
		// ============================================================
		{
			const staleKey = "stale-1f.png";
			const indexHandle = plugin.indexStore.index;
			indexHandle.set({
				key: staleKey,
				cachePath: "attachments/已经不在了.png",
				remoteUrl: `${PUBLIC_BASE}/${staleKey}`,
				size: 7,
				contentType: "image/png",
				etag: "",
				uploadedAt: new Date().toISOString(),
				lastUsedAt: Date.now(),
				sourceName: "已经不在了.png",
			});
			await plugin.runIndexSelfHeal();
			assert.ok(
				indexHandle.get(staleKey),
				"★★ 第一轮只记下「这一轮它不在」，**不许立刻摘**（防误摘：同步中很常见）"
			);
			await plugin.runIndexSelfHeal();
			assert.equal(
				indexHandle.get(staleKey),
				undefined,
				"★★ 两轮之后要把失效记录摘掉（它指向的文件已经不在了）"
			);
		}

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

		// ⭐⭐ 确认框的**摘要**里不再重复"下面那张清单"的内容（2026-10-16 用户实测提的：
		// 「在上部有文件列表的摘要，但其实已经做了下面的列表了，可以精简内容」）。
		// 判据：这个文件**只该出现在清单行里**（它是弹窗下半部分的一行，带缩略图、能勾选），
		// 不该在摘要文字里再被贴一次 —— 同一份清单写两遍，用户看到的就是一屏噪音。
		// ⚠️ 这条断言**是有牙的**：改动之前摘要里会贴出前 10 条路径（这里就是 `attachments/pic.png`），
		// 那时的表现正是用户截图里那句「……还有 424 个」。
		// ⚠️ 而"还有 N 个"这种句子在**列表被截断**的界面里是必需的
		//（`release-space-flow` / `orphan-flow` 自动那一路传的是 `*_LIST_MAX`）——
		// 判据是**清单全不全**，不是"哪个界面更好看"，所以那条边界不在这里钉。
		const batchLines = (pickAsks.at(-1)?.lines ?? []).join(" ｜ ");
		// ⭐⭐ 2026-10-22（D-71 / D-72，用户两次要求）：
		// 「上部的文案取消掉,信息改到列表上面去」→「还是有顶部会根据内容调整的文案,
		// 把文案简化成固定的说明文字」。
		//
		// 所以判据有两条，**两条都要**：
		// ① 只有**一段**（原来这里是 3 段：摘要 / 什么都不搬 / 另有 2 个没有笔记引用 ——
		//    其余四类已经下沉到行：小标签 / 副标题 / 图标）；
		// ② 这一段是**固定说明**：不含任何数字（数量在**按钮**上「上传并改写链接 (12)」）、
		//    不含任何主机名（站点在**每一行的副标题**里）。
		assert.equal(
			(pickAsks.at(-1)?.lines ?? []).length,
			1,
			`★★ 列表上方只该有**一段**说明（其余信息在行里）：${JSON.stringify(pickAsks.at(-1)?.lines)}`
		);
		assert.equal(
			/\d/.test(batchLines),
			false,
			`★★ 顶部是**固定说明**，不许有数字（数量在按钮上）：${batchLines}`
		);
		// ⭐⭐ 2026-10-22（D-73）：**标题必须与命令名说的是同一件事**。
		//
		// 用户报的：「上传功能已经改成涵盖所有附件,但打开界面发现标题是"上传笔记引用的文件",
		// 这不准确」。标题原来只说了**第一类**（被引用的），而候选有四类。
		// ⚠️ 判据用"与命令名逐字相同"而不是"不含某个词"：
		// 前者挡得住任何一侧的漂移（改标题不改命令名、或反过来），后者只挡那一个词。
		assert.equal(
			pickAsks.at(-1)?.title,
			plugin.t("cmdUploadAttachments").replace("…", ""),
			`★★ 弹窗标题必须与命令名一致（功能涵盖四类候选，标题不能只说"笔记引用的文件"）：${pickAsks.at(-1)?.title}`
		);
		assert.ok(
			!batchLines.includes(attachmentPath),
			`★★ 摘要里不该重复列出文件名（那是下面那张清单的事）：${batchLines}`
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
		// 8a2. ⭐⭐ 「已经传过、而笔记里那条链接还是本地的」⇒ 重跑这条命令必须能修好
		//
		// 2026-10-21 用户实报的场景（D-56 的后续）：对象早就传上去了（索引里有记录），
		// 而正文里那条还是本地路径 —— 他看到的现象是「没有被上传」。
		// 他想到的修法就是**再跑一次「上传附件」**，而旧判据按"已经在缓存索引里"把它跳过
		// ⇒ 重跑永远修不好它，用户只剩手工改笔记这一条出路。
		//
		// 这里把那条链完整走两遍：第一次真的传上去；然后把正文**改回本地写法**
		//（正好用用户那条的形状：相对前缀 + `%20` + 括号），第二次必须
		// ① 一个 PUT 都不发（字节云端已有）② 把链接改成远端地址 ③ 确认框如实说这是"重修"。
		// ============================================================
		// ⚠️ 名字里**同时有空格与成对括号**：这正是浏览器下载重名文件给出的形状，
		// 也是用户那条的等价物（`… 游立强 4年(1).pdf`）。`%20` 与括号各守一条判据。
		const pdfPath = "assets/报告 (1).pdf";
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(join(root, pdfPath), Buffer.from([...BATCH_BYTES, 0x7d, 0x7e]));
		const pdfNote = "notes/报告.md";
		await writeFile(join(root, pdfNote), "![报告](assets/报告 (1).pdf)\n");
		harness.setResolvedLinks({ [pdfNote]: { [pdfPath]: 1 } });
		await harness.refreshPathCache();

		runCommand("upload-attachments");
		await waitFor(
			async () => (await readFile(join(root, pdfNote), "utf8")).includes("http"),
			"带括号的附件第一次上传后链接被改写",
			5000,
			diagnose
		);
		const putsAfterFirst = server.countByMethod("PUT");

		// 把那一行**改回本地写法**（含 `%20` 与成对括号：正是用户笔记里的形状）
		await writeFile(join(root, pdfNote), "[FPGA工程师](../assets/报告%20(1).pdf)\n");
		await harness.refreshPathCache();
		mockObsidian.Notice.instances.length = 0;
		runCommand("upload-attachments");
		await waitFor(
			async () => (await readFile(join(root, pdfNote), "utf8")).includes(PUBLIC_BASE),
			"重修之后链接指向存储",
			5000,
			diagnose
		);
		const repairedText = await readFile(join(root, pdfNote), "utf8");
		assert.ok(
			!repairedText.includes("assets/"),
			`★★ 重修必须把本地路径换掉（含括号与 %20 编码）：${repairedText}`
		);
		assert.equal(
			server.countByMethod("PUT"),
			putsAfterFirst,
			`★★ 重修**不许重传字节**（云端已有同一份）：${JSON.stringify(server.requests.filter((r) => r.method === "PUT").map((r) => r.path))}`
		);
		// ⚠️ 必须**看得出来**那一个是"重修"（只改链接、不重传）：
		// 不说的话，用户看到"已经传过的文件又出现在清单里"会以为去重坏了。
		// ⭐ 2026-10-22（D-71）：这条信息从**摘要**（"其中 N 个早就传过了…"）下沉到**那一行**
		// 的行内小标签 —— 用户核对的是行，而列表上方原来堆了八段话。
		const repairRow = (pickAsks.at(-1)?.cards ?? []).find((card) => String(card?.id ?? "").includes("报告 (1)"));
		assert.ok(repairRow, `★ 清单里要找到那份重修的文件：${JSON.stringify((pickAsks.at(-1)?.cards ?? []).map((card) => card.id))}`);
		assert.equal(
			repairRow?.hint,
			plugin.t("maintainBatchRepairHint"),
			`★★ 重修那一行要标「只改链接」（否则用户以为在重传一遍）：${repairRow?.hint}`
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

			// ⚠️ 2026-10-15：确认框换成**清单式弹窗**（同一个壳）⇒ 它给的也是同一份
			// `lines`（站点、原文件留在原地那几句），断言因此只换来源、不换判据。
			// 默认替身已经把 options 收进 `pickAsks` 了。
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

			// ⭐ 站点必须是**看得见的** —— 它就是这次下载的授权凭据（只说"还有 1 张站外图"
			// 等于让用户盲签一份许可）。
			// ⚠️ 2026-10-22（D-72）：它**不再聚合到顶部文案里**（用户要求顶部是**固定**说明），
			// 而是写在**那一行的副标题**上（`externalRowMeta` 给主机）—— 逐行看得见
			// 比一句汇总更具体，授权依据没有变。
			const externalLines = (pickAsks.at(-1)?.lines ?? []).join(" ｜ ");
			assert.equal(
				externalLines.includes(EXTERNAL_HOST),
				false,
				`★★ 顶部是固定说明，不该出现主机名（站点在行里）：${externalLines}`
			);
			const externalRow = (pickAsks.at(-1)?.cards ?? []).find((card) =>
				String(card?.id ?? "").includes(EXTERNAL_HOST)
			);
			assert.ok(
				externalRow,
				`★ 清单里要能找到那条站外候选：${JSON.stringify((pickAsks.at(-1)?.cards ?? []).map((card) => card.id))}`
			);
			assert.equal(
				String(externalRow?.meta ?? "").includes(EXTERNAL_HOST),
				true,
				`★★ 站外那一行的副标题要写明主机（那是授权凭据）：${externalRow?.meta}`
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
			// 用户点了取消 / 直接关掉弹窗 ⇒ 替身返回 null（两条链都按"取消"处理）
			plugin.pickTasks = async () => null;
			runCommand("upload-attachments");
			await new Promise((resolve) => setTimeout(resolve, 300));

			plugin.pickTasks = pickTasksAll; // 恢复默认替身（后面的用例还要用）
			assert.equal(externalHostRequests.length, 0, "★ 取消之后**不得**下载任何站外图");
			// ⭐ 取消还要**如实说一句**（2026-10-15：判据挪到弹窗之后，"不删"是结构保证的，
			//    而"什么都不说"仍然是缺陷 —— 用户会以为命令坏了）
			assert.ok(
				mockObsidian.Notice.instances.some((notice) => notice.message.includes(plugin.t("maintainCancelled"))),
				`★ 取消之后要如实反馈（实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}）`
			);
			assert.ok(
				(await readFile(join(root, cancelNote), "utf8")).includes(externalUrl),
				"取消之后笔记必须一个字都没动"
			);

			plugin.settings.externalImageCache = false;
		}

		// ============================================================
		// 8b2. ⭐⭐ 指向笔记/画布/数据库的**远程**地址不算候选（2026-10-16 用户实测报的）
		//
		// 用户的场景：笔记里链接了一个远程 `.md`，它出现在了「上传附件」的清单里。
		// 那不只是"清单里多一行" —— 真搬下来会在库里**凭空多出一篇笔记**（宿主按后缀把它
		// 当笔记索引），理由与库里那条同款闸门（`.md`/`.canvas`/`.base` 不是附件）完全一样。
		// ⚠️ 判据只有一份（`decideExternalCache` 里的 `isNoteLikeExtension`），所以
		// "打开笔记就搬"那一路同时被拦住；这里钉的是**端到端接线**。
		// ============================================================
		{
			const notePath = "notes/远程笔记链接.md";
			const mdUrl = `https://${EXTERNAL_HOST}/notes/intro.md`;
			// ⚠️ 刻意配一张**同一站点的 .png**（桩回 404，什么都不落库）：它的作用是让这趟
			// 真的有东西可处理（于是"少请求一次"的断言不是恒真的假绿）。
			const pngUrl = `https://${EXTERNAL_HOST}/b.png`;
			// ⭐⭐ 另一半（2026-10-16 用户实测报的）：**没有扩展名的网页地址**（他笔记里那个
			// 企业 wiki 页链接）压根不该进候选 —— 它不是"搬下来失败"，而是根本不该出现。
			const pageUrl = `https://${EXTERNAL_HOST}/projects/m23003/wiki/%E9%A1%B5%E9%9D%A2?cfm=1`;
			// ⭐⭐ 还有**网页类型**那一半（用户第二次实测报的）：B站播放器那种
			// `<iframe src="…/player.html?…">` —— 尾巴有点、能过"像个文件名"那条，但它是**网页**，
			// 下载端必拒（`text/html`），所以压根不该进清单。
			const playerUrl = `https://${EXTERNAL_HOST}/player.html?aid=1055609428&bvid=BV1Zn4y19743`;
			// ⭐⭐ 第三次实测报的那一条：**后缀是页面程序**（`.jsp`）的地址同样是网页 ——
			// 尾巴也有点、后缀也不是 `.html`，但内容是服务端**现算**出来的一张页面
			//（用户原话：「实际上这是一个网页地址」，并补了界限：
			// 「如果是外部网站的文件下载链接，应该看做是附件才对」）。
			const scriptPageUrl = `https://${EXTERNAL_HOST}/pd.jsp?id=172`;
			// ⭐⭐ 第五次实测报的那一条：**尾巴有点像、但后缀不是文件类型** ——
			// GitHub 的分支名 `5.1-translation_terms`（点在 `5` 与 `1` 之间，取不出扩展名）。
			// 它是**普通链接**（`[]()`），所以那两道形状判据都该管它。
			const branchUrl = `https://${EXTERNAL_HOST}/repo/tree/5.1-translation_terms`;
			await writeFile(
				join(root, notePath),
				`![md](${mdUrl})\n![png](${pngUrl})\n[页](${pageUrl})\n<iframe src="${playerUrl}"></iframe>\n[原文链接](${scriptPageUrl})\n[分支](${branchUrl})\n`,
				"utf8"
			);
			await harness.refreshPathCache();

			externalHostRequests.length = 0;
			mockObsidian.Notice.instances.length = 0;
			runCommand("upload-attachments");
			// ⚠️ 先等"该发生的事"发生（那张 `.png` 被请求），再断言"不该发生的一次都没有"。
			// 反过来直接等"什么都没发生"，今天就会**因为别的原因**（比如命令压根没跑完）
			// 恒真通过 —— 本项目踩过这种假绿。
			await waitFor(
				async () => externalHostRequests.some((url) => url.includes("/b.png")),
				"该搬的那张 .png 被请求了",
				10000,
				diagnose
			);
			// 再等这趟**真的结束**（它一定会给出一条提示）：不等的话，它会带着
			// "failed 1" 的结果飘到后面几段里去。
			await waitFor(
				async () => mockObsidian.Notice.instances.length > 0,
				"这趟命令给出了结果",
				10000,
				diagnose
			);

			assert.equal(
				externalHostRequests.some((url) => url.includes("intro.md")),
				false,
				`★★ 指向 .md 的远程地址一次都不许请求（搬下来会在库里多出一篇笔记）：${JSON.stringify(externalHostRequests)}`
			);
			assert.ok(
				(await readFile(join(root, notePath), "utf8")).includes(mdUrl),
				"★ 那条 .md 链接必须原样留着（我们根本没碰它）"
			);
			assert.equal(
				externalHostRequests.some((url) => url.includes("/wiki/")),
				false,
				`★★ 没有扩展名的网页地址一次都不许请求（它不是文件，压根不该进候选）：${JSON.stringify(externalHostRequests)}`
			);
			assert.equal(
				externalHostRequests.some((url) => url.includes("player.html")),
				false,
				`★★ 网页类型（.html）一次都不许请求（R18 绝不抓网页）：${JSON.stringify(externalHostRequests)}`
			);
			assert.equal(
				externalHostRequests.some((url) => url.includes("pd.jsp")),
				false,
				`★★ 页面程序（.jsp）一次都不许请求（它同样是网页，下载端必拒）：${JSON.stringify(externalHostRequests)}`
			);
			assert.equal(
				externalHostRequests.some((url) => url.includes("5.1-translation_terms")),
				false,
				`★★ 后缀不像文件类型的地址（分支名）一次都不许请求（它不是文件）：${JSON.stringify(externalHostRequests)}`
			);
			assert.ok(
				(await readFile(join(root, notePath), "utf8")).includes(pageUrl),
				"★ 那个网页链接也必须原样留着"
			);
			assert.ok(
				(await readFile(join(root, notePath), "utf8")).includes(scriptPageUrl),
				"★ 那条页面程序地址也必须原样留着"
			);
			assert.ok(
				(await readFile(join(root, notePath), "utf8")).includes(branchUrl),
				"★ 那条分支地址也必须原样留着"
			);

			// ⚠️ **收尾必须删掉这条笔记**：候选清单是**全库**的，留在库里会被后面每一段的
			// `upload-attachments` 重新扫到（那条 404 的 `b.png` 于是变成它们的 `failed 1`，
			// 把与它无关的收尾断言打断 —— 2026-10-16 就这么踩过一次）。
			await rm(join(root, notePath), { force: true });
			await harness.refreshPathCache();
		}

		// ============================================================
		// 8b5. ⭐⭐ 本机文件（`file:///…`）：列清单**之前**先问一句"还在不在"
		// ============================================================
		// 2026-10-16 用户实测报的：清单里出现过一行**连缩略图都没有**的
		// `file:///C:/…/Temp/ksohtml/wpsDD.tmp.jpg` —— WPS 的临时文件，早就被删了。
		// 他的原话：「没有缩略图的文件实际上已经不存在了，**不应该上传，即便上传也会失败**」。
		//
		// ⚠️ 这一段**看完清单就取消**（不真的执行）：真执行会把那份**库外**文件的字节传上去、
		// 并在库里写一份本地副本 —— 那会污染后面每一段（与上面那条"夹具收尾"同一类坑）。
		{
			const localDir = await mkdtemp(join(tmpdir(), "acc-local-"));
			const realFile = join(localDir, "acc-real-local.png");
			await writeFile(realFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x55]));
			/** 本机路径 → `file:///` 写法（Windows 的反斜杠要换成正斜杠）。 */
			const toUrl = (path) => `file:///${path.split("\\").join("/")}`;
			// 同一个临时目录下、**故意不存在**的一份（模拟"文件被删了"）
			const goneFile = join(localDir, "acc-gone", "definitely-not-here.png");
			const notePath = "notes/本机文件.md";
			await writeFile(
				join(root, notePath),
				`![real](${toUrl(realFile)})\n![gone](${toUrl(goneFile)})\n`,
				"utf8"
			);
			await harness.refreshPathCache();

			const asks = [];
			plugin.pickTasks = async (options) => {
				asks.push(options);
				return null; // 看完清单就取消 —— 这一段不真的执行
			};
			runCommand("upload-attachments");
			await waitFor(async () => asks.length > 0, "本机文件那一趟弹出了确认框", 10000, diagnose);
			plugin.pickTasks = pickTasksAll; // 恢复默认替身（后面的用例还要用）

			const dialog = asks.at(-1);
			const ids = (dialog.cards ?? []).map((card) => card.id).join(" | ");
			assert.ok(
				ids.includes("acc-real-local.png"),
				`★★ 还在的本机文件要照常列出来（这条链唯一能读库外文件的地方）：${ids}`
			);
			// ⚠️⚠️ 2026-10-22（D-70）：它**要出现**，只是**勾不了**。
			//
			// 用户报的第三次：「有一个文件失效了，**只弹了一个通知**」→「改成列出文件列表，
			// 附件名称后面增加一个跳转链接打开所在笔记」。之前"从清单里摘掉、只在文案里
			// 提一句路径"的做法，等于把他指回笔记里逐条找那条坏链。
			// ⚠️ 但它**绝对不能可勾**：文件都不在了，勾上只会让那一行停在等待
			// —— 清单里出现"勾了也不会被处理"的行，会被读成插件漏了它。
			const goneRow = (dialog.cards ?? []).find((card) => String(card?.id ?? "").includes("acc-gone"));
			assert.ok(goneRow, `★★ 已经不在的本机文件也要**列出来**（用户要能跳去笔记里修）：${ids}`);
			assert.equal(goneRow?.selectable, false, "★★ 但它**勾不了**（必然做不成，勾上只会停在等待）");
			assert.ok(String(goneRow?.hint ?? "").length > 0, "★ 行内标签要说清「文件已不在」（作悬停说明）");
			// ⭐ 2026-10-22（D-71，用户要求）："在列表中用**图标**表示出来" ——
			// 行上带的是图标名（由弹窗层用宿主的 `setIcon` 画），而不是一段文字标签。
			assert.equal(
				goneRow?.hintIcon,
				"alert-triangle",
				`★★ 失效行要用**图标**标出来（文字只作悬停说明）：${goneRow?.hintIcon}`
			);
			assert.deepEqual(
				goneRow?.open,
				{ kind: "vault", value: notePath },
				`★★ 行尾链接打开的是**引用它的那篇笔记**（他去那里修那条坏链）：${JSON.stringify(goneRow?.open)}`
			);
			assert.ok(
				String(goneRow?.meta ?? "").includes("definitely-not-here"),
				`★ 副标题给完整路径（用户要核对"是哪一份"）：${goneRow?.meta}`
			);
			assert.equal(
				(dialog.initiallySelected ?? []).some((key) => String(key).includes("acc-gone")),
				false,
				"★★ 默认勾选**不含**它（勾不了的行不许进初始集合）"
			);
			// ⭐⭐ 而**还在**的那一行**必须把地址交给宿主去画**（`file:///…`）：能不能画出来
			// **由宿主说了算**，画不出来由 `file-cards.ts::renderThumb` 的 `onerror` 静默降级。
			// ⚠️ 这条守的是「**不许提前把图掐掉**」：上一轮我们出于一个**错误的归因**
			//（把控制台那条 `net::ERR_FILE_NOT_FOUND` 读成了"协议被拒"，其实那是"文件不存在"）
			// 把本机行的缩略图直接设成"不给" ⇒ 用户看到的是「列表上有文件了，但是**预览看不到**」
			//（2026-10-16）。⚠️ 递回原文之后**真机判定结果是它画不出来**（Chromium 拒绝从
			// `app://` 原点加载 `file://` 子资源），用户又报了一次同一句话。
			// ⇒ 判据：行里要带着**一串候选** —— 宿主自己的本地前缀在前、原文在后，
			// 画不画得出来**由运行时逐个试**（`local-file.ts::localThumbCandidates`）。
			const realRow = (dialog.cards ?? []).find((card) =>
				String(card?.id ?? "").includes("acc-real-local.png")
			);
			const realUrls = realRow?.thumbUrls ?? [];
			assert.ok(
				Array.isArray(realUrls) && realUrls[0]?.startsWith("app://"),
				`★★ 本机文件行要优先给**宿主认得的形态**（本地文件前缀），而不是「file:」原文：${JSON.stringify(realUrls)}`
			);
			assert.ok(
				realUrls.includes(`file:///${realFile.split("\\").join("/")}`),
				`★★ 原文仍要留在候选里兜底（宿主前缀不被认时还有一条路）：${JSON.stringify(realUrls)}`
			);
			const lines = (dialog.lines ?? []).join("\n");
			// ⭐⭐ 2026-10-22（D-72）：顶部已经是**固定说明**（不含数字、不含主机名、不含路径），
			// 所以"摘要说 0 个、清单列 8 行"那类不一致**结构上不可能再发生** ——
			// 判据改成"它就是一句固定的话"：
			// ① 不许有数字（数量在**按钮**上）；② 路径/主机名只出现在行里。
			assert.equal(
				/\d/.test(lines),
				false,
				`★★ 顶部必须是**固定说明**（不许随内容调整：没有数字、没有主机名）：${lines}`
			);

			// ⚠️ 失效那条**不写在文案里**（D-70 / D-72）：路径在它自己那一行（`meta`）、
			// 说明在那一行的图标上（`title`）。文案里再贴一次路径，等于又变回"说了但不给点"。
			assert.equal(
				lines.includes("definitely-not-here"),
				false,
				`★ 路径只出现在清单行里（文案里那份点不了）：${lines}`
			);
			assert.ok(!lines.includes("**"), `★ 文案是纯文本，不许露出 Markdown 星号：${lines}`);

			// 收尾：库外那个临时目录 + 这篇笔记都要清掉（候选清单是**全库**的）
			await rm(join(root, notePath), { force: true });
			await rm(localDir, { recursive: true, force: true });
			await harness.refreshPathCache();
		}

		// ============================================================
		// 8b6. ⭐⭐ 命令**失败**必须有人说话（2026-10-16 用户实测：「点击命令没有反应」）
		//
		// 命令回调是异步的，它一旦抛，抛出的错就只是控制台里一条 unhandled rejection
		// —— **界面上什么都不发生**。用户既不知道出了什么事，也无从报告；
		// 他 2026-10-16 报的正是这一句（真因是取 `fs` 的写法在宿主里不成立，
		// 而当时**所有测试都是绿的** —— 夹具自己补了真机没有的东西）。
		// ⇒ 这条钉的是那条**兜底**本身：让命令在中途抛，看界面有没有说话。
		// ⚠️ 制造失败用的是**覆写接缝**（`maintenanceDeps` 由 `flowContext()` 转调，
		// 所以覆写实例字段就生效），不必真去弄坏环境。
		// ============================================================
		{
			const upload = plugin.commands.find((command) => command.id === "upload-attachments");
			assert.ok(upload, "★ 命令表里得找得到 upload-attachments（找不到就说明这条断言自己失效了）");
			const original = plugin.maintenanceDeps;
			plugin.maintenanceDeps = () => {
				throw new Error("探针：命令第一步就失败");
			};
			mockObsidian.Notice.instances.length = 0;
			try {
				// ⚠️ 这一句**必须同步不抛**：抛到宿主那里就是真机上的"点了没反应"。
				upload.callback();
				await waitFor(
					async () => mockObsidian.Notice.instances.length > 0,
					"命令失败之后界面说了句话",
					5000,
					diagnose
				);
				const said = mockObsidian.Notice.instances.map((notice) => notice.message).join(" | ");
				assert.ok(
					said.includes("探针：命令第一步就失败"),
					`★★ 命令失败必须把原因说出来（用户看到的不能是「没有反应」）：${said}`
				);
			} finally {
				plugin.maintenanceDeps = original;
			}
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
			const originalPickTasks = plugin.pickTasks;
			/**
			 * 清单替身 = "用户只勾了**站外/本机**那几行、点确认"。
			 *
			 * ⚠️ 2026-10-22（D-68）：「挑选外链」那条命令并入了「上传附件」，于是这里改成
			 * 驱动**大命令**的清单 —— 只勾 `pickKey` 形态的行（站外/本机的 id 是
			 * `笔记\0地址`；库内文件的 id 是路径，不可能含 NUL）。
			 * ⚠️ `run` 仍要跑一遍：缓存与进度都在它里面（弹窗只负责列出来与收勾选）。
			 */
			const pickOnlyExternal = () => {
				plugin.pickTasks = async (options) => {
					pickAsks.push(options);
					const selected = (options.cards ?? [])
						.map((card) => card.id)
						.filter((id) => typeof id === "string" && id.includes("\u0000"));
					await options.run?.(selected, () => {});
					return { selected, ran: true };
				};
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
			pickOnlyExternal();

			const filesBefore = await cacheFiles();
			const entriesBefore = (await readIndex()).entries.length;
			externalHostRequests.length = 0;

			runCommand("upload-attachments");

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
			pickOnlyExternal();

			const filesBeforeReuse = await cacheFiles();
			const entriesBeforeReuse = (await readIndex()).entries.length;
			externalHostRequests.length = 0;

			runCommand("upload-attachments");
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
			pickOnlyExternal();

			const filesBeforeToken = await cacheFiles();
			runCommand("upload-attachments");
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

			plugin.pickTasks = originalPickTasks;
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

			// ③ ⛔ 被**笔记用库内路径直接指着**的那一份 ⇒ 淘汰不许碰它（2026-10-15 新加的安全线）。
			// ⚠️ 笔记里刻意写成**相对路径**（`../attachments/…`）—— 这正是用户实测报过的形态
			//（`![](../企业微信截图_….png)`），也是"判据漏一半"最容易漏掉的那一形。
			const pinnedKey = "pinned-big-3f.png";
			const pinnedPath = `attachments/${pinnedKey}`;
			const pinnedNote = "notes/pinned-copy.md";
			await mkdir(join(root, "attachments"), { recursive: true });
			await writeFile(join(root, pinnedPath), Buffer.from([...bigBytes, 0x11]));
			await writeFile(join(root, pinnedNote), `![x](../${pinnedPath})\n`, "utf8");

			// ⭐ 只有第一份在"云端"（HEAD 复核要能查到它）
			server.objects.set(legacyKey, { body: Buffer.from(bigBytes), contentType: "image/png" });
			// ⚠️⚠️ 第三份**也放进"云端"**：否则它会因为"云端确认不上"被跳过，
			// 于是"判据漏了 ⇒ 它被删掉"这条根本走不出来（实测：第一版忘了放，
			// 那条"不许淘汰"的断言在变异下**依然通过** —— 假绿）。
			server.objects.set(pinnedKey, { body: Buffer.from([...bigBytes, 0x11]), contentType: "image/png" });
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
			// 第三份：**最久没用**（回拨 5 小时）⇒ 判据一旦漏了，它会被**第一个**挑走。
			// 它被笔记直接指着 ⇒ 该留。
			index.set({
				key: pinnedKey,
				cachePath: pinnedPath,
				remoteUrl: `${PUBLIC_BASE}/${pinnedKey}`,
				size: bigBytes.length + 1,
				contentType: "image/png",
				etag: "",
				uploadedAt: new Date().toISOString(),
				lastUsedAt: Date.now() - 5 * 60 * 60 * 1000,
				sourceName: pinnedKey,
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
					return realRotator.maybeRotate(reason).then((summary) => { console.log("[probe] rotate", reason, JSON.stringify(summary)); return summary; });
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

			console.log("[probe] index=", JSON.stringify(index.toArray().map((e) => ({ k: e.key, size: e.size, at: e.lastUsedAt }))));
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

			// ⛔⛔ 第三道边界（2026-10-15 新加）：笔记里**直接指着这份文件**（库内路径）⇒ 淘汰不许碰。
			//
			// 那种链接指着的是**文件本身**，不是云端地址 ⇒ 删了**没有任何兜底**
			//（回退下载只认属于本存储的 URL）⇒ 用户打开那篇笔记看到的是破图。
			// ⭐ 这一份还是**最久没用**的（回拨 5 小时）⇒ 判据一旦漏了，它是**第一个**被挑走的。
			//
			// ⚠️ 这条同时也守着**接线**：判据层的单测证明不了"`referencedPaths` 有没有被
			// 真的递到淘汰那条链上"（`maintenanceDeps` 与 `rotation` 是**两个**接缝）。
			assert.equal(
				await existsOnDisk(root, pinnedPath),
				true,
				"★★ 被笔记用库内路径直接指着的副本**不许淘汰**（删了那张图没有任何兜底）"
			);
			assert.ok(index.has(pinnedKey), "★ 那份的索引记录也必须留着（文件还在磁盘上）");
			assert.equal(
				harness.calls.delete.includes(pinnedPath),
				false,
				"★★ 更不许真的发出删除（上面两条的实现层对照）"
			);

			// 这一节的夹具要**整个收走**：那篇笔记留着会改变后面几节的「还有人引用吗」，
			// 那份副本留着会变成后面几节的「孤儿」（索引里有、没人引用）—— 两者都会让
			// 别的用例开始测另一件事。
			await rm(join(root, pinnedNote), { force: true });
			await rm(join(root, pinnedPath), { force: true });
			index.remove(pinnedKey);
			await harness.refreshPathCache();

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
					// ⚠️ **一小时前用过**，不是"刚刚"：上限那条路有 **10 分钟宽限**（刚用过的这轮不动），
					// 而本节的最后一条断言（"切回保留副本不该问"）要求**那条错路真的能走到弹窗**——
					// 写成 `Date.now()` 时它落在宽限里 ⇒ 零候选 ⇒ 静默返回 ⇒ 错路不可见（实测踩到）。
					// 「不留副本」那条路不看这个字段，所以这里改它不影响上面的断言。
					lastUsedAt: Date.now() - 60 * 60 * 1000,
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

			// ⭐⭐ 反向（2026-10-15，用户从"站在用户角度"提出来）：把档位切**回保留副本** ⇒ **不该再问**。
			//
			// 若判定放宽成"只要档位变了就问"，用户刚说要保留副本，插件却问"要不要把本地副本删掉"
			// —— 那是自相矛盾的配置（与"不留副本档下不给删除按钮"同一条纪律）。
			// ⚠️ 此刻候选**非空**（那份云端确认不上的仍在候选里）⇒ 这一条测的是"**不该问**"，
			// 不是"没东西可问所以静默"。两者必须能区分开，否则这条断言会永远为真。
			// ⚠️ 否定断言要走 `waitForAbsence`（**给它一个出现的窗口**），不能直接 assert：
			// 上面那次 `saveSettings` 里的清理流程是 `void` 启动的，直接断言时它还没跑到
			// 弹确认框那一步 ⇒ 这条断言会**恒真**（实测：第一版直接 assert，变异报"漏过"）。
			//
			// ⚠️⚠️ 还要**让那条错路真的能走到能被看到的地方**（D-27 之后补的这一条）：
			// 目标现在来自档位，而"保留副本 + 没设上限"= **没有目标** ⇒ 流程自己就返回了
			// ⇒ 判定写错也**什么都不发生** ⇒ 这条否定断言变得**没有牙**（实测：D-27 落地后
			// `mutate-load-acceptance` 又报了一次"漏过"）。
			//
			// ⭐ 所以上限必须**低于当前占用量**、且夹具里那些副本必须**不在宽限期内**：
			// 这样"切回保留档却去清"在错误实现下**真的有候选可问** ⇒ 弹出确认框 ⇒ 这条断言才看得见。
			// ⚠️ 第一版写的是 `4096`（"远大于占用量，顺便避免触发后台淘汰"）—— 那正好让错路
			// **零候选、静默返回** ⇒ 变异报"漏过（测试无牙）"。**上限取值的判据是"能不能让错路现形"，
			// 不是"能不能避开别的副作用"。**
			// ⚠️ 后台淘汰（`maybeRotate("settings")`）确有 60 s 节流且本套件更早处已经真跑过一轮
			// ⇒ 这里这一轮会被节流跳过（`isRotationDue`），不会把候选先清空。
			plugin.settings.cacheLimitMb = 1;
			plugin.settings.localCopy = "keep";
			await plugin.saveSettings();
			await waitForAbsence(
				() => releaseAsks.length > 2,
				"★ 切成「保留副本」时不该问要不要删（用户刚说要保留）"
			);
			// ⚠️ 收尾把上限还原成"不限量"：这一节造出来的 1 MB 上限留在设置里，会让**后面**
			// 任何一次 `saveSettings` 都想去淘汰（虽然也会被 60 s 节流挡下）—— 不留这种尾巴。
			plugin.settings.cacheLimitMb = 0;
			await plugin.saveSettings();

			// ============================================================
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

			// ⭐ 清单里那一行**必须带缩略图地址**（用户 2026-10-15 真机报「.png 缩略图不显示图片」）。
			//
			// ⚠️ 这一条只能在这里钉（端到端）：判定层的单测（`file-cards-suite`）证明不了
			// 「流程有没有把 `localPath` 递下去」—— 少了那一步，界面那一行只会显示一个
			// 「PNG」标记，而图正是用户核对清单时唯一能用的东西。
			{
				const row = (pickAsks.at(-1)?.cards ?? []).find((card) => card.id === twinPath);
				assert.ok(row, `★ 清单里应当有 ${twinPath} 这一行`);
				assert.ok(
					row.thumbUrls?.[0]?.startsWith("app://"),
					`★ 库内图片那一行必须有缩略图地址（用磁盘上那份，零网络）：实际 ${JSON.stringify(row.thumbUrls)}`
				);
				assert.equal(row.fromLocalCopy, true, "★ 库内那一行必须用本地副本（不联网）");
			}

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
		// 8f. ⭐ **百分号编码**的写法也要能改写 ⇒ 重复副本照常删掉（2026-10-15 修）
		//
		// 这一条原先测的是反面：当时改写器认不出编码写法（`dup3%201.png`）⇒ 它**原样留在正文里**
		// ⇒ 判据必须认定"这一份还被指着" ⇒ 不删。用户 2026-10-15 报的正是这种写法
		// （`../assets/Pasted%20image%20….png`）：**传上去了、而笔记一处都没改**
		// —— 在他那里症状是"能识别出来、实际上没有上传"。
		//
		// 根因是**两侧各写了一遍归一**：改写侧不认百分号编码，删除判据侧不认相对前缀。
		// 现在两侧共用同一份（`linkTargetForms`）⇒ 这种写法**改得掉** ⇒ 重复副本也照常
		// 按 D-24 ④ 删掉。断言因此反过来：**链接必须被改写、副本必须被删掉**。
		// ⚠️ "有引用没能改写 ⇒ 一份都不删"仍由 8e（画布解不开的值）与 `maintenance-suite`
		//    里"歧义短名"那条单元断言守着。
		// ============================================================
		{
			const twinPath = "attachments/dup3.png";
			const duplicatePath = "attachments/dup3 1.png";
			const DUP3_BYTES = new Uint8Array([...BATCH_BYTES, 0x7f]);
			const notePath = "notes/重复丁.md";
			await writeFile(join(root, twinPath), Buffer.from(DUP3_BYTES));
			await writeFile(join(root, duplicatePath), Buffer.from(DUP3_BYTES));
			// 编码形式（空格写成 %20）—— 宿主的「相对路径」链接格式自己就这么写
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
			// 再给它一点时间：删除发生在改写之后（同一趟里）
			await new Promise((resolve) => setTimeout(resolve, 200));

			// ⭐ 用户看到的症状就出在这里：链接没被改写 ⇒ 笔记看起来"没上传"
			const encodedNote = await readFile(join(root, notePath), "utf8");
			assert.equal(
				encodedNote.includes("dup3%201.png"),
				false,
				`★ 编码写法必须被改写（否则就是"传上去了、笔记没变"）：${encodedNote}`
			);
			assert.equal(encodedNote.includes(`${PUBLIC_BASE}/`), true, `★ 换上的是自己存储的公开地址：${encodedNote}`);
			assert.equal(await existsOnDisk(root, duplicatePath), false, "★ 链接已改写、它已零引用 ⇒ 重复副本照常删掉");
			assert.equal(harness.calls.delete.length, deletesBefore + 1, "★ 这一趟正好删掉那一份重复副本");
			assert.equal(await existsOnDisk(root, twinPath), true, "★ 留下来的那一份当然还在");
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
			// ⚠️ 宿主的链接索引**跟着正文走**：真机上改写/清空之后它会重新解析，这里必须手动跟上。
			// 不跟会怎样：判"本地副本还被正文指着"的那条会读到**旧的** resolvedLinks，
			// 于是这个对象被当成"还在用"、询问不出声（2026-10-22 加本地引用那一半时踩到，
			// 现象是"引用消失了却不弹"—— 与真机行为相反，纯属夹具没跟上）。
			harness.setResolvedLinks({});
			app.vault.trigger("modify", app.vault.getAbstractFileByPath(notePath));

			// 1.5 s（引用重算）+ 4 s（询问防抖）—— 等它自己走完
			await waitFor(
				() =>
					mockObsidian.Notice.instances.some(
						(notice) =>
							notice.message ===
							// ⚠️ 指路指向的是**新那条命令**（"检查未被引用的云端附件…"）：它按同一批
							// 判据再列一次，正是"想再处理一次"该去的地方。
							plugin.t("orphanNotice", { count: 1, command: plugin.t("cmdCheckOrphans") })
					),
				"★ 引用消失了 ⇒ 必须出声（`notice` 档：一条通知，且数量如实）",
				9000,
				() => `实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))}`
			);
		}

		// ============================================================
		// 8i2. ⭐⭐ 清理命令涵盖**两类**：云端对象 ＋ **没有任何引用的本地文件**（D-74）
		//
		// 用户 2026-10-22：「增强清理命令功能涵盖所有可以被清理的对象，把本地孤立文件也纳入清理。
		// 加过滤选项，可以不勾本地，也可以不勾云端。」
		//
		// ⚠️ 命令路只有在 `orphanAsk === "always"` 时才弹**清单**（`notice` 档只出一句通知，
		// §8i 测的正是那一档）⇒ 这一段显式切回来。
		// ⚠️ 替身会 `run(selected)` 但**不传 `action`** ⇒ 三档一个都不执行，
		// 所以这一段**不删任何东西**（它只验清单长什么样）。
		// ============================================================
		{
			plugin.settings.orphanAsk = "always";
			// 造一个"从没上传过、也没有任何引用"的本地文件
			const strayPath = "attachments/没人引用我.png";
			await writeFile(join(root, strayPath), Buffer.from([...BATCH_BYTES, 0x92]));
			// ⭐ 2026-10-22（D-77）：**站外缓存的本地副本** ——
			// 一份没人引用的（要进清单）、一份被笔记直接指着的（**不进**）。
			const cachedPath = "attachments/站外缓存图.png";
			const cachedPinned = "attachments/站外缓存图-被引用.png";
			await writeFile(join(root, cachedPath), Buffer.from([...BATCH_BYTES, 0x93]));
			await writeFile(join(root, cachedPinned), Buffer.from([...BATCH_BYTES, 0x94]));
			for (const [key, path] of [["cached-1f.png", cachedPath], ["cached-2f.png", cachedPinned]]) {
				plugin.indexStore.index.set({
					key,
					cachePath: path,
					remoteUrl: `${PUBLIC_BASE}/${key}`,
					size: 12,
					contentType: "image/png",
					etag: "",
					uploadedAt: new Date().toISOString(),
					lastUsedAt: Date.now(),
					sourceName: path.split("/").pop() ?? path,
					origin: "external",
				});
			}
			// 被引用的那一份：笔记里直接指着路径（最严格的那一半判据）
			await writeFile(join(root, "notes/站外缓存引用.md"), `![](${cachedPinned})`);
			harness.setResolvedLinks({ "notes/站外缓存引用.md": { [cachedPinned]: 1 } });
			await harness.refreshPathCache();

			const asks = [];
			plugin.pickTasks = async (options) => {
				asks.push(options);
				return null; // 看完清单就取消 —— 这一段不执行任何删除
			};
			runCommand("check-orphans");
			await waitFor(() => asks.length > 0, "清理命令弹出了清单", 10000, diagnose);
			plugin.pickTasks = pickTasksAll;
			plugin.settings.orphanAsk = "notice"; // 还原（后面还有用例在用）

			const dialog = asks.at(-1);
			const ids = (dialog.cards ?? []).map((card) => String(card.id));
			assert.ok(
				ids.some((id) => id.startsWith("cloud:")),
				`★★ 清单里要有云端对象那一类：${ids.join(" | ")}`
			);
			assert.ok(
				ids.includes(`vault:${strayPath}`),
				`★★ 从来没有上传过、也没有任何引用的本地文件也要列出来（D-74）：${ids.join(" | ")}`
			);
			// ⚠️ 这一格守的是"还**被远端 URL 引用着**的不算孤立"：
			// 前面几节上传过、链接也已经改成远端地址的那份附件（`attachments/pic.png`）
			// **不许**出现在本地孤立那一列 —— 否则用户一清就把正在显示的图删掉。
			assert.equal(
				ids.includes("vault:attachments/pic.png"),
				false,
				`★★ 链接已改成远端地址的附件不算孤立（只查本地引用就会误删）：${ids.join(" | ")}`
			);

			// ⭐ 默认只勾云端：本地文件从没上传过，删了**没有云端可依**
			const picked = (dialog.initiallySelected ?? []).map(String);
			assert.ok(
				picked.length > 0 && picked.every((id) => id.startsWith("cloud:")),
				`★★ 默认只勾云端对象（本地孤立文件要用户自己决定）：${picked.join(" | ")}`
			);

			// ⭐ 两个类别开关（用户原话：「可以不勾本地，也可以不勾云端」）
			assert.deepEqual(
				(dialog.filters ?? []).map((item) => item.key),
				["cloud", "local"],
				"★★ 两个类别过滤开关"
			);

			const localOnly = await dialog.onFiltersChange({ cloud: false, local: true });
			const localIds = localOnly.cards.map((card) => String(card.id));
			assert.ok(
				localIds.every((id) => id.startsWith("vault:")),
				`★★ 关掉「云端对象」后只剩本地文件那一类：${localIds.join(" | ")}`
			);
			assert.ok(
				localIds.includes(`vault:${strayPath}`),
				`★ 刚造的那份孤立文件要在里面：${localIds.join(" | ")}`
			);
			// ⭐⭐ 2026-10-22（D-77，用户：「语义也扩展到所有可以被清理的附件」）：
			// **站外缓存副本**也在清单里，但行内标「站外缓存」（与「本地」区分）、**默认不勾**。
			const cachedRow = (localOnly.cards ?? []).find((card) => String(card.id) === `vault:${cachedPath}`);
			assert.ok(
				cachedRow,
				`★★ 站外缓存下来的本地副本也要列出来（以前被硬排除，永远清不掉）：${localIds.join(" | ")}`
			);
			assert.equal(
				cachedRow?.hint,
				plugin.t("orphanRowCached"),
				`★★ 缓存那一行要标「${plugin.t("orphanRowCached")}」（否则用户不知道删了会怎样）：${cachedRow?.hint}`
			);
			assert.equal(
				picked.includes(`vault:${cachedPath}`),
				false,
				`★★ 缓存那一行**默认不勾**（删了下次显示要重新下载）：${picked.join(" | ")}`
			);
			// ⚠️ 而**被笔记直接指着**的那份缓存副本一行都不许有（那就是删正在显示的图）。
			assert.equal(
				localIds.includes(`vault:${cachedPinned}`),
				false,
				`★★ 被引用的缓存副本不进清单（与普通文件同一道判据）：${localIds.join(" | ")}`
			);
			// ⚠️⚠️ **宿主自己的目录一个都不许出现**：`.obsidian/` 里是插件与设置
			//（本插件自己的 `.cache-index.json` 就在那儿）—— 它同样"没有任何笔记引用"，
			// 但删了就是坏配置。这条是实测抓到的（第一版把它列成了可清理项）。
			assert.equal(
				localIds.some((id) => id.startsWith("vault:.")),
				false,
				`★★ 隐藏目录（.obsidian / .trash）里的文件不是可清理项：${localIds.join(" | ")}`
			);
			const cloudOnly = await dialog.onFiltersChange({ cloud: true, local: false });
			assert.ok(
				cloudOnly.cards.length > 0 && cloudOnly.cards.every((card) => String(card.id).startsWith("cloud:")),
				`★★ 关掉「本地文件」后只剩云端对象：${cloudOnly.cards.map((card) => card.id).join(" | ")}`
			);
			// ⭐⭐ 2026-10-22（D-76）：**两条命令的清单弹窗统一风格**，三条判据（与「上传附件」逐字对得上）：
			//
			//  ① 标题 = **命令名**（问句只留给自动那条询问）；
			//  ② 顶部是**一句固定说明**：不随内容变、**不含数字**；
			//  ③ 数量在**要按的那个按钮上**。
			assert.equal(
				dialog.title,
				plugin.t("cmdCheckOrphans").replace("…", ""),
				`★★ 清单弹窗的标题 = 命令名（与「上传附件」同一条规则，问句只留给自动那条）：${dialog.title}`
			);
			assert.equal(
				/\d/.test((cloudOnly.lines ?? []).join(" ")),
				false,
				`★★ 顶部是**固定说明**，不许有数字（数量在按钮上）：${JSON.stringify(cloudOnly.lines)}`
			);
			assert.equal(
				(cloudOnly.lines ?? []).length,
				1,
				`★★ 顶部只该有**一段**（与「上传附件」一致；原来是 3~4 段且随过滤变）：${JSON.stringify(cloudOnly.lines)}`
			);
			// ③ 数量真的在按钮上（两个删除档）；「保留」不动任何东西 ⇒ 不带
			const deleteActions = (dialog.actions ?? []).filter((action) => action.key !== "keep");
			assert.equal(deleteActions.length, 2, `★ 两个删除档：${JSON.stringify((dialog.actions ?? []).map((a) => a.key))}`);
			for (const action of deleteActions) {
				assert.equal(
					String(action.label(5)).includes("5"),
					true,
					`★★ 「${action.key}」这一档要说清**动几个**（与「上传附件」的主按钮同一个读法）：${action.label(5)}`
				);
			}
			// ⚠️ 只钉“字段存在”是不够的：`buildTaskLabels` 也还要真的把 `{count}` 换掉
			//（D-72 的生产缺陷：模板里没有 `{count}`，数字一直被静默丢掉，而套件的假 `t` 把参数拼进去了）。
			for (const key of ["maintainBatchCta", "orphanLocalOnly", "orphanBoth"]) {
				assert.equal(
					plugin.t(key, { count: 7 }).includes("7"),
					true,
					`★★ 按钮文案要真的带上数量（模板里得有 {count}）：${key} ⇒ ${plugin.t(key, { count: 7 })}`
				);
			}
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

			// ── ② 台账清空 ⇒ **绝不能静默**：要么弹清单、要么如实说"没有发现" ──
			//
			// 办法：把**上传台账**清空（`forgetUploaded`）—— 那正是"这台设备什么都没上传过"。
			//
			// ⚠️ 2026-10-22（D-74）之后"两类都空"在这套夹具里**造不出来**：库是全局的，
			// 前面几十节留下的文件里必然有"没人引用、也没上传过"的本地文件 ⇒ 命令照样有东西可列。
			// 所以判据改成"**不许静默**"（两种合法出口之一），而不是死盯那一句文案。
			// ⚠️ 别把它改成"必须弹清单"：那会在**真的**没有孤立文件的环境里假红
			//（演示库、用户库都可能是干净的）。
			index.forgetUploaded(orphanKey);
			mockObsidian.Notice.instances.length = 0;
			const emptyAsk = [];
			plugin.pickTasks = async (options) => {
				emptyAsk.push(options);
				return null;
			};
			runCommand("check-orphans");
			await waitFor(
				() =>
					emptyAsk.length > 0 ||
					mockObsidian.Notice.instances.some((notice) => notice.message === plugin.t("orphanNoneToCheck")),
				"★ 云端候选为空时也必须出声（弹清单，或如实说「没有发现」—— 绝不能静默）",
				6000,
				() =>
					`实际提示：${JSON.stringify(mockObsidian.Notice.instances.map((n) => n.message))} ｜ 清单：${emptyAsk.length}`
			);
			plugin.pickTasks = pickTasksAll;
		}

		// ============================================================
		// 8i. ⭐⭐ **改不了、但仍被指着** ⇒ 一份都不删（同名歧义）
		//
		// 这一条接替 §8f 原先的位置：那里用的是"**URL 编码**那种认不出来的写法"，而
		// 2026-10-15（D-29）之后编码写法**改得掉**了 ⇒ "删除前必须先问正文"这道守卫在验收里
		// **失去了窗口**（`mutate-maintenance-run` 的「删除前不看正文里还留着的那条引用」
		// 当场报「漏过（测试无牙）」）。
		//
		// 现在"认得出、但**改不了**"的形态只剩**同名歧义**：两个不同目录下都有 `dup5 1.png`
		// 且都要上传 ⇒ 规则里短名 `dup5 1` 撞车 ⇒ 改写器**宁可不改**（改成错的那张更糟），
		// 而判据必须把它当成"还指着它" ⇒ 两份重复副本都不许删。
		// ⚠️ 链接刻意写成"相对 + 编码"（宿主「相对路径」格式自己那种形态）：它认得出（走短名）
		// 却改不了（同名歧义），正是这道守卫要求的形态。
		// ============================================================
		{
			const dupA = "attachments/dup5 1.png";
			const dupATwin = "attachments/dup5.png";
			const dupB = "notes/dup5 1.png";
			const dupBTwin = "notes/dup5.png";
			const BYTES_A = new Uint8Array([...BATCH_BYTES, 0x81]);
			const BYTES_B = new Uint8Array([...BATCH_BYTES, 0x82]);
			const notePath = "notes/重复戊.md";
			await writeFile(join(root, dupATwin), Buffer.from(BYTES_A));
			await writeFile(join(root, dupA), Buffer.from(BYTES_A));
			await writeFile(join(root, dupBTwin), Buffer.from(BYTES_B));
			await writeFile(join(root, dupB), Buffer.from(BYTES_B));
			await writeFile(join(root, notePath), "![x](../attachments/dup5%201.png)\n", "utf8");
			harness.setResolvedLinks({ [notePath]: { [dupA]: 1, [dupB]: 1 } });
			await harness.refreshPathCache();

			const deletesBefore = harness.calls.delete.length;
			plugin.confirmMaintenance = async () => true;
			runCommand("upload-attachments");
			// 两份都是宿主撞名另落的重复副本 ⇒ 各自一次 PUT（拿它当"这一趟跑到了"的信号）
			await waitFor(
				async () => server.requests.filter((request) => request.method === "PUT").length >= 2,
				"这一趟跑完（两份重复副本都进了存储）",
				6000,
				diagnose
			);
			// 删除排在改写之后（同一趟里）：判据错了它会紧接着消失
			await new Promise((resolve) => setTimeout(resolve, 600));

			const ambiguousNote = await readFile(join(root, notePath), "utf8");
			assert.equal(
				ambiguousNote.includes("dup5%201.png"),
				true,
				`★ 同名歧义 ⇒ 改写器宁可不改（这条引用要原样留在正文里）：${ambiguousNote}`
			);
			assert.equal(
				await existsOnDisk(root, dupA),
				true,
				"★★ 正文里还有一条认不出的引用指着它 ⇒ 不许删（删了就留一条指向不存在文件的链接）"
			);
			assert.equal(await existsOnDisk(root, dupB), true, "★ 同理：歧义那两份都不许删");
			assert.equal(harness.calls.delete.length, deletesBefore, "★ 这一趟一个文件都不该删");
		}

		// ============================================================
		// 8j. ⭐⭐ 「大而全的上传」：**没有任何笔记引用的附件**也要真能传（D-68 的接线）
		//
		// ## 为什么必须在这一层测
		//
		// 候选那一侧（`selectUploadCandidates` 的 `includeUnreferenced`）在 `maintenance`
		// 套件里逐格钉过 —— 但**执行层会重新算一遍候选**（安全判据在那儿）。那个口子没接上时，
		// 用户勾了未引用项、点了确认，清单上那一行**永远停在等待**：既不是失败也不是跳过
		//（`onItem` 只对真正处理到的那些上报），一个字都不报。2026-10-22 实测到的正是这个缺口。
		//
		// ⚠️ 这条同时钉住另一半：它们**默认不勾** —— 传上去不会出现在任何笔记里（只是备份），
		// 而这类文件可能有几百个（旧图、废弃稿），默认全勾等于替用户做了"全备份"这个决定。
		// ============================================================
		{
			const orphanName = "没有引用的附件";
			const orphanPath = `attachments/${orphanName}.png`;
			const ORPHAN_BYTES = new Uint8Array([0x6f, 0x72, 0x70, 0x68, 0x61, 0x6e, 0x21]);
			await writeFile(join(root, orphanPath), Buffer.from(ORPHAN_BYTES));
			await harness.refreshPathCache();
			const orphanKey = `${orphanName}-${createHash("sha256").update(Buffer.from(ORPHAN_BYTES)).digest("hex")}.png`;

			// 替身扮演"用户只勾了这一行"（真弹窗里它默认不勾，见下面的断言）
			let rowSeen = false;
			let tickedByDefault;
			plugin.pickTasks = async (options) => {
				const row = (options.cards ?? []).find((card) => card.id === orphanPath);
				rowSeen = Boolean(row);
				tickedByDefault = (options.initiallySelected ?? []).includes(orphanPath);
				await options.run?.(row ? [row.id] : [], () => {});
				return { selected: row ? [row.id] : [], ran: true };
			};
			runCommand("upload-attachments");
			await waitFor(
				() => plugin.indexStore.index.wasUploaded(orphanKey),
				"★★ 勾上「没有被任何笔记引用」的附件之后必须**真的**上传（执行层少了 `includeUnreferenced` 就会静默跳过：那一行永远停在等待）",
				6000,
				diagnose
			);
			plugin.pickTasks = pickTasksAll; // 恢复默认替身

			assert.equal(rowSeen, true, "★★ 没有引用的附件必须出现在清单里（用户要一条命令把库里该传的都传了）");
			assert.equal(
				tickedByDefault,
				false,
				"★★ 但它默认**不勾**（传上去不会出现在任何笔记里，只是备份 —— 得他自己决定）"
			);
			assert.equal(await existsOnDisk(root, orphanPath), true, "★ 文件留在原处：这条命令从不搬文件、从不改名");
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
