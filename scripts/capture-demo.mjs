/**
 * 录制 README 演示动图的**素材**（`demo-frames/` 下的 PNG 序列 ＋ `timeline.json`）。
 * 动图本身由 `capture-demo-gif.mjs` 用 ffmpeg 合成（叠英文字幕 ＋ 调色板优化）。
 *
 * ## 为什么用一个**一次性的空库**，而不是现成的演示库
 *
 * 2026-10-24 之前是在 `../ObsidianVault` 上录的 —— 那个库里有**用户自己的附件**
 * （专利号、产品资料…），而「附件管理」那张表会把库里所有文件列出来 ⇒ 动图一放到
 * 公开 README 上，等于把这些文件名连同大小一起发出去了。
 *
 * 而且那个库还有别的插件、几十篇笔记、残留布局，每一样都要靠"临时改配置/临时挪文件"
 * 去压住。⇒ 现在的做法：**开一个空库，只放这次要演的东西**，跑完整个删掉。
 *
 * ## 它动的都是"临时"的东西（跑完全部还原）
 *
 * | 位置 | 改什么 | 怎么还原 |
 * |---|---|---|
 * | `%TEMP%/acc-demo-vault/` | 整个库（`.obsidian` ＋ 演示笔记 ＋ 附件） | 删掉 |
 * | `%APPDATA%/obsidian/obsidian.json` | 加一条库登记（不登记就打不开） | 备份后写回 |
 * | `%APPDATA%/obsidian/<appId>.json` | 窗口大小 | 删掉（本来就没有） |
 * | 宿主 localStorage | `language=en`（全局）、`enable-plugin-<appId>=true`（本库） | 语言写回 `zh`，插件开关删掉 |
 *
 * ⚠️ `language` 是**全局**的（同一个 Obsidian 装的所有库共用）。录完必须写回中文，
 * 否则用户下次打开 Obsidian 会变成英文界面 —— 这是本脚本唯一会碰到库外状态的地方。
 *
 * ## 英文界面怎么来的
 *
 * 宿主没有"设置语言"的公开 API，语言落在 `localStorage.language`，改完要**重载**才生效
 *（`app.vault.setConfig` 改不动它）。社区插件另有一道闸：`localStorage["enable-plugin-"+app.appId]
 * = "true"`，否则空库里插件根本不加载（表里那些 `enable-plugin-<16位>` 就是这个键）。
 *
 * ## 流程：**复刻 1.8.0 那一版的分镜**（五步、约 13 秒、英文字幕 ＋ 中文小字）
 *
 * 2026-10-24 用户：「感觉还没有以前做得好，先复刻以前做过的动图，确保能力还在」。
 * 于是照 `de3cf30`（1.8.0）的分镜重录 —— 那版的形状是：`notes/Attachments.md`、
 * 文件名当标题、"Everything for this project:"、一次性粘三件、**源码模式下看着三条链接被改写**、
 * 最后切回预览看它们照常渲染。字幕也是那版的**两行**（英文主行 ＋ 中文次行）。
 *
 * 1. 笔记在**源码模式**（实时预览会把嵌入渲染出来，就看不见"链接被改写"了）；
 * 2. 一次性粘贴三件（照片 / 图表 / PDF）⇒ 走**宿主**的 `editor-paste`
 *（不是 DOM 事件，理由见 `verify-real-storage.mjs`）；
 * 3. 三条 `![](…/name-hash.ext)` 当场变成 `![](https://cdn.example.com/…)`；
 * 4. 停掉 mock 存储；
 * 5. 切回实时预览 ⇒ 三件照常显示（渲染读的是库里那几份本地副本）。
 *
 * ## 为什么用 mock 存储
 *
 * 上传真的发生（PUT 有字节），但不出这台机器 ⇒ 可以反复跑，也不会把演示图留在谁的桶里。
 *
 * 用法：`node scripts/capture-demo.mjs [--port 9225]`
 * 之后：`node scripts/capture-demo-gif.mjs`
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { createMockS3 } from "./lib/mock-s3.mjs";
import { connect, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const VAULT_NAME = "acc-demo-vault";
const VAULT_DIR = process.env.ACC_DEMO_VAULT_DIR ?? join(tmpdir(), VAULT_NAME);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PORT = Number(
	process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9225
);
const APP_DIR = process.env.APPDATA ? join(process.env.APPDATA, "obsidian") : null;
const OBSIDIAN_JSON = APP_DIR ? join(APP_DIR, "obsidian.json") : null;

/** 每帧间隔（毫秒）。120ms ≈ 8.3fps，合成时再按"到下一帧的真实间隔"重算时长。 */
const FRAME_MS = 110;
/** 想要的窗口尺寸（写进宿主按库保存的窗口状态：不写它，宿主会给一个随机的默认尺寸）。 */
// ⚠️ 窗口别开太宽：附件管理那个弹窗是 `min(880px, 92vw)`，**宽度上限就是 880**
// ⇒ 窗口越宽，弹窗在画面里占比越小、字越小（合成时还要缩到 900）。1024×800 时
// 弹窗占满约 86% 宽，读起来刚刚好。
const WINDOW = { x: 40, y: 24, width: 1080, height: 620 };

const DEMO_DIR = "notes";
/**
 * 要粘贴的三件附件（复刻旧版：一张图 ＋ 一个 PDF ＋ 一段音频）。
 *
 * ⚠️ 三件都是**仓库里的真文件**（`scripts/demo-assets/`，来源见那里的 README）：
 * 图片是 Pexels 的免费照片，PDF / WAV 是脚本自己生成的最小样本（几百字节 / 8 KB）。
 * ⇒ 录出来的动图里没有一个字节来自用户自己的库。
 */
// ⚠️ 顺序有讲究：**PDF 排在最后**。宿主 1.14 的 PDF 嵌入会按页高铺开，
// 排中间会把后面那件顶到屏幕外 ⇒ 第 5 步"三件都还在"就看不全（实测踩到）。
// ⚠️ 为什么第三件不是音频（旧版用的是 wav）：`<audio>` 的原生控件**不进 CDP 截图**
//（实测：元素在、readyState=4、duration=1、高 42px，截出来一片白）⇒ 观众会以为播放器坏了。
// 换成第二张图最稳：不依赖任何原生控件。
const PASTE_FILES = [
	{ name: "photo.jpg", type: "image/jpeg", path: "scripts/demo-assets/photo.jpg" },
	{ name: "chart.png", type: "image/png", path: "scripts/demo-assets/chart.png" },
	{ name: "meeting-notes.pdf", type: "application/pdf", path: "scripts/demo-assets/meeting-notes.pdf" },
].map((file) => ({
	name: file.name,
	type: file.type,
	base64: readFileSync(join(REPO, file.path)).toString("base64"),
}));
/** 写进笔记的链接前缀（上传仍走 mock 端点；这个只决定链接长什么样）。 */
const PUBLIC_BASE = "https://cdn.example.com";
const NOTE = "notes/Attachments.md";
const OUT = join(REPO, "demo-frames");

const log = (line = "") => console.log(line);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个空库：只有 `.obsidian` 里的最小配置 ＋ 三个发布资产（不装别的插件）。 */
function prepareVault() {
	rmSync(VAULT_DIR, { recursive: true, force: true });
	const pluginDir = join(VAULT_DIR, ".obsidian/plugins/attachment-cloud-cache");
	mkdirSync(pluginDir, { recursive: true });
	writeFileSync(
		join(VAULT_DIR, ".obsidian/app.json"),
		JSON.stringify(
			{
				// 「附件管理」的「位置」列要有个可读的目录名，别显示成根目录
				attachmentFolderPath: DEMO_DIR,
				// 文件名与 H1 不叠成两行大标题
				showInlineTitle: true,
				livePreview: true,
				useMarkdownLinks: true,
			},
			null,
			2
		)
	);
	// 固定浅色主题：动图要在 GitHub 的深色/浅色两套皮肤下都好看，浅色更好认表格线
	writeFileSync(join(VAULT_DIR, ".obsidian/appearance.json"), JSON.stringify({ theme: "moonstone" }, null, 2));
	writeFileSync(join(VAULT_DIR, ".obsidian/community-plugins.json"), JSON.stringify(["attachment-cloud-cache"]));
	writeFileSync(join(VAULT_DIR, ".obsidian/core-plugins.json"), JSON.stringify(["file-explorer", "global-search"]));
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		const from = join(REPO, name);
		if (!existsSync(from)) throw new Error(`缺少构建产物 ${name} —— 先跑 npm run build`);
		copyFileSync(from, join(pluginDir, name));
	}
	log(`· 空库已就绪：${VAULT_DIR}`);
}

/** 把库登记进 `obsidian.json`（`obsidian://open?vault=` 只认登记过的库）。 */
function registerVault() {
	if (!OBSIDIAN_JSON || !existsSync(OBSIDIAN_JSON)) throw new Error("找不到 obsidian.json（APPDATA 未设置？）");
	const backup = `${OBSIDIAN_JSON}.demo-bak`;
	copyFileSync(OBSIDIAN_JSON, backup);
	const config = JSON.parse(readFileSync(OBSIDIAN_JSON, "utf8"));
	config.vaults = config.vaults ?? {};
	config.vaults[VAULT_NAME] = { path: VAULT_DIR.replace(/\//g, "\\"), ts: Date.now() };
	writeFileSync(OBSIDIAN_JSON, JSON.stringify(config));
	log("· 已登记临时库（obsidian.json 已备份）");
	return backup;
}

async function main() {
	if (!existsSync(OBSIDIAN)) throw new Error(`找不到 Obsidian：${OBSIDIAN}`);
	// ⚠️ 宿主是单实例的：还开着一个的话，新实例把参数交出去就退出了，调试端口**永远**等不到
	//（`launchAndAttach` 会按进程数把这两种原因分开报，不用在这里预判）。

	prepareVault();
	const obsidianBackup = registerVault();

	// 帧目录每次重来（旧帧留着会让"这一轮到底录了几帧"说不清）
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });

	// 窗口大小：宿主按库把窗口状态存在 `%APPDATA%/obsidian/<appId>.json`
	const windowState = APP_DIR ? join(APP_DIR, `${VAULT_NAME}.json`) : null;
	if (windowState) writeFileSync(windowState, JSON.stringify({ ...WINDOW, isMaximized: false, devTools: false, zoom: 0 }));

	const mock = createMockS3({
		accessKeyId: "demo-key",
		secretAccessKey: "demo-secret",
		bucket: "my-notes",
	});
	const endpoint = await mock.start();
	/** `close()` 只能关一次（Node 的 server.close 第二次会给错误回调）；流程中途要"停存储"，所以包一层。 */
	let mockClosed = false;
	const closeMock = async () => {
		if (mockClosed) return;
		mockClosed = true;
		await mock.close().catch(() => {});
	};
	log(`· mock 存储在 ${endpoint}`);

	let child = null;
	let client = null;
	const frames = [];
	let languageWas = null;
	let appId = VAULT_NAME;

	try {
		({ child } = await launchAndAttach({
			exe: OBSIDIAN,
			port: PORT,
			vault: VAULT_NAME,
			waitSeconds: 90,
			log,
		}));
		client = await connect(PORT, { tries: 25, gapMs: 1000 });

		// ── 1) 英文界面 ＋ 让这个库的社区插件真的加载（都要重载才生效）──
		const ids = await evaluate(
			client,
			`({ appId: app.appId, lang: localStorage.getItem("language") })`
		);
		appId = ids?.appId ?? VAULT_NAME;
		languageWas = ids?.lang ?? null;
		log(`· appId=${appId}｜原语言=${JSON.stringify(languageWas)}`);
		await evaluate(
			client,
			`(() => {
				localStorage.setItem("enable-plugin-" + app.appId, "true");
				localStorage.setItem("language", "en");
				return true;
			})()`
		);
		await evaluate(client, `(() => { location.reload(); return true; })()`).catch(() => {});
		// 重载会销毁执行上下文 ⇒ 头几秒的求值可能报错，重试到插件真的加载为止
		let english = false;
		for (let i = 0; i < 30; i += 1) {
			await delay(700);
			try {
				english = await evaluate(
					client,
					`Boolean(app.plugins.plugins["attachment-cloud-cache"]) && /Attachment manager/.test(
						app.commands.commands["attachment-cloud-cache:manage-attachments"]?.name ?? ""
					)`
				);
			} catch {
				english = false;
			}
			if (english) break;
		}
		if (!english) throw new Error("界面没切到英文或插件没加载（先看 localStorage 的两把闸）");
		log("· 英文界面 ＋ 插件已加载");

		// ── 2) 存储指向 mock（只在内存里；这个库是临时的，落盘也无所谓）──
		const ready = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins["attachment-cloud-cache"];
				if (!plugin) return { error: "插件没加载" };
				plugin.settings.s3 = {
					endpoint: ${JSON.stringify(endpoint)},
					region: "auto",
					bucket: "my-notes",
					accessKeyId: "demo-key",
					secretAccessKeyRef: "acc-demo-secret-ref",
					// ⭐ 写成 https://files.example.com：动图里那条链接要像"你自己的存储"，
					// 而不是 127.0.0.1:49210（README 上会像本地测试）。上传仍走 mock 端点 ——
					// publicUrlBase 只决定**链接长什么样**；渲染判定按这个前缀命中索引 ⇒ 用本地副本，
					// 不会真的去解析这个域名（离线那段因此仍然成立）。
					publicUrlBase: ${JSON.stringify(PUBLIC_BASE)},
					forcePathStyle: true,
				};
				try { app.secretStorage?.setSecret?.("acc-demo-secret-ref", "demo-secret"); } catch {}
				plugin.settings.autoUpload = true;
				plugin.settings.localCopy = "keep";
				plugin.settings.externalImageCache = false;
				plugin.settings.uploadLocalFiles = false;
				return { ok: true };
			})()`
		);
		if (ready?.error) throw new Error(ready.error);

		// ── 3) 备好笔记并打开 ──
		// ⭐ 复刻旧版（1.8.0，`de3cf30`）的版式：**文件名当标题**（inline title），正文两行导语，
		// 然后一次性粘贴三件附件。旧动图就是 `notes/Attachments.md` + "Everything for this project:"。
		const noteBody = [
			"Everything for this project:",
			"The photo, the chart and the meeting notes.",
			"",
		].join("\n");
		await evaluate(
			client,
			`(async () => {
				const dir = ${JSON.stringify(DEMO_DIR)};
				if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
				const path = ${JSON.stringify(NOTE)};
				const body = ${JSON.stringify(noteBody)};
				const existing = app.vault.getAbstractFileByPath(path);
				if (existing) await app.vault.modify(existing, body);
				else await app.vault.create(path, body);
				await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(path));
				return true;
			})()`
		);
		await delay(1500);

		// 光标落到末尾（粘贴点）＋ 收掉两侧边栏（演示只要正文；宿主自己会蹦出来，所以用样式钉住）
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				if (editor) {
					const line = editor.lineCount() - 1;
					editor.setCursor({ line, ch: editor.getLine(line).length });
					editor.focus?.();
				}
				if (!document.getElementById("acc-demo-clean")) {
					const st = document.createElement("style");
					st.id = "acc-demo-clean";
					st.textContent =
						".workspace-split.mod-left-split{display:none!important}" +
						".workspace-split.mod-right-split{display:none!important}" +
						".status-bar .status-bar-item.mod-clickable{display:none!important}" +
						// 旧动图（1.8.0）那一屏**没有标签栏**，顶部直接是面包屑 —— 复刻它，
						// 顺带把纵向空间让给正文（三件附件要挤进一屏）
						".workspace-tab-header-container{display:none!important}";
					document.head.appendChild(st);
				}
				return Boolean(editor);
			})()`
		);
		await delay(900);

		// 等宿主的通知自己消失（空库里只有"受限模式已关闭"之类的一两条）
		for (let i = 0; i < 20; i += 1) {
			const busy = await evaluate(client, `document.querySelectorAll(".notice-container .notice").length > 0`);
			if (!busy) break;
			await delay(400);
		}

		// ── 开录 ──
		const marks = [];
		const t0 = Date.now();
		let recording = true;
		const recorder = (async () => {
			while (recording) {
				const at = Date.now() - t0;
				try {
					const shot = await client.send("Page.captureScreenshot", { format: "png" });
					if (shot?.result?.data) {
						const name = `f${String(frames.length).padStart(4, "0")}.png`;
						writeFileSync(join(OUT, name), Buffer.from(shot.result.data, "base64"));
						frames.push({ file: name, at });
					}
				} catch (error) {
					log(`  （一帧没截到：${String(error?.message ?? error)}）`);
				}
				const spent = Date.now() - t0 - at;
				await delay(Math.max(0, FRAME_MS - spent));
			}
		})();
		/** 打一个字幕点。`sub` 是第二行（旧版是"英文 ＋ 中文"，这里照抄那个形状）。 */
		const mark = (label, sub) => marks.push({ at: Date.now() - t0, label, sub });

		// ⭐ 源码模式：三行都是裸 markdown，观众才看得见"链接被改写"这件事
		//（标题是宿主画的 inline title，所以源码模式下它照样是渲染后的样子）
		// ⚠️ 不能用 `app.vault.setConfig("livePreview", false)` —— 值变了，但编辑器**不重渲染**。
		const toggleSource = async () => {
			await evaluate(client, `(() => { app.commands.executeCommandById("editor:toggle-source"); return true; })()`);
			await delay(600);
		};
		await toggleSource();

		mark("Step 1 · Paste any file — a photo, a chart, a PDF", "第 1 步 · 粘贴任意附件：图片、图表、PDF 都行");
		await delay(1000);

		// ⚠️ 切模式之后光标回到文件开头 ⇒ 粘贴前必须重新落到末尾
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				if (!editor) return false;
				const line = editor.lineCount() - 1;
				editor.setCursor({ line, ch: editor.getLine(line).length });
				editor.focus?.();
				return true;
			})()`
		);
		await delay(200);

		// ── 一次性粘贴三件（走宿主事件；DOM 的合成 paste 载荷是空的）──
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				const info = app.workspace.activeEditor;
				const files = ${JSON.stringify(PASTE_FILES)};
				const dt = new DataTransfer();
				for (const f of files) {
					const bin = atob(f.base64);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					dt.items.add(new File([bytes], f.name, { type: f.type }));
				}
				app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
				return true;
			})()`
		);

		// ── 等三处链接都变成远端地址（判据取**公开前缀**，改域名时这里跟着走）──
		let rewritten = 0;
		for (let i = 0; i < 120; i += 1) {
			const text = await evaluate(
				client,
				`(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
					return f ? await app.vault.read(f) : "";
				})()`
			);
			rewritten = typeof text === "string" ? text.split(PUBLIC_BASE).length - 1 : 0;
			if (rewritten >= 3) break;
			await delay(150);
		}
		log(rewritten >= 3 ? "· 三件都上传完成（笔记里已是远端地址）" : `⚠️ 只有 ${rewritten}/3 变成远端地址（动图里会露馅）`);
		mark("Step 2 · Each one uploads to your storage, and the note keeps a link", "第 2 步 · 它们都上传到你的存储，笔记里各留一条链接");
		await delay(1600);

		mark("Step 3 · The file itself stays in your vault — it is the local copy", "第 3 步 · 文件本身留在库里，它就是本地副本");
		await delay(2000);

		// ── 停掉存储（界面不动，让观众盯着那三条链接）──
		mark("Step 4 · Your storage is now unreachable", "第 4 步 · 现在把你的存储整个停掉");
		await delay(300);
		await closeMock();
		log("· mock 存储已停掉");
		await delay(1200);

		// ── 切回实时预览：三件都渲染出来（图片 / PDF / 音频）──
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				if (editor) { editor.setCursor({ line: 0, ch: 0 }); editor.focus?.(); }
				return true;
			})()`
		);
		await toggleSource();
		// 视图沿用原来的滚动位置（光标在末尾 ⇒ 停在 PDF 那一屏）⇒ 拉回顶部。
		// ⚠️ 实时预览的滚动容器是 CodeMirror 的 `.cm-scroller`（不是阅读视图的
		// `.markdown-preview-view`）：两处都试一下，谁在就滚谁。
		await evaluate(
			client,
			`(() => {
				const view = app.workspace.activeLeaf?.view;
				view?.previewMode?.applyScroll?.(0);
				for (const sel of [".cm-scroller", ".markdown-preview-view", ".markdown-reading-view"]) {
					document.querySelector(sel)?.scrollTo?.({ top: 0 });
				}
				return true;
			})()`
		);
		await delay(600);
		// 排障用的一行：三件到底渲染出几个（音频最容易静默缺席）
		const rendered = await evaluate(
			client,
			`(async () => ({
				text: (await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}))).split("\\n").filter((l) => l.includes("![")).length,
				img: document.querySelectorAll(".markdown-preview-view img, .cm-content img, .internal-embed img").length,
				audio: document.querySelectorAll("audio, .internal-embed audio, .media-embed audio, .audio-embed").length,
				pdf: document.querySelectorAll(".pdf-embed, .internal-embed[src$='.pdf']").length,
				embeds: [...document.querySelectorAll(".internal-embed")].map((el) => el.className + "|" + (el.getAttribute("src") ?? "")),
				audioSrc: [...document.querySelectorAll("audio")].map((a) => ({
					src: String(a.currentSrc || a.src).slice(0, 90),
					ready: a.readyState,
					net: a.networkState,
					dur: Number.isFinite(a.duration) ? a.duration : null,
					h: a.getBoundingClientRect().height,
				})),
			}))()`
		);
		// ⚠️ 这是**守卫**不是日志：第 5 步的字幕说"三件都还在"，少一件就是假话。
		//（踩过的坑：`<audio>` 的原生控件不进 CDP 截图 —— 元素在、readyState=4，截出来一片白。）
		if (rendered?.text !== 3 || rendered?.pdf < 1 || rendered?.img < 2) {
			throw new Error(`第 5 步没把三件都画出来：${JSON.stringify(rendered)}`);
		}
		log(`· 第 5 步渲染齐全：${JSON.stringify(rendered.embeds)}`);
		mark("Step 5 · All three still render — with no network", "第 5 步 · 三者照常显示/播放，零网络请求");
		await delay(2600);

		recording = false;
		await recorder;

		const view = await evaluate(client, `({ w: window.innerWidth, h: window.innerHeight })`);
		writeFileSync(
			join(OUT, "timeline.json"),
			JSON.stringify({ width: view?.w ?? 0, height: view?.h ?? 0, frameMs: FRAME_MS, marks, frames }, null, "\t")
		);
		log(`· 共 ${frames.length} 帧（${view?.w}×${view?.h}）→ ${OUT}`);
	} finally {
		try {
			client?.close?.();
		} catch {}
		// 收尾顺序有讲究：先还原"库外"的状态（语言/登记/窗口），再删库
		try {
			if (client) {
				await evaluate(
					client,
					`(() => {
						localStorage.setItem("language", ${JSON.stringify(languageWas ?? "zh")});
						localStorage.removeItem("enable-plugin-" + ${JSON.stringify(appId)});
						return true;
					})()`
				).catch(() => {});
			}
		} catch {}
		try {
			child?.kill();
		} catch {}
		await closeMock();
		// ⚠️ 只删**我们那一行**，不回滚整个文件：回滚会把中间这段时间宿主自己写的
		// 变更一起抹掉；而且上一轮崩在半路时，备份里可能已经带着这条登记（越回滚越脏）。
		if (OBSIDIAN_JSON && existsSync(OBSIDIAN_JSON)) {
			try {
				const config = JSON.parse(readFileSync(OBSIDIAN_JSON, "utf8"));
				if (config.vaults?.[VAULT_NAME]) {
					delete config.vaults[VAULT_NAME];
					writeFileSync(OBSIDIAN_JSON, JSON.stringify(config));
				}
				if (obsidianBackup && existsSync(obsidianBackup)) rmSync(obsidianBackup, { force: true });
				log("· 临时库的登记已删掉");
			} catch {}
		}
		try {
			if (windowState) rmSync(windowState, { force: true });
		} catch {}
		try {
			rmSync(VAULT_DIR, { recursive: true, force: true });
			log("· 临时库已删除");
		} catch {}
	}
}

await main();
