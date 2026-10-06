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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

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
			publicUrlBase: `${endpoint}/${BUCKET}`,
			accessKeyIdRef: "acc-test-ak",
			secretAccessKeyRef: "acc-test-sk",
			forcePathStyle: true,
			objectKeyTemplate: "{hash}.{ext}",
		},
	});
	// 凭据进钥匙串（替身的 SecretStorage 是内存 Map）
	app.secretStorage.setSecret("acc-test-ak", ACCESS_KEY_ID);
	app.secretStorage.setSecret("acc-test-sk", SECRET_ACCESS_KEY);

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

		assert.ok(plugin.settingTabs.length >= 1, "★ 设置页必须被注册（否则用户连配置入口都没有）");

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
			text.includes(`${endpoint}/${BUCKET}/`),
			"链接必须指向配置的公开前缀（否则图片打开是 404）"
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
		// 3. 反向：已被别的插件处理过的载荷，我们**不得**再接管
		// ============================================================
		const taken = makePasteEvent([makeFile("x.png", HOSTILE_BYTES)]);
		taken.preventDefault(); // 模拟另一个插件先处理了
		const editor3 = makeEditor();
		app.workspace.trigger("editor-paste", taken, editor3, info);
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(editor3.replaced.length, 0, "★ 别人已处理的事件不得重复插入链接");

		// ============================================================
		// 4. 未配置：**放行**（图留给宿主保存）+ 给出提示
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

		// ============================================================
		// 5. 卸载：事件引用必须能被宿主注销（否则热重载后每粘一次插两条）
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
		// 恢复默认（抛错）—— 否则同一进程里后续套件会意外走真实网络。
		mockObsidian.setRequestUrlImpl(null);
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
}
