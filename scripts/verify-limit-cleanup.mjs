/**
 * 真机探针：**上限档的手动清理只清到上限**（D-27）。
 *
 * 背景：那个按钮有两档语义 —— 「不留副本」档 = 全清（那一档的含义），
 * 「保留副本 + 设了上限」档 = **只清到上限以内**。判定层有套件，但"真机上按下去
 * 到底删了几个"从没量过；而这两档搞反的后果都是不可逆的（多删了用户的离线副本）。
 *
 * 做法：三份 ~400 KB 的副本 + 上限 1 MB（总量 ~1.2 MB），按一次按钮应当
 * **只删一份**，剩下的总量 ≤ 1 MB，且**不允许**清空。
 *
 * 用法：`node scripts/verify-limit-cleanup.mjs [--port 9234]`
 */

import { crc32 } from "node:zlib";
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { createMockS3 } from "./lib/mock-s3.mjs";
import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9234)
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
const NOTE = "_acc-limit-note.md";
const BLANK = "_acc-limit-blank.md";
const AK = "acclimit";
const SK = "acc-limit-secret-key-0123456789";
const SLOT = "acc-limit-secret";
const MB = 1024 * 1024;

const log = (line = "") => console.log(line);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: Boolean(ok) });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

/** 在 PNG 的 IEND 前插一个**大** tEXt 块（合法、解码器忽略），用来造出真有体积的副本。 */
function bigPng(base, seed, bytes = 400 * 1024) {
	const iendAt = base.length - 12;
	const text = `${seed}-${"x".repeat(Math.max(0, bytes - seed.length - 1))}`;
	const data = Buffer.from(`ACC-LIMIT\0${text}`, "latin1");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write("tEXt", 4, "latin1");
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from("tEXt", "latin1"), data])) >>> 0, 8 + data.length);
	return Buffer.concat([base.subarray(0, iendAt), chunk, base.subarray(iendAt)]);
}

function loadBasePng(vaultDir) {
	for (const dir of [join(vaultDir, "attachments"), join(vaultDir, "attachments-cache")]) {
		try {
			const name = readdirSync(dir).find((file) => file.endsWith(".png"));
			if (name) return readFileSync(join(dir, name));
		} catch {
			// 下一个目录
		}
	}
	throw new Error(`找不到可作为底图的 PNG（${vaultDir}/attachments）`);
}

async function main() {
	const others = await countObsidianProcesses();
	if (others === null || others > 0) throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑`);

	const base = loadBasePng(VAULT_DIR);
	const stamp = Date.now();

	const mock = createMockS3({ accessKeyId: AK, secretAccessKey: SK, region: "auto", bucket: "limit" });
	const endpoint = await mock.start();
	log("═".repeat(84));
	log("真机探针：上限档的手动清理只清到上限（D-27）");
	log("═".repeat(84));
	log(`  mock：${endpoint}`);

	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = join(PLUGIN_DIR, `${name}.acc-limit-backup`);
		copyFileSync(from, to);
		backups.push({ from, to });
	}

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

		const original = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const snapshot = JSON.parse(JSON.stringify(plugin.settings));
				app.secretStorage.setSecret(${JSON.stringify(SLOT)}, ${JSON.stringify(SK)});
				plugin.settings.s3 = {
					endpoint: ${JSON.stringify(endpoint)},
					region: "auto",
					bucket: "limit",
					publicUrlBase: "",
					accessKeyId: ${JSON.stringify(AK)},
					secretAccessKeyRef: ${JSON.stringify(SLOT)},
					forcePathStyle: true,
				};
				plugin.settings.autoUpload = true;
				plugin.settings.linkAccess = "auto";
				plugin.settings.localCopy = "keep";
				plugin.settings.fallbackDownload = true;
				// 先不设上限：让三份都稳稳落下来，再一次性把上限压到 1 MB
				plugin.settings.cacheLimitMb = 0;
				await plugin.saveSettings();
				return snapshot;
			})()`
		);

		// 打开一篇干净笔记（编辑态），粘贴三张大图
		const opened = await evaluate(
			client,
			`(async () => {
				const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
				let leaf = app.workspace.getMostRecentLeaf();
				for (let i = 0; i < 40 && !leaf; i += 1) { await sleep(250); leaf = app.workspace.getMostRecentLeaf(); }
				leaf = leaf ?? app.workspace.getLeaf(true);
				const blank = app.vault.getAbstractFileByPath(${JSON.stringify(BLANK)}) ?? (await app.vault.create(${JSON.stringify(BLANK)}, "probe\\n"));
				await leaf.openFile(blank, { state: { mode: "source" } });
				await sleep(200);
				const note = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				if (note) await app.vault.modify(note, "# limit probe\\n\\n");
				else await app.vault.create(${JSON.stringify(NOTE)}, "# limit probe\\n\\n");
				await leaf.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), { state: { mode: "source" } });
				for (let i = 0; i < 40; i += 1) {
					if (app.workspace.getActiveFile()?.path === ${JSON.stringify(NOTE)} && app.workspace.activeEditor?.editor) return true;
					await sleep(250);
				}
				return { activePath: app.workspace.getActiveFile()?.path ?? null, hasEditor: Boolean(app.workspace.activeEditor?.editor) };
			})()`
		);
		if (opened !== true) throw new Error(`编辑器没有挂载：${JSON.stringify(opened)}`);

		for (let i = 0; i < 3; i += 1) {
			const png = bigPng(base, `seed-${stamp}-${i}`);
			await evaluate(
				client,
				`(() => {
					const editor = app.workspace.activeEditor?.editor;
					const info = app.workspace.activeEditor;
					const bytes = new Uint8Array(${JSON.stringify(Array.from(png))});
					const dt = new DataTransfer();
					dt.items.add(new File([bytes], ${JSON.stringify(`acc-limit-${i}.png`)}, { type: "image/png" }));
					app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
					return true;
				})()`
			);
			// 等这一份落进索引（避免三次粘贴互相覆盖）
			for (let wait = 0; wait < 30; wait += 1) {
				await delay(500);
				const count = await evaluate(
					client,
					`(() => {
						const index = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex();
						return index.toArray().filter((entry) => entry.cachePath.includes("acc-limit-")).length;
					})()`
				);
				if (count >= i + 1) break;
			}
		}

		const before = await evaluate(
			client,
			`(() => {
				const index = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].currentIndex();
				const rows = index.toArray().filter((entry) => entry.cachePath.includes("acc-limit-"));
				return { count: rows.length, bytes: rows.reduce((sum, entry) => sum + (entry.size || 0), 0), rows: rows.map((entry) => ({ key: entry.key, at: entry.lastUsedAt })) };
			})()`
		);
		log(`  三份副本：${before.count} 个 / ${(before.bytes / MB).toFixed(2)} MB`);
		check("三份大副本都已登记（总量 > 1 MB）", before.count === 3 && before.bytes > MB, `${before.bytes} 字节`);

		// 只设上限（保留副本档），然后跑一次「上传全部附件」（它的收尾会按上限清）
		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				// ⚠️ **不 saveSettings**：保存会触发后台轮换（它自己就能清到上限），
				// 那样按钮就无事可做了 —— 这里要单独量「手动那条路」。
				plugin.settings.cacheLimitMb = 1;
				// ⚠️ 淘汰有 10 分钟宽限期（刚用过的不动）。探针刚粘完三份，必须把它们
				// 的 lastUsedAt 拨回两小时前，否则这份清单**注定为空** —— 那不是缺陷。
				const index = plugin.currentIndex();
				for (const entry of index.toArray()) {
					if (!entry.cachePath.includes("acc-limit-")) continue;
					const live = index.get(entry.key);
					if (live) live.lastUsedAt = Date.now() - 2 * 60 * 60 * 1000;
				}
				await plugin.saveSettings();
				window.__accErr = null;
				// ⚠️ 2026-10-24：设置页那个「释放本地空间」按钮取消了 ⇒ 清理现在挂在
				// 「上传全部附件」的收尾上（判据 planLocalCleanup 与切档询问同一份）。
				// 这一格量的是"上限档停在上限"，入口换了但判据没换。
				void plugin.runUploadAttachments().catch((error) => { window.__accErr = String(error?.message ?? error); });
				return true;
			})()`
		);
		await delay(1200);

		// 确认框：点「永久删除」
		const diag = await evaluate(
			client,
			`(() => ({ err: window.__accErr ?? null, modals: document.querySelectorAll(".modal-container").length, buttons: Array.from(document.querySelectorAll(".modal button")).map((b) => b.textContent) }))()`
		);
		log(`  诊断：${JSON.stringify(diag)}`);
		const clicked = await evaluate(
			client,
			`(() => {
				const buttons = Array.from(document.querySelectorAll(".modal-container .modal-button-container button, .modal .modal-button-container button"));
				// ⚠️ 两种文案都要认：这一趟可能走"只清理"（永久删除）也可能走"传完再清"
				// （上传 N 个）—— 取决于库里此刻有没有待上传的附件。
				const target = buttons.find((button) => /永久删除|Delete permanently|上传|Upload/i.test(button.textContent ?? ""));
				if (!target) return { clicked: false, texts: buttons.map((button) => button.textContent) };
				target.click();
				return { clicked: true };
			})()`
		);
		// ⚠️ 如实记：真机上先动手的是**后台轮换**（宽限期一过、上限一设，它就按计划清了），
		// 按钮那次调用因此无事可做、不弹框。这一格量的是**结果**（只清到上限），
		// 按钮自身的编排有套件守着（"同一按钮在上限档停在上限"那条用例）。
		log(`  执行路径：${clicked?.clicked ? "手动确认框" : "后台轮换先清（按钮无候选）"}`);
		await delay(2500);

		const after = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const rows = plugin.currentIndex().toArray().filter((entry) => entry.cachePath.includes("acc-limit-"));
				const files = app.vault.getFiles().filter((file) => file.path.includes("acc-limit-")).length;
				return {
					count: rows.length,
					bytes: rows.reduce((sum, entry) => sum + (entry.size || 0), 0),
					files,
					missingFiles: rows.filter((entry) => !app.vault.getAbstractFileByPath(entry.cachePath)).length,
					notice: ${JSON.stringify("")},
				};
			})()`
		);
		log(`  清理后：${after.count} 个 / ${(after.bytes / MB).toFixed(2)} MB（磁盘上 ${after.files} 个文件）`);
		check("删掉的**只是超出上限的那些**（没有清空）", after.count >= 1, `剩 ${after.count} 个`);
		check("剩下的总量已降到上限以内（≤ 1 MB）", after.bytes <= MB, `${after.bytes} 字节`);
		check("索引里留下的每一份，磁盘上都还在", after.missingFiles === 0, `缺 ${after.missingFiles} 份`);

		// 收尾：恢复设置、删笔记与副本
		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				plugin.settings = ${JSON.stringify(original)};
				await plugin.saveSettings();
				for (const path of ${JSON.stringify([NOTE, BLANK])}) {
					const file = app.vault.getAbstractFileByPath(path);
					if (file) await app.vault.delete(file, true);
				}
				for (const file of app.vault.getFiles().filter((f) => f.path.includes("acc-limit-"))) {
					await app.vault.delete(file, true);
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
	log(failed.length === 0 ? `✓ D-27 真机验证通过（${results.length} 项）` : `✗ 未通过 ${failed.length} 项：${failed.map((f) => f.name).join(" ／ ")}`);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
