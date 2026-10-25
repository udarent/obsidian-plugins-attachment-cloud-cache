/**
 * 真机探针：**格式矩阵**（R15 / R6 / R21 的跨类型面）。
 *
 * ## 它回答什么
 *
 * 前面的探针只跑了 PNG 与"假 MP4"（看节点形状）。这一支把**每一族**都走一遍真实链路：
 * 粘贴 → 上传（真实 MinIO，私有桶）→ 本地副本 → 阅读视图里由宿主真的渲染出来。
 *
 * | 格式 | 期望 |
 * |---|---|
 * | `svg` / `webp` | `<img src="app://…">`，且 `naturalWidth > 0`（真解码） |
 * | `mp3` / `wav` | `<audio>` 成形，`duration > 0`（元数据真的读到了） |
 * | `mp4` / `webm` | `<video>` 成形，`readyState ≥ 1` 且 `videoWidth > 0` |
 * | `pdf` | 宿主的 pdf 嵌入容器存在（pdf.js 真的接上了） |
 * | `zip` | **普通链接**（不可嵌入 ⇒ 不该出现 `![]()`） |
 *
 * ## 素材从哪来（可复现）
 *
 * - 下载：mp3 / mp4 / webm / webp（MDN 与 gstatic 的公开样本）；
 * - 本地生成：wav（正弦波）、pdf（最小合法 PDF，xref 自己算）、svg、zip（python stdlib）。
 * 目录默认 `%TEMP%/acc-formats`，可用 `ACC_FORMATS_DIR` 覆盖；缺文件时脚本会**直接报错**，
 * 不会静默跳过 —— 少测一族却当全过，是这一支最该防的事。
 *
 * ## 它会写远端（并在收尾删掉）
 *
 * 上传是为了让"粘贴 → 上传 → 本地副本 → 渲染"这条真实链路跑起来。
 * 收尾时会用**同一份凭据**把这一轮新增的对象从桶里删掉，并删除本地副本与临时笔记；
 * 即使中途失败，`finally` 也会按"已经记下来的 key"尽力清理。
 *
 * 用法：`node scripts/verify-formats.mjs [--port 9237]`
 */

import { existsSync, readFileSync, statSync, copyFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9237)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const VAULT = process.env.OBSIDIAN_VAULT ?? "ObsidianVault";
// ⚠️ 默认值是**仓库的同级目录**（`../ObsidianVault`），不写某台机器的绝对路径 ——
// 那种路径会随仓库一起公开，对别人也毫无用处。
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? resolve(REPO, "..", "ObsidianVault");
const PLUGIN_DIR = join(VAULT_DIR, ".obsidian", "plugins", "attachment-cloud-cache");
const ASSET_DIR = process.env.ACC_FORMATS_DIR ?? join(tmpdir(), "acc-formats");
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);
const PLUGIN_ID = "attachment-cloud-cache";

const log = (line = "") => console.log(line);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: Boolean(ok) });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

/** 这一轮要跑的格式；`mode` 决定在阅读视图里看什么。 */
const CASES = [
	// 图片族：8 个可嵌入后缀全覆盖（png 已由另外三支探针覆盖，这里补齐其余 7 个中的 6 个）
	{ file: "icon.svg", mime: "image/svg+xml", kind: "image", label: "SVG", expect: "decode" },
	{ file: "1.webp", mime: "image/webp", kind: "image", label: "WebP", expect: "decode" },
	{ file: "160.jpg", mime: "image/jpeg", kind: "image", label: "JPEG", expect: "decode" },
	{ file: "pixel.gif", mime: "image/gif", kind: "image", label: "GIF", expect: "decode" },
	{ file: "pixel.bmp", mime: "image/bmp", kind: "image", label: "BMP", expect: "decode" },
	{ file: "fox.profile0.8bpc.yuv420.avif", mime: "image/avif", kind: "image", label: "AVIF", expect: "decode" },
	// 音频族：mp3 / wav / m4a / flac / ogg / oga / opus（后三个都是 Ogg 容器，样本来自 filesamples）
	{ file: "t-rex-roar.mp3", mime: "audio/mpeg", kind: "audio", label: "MP3", expect: "decode" },
	{ file: "sine.wav", mime: "audio/wav", kind: "audio", label: "WAV", expect: "decode" },
	{ file: "sample1.m4a", mime: "audio/mp4", kind: "audio", label: "M4A", expect: "decode" },
	{ file: "sample1.flac", mime: "audio/flac", kind: "audio", label: "FLAC", expect: "decode" },
	{ file: "sample1.ogg", mime: "audio/ogg", kind: "audio", label: "OGG", expect: "decode" },
	{ file: "sample1.oga", mime: "audio/ogg", kind: "audio", label: "OGA", expect: "decode" },
	{ file: "sample1.opus", mime: "audio/opus", kind: "audio", label: "OPUS", expect: "decode" },
	// 视频族：mp4 / webm 期望解码；mkv / mov / 3gp / ogv 只要求**节点成形**（解码能力是宿主的，不是我们的判定）
	{ file: "flower.mp4", mime: "video/mp4", kind: "video", label: "MP4", expect: "decode" },
	{ file: "flower.webm", mime: "video/webm", kind: "video", label: "WebM", expect: "decode" },
	{ file: "sample_640x360.mkv", mime: "video/x-matroska", kind: "video", label: "MKV", expect: "node" },
	{ file: "sample_640x360.mov", mime: "video/quicktime", kind: "video", label: "MOV", expect: "node" },
	{ file: "sample_640x360.3gp", mime: "video/3gpp", kind: "video", label: "3GP", expect: "node" },
	{ file: "sample_640x360.ogv", mime: "video/ogg", kind: "video", label: "OGV", expect: "node" },
	// 文档 / 其它附件
	{ file: "doc.pdf", mime: "application/pdf", kind: "pdf", label: "PDF", expect: "decode" },
	{ file: "sample.zip", mime: "application/zip", kind: "plain-link", label: "ZIP（不可嵌入）", expect: "n/a" },
];

function loadAssets() {
	const missing = CASES.filter((item) => !existsSync(join(ASSET_DIR, item.file)));
	if (missing.length > 0) {
		throw new Error(`素材缺失：${missing.map((item) => item.file).join(", ")}（目录 ${ASSET_DIR}）`);
	}
	return CASES.map((item) => ({ ...item, bytes: new Uint8Array(readFileSync(join(ASSET_DIR, item.file))), size: statSync(join(ASSET_DIR, item.file)).size }));
}

async function openNoteSource(client, path) {
	const opened = await evaluate(
		client,
		`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			// ⚠️ 探针自己开出来的空标签会越积越多（每次 getLeaf("tab") 一个），
			// 而"最近叶子"不等于"活动叶子" ⇒ activeEditor 拿到 null。先收掉空的。
			for (const extra of app.workspace.getLeavesOfType("markdown")) {
				if (!extra.view?.file) extra.detach();
			}
			await sleep(200);
			let leaf = app.workspace.getMostRecentLeaf();
			for (let i = 0; i < 40 && !leaf; i += 1) { await sleep(250); leaf = app.workspace.getMostRecentLeaf(); }
			leaf = leaf ?? app.workspace.getLeaf(true);
			const blankPath = "_acc-fmt-blank.md";
			const blank = app.vault.getAbstractFileByPath(blankPath) ?? (await app.vault.create(blankPath, "probe\\n"));
			await leaf.setViewState({ type: "markdown", state: { file: blankPath, mode: "source" } });
			await sleep(250);
			const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (existing) await app.vault.modify(existing, "# format probe\\n\\n");
			else await app.vault.create(${JSON.stringify(path)}, "# format probe\\n\\n");
			await leaf.setViewState({ type: "markdown", state: { file: ${JSON.stringify(path)}, mode: "source" } });
			// ⚠️ 工作区里有多个叶子时，"最近"不等于"活动"：显式设活动叶子，否则 activeEditor 会是 null。
			app.workspace.setActiveLeaf(leaf, { focus: true });
			for (let i = 0; i < 24; i += 1) {
				if (app.workspace.getActiveFile()?.path === ${JSON.stringify(path)} && app.workspace.activeEditor?.editor) return true;
				await sleep(200);
			}
			// ⚠️ 宿主的默认视图模式可能是阅读视图：此时切成编辑视图最稳的办法就是执行它自己的命令
			//（等价于用户按 Ctrl+E）。openFile/setViewState 的 mode 在个别状态下不生效。
			if (app.workspace.getActiveFile()?.path === ${JSON.stringify(path)} && !app.workspace.activeEditor?.editor) {
				app.commands.executeCommandById("markdown:toggle-preview");
				for (let i = 0; i < 24; i += 1) {
					if (app.workspace.activeEditor?.editor) return true;
					await sleep(200);
				}
			}
			return { activePath: app.workspace.getActiveFile()?.path ?? null, hasEditor: Boolean(app.workspace.activeEditor?.editor), mode: app.workspace.activeLeaf?.view?.getState?.()?.mode ?? null };
		})()`
	);
	if (opened !== true) throw new Error(`编辑器没有挂载（${path}）：${JSON.stringify(opened)}`);
	return true;
}

async function paste(client, asset) {
	await evaluate(
		client,
		`(() => {
			const editor = app.workspace.activeEditor?.editor;
			const info = app.workspace.activeEditor;
			const bytes = new Uint8Array(${JSON.stringify(Array.from(asset.bytes))});
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], ${JSON.stringify(asset.file)}, { type: ${JSON.stringify(asset.mime)} }));
			app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
			return true;
		})()`
	);
}

async function waitForNoteText(client, path, timeoutMs = 45000) {
	const deadline = Date.now() + timeoutMs;
	let text = "";
	while (Date.now() < deadline) {
		await delay(600);
		text = (await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
				return file ? await app.vault.read(file) : "";
			})()`
		)) ?? "";
		if (/https?:\/\//.test(text)) return text;
	}
	return text;
}

async function readingView(client, path) {
	await evaluate(
		client,
		`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf("tab");
			const blank = app.vault.getAbstractFileByPath("_acc-fmt-blank.md") ?? (await app.vault.create("_acc-fmt-blank.md", "probe\\n"));
			await leaf.openFile(blank);
			await sleep(350);
			await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(path)}), { state: { mode: "preview" } });
			for (let i = 0; i < 24; i += 1) {
				if (app.workspace.getActiveFile()?.path === ${JSON.stringify(path)}) return true;
				await sleep(250);
			}
			return false;
		})()`
	);
}

/** 等某个 DOM 判据成立（每 400 ms 一次，最多 `timeoutMs`）。 */
async function waitForDom(client, expression, timeoutMs = 12000) {
	const deadline = Date.now() + timeoutMs;
	let last = null;
	while (Date.now() < deadline) {
		last = await evaluate(client, expression);
		if (last && last.ok) return last;
		await delay(400);
	}
	return last ?? { ok: false, detail: "没有取到判据" };
}

async function main() {
	const others = await countObsidianProcesses();
	if (others === null || others > 0) throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑（单实例锁）`);

	const only = (process.env.ACC_FORMATS_ONLY ?? "").trim();
	const all = loadAssets();
	const assets = only ? all.filter((item) => only.split(",").some((needle) => item.file === needle.trim() || item.label === needle.trim())) : all;
	if (assets.length === 0) throw new Error(`ACC_FORMATS_ONLY=${only} 没有匹配任何用例`);
	log("═".repeat(84));
	log("真机探针：格式矩阵（真实 MinIO 私有桶；上传后收尾删除）");
	log("═".repeat(84));
	for (const asset of assets) log(`  素材 ${asset.label.padEnd(16)} ${asset.file.padEnd(18)} ${asset.size} 字节`);

	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = join(PLUGIN_DIR, `${name}.acc-fmt-backup`);
		copyFileSync(from, to);
		backups.push({ from, to });
	}

	/** 本轮**碰过**的 key（从笔记里的地址反推，不依赖索引 diff —— 复用那条路不会新增条目）。 */
	const touchedKeys = new Set();
	/** 跑之前桶里已经有的 key：这些**绝不删**（可能是用户自己的对象，只是内容相同被复用）。 */
	const preExistingKeys = new Set();
	const createdFiles = [];
	const notes = ["_acc-fmt-blank.md"];
	const { client, child } = await launchAndAttach({
		exe: OBSIDIAN,
		port: PORT,
		vault: VAULT,
		waitSeconds: WAIT_SECONDS,
		log,
	});

	let original = null;
	try {
		const loaded = await evaluate(
			client,
			`(async () => {
				for (let i = 0; i < 90; i += 1) {
					if (app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}]?._loaded) return true;
					await new Promise((r) => setTimeout(r, 500));
				}
				return false;
			})()`
		);
		if (!loaded) throw new Error("插件没有加载成功");

		const state = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const snapshot = JSON.parse(JSON.stringify(plugin.settings));
				plugin.settings.autoUpload = true;
				plugin.settings.linkAccess = "auto";
				plugin.settings.localCopy = "keep";
				plugin.settings.fallbackDownload = true;
				plugin.settings.cacheLimitMb = 0;
				await plugin.saveSettings();
				await plugin.refreshAccessProbe({ force: true });
				return { probe: plugin.currentAccessProbe(), original: snapshot, endpoint: plugin.settings.s3.endpoint, bucket: plugin.settings.s3.bucket };
			})()`
		);
		original = state.original;
		log(`  存储：${state.endpoint} / ${state.bucket}；探测=${JSON.stringify(state.probe)}`);
		const preKeys = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const client = plugin.buildClient();
				const out = await client.listObjects({ maxKeys: 1000 });
				return (out.objects ?? []).map((item) => item.key);
			})()`
		);
		for (const key of preKeys ?? []) preExistingKeys.add(key);
		log(`  桶里原有 ${preExistingKeys.size} 个对象（本轮只删"新建的"）`);
		if (state.probe?.kind !== "forbidden" && state.probe?.kind !== "ok") {
			log("  ⚠️ 探测没有结论（离线/未配）—— 下面的渲染结论可能不成立，请先确认网络");
		}

		for (const asset of assets) {
			const note = `_acc-fmt-${asset.file.replace(/[^a-z0-9]/gi, "-")}.md`;
			notes.push(note);
			log("");
			log(`── ${asset.label}（${asset.file}） ──`);
			// ⚠️ 真机上偶发"activePath 对了但 editor 没挂上"（叶子还停在预览态）——
			// 重开一次就好，不必把它当成产品缺陷。
			let openedNote = false;
			let openDetail = null;
			for (let attempt = 0; attempt < 3 && !openedNote; attempt += 1) {
				openDetail = await openNoteSource(client, note);
				openedNote = openDetail === true;
				if (!openedNote) await delay(600);
			}
			if (!openedNote) throw new Error(`编辑器没有挂载（${note}）：${JSON.stringify(openDetail)}`);
			const before = await evaluate(
				client,
				`(() => app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex().keys())()`
			);
			await paste(client, asset);
			const text = await waitForNoteText(client, note);
			const linked = /https?:\/\//.test(text);
			check(`${asset.label}：上传后写进了笔记`, linked, text.trim().slice(0, 90));

			const after = await evaluate(
				client,
				`(() => app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex().keys())()`
			);
			const newKeys = (after ?? []).filter((key) => !(before ?? []).includes(key));
			// ⚠️ 没有新 key 不等于失败：同内容会**复用**已有对象（内容寻址）——
			// 比如 .ogg 与 .oga 字节相同 ⇒ 第二次粘贴不会再进索引，链接指向同一个 key。
			// 这时按笔记里那条地址反查索引，仍然要求"有本地副本"。
			const urlInNote = (text.match(/https?:\/\/\S+?(?=\)|\s|$)/) ?? [""])[0] ?? "";
			const reusedEntry =
				!newKeys.length && urlInNote
					? await evaluate(
							client,
							`(() => {
								const entry = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex().toArray().find((item) => item.remoteUrl === ${JSON.stringify(urlInNote)});
								return entry ? { key: entry.key, cachePath: entry.cachePath, size: entry.size } : null;
							})()`
						)
					: null;
			const entry = newKeys.length
				? await evaluate(
						client,
						`(() => {
							const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
							const entry = plugin.currentIndex().get(${JSON.stringify(newKeys[0])});
							return entry ? { key: entry.key, cachePath: entry.cachePath, size: entry.size } : null;
						})()`
					)
				: reusedEntry;
			if (entry?.cachePath) createdFiles.push(entry.cachePath);
			const keyFromNote = (() => {
				const match = text.match(/https?:\/\/\S+?(?=\)|\s|$)/);
				if (!match) return "";
				const last = match[0].split("/").pop() ?? "";
				try {
					return decodeURIComponent(last);
				} catch {
					return last;
				}
			})();
			if (keyFromNote) touchedKeys.add(keyFromNote);
			check(`${asset.label}：登记进索引（有本地副本）`, Boolean(entry?.cachePath), entry?.cachePath ?? "无");

			await readingView(client, note);

			if (asset.kind === "image") {
				let dom = { ok: false };
				for (let attempt = 0; attempt < 6; attempt += 1) {
					dom = await waitForDom(
						client,
						`(() => {
							const imgs = Array.from(document.querySelectorAll(".markdown-reading-view img, .markdown-preview-view img"));
							const hit = imgs.find((img) => (img.getAttribute("src") ?? "").startsWith("app://"));
							return { ok: Boolean(hit) && hit.naturalWidth > 0, detail: hit ? { w: hit.naturalWidth, h: hit.naturalHeight, src: hit.getAttribute("src").slice(0, 40) } : { imgs: imgs.length, active: app.workspace.getActiveFile()?.path ?? null } };
						})()`,
						4000
					);
					if (dom?.ok) break;
					// 预览偶尔会没画出来（量到 imgs:0）：重开一次比空等有效
					await readingView(client, note);
				}
				check(`${asset.label}：宿主真的解码了（app:// + naturalWidth>0）`, dom.ok, JSON.stringify(dom.detail));
			} else if (asset.kind === "audio") {
				const dom = await waitForDom(
					client,
					`(() => {
						const el = document.querySelector(".markdown-reading-view audio, .markdown-preview-view audio");
						if (!el) return { ok: false, detail: "没有 <audio>" };
						if (el.readyState < 1) { try { el.preload = "auto"; el.load(); } catch {} }
						const duration = Number.isFinite(el.duration) ? el.duration : 0;
						return { ok: el.readyState >= 1 && duration > 0, detail: { readyState: el.readyState, duration, src: (el.getAttribute("src") ?? "").slice(0, 40) } };
					})()`,
					15000
				);
				if (asset.expect === "decode") {
					check(`${asset.label}：<audio> 读到元数据（duration>0）`, dom.ok, JSON.stringify(dom.detail));
				} else {
					const nodeOnly = await waitForDom(client, `(() => ({ ok: Boolean(document.querySelector(".markdown-reading-view audio, .markdown-preview-view audio")), detail: "节点" }))()`, 8000);
					check(`${asset.label}：<audio> 节点成形`, nodeOnly.ok, JSON.stringify(dom.detail));
				}
			} else if (asset.kind === "video") {
				const dom = await waitForDom(
					client,
					`(() => {
						const el = document.querySelector(".markdown-reading-view video, .markdown-preview-view video");
						if (!el) return { ok: false, detail: "没有 <video>" };
						if (el.readyState < 1) { try { el.preload = "auto"; el.load(); } catch {} }
						return { ok: el.readyState >= 1 && el.videoWidth > 0, detail: { readyState: el.readyState, w: el.videoWidth, h: el.videoHeight, src: (el.getAttribute("src") ?? "").slice(0, 40) } };
					})()`,
					20000
				);
				if (asset.expect === "decode") {
					check(`${asset.label}：<video> 读到元数据（videoWidth>0）`, dom.ok, JSON.stringify(dom.detail));
				} else {
					// 只要求**有可播放节点**；具体是 <video> 还是 <audio>、能不能解码，如实打出来。
					// ⚠️ 3gp 是个例子：可嵌入表把它归成 audio（不是 video），所以这里不该只找 <video> ——
					// 那会把"归错类"误报成"节点没造出来"。
					const node = await waitForDom(client, `(() => {
						const el = document.querySelector(".markdown-reading-view video, .markdown-preview-view video, .markdown-reading-view audio, .markdown-preview-view audio");
						if (!el) return { ok: false, detail: "没有 audio/video 节点" };
						return { ok: true, detail: { tag: el.tagName.toLowerCase(), readyState: el.readyState, w: el.videoWidth ?? null, err: el.error ? el.error.code : null } };
					})()`, 15000);
					check(`${asset.label}：可播放节点成形`, node.ok, JSON.stringify(node.detail));
					log(`     ⓘ ${asset.label} 节点与解码状态（宿主能力）：${JSON.stringify(node.detail)}`);
				}
			} else if (asset.kind === "pdf") {
				const dom = await waitForDom(
					client,
					`(() => {
						const hit = document.querySelector(".markdown-reading-view .pdf-embed, .markdown-reading-view .pdf-container, .markdown-reading-view .internal-embed[src$='.pdf'], .markdown-reading-view canvas");
						return { ok: Boolean(hit), detail: hit ? hit.className || hit.tagName : "没有 pdf 容器" };
					})()`,
					20000
				);
				check(`${asset.label}：宿主的 pdf 嵌入容器存在`, dom.ok, JSON.stringify(dom.detail));
			} else {
				// 不可嵌入：应当写成**普通链接**（不该出现 `![](`）
				check(`${asset.label}：写成的是普通链接而不是嵌入`, !/!\[/.test(text) && /\[[^\]]*\]\(https?:/.test(text), text.trim().slice(0, 90));
			}
		}
	} finally {
		// 收尾：先删云端新增对象（尽力而为），再删本地副本与笔记
		try {
			const toDelete = [...touchedKeys].filter((key) => !preExistingKeys.has(key));
			if (toDelete.length > 0) {
				const cleanup = await evaluate(
					client,
					`(async () => {
						const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
						const client = plugin.buildClient();
						const out = { deleted: [], failed: [] };
						for (const key of ${JSON.stringify(toDelete)}) {
							try {
								await client.deleteObject(key);
								out.deleted.push(key);
							} catch (error) {
								out.failed.push({ key, error: String(error?.message ?? error) });
							}
						}
						return out;
					})()`
				);
				log("");
				log(`  清理远端：删除 ${cleanup?.deleted?.length ?? 0} 个对象${cleanup?.failed?.length ? `，失败 ${cleanup.failed.length} 个` : ""}`);
				if (cleanup?.failed?.length) log(`  ⚠️ ${JSON.stringify(cleanup.failed.slice(0, 3))}`);
			}
			await evaluate(
				client,
				`(async () => {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					// 关掉没有文件的空叶子（探针 getLeaf("tab") 开出来的），保留用户自己的标签
					for (const leaf of app.workspace.getLeavesOfType("markdown")) {
						if (!leaf.view?.file) leaf.detach();
					}
					if (${JSON.stringify(original !== null)}) { plugin.settings = ${JSON.stringify(original ?? {})}; await plugin.saveSettings(); }
					for (const path of ${JSON.stringify([...notes, ...createdFiles])}) {
						const file = app.vault.getAbstractFileByPath(path);
						if (file) await app.vault.delete(file, true);
					}
					return true;
				})()`
			);
		} catch (error) {
			log(`  ⚠️ 收尾失败：${error.message}`);
		}
		try {
			client?.close();
		} catch {
			// 尽力而为
		}
		try {
			child.kill();
		} catch {
			// 已经退了
		}
		await delay(2500);
		for (const { from, to } of backups) {
			try {
				copyFileSync(to, from);
				unlinkSync(to);
			} catch (error) {
				log(`  ⚠️ 恢复 ${from} 失败：${error.message}`);
			}
		}
	}

	const failed = results.filter((item) => !item.ok);
	log("");
	log("═".repeat(84));
	log(failed.length === 0 ? `✓ 格式矩阵真机通过（${results.length} 项）` : `✗ 未通过 ${failed.length} 项：${failed.map((f) => f.name).join(" ／ ")}`);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
