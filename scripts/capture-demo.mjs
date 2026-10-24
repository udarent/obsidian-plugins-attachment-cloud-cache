/**
 * 重建 README 的演示动图（`docs/demo.gif` 的原材料）。
 *
 * ## 它做什么
 *
 * 在**真实 Obsidian**（演示库）里走一遍主流程，**连续截图**，把每帧的时间戳与字幕分段写进
 * `demo-frames/timeline.json`；动图本身由 `capture-demo-gif.py` 合成（叠字幕 ＋ 调色板优化）。
 *
 * 流程（约 13 秒）：
 * 1. 打开一篇笔记，光标停在末尾；
 * 2. 粘贴一张图片 ⇒ 走**宿主**的 `editor-paste`（不是 DOM 事件，理由见 `verify-real-storage.mjs`）；
 * 3. 光标停在那一行 ⇒ 实时预览会把 markdown 源码摊开，能看见链接**从本地路径变成远端地址**；
 * 4. 光标下移，图片渲染出来；
 * 5. 打开「附件管理」，看一眼表格里的状态与引用；
 * 6. **把 mock 存储停掉**，重建视图 ⇒ 图片照常显示（渲染读的是本地副本）。
 *
 * ## 为什么用 mock S3 而不是真桶
 *
 * 演示动图要展示"传上去了"，而真桶会把演示图留在用户自己的存储里。mock 是本机 HTTP 服务，
 * 上传真的发生（PUT 有字节），但不出这台机器 ⇒ 可以放心跑，也可以反复跑。
 *
 * ## 会动什么
 *
 * - 只碰演示库（默认 `E:/svn/obsidian-plugins/ObsidianVault`，`ACC_DEMO_VAULT_DIR` 可改）里的
 *   `demo/` 目录：跑完删掉；`data.json` / `.cache-index.json` **先备份后写回**；
 * - 设置只在**内存**里改（`plugin.settings.s3` 指向 mock），不落盘。
 *
 * 用法：`node scripts/capture-demo.mjs [--port 9225]`
 * 之后：`<隔离 venv>/python scripts/capture-demo-gif.py`
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockS3 } from "./lib/mock-s3.mjs";
import { connect, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const VAULT_DIR = process.env.ACC_DEMO_VAULT_DIR ?? "E:/svn/obsidian-plugins/ObsidianVault";
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PORT = Number(
	process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 9225
);

/** 截图尺寸：与动图一致（不改窗口，只覆盖渲染区尺寸）。 */
const SHOT_W = 1080;
const SHOT_H = 648;
/** 每帧间隔（毫秒）。120ms ≈ 8.3fps，与旧动图（110 帧 / 12s）同档。 */
const FRAME_MS = 120;

const DEMO_DIR = "demo";
const NOTE = `${DEMO_DIR}/演示.md`;
const OUT = join(REPO, "demo-frames");

const log = (line = "") => console.log(line);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
	if (!existsSync(OBSIDIAN)) throw new Error(`找不到 Obsidian：${OBSIDIAN}`);
	if (!existsSync(join(VAULT_DIR, ".obsidian"))) throw new Error(`不是库：${VAULT_DIR}`);

	const dataJson = join(VAULT_DIR, ".obsidian/plugins/attachment-cloud-cache/data.json");
	const indexJson = join(VAULT_DIR, ".obsidian/plugins/attachment-cloud-cache/.cache-index.json");
	const backups = [
		[dataJson, `${dataJson}.demo-bak`],
		[indexJson, `${indexJson}.demo-bak`],
	];
	for (const [from, to] of backups) if (existsSync(from)) copyFileSync(from, to);

	// ⚠️ 演示库的**布局**（分屏、一堆标签）全在 `workspace.json` 里，而它不归插件管 ——
	// 录制时删掉它让宿主重建默认布局（单编辑区、侧栏收起），跑完再把备份写回去。
	const layoutJson = join(VAULT_DIR, ".obsidian/workspace.json");
	const layoutBackup = `${layoutJson}.demo-bak`;
	const layoutExisted = existsSync(layoutJson);
	if (layoutExisted) copyFileSync(layoutJson, layoutBackup);

	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(OUT, { recursive: true });

	const mock = createMockS3({
		accessKeyId: "acc-demo-key",
		secretAccessKey: "acc-demo-secret",
		bucket: "acc-demo-bucket",
	});
	const endpoint = await mock.start();
	/** `close()` 只能关一次（Node 的 server.close 第二次会给错误回调）；演示流程中途要"停存储"，所以包一层。 */
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

	try {
		if (layoutExisted) rmSync(layoutJson, { force: true });

		({ child } = await launchAndAttach({
			exe: OBSIDIAN,
			port: PORT,
			vault: "ObsidianVault",
			path: VAULT_DIR,
			waitSeconds: 90,
			log,
		}));
		client = await connect(PORT, { tries: 25, gapMs: 1000 });
		await client.send("Page.enable");
		// ⚠️ **不要**用 `Emulation.setDeviceMetricsOverride`：把渲染区设成 1080×648 而真实窗口是
		// 1024×800 时，宿主的布局按窗口算、截图按覆盖尺寸取 ⇒ 正文被挤在左半屏（实测）。
		// ⇒ 直接按**真实窗口**截，尺寸在合成动图那一步再统一缩放。

		// ── 准备：存储指向 mock（只在内存里）＋ 关掉会抢戏的开关 ──
		const ready = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins["attachment-cloud-cache"];
				if (!plugin) return { error: "插件没加载" };
				plugin.settings.s3 = {
					endpoint: ${JSON.stringify(endpoint)},
					region: "auto",
					bucket: "acc-demo-bucket",
					accessKeyId: "acc-demo-key",
					secretAccessKeyRef: "acc-demo-secret-ref",
					publicUrlBase: "",
					forcePathStyle: true,
				};
				try { app.secretStorage?.setSecret?.("acc-demo-secret-ref", "acc-demo-secret"); } catch {}
				plugin.settings.autoUpload = true;
				plugin.settings.localCopy = "keep";
				plugin.settings.externalImageCache = false;
				plugin.settings.uploadLocalFiles = false;
				return { ok: true };
			})()`
		);
		if (ready?.error) throw new Error(ready.error);

		// 关掉 inline title：文件名与 H1 会叠出两行大标题（画面脏），这不改内容、只改呈现
		const inlineTitleWas = await evaluate(client, `app.vault.getConfig("showInlineTitle")`);
		if (inlineTitleWas !== false) {
			await evaluate(
				client,
				`(() => { app.vault.setConfig("showInlineTitle", false); app.workspace.updateOptions?.(); return true; })()`
			);
		}

		// ── 造一篇干净的笔记并打开 ──
		const noteBody = [
			"# 附件存在你自己的存储里",
			"",
			"往笔记里粘贴一个文件 —— 它上传到**你自己的**存储，链接换掉，文件留在库里。",
			"",
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
				// ⚠️ 演示库里可能留着上次的分屏与一堆标签 —— 只留这一篇（否则画面右边是一块空白面板）
				const keep = path;
				app.workspace.iterateAllLeaves((leaf) => {
					const viewPath = leaf.view?.file?.path;
					const type = leaf.view?.getViewType?.();
					if (viewPath === keep) return;
					if (type === "markdown" || type === "empty" || type === "canvas") leaf.detach();
				});
				return true;
			})()`
		);
		await delay(1600);

		// 光标落到末尾（粘贴点）；同时收起左侧栏，让画面只剩正文
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				if (editor) {
					const line = editor.lineCount() - 1;
					editor.setCursor({ line, ch: editor.getLine(line).length });
					editor.focus?.();
				}
				app.workspace.leftSplit?.collapse?.();
				app.workspace.rightSplit?.collapse?.();
				// ⚠️ collapse() 在布局重建后会被覆盖回来（实测右栏仍占 ~400px；本行注释**不许**写反引号，
				// 它在模板串里会提前闭合字符串 —— 本项目第五次踩这个坑）。
				// 演示只要正文 —— 用一行样式把两侧收掉（纯呈现，不改任何数据）。
				if (!document.getElementById("acc-demo-clean")) {
					const st = document.createElement("style");
					st.id = "acc-demo-clean";
					st.textContent =
						".workspace-split.mod-left-split{display:none!important}" +
						".workspace-split.mod-right-split{display:none!important}";
					document.head.appendChild(st);
				}
				return Boolean(editor);
			})()`
		);
		await delay(900);

		// 等库里的加载失败提示自己消失（演示库里还装着别的插件，会弹两条红通知）
		for (let i = 0; i < 40; i += 1) {
			const busy = await evaluate(
				client,
				`document.querySelectorAll(".notice-container .notice").length > 0`
			);
			if (!busy) break;
			await delay(500);
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
		const mark = (label) => marks.push({ at: Date.now() - t0, label });

		// ⭐ 先切到**源码模式**：实时预览会把嵌入渲染成图，观众看不到"链接被换掉"这件事。
		// 源码模式下 `![](attachments/diagram.png)` 会当场变成 `![](https://…/key.png)`。
		// ⚠️ 不能用 `app.vault.setConfig("livePreview", false)` —— 值确实变了，但**编辑器不重渲染**
		//（实测：改完画面还是实时预览）。走命令 `editor:toggle-source`。
		const livePreviewWas = await evaluate(client, `app.vault.getConfig("livePreview")`);
		const toggleSource = async () => {
			await evaluate(
				client,
				`(() => { app.commands.executeCommandById("editor:toggle-source"); return true; })()`
			);
			await delay(700);
		};
		if (livePreviewWas !== false) await toggleSource();

		mark("一篇普通笔记");
		await delay(400);
		mark("粘贴一张图 —— 自动上传，链接换成你自己的存储地址");

		// ⚠️ `rebuildView()` 之后光标回到文件开头 ⇒ 粘贴前必须重新落到末尾
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
		await delay(250);

		// ── 粘贴（走宿主事件；DOM 的合成 paste 载荷是空的）──
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				const info = app.workspace.activeEditor;
				// 画一张 640×360 的图（渐变 + 两个几何块），不读用户任何文件
				const c = document.createElement("canvas");
				c.width = 640; c.height = 360;
				const g = c.getContext("2d");
				const grad = g.createLinearGradient(0, 0, 640, 360);
				grad.addColorStop(0, "#6b8afd");
				grad.addColorStop(1, "#a06bfd");
				g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
				g.fillStyle = "rgba(255,255,255,0.92)";
				g.fillRect(72, 96, 496, 24);
				g.fillRect(72, 148, 344, 16);
				g.fillRect(72, 184, 420, 16);
				g.fillStyle = "rgba(255,255,255,0.65)";
				g.beginPath(); g.arc(520, 268, 52, 0, Math.PI * 2); g.fill();
				const bin = atob(c.toDataURL("image/png").split(",")[1]);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const dt = new DataTransfer();
				dt.items.add(new File([bytes], "diagram.png", { type: "image/png" }));
				app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
				return true;
			})()`
		);

		// ── 等上传完成（笔记里出现远端地址），期间光标停在那一行 ⇒ 能看到链接变化 ──
		let uploaded = false;
		for (let i = 0; i < 90; i += 1) {
			const text = await evaluate(
				client,
				`(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
					return f ? await app.vault.read(f) : "";
				})()`
			);
			if (typeof text === "string" && text.includes("/acc-demo-bucket/")) {
				uploaded = true;
				break;
			}
			await delay(200);
		}
		log(uploaded ? "· 上传完成（笔记里已是远端地址）" : "⚠️ 等上传超时，动图里这一段会是本地链接");
		await delay(800);

		// ── 切回实时预览：图片渲染出来 ──
		await toggleSource();
		await delay(500);
		mark("文件留在库里，所以显示不联网");
		await delay(1000);
		mark("「附件管理」：状态与引用一目了然");

		// ── 打开附件管理 ──
		await evaluate(client, `(() => { app.commands.executeCommandById("attachment-cloud-cache:manage-attachments"); return true; })()`);
		for (let i = 0; i < 30; i += 1) {
			const open = await evaluate(client, `Boolean(document.querySelector(".acc-gallery"))`);
			if (open) break;
			await delay(200);
		}
		await delay(900);
		// 切到「已上传」：演示库里有几十个文件，不筛的话刚传的那一行根本不在前几行
		await evaluate(
			client,
			`(() => {
				const pills = Array.from(document.querySelectorAll(".acc-gallery-filter"));
				const hit = pills.find((el) => (el.textContent ?? "").includes("已上传"));
				hit?.click?.();
				return Boolean(hit);
			})()`
		);
		await delay(1600);
		// ⚠️ 弹窗根节点是 `.acc-gallery`（挂在 body 下），不是 `.acc-gallery-modal` ——
		// 按那个类名找关闭按钮会**静默失败**，于是最后一段"离线仍显示"被弹窗挡住（实测）。
		const closed = await evaluate(
			client,
			`(() => {
				const byClass = document.querySelector(".modal-close-button");
				if (byClass) { byClass.click(); return "close-button"; }
				const byText = Array.from(document.querySelectorAll("button")).find(
					(b) => (b.textContent ?? "").trim() === "关闭"
				);
				if (byText) { byText.click(); return "text"; }
				return "none";
			})()`
		);
		log(`· 关闭弹窗：${closed}`);
		await delay(600);
		const stillOpen = await evaluate(client, `Boolean(document.querySelector(".acc-gallery"))`);
		if (stillOpen) throw new Error("弹窗没关掉（录制会拍到一半弹窗，先修这个）");
		await delay(700);

		// ── 停掉存储，然后重建视图：图照常显示 ──
		mark("把存储停掉 —— 图片照常显示（渲染读本地副本）");
		await closeMock();
		log("· mock 存储已停掉");
		await evaluate(
			client,
			`(async () => {
				// ⚠️ 用**当前** leaf 重开（getLeaf(false)）：传 true 会新开一个标签，
				// 画面上于是出现两个同名标签（实测）。重建视图同样能证明"图不靠网络"。
				await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}));
				return true;
			})()`
		);
		await delay(2600);

		recording = false;
		await recorder;

		if (inlineTitleWas !== false) {
			await evaluate(
				client,
				`(() => { app.vault.setConfig("showInlineTitle", true); app.workspace.updateOptions?.(); return true; })()`
			).catch(() => {});
		}
		// 收尾：切回实时预览（源码模式是**视图状态**，跑完要还原，否则演示库下次打开是源码模式）
		if (livePreviewWas !== false) {
			await evaluate(client, `(() => { app.commands.executeCommandById("editor:toggle-source"); return true; })()`).catch(() => {});
		}

		const view = await evaluate(client, `({ w: window.innerWidth, h: window.innerHeight })`);
		writeFileSync(
			join(OUT, "timeline.json"),
			JSON.stringify({ width: view?.w ?? SHOT_W, height: view?.h ?? SHOT_H, frameMs: FRAME_MS, marks, frames }, null, "\t")
		);
		log(`· 共 ${frames.length} 帧 → ${OUT}`);
	} finally {
		try {
			client?.close?.();
		} catch {}
		try {
			child?.kill();
		} catch {}
		// 收尾：删掉演示笔记目录，还原两个状态文件
		try {
			rmSync(join(VAULT_DIR, DEMO_DIR), { recursive: true, force: true });
		} catch {}
		// ⚠️ 粘贴的图会落在库的附件目录里（宿主按自己的设置取名 `diagram.png` / `diagram 3.png`…），
		// 只删 `demo/` 会留下一堆 —— 每录一次多一张，演示库会越来越脏。
		try {
			const attachments = join(VAULT_DIR, "attachments");
			if (existsSync(attachments)) {
				for (const name of readdirSync(attachments)) {
					if (/^diagram( \d+)?\.png$/i.test(name)) rmSync(join(attachments, name), { force: true });
				}
			}
		} catch {}
		try {
			if (layoutExisted && existsSync(layoutBackup)) {
				copyFileSync(layoutBackup, layoutJson);
				rmSync(layoutBackup, { force: true });
			}
		} catch {}
		for (const [from, to] of backups) {
			if (existsSync(to)) {
				copyFileSync(to, from);
				rmSync(to, { force: true });
			}
		}
		await closeMock();
	}
}

await main();
