/**
 * 真机探针：链接可访问性三档 ＋ 三条显示路径（R21 / D-51 / D-52）。
 *
 * ## 它补的是哪几条**只有真机才能给**的证据
 *
 * 1. **私有语义（探测 403 ⇒ 内部路径）**：本地 mock 存储对匿名 HEAD 一律 403
 *    （与真私有桶同一个事实），插件应当把「缺副本的图」**强制取回**成本地副本并用 `app://` 显示；
 * 2. **副本被删之后真的会重新取回**（`fallbackDownload` 关掉时也是如此 —— 那条开关
 *    的语义是"省流量"，不是"宁可不看图"）；
 * 3. **仅内部 ＋ 不留副本 ⇒ 预签名地址**：`img.src` 带 `X-Amz-Signature`，
 *    而那个 URL 由**服务端独立重算签名**（mock 会按 SigV4 验），并逐字节取回同一份内容；
 * 4. **公开 ＋ 不留副本 ⇒ 直连**：音频/视频换成 `<video>` / `<audio>` 节点，
 *    `src` 就是笔记里那条地址（**不签名**）；
 * 5. **注入线**（`accessProbe` 真的传到了下载闸门）：公开 ＋ 关掉「自动下载」⇒
 *    删掉副本后**不该**再发 GET（若注错，`auto` 会退回"未知 ⇒ 私有"而强行下载）。
 *
 * ## 它会动什么（都在演示库上，跑完还原）
 *
 * - 备份并恢复 `data.json` / `.cache-index.json`；
 * - 在库里建 `_acc-la-*.md`，跑完删除；
 * - 远端只写本地 mock（`127.0.0.1`），**不碰用户的任何存储**。
 *
 * 用法：`node scripts/verify-link-access.mjs [--port 9222]`
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_VAULT_DIR / OBSIDIAN_DEBUG_WAIT
 */

import { crc32 } from "node:zlib";
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";

import { createMockS3 } from "./lib/mock-s3.mjs";
import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9233)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const VAULT = process.env.OBSIDIAN_VAULT ?? "ObsidianVault";
// ⚠️ 默认值是**仓库的同级目录**（`../ObsidianVault`），不写某台机器的绝对路径 ——
// 那种路径会随仓库一起公开，对别人也毫无用处。
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? resolve(REPO, "..", "ObsidianVault");
const PLUGIN_DIR = join(VAULT_DIR, ".obsidian", "plugins", "attachment-cloud-cache");
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);
const PLUGIN_ID = "attachment-cloud-cache";

const AK = "accprobe";
const SK = "acc-probe-secret-key-0123456789";
const SLOT = "acc-probe-secret";
const BUCKET = "probe";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (line = "") => console.log(line);

/** 造一张内容唯一的合法 PNG（在 IEND 前插 tEXt）。 */
function pngWithText(base, keyword, text) {
	const iendAt = base.length - 12;
	const data = Buffer.from(`${keyword}\0${text}`, "latin1");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write("tEXt", 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from("tEXt", "latin1"), data])) >>> 0, 8 + data.length);
	return Buffer.concat([base.subarray(0, iendAt), chunk, base.subarray(iendAt)]);
}

function loadBasePng(vaultDir) {
	for (const dir of [join(vaultDir, "attachments"), join(vaultDir, "attachments-cache")]) {
		let name = null;
		try {
			name = readdirSync(dir).find((file) => file.endsWith(".png")) ?? null;
		} catch {
			// 目录不存在就试下一个
		}
		if (name) return readFileSync(join(dir, name));
	}
	throw new Error(`找不到可作为底图的 PNG —— 试过 ${vaultDir}/attachments`);
}

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

/** 在页面里把设置改成这一组（并落盘）。 */
async function applySettings(client, patch) {
	return evaluate(
		client,
		`(async () => {
			const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
			Object.assign(plugin.settings, ${JSON.stringify(patch)});
			await plugin.saveSettings();
			return {
				linkAccess: plugin.settings.linkAccess,
				localCopy: plugin.settings.localCopy,
				fallbackDownload: plugin.settings.fallbackDownload,
			};
		})()`
	);
}

/** 建一篇干净笔记并打开；返回是否拿到编辑器。 */
async function openNote(client, path) {
	return evaluate(
		client,
		`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const leaf = app.workspace.getLeaf(true);
			// ⚠️ 先切走再动目标文件：删掉/改写"正在被编辑器打开的那篇"会让 activeEditor
			// 指向一个已不存在的文件，后续粘贴会写进幽灵编辑器（实测症状：上传静默不发生）。
			const blankPath = "_acc-probe-blank.md";
			const blank = app.vault.getAbstractFileByPath(blankPath) ?? (await app.vault.create(blankPath, "probe\\n"));
			await leaf.openFile(blank, { state: { mode: "source" } });
			await sleep(300);

			const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (existing) await app.vault.modify(existing, "# probe\\n\\n");
			else await app.vault.create(${JSON.stringify(path)}, "# probe\\n\\n");
			await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(path)}), { state: { mode: "source" } });
			for (let i = 0; i < 40; i += 1) {
				if (app.workspace.getActiveFile()?.path === ${JSON.stringify(path)} && app.workspace.activeEditor?.editor) return true;
				await sleep(250);
			}
			return { ok: false, activePath: app.workspace.getActiveFile()?.path ?? null, hasEditor: Boolean(app.workspace.activeEditor?.editor), leaves: app.workspace.getLeavesOfType("markdown").map((l) => l.view?.getViewType?.() ?? "?") };
		})()`
	);
}

async function openNoteOrThrow(client, path) {
	const result = await openNote(client, path);
	if (result !== true) throw new Error(`编辑器没有挂载（${path}）：${JSON.stringify(result)}`);
}

/** 触发宿主的 editor-paste（与真机同一条事件，见 editor-bridge 的说明）。 */
async function pasteFile(client, { name, type, bytes }) {
	return evaluate(
		client,
		`(async () => {
			const editor = app.workspace.activeEditor?.editor;
			const info = app.workspace.activeEditor;
			const bytes = new Uint8Array(${JSON.stringify(Array.from(bytes))});
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
			app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
			return true;
		})()`
	);
}

const readNote = (client, path) =>
	evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			return file ? await app.vault.read(file) : "";
		})()`
	);

/** 等笔记里出现一条地址；返回那条地址（拿不到返回空串）。 */
async function waitForLink(client, path, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	let text = "";
	while (Date.now() < deadline) {
		await delay(700);
		text = (await readNote(client, path)) ?? "";
		const match = text.match(/https?:\/\/\S+\)/);
		if (match) return match[0].replace(/\)$/, "");
	}
	return "";
}

/** 切到阅读视图并回读当前笔记里所有 `img` / `video` / `audio`。 */
async function readingSnapshot(client, path, waitMs = 1500) {
	await evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			const leaf = app.workspace.getLeaf(true);
			await leaf.openFile(file, { state: { mode: "preview" } });
			return true;
		})()`
	);
	await delay(waitMs);
	return evaluate(
		client,
		`(() => ({
			imgs: Array.from(document.querySelectorAll(".markdown-reading-view img, .markdown-preview-view img")).map((el) => el.getAttribute("src") ?? ""),
			videos: Array.from(document.querySelectorAll(".markdown-reading-view video, .markdown-preview-view video")).map((el) => el.getAttribute("src") ?? ""),
			audios: Array.from(document.querySelectorAll(".markdown-reading-view audio, .markdown-preview-view audio")).map((el) => el.getAttribute("src") ?? ""),
		}))()`
	);
}

/** 源文件 → 预览 来回一次，逼渲染钩子重跑。 */
async function rerender(client, path) {
	await evaluate(
		client,
		`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const leaf = app.workspace.getLeaf(true);
			// ⚠️ 必须真的换一次视图：对**同一个文件**再 openFile 不会重渲染
			//（"删了副本却没重新取回"那次就是这个假象）。
			const blank = app.vault.getAbstractFileByPath("_acc-probe-blank.md") ?? (await app.vault.create("_acc-probe-blank.md", "probe\\n"));
			await leaf.openFile(blank);
			await sleep(300);
			await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(path)}), { state: { mode: "preview" } });
			return true;
		})()`
	);
	await delay(1500);
}

async function main() {
	const others = await countObsidianProcesses();
	if (others === null || others > 0) {
		throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑 —— 单实例锁会让调试端口永远起不来。`);
	}

	const base = loadBasePng(VAULT_DIR);
	const stamp = Date.now();
	const pngPrivate = pngWithText(base, "ACC-PRIVATE", String(stamp));
	const pngSigned = pngWithText(base, "ACC-SIGNED", `${stamp}-2`);
	const pngPublic = pngWithText(base, "ACC-PUBLIC", `${stamp}-3`);
	// 假 mp4：内容不重要，宿主只看扩展名/类型决定节点（不看能否解码）
	const mp4 = Buffer.concat([Buffer.from("\0\0\0\x18ftypmp42", "latin1"), Buffer.alloc(64, 7)]);

	const mock = createMockS3({
		accessKeyId: AK,
		secretAccessKey: SK,
		region: "auto",
		bucket: BUCKET,
	});
	const endpoint = await mock.start();
	log("═".repeat(84));
	log("真机探针：链接可访问性（本地 mock 存储；不碰用户存储）");
	log("═".repeat(84));
	log(`  vault：${VAULT}（${VAULT_DIR}）`);
	log(`  mock：${endpoint}（匿名 HEAD 一律 403 ⇒ 等价于私有桶）`);

	// 备份会改动的两个文件（跑完原样恢复）
	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = join(PLUGIN_DIR, `${name}.acc-probe-backup`);
		copyFileSync(from, to);
		backups.push({ from, to });
	}

	const notes = ["_acc-la-private.md", "_acc-la-signed.md", "_acc-la-direct.md", "_acc-la-plain.md", "_acc-probe-blank.md"];
	const { client, child } = await launchAndAttach({
		exe: OBSIDIAN,
		port: PORT,
		vault: VAULT,
		waitSeconds: WAIT_SECONDS,
		log,
	});

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
		log("  ✓ 插件已加载");

		// ── 指向 mock 存储（凭据进钥匙串，与设置页同一条路）──
		const setup = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const original = JSON.parse(JSON.stringify(plugin.settings));
				app.secretStorage.setSecret(${JSON.stringify(SLOT)}, ${JSON.stringify(SK)});
				plugin.settings.s3 = {
					endpoint: ${JSON.stringify(endpoint)},
					region: "auto",
					bucket: ${JSON.stringify(BUCKET)},
					publicUrlBase: "",
					accessKeyId: ${JSON.stringify(AK)},
					secretAccessKeyRef: ${JSON.stringify(SLOT)},
					forcePathStyle: true,
				};
				plugin.settings.autoUpload = true;
				plugin.settings.localCopy = "keep";
				plugin.settings.fallbackDownload = true;
				plugin.settings.cacheLimitMb = 0;
				plugin.settings.linkAccess = "auto";
				await plugin.saveSettings();
				// 先塞一个"样本 key"，否则没有对象可探（探测刻意不自己造请求）
				return original;
			})()`
		);
		log("  ✓ 已指向 mock 存储（原设置已留存，跑完恢复）");

		// ── 第 1 步：私有语义 —— 探测 403 ⇒ 内部路径 ──
		await openNoteOrThrow(client, notes[0]);
		await pasteFile(client, { name: "acc-private.png", type: "image/png", bytes: pngPrivate });
		const link1 = await waitForLink(client, notes[0]);
		check("私有：图已上传并写进笔记", Boolean(link1), link1.slice(0, 80));
		const key1 = decodeURIComponent(link1.slice(link1.lastIndexOf("/") + 1));

		const probe = await evaluate(client, `(async () => (await app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].refreshAccessProbe({ force: true })))()`);
		check("私有：匿名探测结论 = forbidden（403）", probe?.kind === "forbidden", JSON.stringify(probe));

		// 索引里那条副本的路径（用于删除后验"重新取回"）
		const copyPath1 = await evaluate(
			client,
			`(() => {
				const entry = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex().get(${JSON.stringify(key1)});
				return entry?.cachePath ?? "";
			})()`
		);
		const snap1 = await readingSnapshot(client, notes[0]);
		check(
			"私有：阅读视图里用本地副本显示（app://）",
			snap1.imgs.some((src) => src.startsWith("app://")),
			JSON.stringify(snap1.imgs.slice(0, 2))
		);

		// ── 第 2 步：删掉副本 ⇒ 重新取回（fallbackDownload 仍开着）──
		await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(copyPath1)});
				if (file) await app.vault.delete(file, true);
				return true;
			})()`
		);
		const getsBefore = mock.requests.filter((r) => r.method === "GET" && r.key === key1).length;
		let refetched = false;
		for (let i = 0; i < 8; i += 1) {
			// 每次都真的换一次视图（同一个文件重复 open 不会重渲染 —— 这一条踩过）
			await rerender(client, notes[0]);
			const gets = mock.requests.filter((r) => r.method === "GET" && r.key === key1).length;
			const snap = await readingSnapshot(client, notes[0], 300);
			if (gets > getsBefore && snap.imgs.some((src) => src.startsWith("app://"))) {
				refetched = true;
				break;
			}
		}
		check(
			"私有：副本被删后重新取回（签名 GET）并换回 app://",
			refetched,
			`GET ${getsBefore} → ${mock.requests.filter((r) => r.method === "GET" && r.key === key1).length}`
		);

		// ── 第 3 步：仅内部 ＋ 不留副本 ⇒ 预签名地址 ──
		await applySettings(client, { linkAccess: "private", localCopy: "trash" });
		await openNoteOrThrow(client, notes[1]);
		await pasteFile(client, { name: "acc-signed.png", type: "image/png", bytes: pngSigned });
		const link2 = await waitForLink(client, notes[1]);
		check("仅内部+不留副本：图已上传", Boolean(link2), link2.slice(0, 80));
		const key2 = decodeURIComponent(link2.slice(link2.lastIndexOf("/") + 1));
		let signedSrc = "";
		for (let i = 0; i < 20; i += 1) {
			const snap = await readingSnapshot(client, notes[1], 400);
			signedSrc = snap.imgs.find((src) => src.includes("X-Amz-Signature")) ?? "";
			if (signedSrc) break;
			await rerender(client, notes[1]);
		}
		check("仅内部+不留副本：img.src 是预签名地址", Boolean(signedSrc), signedSrc.slice(0, 120));

		if (signedSrc) {
			const response = await fetch(signedSrc, { signal: AbortSignal.timeout(15000) });
			const bytes = new Uint8Array(await response.arrayBuffer());
			check(
				"预签名地址被服务端接受（独立重算签名）且字节一致",
				response.status === 200 && sha256(bytes) === sha256(pngSigned),
				`HTTP ${response.status} / ${bytes.length} 字节`
			);
		}
		const strayFiles = await evaluate(
			client,
			`(() => {
				const needle = ${JSON.stringify(key2)};
				if (!needle) return -1;
				const names = app.vault.getFiles().map((f) => f.path);
				return names.filter((p) => p.includes(needle)).length;
			})()`
		);
		check("仅内部+不留副本：库里没有落下这份文件", strayFiles === 0, `命中 ${strayFiles} 个`);

		// ── 第 4 步：公开 ＋ 不留副本 ⇒ 直连（音视频换节点、不签名）──
		await applySettings(client, { linkAccess: "public", localCopy: "trash" });
		await openNoteOrThrow(client, notes[2]);
		await pasteFile(client, { name: "acc-clip.mp4", type: "video/mp4", bytes: mp4 });
		const link3 = await waitForLink(client, notes[2]);
		check("公开+不留副本：视频已上传", Boolean(link3), link3.slice(0, 80));
		let videoSrc = "";
		for (let i = 0; i < 20; i += 1) {
			const snap = await readingSnapshot(client, notes[2], 400);
			videoSrc = snap.videos[0] ?? "";
			if (videoSrc) break;
			await rerender(client, notes[2]);
		}
		check(
			"公开+不留副本：视频换成 <video> 且用笔记里那条地址（不签名）",
			Boolean(videoSrc) && videoSrc.startsWith("http") && !videoSrc.includes("X-Amz-Signature"),
			videoSrc.slice(0, 120)
		);

		// ── 第 5 步：注入线 —— 公开 + 关掉自动下载 ⇒ 删了副本也不许联网取回 ──
		await applySettings(client, { linkAccess: "public", localCopy: "keep", fallbackDownload: false });
		await openNoteOrThrow(client, notes[3]);
		await pasteFile(client, { name: "acc-plain.png", type: "image/png", bytes: pngPublic });
		const link4 = await waitForLink(client, notes[3]);
		check("公开+保留副本：图已上传", Boolean(link4), link4.slice(0, 80));
		const key4 = decodeURIComponent(link4.slice(link4.lastIndexOf("/") + 1));
		const copyPath4 = await evaluate(
			client,
			`(() => {
				const entry = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex().get(${JSON.stringify(key4)});
				return entry?.cachePath ?? "";
			})()`
		);
		await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(copyPath4)});
				if (file) await app.vault.delete(file, true);
				return true;
			})()`
		);
		const signedGets = () => mock.requests.filter((r) => r.method === "GET" && r.key === key4 && Boolean(r.headers.authorization)).length;
		// ⚠️ 只数**带签名**的 GET：阅读视图里那张 <img> 自己也会去抓远端地址（无 Authorization），
		// 那是浏览器行为，不是插件在取字节 —— 混在一起会把这条判据变成永远红。
		const getsBefore4 = signedGets();
		await rerender(client, notes[3]);
		await delay(5000);
		const getsAfter4 = signedGets();
		check(
			"注入线：公开 + 关掉自动下载 ⇒ 删了副本也不发 GET（探测结论没被误当私有）",
			getsAfter4 === getsBefore4,
			`GET ${getsBefore4} → ${getsAfter4}`
		);

		// ── 收尾：恢复设置、删测试笔记 ──
		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const original = ${JSON.stringify(setup)};
				plugin.settings = original;
				await plugin.saveSettings();
				for (const path of ${JSON.stringify(notes)}) {
					const file = app.vault.getAbstractFileByPath(path);
					if (file) await app.vault.delete(file, true);
				}
				// 副本也清掉（keep 档下它们会留在附件目录里）
				for (const path of ${JSON.stringify([copyPath1, copyPath4].filter(Boolean))}) {
					const file = app.vault.getAbstractFileByPath(path);
					if (file) await app.vault.delete(file, true);
				}
				return true;
			})()`
		);
	} finally {
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
		await mock.close();
	}

	const failed = results.filter((item) => !item.ok);
	log("");
	log("═".repeat(84));
	log(failed.length === 0 ? `✓ 真机探针全部通过（${results.length} 项）` : `✗ 未通过 ${failed.length} 项：${failed.map((f) => f.name).join(" ／ ")}`);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
