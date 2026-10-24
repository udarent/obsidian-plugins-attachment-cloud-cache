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
 * ## 流程：**沿用 1.8.0 的版式与语气，内容换成 1.9.0 的核心功能**（六步、约 16 秒）
 *
 * 用户 2026-10-24：「按之前动图的风格，做新版本内容的动图……给用户展示核心功能」。
 * ⇒ 版式、节奏、两行字幕、源码模式演链接改写**一律照旧**（那套是用户认可的），
 * 只把中间那两步换成新东西：**唯一的命令 ＋ 附件管理弹窗**。
 *
 * | 步 | 演什么 | 为什么放在这儿 |
 * |---|---|---|
 * | 1 | 源码模式下一次性粘贴三件（照片 / 图表 / PDF） | 与旧版同一个开场：观众先看见"这是个笔记插件" |
 * | 2 | 三条链接当场变成 `https://cdn.example.com/…` | 插件的主承诺（附件进你自己的存储），在**源码**里最清楚 |
 * | 3 | 文件本身还在库里 —— 它就是本地副本 | 这一句是第 6 步"停存储仍显示"的伏笔 |
 * | 4 | 命令面板里**只剩一条**「Attachment manager」→ 打开它 | 1.9.0 最大的变化：旧的两条命令并进这一个弹窗 |
 * | 5 | 点筛选胶囊（件数跟着走）→ 勾两行（按钮数字跟着变、Rename 灰掉） | 一张表 ＋ 筛选 ＋ 批量动作，就是这次新加的全部能力 |
 * | 6 | 停掉存储 → 切回预览 ⇒ 三件照常渲染 | 收尾接回主承诺：上传了，但离线照样能用 |
 *
 * ⚠️ 第 5 步**只勾选、不执行**：执行会删掉本地副本（第 6 步就没得看了），
 * 而"数字＝真正能作用的件数"这件事，勾选时就已经看得见。
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
// ⚠️ 高度是**三件同屏**算出来的：照片 173 ＋ 图表 140 ＋ PDF 约 150 ＋ 标题区约 160 = 623
// ⇒ 620 会把 PDF 底边顶到正好贴着视口（实测 620/620）⇒ 给到 640。
const WINDOW = { x: 40, y: 24, width: 1080, height: 640 };

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
/**
 * 额外躺在库里、**既没上传也没被引用**的两个文件。
 *
 * ⭐ 它们只为第 5 步的筛选服务：没有它们，「Not uploaded」「To clean up」两个胶囊
 * 永远是 0，点下去清单是空的 —— 观众就看不到"筛选真的在筛"。
 * ⚠️ 文件名要像"人自己放进去的东西"（旧手稿、早期的说明），不能像测试夹具。
 */
const EXTRA_FILES = [
	{ name: "whiteboard.png", type: "image/png", path: "scripts/demo-assets/chart.png" },
	{ name: "old-handout.pdf", type: "application/pdf", path: "scripts/demo-assets/meeting-notes.pdf" },
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
	// ⚠️ 「命令面板」本身是核心插件：不列它，`command-palette:open` 这条命令**根本不存在**
	//（第 4 步要靠它在镜头前把"只剩一条"演出来）⇒ 2026-10-24 实测踩到，补上。
	writeFileSync(
		join(VAULT_DIR, ".obsidian/core-plugins.json"),
		JSON.stringify(["file-explorer", "global-search", "command-palette"])
	);
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
				// ⭐ 两个"没人引用、也没上传过"的文件（第 5 步的筛选要有东西可筛）
				for (const extra of ${JSON.stringify(EXTRA_FILES)}) {
					const extraPath = dir + "/" + extra.name;
					if (app.vault.getAbstractFileByPath(extraPath)) continue;
					const bin = atob(extra.base64);
					const bytes = new Uint8Array(bin.length);
					for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
					await app.vault.createBinary(extraPath, bytes.buffer);
				}
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
						".workspace-tab-header-container{display:none!important}" +
						// ⚠️ 光标闪烁是**录制噪声**：它每 500ms 变一次 ⇒ 每一帧都与上一帧不同，
						// 去重失效、GIF 白胖一倍（实测 148 帧只去重到 36）。观众不需要看见它。
						".cm-cursor,.cm-cursorLayer,.cm-dropCursor{display:none!important}" +
						"*{caret-color:transparent!important}" +
						// ⚠️ 只关浮层的过渡（弹窗淡入、命令面板、通知）。110ms 采样下这些动画
						// 只会产出半透明中间帧，既不好看又多几帧整屏变化。
						// ⚠️ 别用「全局关 transition」：实测会把 PDF 嵌入的高度计算一起弄坏
						// （PDF bottom 从 620 变成 1291）—— 那个容器的尺寸是过渡结束时才定下来的。
						".modal,.prompt,.notice,.menu{transition:none!important;animation:none!important}";
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
		await delay(800);

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
		await delay(1200);

		mark("Step 3 · The file itself stays in your vault — it is the local copy", "第 3 步 · 文件本身留在库里，它就是本地副本");
		await delay(1400);

		// ── 第 4 步：命令面板里**只剩一条**（1.9.0 把旧的两条并进了这个弹窗）──
		mark("Step 4 · One command for attachments — the attachment manager", "第 4 步 · 附件相关的只有一条命令：附件管理");
		await delay(500);
		await evaluate(client, `(() => { app.commands.executeCommandById("command-palette:open"); return true; })()`);
		/** 往命令面板里打字并读回结果（结果异步刷出 ⇒ 轮询到条数稳定）。 */
		const searchPalette = async (query) => {
			const typed = await evaluate(
				client,
				`(() => {
					const input = document.querySelector(".prompt-input");
					if (!input) return false;
					input.value = ${JSON.stringify(query)};
					input.dispatchEvent(new Event("input", { bubbles: true }));
					return true;
				})()`
			);
			if (!typed) return null;
			let last = { count: -1, items: [] };
			for (let i = 0; i < 28; i += 1) {
				await delay(110);
				const next = await evaluate(
					client,
					`(() => {
						const items = [...document.querySelectorAll(".prompt-results .suggestion-item")].map((el) => el.textContent.trim());
						return { count: items.length, items };
					})()`
				);
				if (next && next.count === last.count && next.count >= 0) return next;
				last = next ?? last;
			}
			return last;
		};

		// ⚠️ 搜什么词有讲究：搜 "attach" 会命中**宿主自带**的两条命令
		//（"Insert attachment" / "Download attachments for current file"）—— 那样
		// "就这一条"就成了假话（实测 3 条）。搜插件名只命中我们自己那一条。
		// ⚠️ 等输入框出现不能用固定时长（重载后第一次开会慢一拍），先轮询。
		for (let i = 0; i < 30; i += 1) {
			const ready = await evaluate(client, `Boolean(document.querySelector(".prompt-input"))`);
			if (ready) break;
			await delay(100);
		}
		let palette = null;
		let queryUsed = null;
		for (const query of ["cloud cache", "attachment manager"]) {
			const result = await searchPalette(query);
			if (result && result.count === 1 && /Attachment manager/.test(result.items[0] ?? "")) {
				palette = result;
				queryUsed = query;
				break;
			}
			palette = palette ?? result;
		}
		log(`· 命令面板搜 ${JSON.stringify(queryUsed)}：${JSON.stringify(palette)}`);
		// ⚠️ 守卫：字幕说"就这一条"，那搜索里就真的只能有一条，否则这句是假话
		if (!palette || palette.count !== 1) {
			throw new Error(`命令面板里应只剩一条（我们的那条），实际 ${palette?.count} 条：${JSON.stringify(palette?.items)}`);
		}
		await delay(800);
		// 点那一条（等于回车选中）：它自己收起面板并开出弹窗
		await evaluate(client, `(() => { document.querySelector(".prompt-results .suggestion-item")?.click(); return true; })()`);

		// 等弹窗**真的画出来**（节点存在 ≠ 看得见：还有一段 opacity 过渡）
		let opened = false;
		for (let i = 0; i < 60; i += 1) {
			const state = await evaluate(
				client,
				`(() => {
					const el = document.querySelector(".acc-gallery-modal .acc-gallery") ?? document.querySelector(".acc-gallery");
					if (!el) return { open: false };
					const opacity = Number(getComputedStyle(el.closest(".modal") ?? el).opacity);
					return {
						open: true,
						opacity,
						filters: document.querySelectorAll(".acc-gallery-filter").length,
						rows: document.querySelectorAll(".acc-task-row").length,
					};
				})()`
			);
			if (state?.open && state.opacity > 0.98 && state.filters === 6) {
				opened = true;
				log(`· 弹窗已打开：${state.filters} 个胶囊 / ${state.rows} 行`);
				break;
			}
			await delay(100);
		}
		if (!opened) throw new Error("附件管理弹窗没打开（或胶囊不是 6 个）");
		await delay(1100);

		// ── 第 5 步：筛选（件数跟着走）＋ 勾选（按钮数字跟着走）──
		mark("Step 5 · Filter chips carry their counts — tick rows to act", "第 5 步 · 胶囊上就是件数，勾两行试试批量");
		await delay(300);
		/** 点一个胶囊并等清单重画完（判据：行数变了且胶囊已按下）。 */
		const pickFilter = async (key) => {
			await evaluate(client, `(() => { document.querySelector('[data-filter="${key}"]')?.click(); return true; })()`);
			for (let i = 0; i < 30; i += 1) {
				const state = await evaluate(
					client,
					`(() => ({
						active: document.querySelector('[data-filter="${key}"]')?.getAttribute("aria-pressed") === "true",
						rows: document.querySelectorAll(".acc-task-row").length,
					}))()`
				);
				if (state?.active) return state.rows;
				await delay(100);
			}
			throw new Error(`筛选 ${key} 没生效`);
		};
		// 「Not uploaded」：那两个既没上传、也没被引用的文件
		const notUploadedRows = await pickFilter("not-uploaded");
		log(`· 「Not uploaded」→ ${notUploadedRows} 行`);
		if (notUploadedRows !== 2) throw new Error(`「Not uploaded」应有 2 行，实际 ${notUploadedRows}`);
		await delay(1000);

		// 勾前两行：按钮上的数字 = 真正能作用的件数，Rename 只支持单选 ⇒ 变灰
		// ⚠️ 就在「Not uploaded」里勾（不回切「Uploaded」）：勾两个没传过的 ⇒
		// 「Upload (2)」可点、Rename 灰 —— 同一句话的两种证据，还少一拍切换。
		await evaluate(
			client,
			`(() => {
				const boxes = [...document.querySelectorAll(".acc-task-check")];
				boxes[0]?.click();
				return true;
			})()`
		);
		await delay(400);
		await evaluate(
			client,
			`(() => {
				const boxes = [...document.querySelectorAll(".acc-task-check")];
				boxes[1]?.click();
				return true;
			})()`
		);
		await delay(1200);

		const footer = await evaluate(
			client,
			`(() => [...document.querySelectorAll(".acc-gallery .acc-task-actions button")].map((b) => ({
				text: (b.textContent ?? "").replace(/\\s+/g, " ").trim(),
				disabled: Boolean(b.disabled),
			})))()`
		);
		log(`· 勾两行之后：${JSON.stringify(footer)}`);
		const rename = (footer ?? []).find((button) => /Rename/.test(button.text));
		const upload = (footer ?? []).find((button) => /^Upload/.test(button.text));
		// ⚠️ 守卫：这两条正是"数字＝能作用的件数"的证据，画面与字幕都靠它们
		if (!rename?.disabled) throw new Error(`勾两行之后 Rename 应该灰掉：${JSON.stringify(footer)}`);
		if (!upload || upload.disabled || !/\(2\)/.test(upload.text)) {
			throw new Error(`勾两行之后「Upload」应该是 (2) 且可点：${JSON.stringify(footer)}`);
		}
		await delay(1100);

		// ── 第 6 步：关掉弹窗、停存储（界面回到笔记，让观众盯着那三条链接）──
		// ⚠️ 关闭**必须有兜底且必须校验**：只点右上角那颗 X 时它会静默失败
		//（2026-10-24 实测：弹窗一直盖在笔记上，最后一幕整段被挡住，而日志一切正常）。
		let closedBy = "none";
		for (const attempt of ["close-button", "footer-close", "escape"]) {
			closedBy = await evaluate(
				client,
				`(() => {
					const mode = ${JSON.stringify("__M__")}.replace("__M__", ${JSON.stringify(attempt)});
					const root = document.querySelector(".acc-gallery");
					if (!root) return "already-closed";
					if (mode === "close-button") {
						const button = document.querySelector(".acc-gallery-modal .modal-close-button") ?? document.querySelector(".modal-close-button");
						if (button) { button.click(); return "close-button"; }
						return "no-close-button";
					}
					if (mode === "footer-close") {
						const buttons = [...root.querySelectorAll(".acc-task-actions button")];
						const button = buttons[buttons.length - 1];
						if (button) { button.click(); return "footer-close"; }
						return "no-footer-button";
					}
					document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
					return "escape";
				})()`
			);
			for (let i = 0; i < 12; i += 1) {
				await delay(100);
				if (!(await evaluate(client, `Boolean(document.querySelector(".acc-gallery"))`))) break;
			}
			if (!(await evaluate(client, `Boolean(document.querySelector(".acc-gallery"))`))) break;
		}
		log(`· 关闭弹窗：${closedBy}`);
		// ⚠️ 守卫：弹窗还开着 ⇒ 后面三步全被挡住，动图就废了
		if (await evaluate(client, `Boolean(document.querySelector(".acc-gallery"))`)) {
			throw new Error(`弹窗关不掉（试过 ${closedBy}）—— 最后一幕会被挡住`);
		}
		await delay(400);

		// ⭐⭐ **顺序有讲究**（2026-10-24 重排）：先在**存储还活着时**切回预览、等三件真的画出来，
		// 再让存储下线。反过来（先停存储、再切视图）会在"存储下线"那句字幕上露出一帧
		// **PDF 破图 ＋ 半张照片**（切视图时 PDF 要重新加载、图片要重新解码，约 0.5s）——
		// 观众会读成"停存储把附件弄坏了"，而下一句又说"三者照常显示"。
		// 现在切视图那一下落在**上一句**（"勾两行"）的尾巴上，语义是"关窗后回到笔记"，读得通。
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				if (editor) { editor.setCursor({ line: 0, ch: 0 }); editor.focus?.(); }
				return true;
			})()`
		);
		await toggleSource();

		// ⚠️ **先滚一次顶部**再等 PDF：切视图时沿用编辑器的滚动位置（光标在末尾 ⇒ 停在 PDF 那一屏），
		// 不等就对，那半秒会停在"柱状图中段 + PDF 工具栏"（实测落到了上一句字幕下，很突兀）。
		// 这里只求"尽快把画面带到顶部"，校验留给下面那次（PDF 高度会变，位置还要再对一次）。
		await evaluate(
			client,
			`(() => {
				app.workspace.activeEditor?.editor?.scrollIntoView?.({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, true);
				for (const el of document.querySelectorAll(".cm-scroller, .markdown-preview-view, .markdown-reading-view")) {
					el.scrollTo?.({ top: 0 });
				}
				return true;
			})()`
		);
		await delay(150);

		// 等 PDF **真的画出来**（里面出现了 canvas/iframe，且高度正常）：
		// ⚠️ 只看高度会误判 —— 破图/占位时的盒子也可能很高。
		let pdfDrawn = false;
		for (let i = 0; i < 40; i += 1) {
			const height = await evaluate(
				client,
				`(() => {
					const pdf = document.querySelector(".pdf-embed");
					if (!pdf) return 0;
					const painted = pdf.querySelector("canvas, iframe, .pdf-container canvas") !== null;
					return painted ? Math.round(pdf.getBoundingClientRect().height) : 0;
				})()`
			);
			if (typeof height === "number" && height > 100) {
				pdfDrawn = true;
				break;
			}
			await delay(100);
		}
		if (!pdfDrawn) throw new Error("PDF 一直没画出来 —— 最后一幕会露破图");

		// 滚到顶部，**问到画面为止**（`scrollTop === 0` 会骗人：报 0 而画面停在柱状图中段）。
		// 判据：第一张图落在视口上部、PDF 底边也在视口内 —— 那才叫"三件都看得见"。
		// ⚠️ 图必须限定在**正文容器**里找：正文之外也有 img（侧栏图标、文件树缩略图）。
		let framed = false;
		let lastBox = null;
		for (let i = 0; i < 30; i += 1) {
			const box = await evaluate(
				client,
				`(() => {
					const editor = app.workspace.activeEditor?.editor;
					editor?.scrollIntoView?.({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, true);
					for (const el of document.querySelectorAll(".cm-scroller, .markdown-preview-view, .markdown-reading-view")) {
						el.scrollTo?.({ top: 0 });
					}
					const img = document.querySelector(".cm-content img") ?? document.querySelector(".markdown-preview-view img");
					const pdf = document.querySelector(".pdf-embed");
					if (!img) return null;
					return {
						imgTop: Math.round(img.getBoundingClientRect().top),
						pdfBottom: pdf ? Math.round(pdf.getBoundingClientRect().bottom) : null,
						view: window.innerHeight,
					};
				})()`
			);
			lastBox = box;
			// ⚠️ imgTop 在滚动进行中会偏大（实测同一帧先报 300、下一轮就正常），只当粗筛；
			// 真正的锚是 `pdfBottom < view`（三件同屏）＋ 人看那一帧。
			if (box && box.imgTop >= 0 && box.imgTop < 420 && (box.pdfBottom ?? 0) > 0 && box.pdfBottom < box.view) {
				framed = true;
				log(`· 最后一幕取景：图 top=${box.imgTop}｜PDF bottom=${box.pdfBottom}/${box.view}`);
				break;
			}
			await delay(120);
		}
		if (!framed) throw new Error(`最后一幕没把三件同时框进视野：${JSON.stringify(lastBox)}`);

		// 让画面稳住再换字幕（这一段还在上一句字幕下，观众看到的是"关窗后回到笔记"）
		await delay(800);

		// ── 第 6 步：存储下线 —— 画面此刻已是三件，之后**纹丝不动** ──
		// ⭐ 措辞用 **offline / 离线**，不用 "unreachable"（太技术），也不硬说"断网"：
		// 录制时做的确实是"把那台存储关掉"（`closeAllConnections()` + `close()` ⇒ 客户端连接被拒），
		// 对插件来说与断网**没有区别**，但整机网络并没有断 —— 说"我把你的网断了"就是假话。
		mark("Step 6 · Your storage goes offline", "第 6 步 · 把存储下线 —— 就当断网了");
		await delay(700);
		await closeMock();
		log("· mock 存储已停掉");
		await delay(1300);

		// ── 第 7 步：画面没动过 —— 因为渲染读的是库里那几份副本 ──
		mark(
			"Step 7 · All three still render — from the copies in your vault",
			"第 7 步 · 三者照常显示 —— 读的是库里的副本"
		);
		await delay(300);
		// 排障用的一行：三件到底渲染出几个（音频最容易静默缺席）
		const rendered = await evaluate(
			client,
			`(async () => ({
				text: (await app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}))).split("\\n").filter((l) => l.includes("![")).length,
				img: document.querySelectorAll(".markdown-preview-view img, .cm-content img, .internal-embed img").length,
				pdf: document.querySelectorAll(".pdf-embed, .internal-embed[src$='.pdf']").length,
				embeds: [...document.querySelectorAll(".internal-embed")].map((el) => el.className + "|" + (el.getAttribute("src") ?? "")),
			}))()`
		);
		// ⚠️ 这是**守卫**不是日志：第 7 步的字幕说"三件都还在"，少一件就是假话。
		if (rendered?.text !== 3 || rendered?.pdf < 1 || rendered?.img < 2) {
			throw new Error(`第 7 步没把三件都画出来：${JSON.stringify(rendered)}`);
		}
		log(`· 第 7 步渲染齐全：${JSON.stringify(rendered.embeds)}`);
		await delay(1600);

		recording = false;
		await recorder;

		const view = await evaluate(client, `({ w: window.innerWidth, h: window.innerHeight })`);
		writeFileSync(
			join(OUT, "timeline.json"),
			// ⚠️ `endedAt` 必须有：末尾那段"画面不动"的帧会被去重合并，
			// 合成端如果没有真正的结束时刻，就只能按"最后一帧 +1.2s"收尾 ⇒ **最后一句字幕整段被截掉**（实测）。
			JSON.stringify(
				{ width: view?.w ?? 0, height: view?.h ?? 0, frameMs: FRAME_MS, marks, frames, endedAt: Date.now() - t0 },
				null,
				"\t"
			)
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
