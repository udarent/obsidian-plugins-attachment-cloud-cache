/**
 * 真机探针（**真实 MinIO，私有桶**）：链接可访问性三档里"仅内部"那条路。
 *
 * 与 `verify-link-access.mjs` 的分工：那个用本地 mock 造"匿名一律 403"，
 * 证明的是**判定与接线**；这个打的是用户真实的私有桶，证明的是
 * **匿名确实被拒、签名确实被服务端接受**这两件只有真服务端才能回答的事。
 *
 * 不写远端：只用**索引里已有的对象**（不新传、不删除云端任何东西）。
 * 会动本地：临时笔记一篇；某个副本删掉后会自动重新取回（净变化为零）。
 * 跑完还原 `data.json` 与 `.cache-index.json`。
 *
 * 用法：`node scripts/verify-real-private.mjs [--port 9235]`
 */

import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9235)
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
const NOTE = "_acc-real-private.md";
const BLANK = "_acc-real-blank.md";

const log = (line = "") => console.log(line);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: Boolean(ok) });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

async function snapshot(client, path, waitMs = 1200) {
	await evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf("tab");
			await leaf.openFile(file, { state: { mode: "preview" } });
			return true;
		})()`
	);
	await delay(waitMs);
	return evaluate(
		client,
		`(() => Array.from(document.querySelectorAll(".markdown-reading-view img, .markdown-preview-view img")).map((el) => el.getAttribute("src") ?? ""))()`
	);
}

async function rerender(client, path) {
	await evaluate(
		client,
		`(async () => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const leaf = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf("tab");
			const blank = app.vault.getAbstractFileByPath(${JSON.stringify(BLANK)}) ?? (await app.vault.create(${JSON.stringify(BLANK)}, "probe\\n"));
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
	if (others === null || others > 0) throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑（单实例锁）`);

	log("═".repeat(84));
	log("真机探针：真实 MinIO（私有桶）—— 匿名应被拒、签名应被接受");
	log("═".repeat(84));

	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = join(PLUGIN_DIR, `${name}.acc-real-backup`);
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

		const info = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const entries = plugin.currentIndex().toArray();
				const client = plugin.buildClient();
				// ⚠️ 索引可能记着**早被清掉的**对象（用户清过桶）：先 ask 服务端哪一条真的还在。
				// 拿一条不存在的对象去验"签名能不能用"，得到的 404 会被误读成"签名写错了"。
				let entry = null;
				for (const item of entries) {
					if (!item.remoteUrl || !item.cachePath) continue;
					try {
						const head = await client.headObject(item.key);
						if (head) {
							entry = { key: item.key, remoteUrl: item.remoteUrl, cachePath: item.cachePath, size: head.size ?? item.size };
							break;
						}
					} catch {
						// 单条问不通就试下一条
					}
				}
				return {
					endpoint: plugin.settings.s3.endpoint,
					bucket: plugin.settings.s3.bucket,
					original: JSON.parse(JSON.stringify(plugin.settings)),
					entry,
					count: entries.length,
					missing: entries.length - (entry ? 1 : 0),
				};
			})()`
		);
		log(`  存储：${info.endpoint} / ${info.bucket}（索引 ${info.count} 条）`);
		if (!info.entry) throw new Error("索引里没有任何**仍然存在**的对象 —— 这个探针刻意不新传对象，请先上传一张图再跑");

		const { key, remoteUrl, cachePath, size } = info.entry;
		log(`  对象：${key.slice(0, 48)}…（${size} 字节）`);
		log(`  本地副本：${cachePath}`);

		// ── ① 真实匿名可达性：应当 403 ──
		const anonymous = await fetch(remoteUrl, { method: "HEAD", signal: AbortSignal.timeout(15000) });
		check("① 匿名 HEAD 真的被拒（桶已是私有）", anonymous.status === 401 || anonymous.status === 403, `HTTP ${anonymous.status}`);

		// ── ② 插件自己的探测：应为 forbidden ──
		const probe = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				plugin.settings.linkAccess = "auto";
				plugin.settings.localCopy = "keep";
				plugin.settings.fallbackDownload = true;
				await plugin.saveSettings();
				return await plugin.refreshAccessProbe({ force: true });
			})()`
		);
		check("② 插件探测结论 = forbidden（auto 档据此走内部路径）", probe?.kind === "forbidden", JSON.stringify(probe));

		// ── ③ 缺副本的图：真机里用本地副本显示（app://）──
		await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				const text = "# real private probe\\n\\n![](" + ${JSON.stringify(remoteUrl)} + ")\\n";
				if (file) await app.vault.modify(file, text);
				else await app.vault.create(${JSON.stringify(NOTE)}, text);
				return true;
			})()`
		);
		let visible = false;
		let srcs1 = [];
		for (let i = 0; i < 20; i += 1) {
			srcs1 = await snapshot(client, NOTE, 600);
			if (srcs1.some((src) => src.startsWith("app://"))) {
				visible = true;
				break;
			}
			await delay(700);
		}
		check("③ 阅读视图里用本地副本显示（app://）", visible, JSON.stringify(srcs1.slice(0, 2)));

		// ── ④ 删掉副本 ⇒ 走**带签名**的 GET 重新取回 ──
		await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(cachePath)});
				if (file) await app.vault.delete(file, true);
				return true;
			})()`
		);
		let refetched = false;
		let lastBack = false;
		let lastSrcs = [];
		for (let i = 0; i < 12; i += 1) {
			await rerender(client, NOTE);
			const srcs = await snapshot(client, NOTE, 300);
			const back = await evaluate(
				client,
				`Boolean(app.vault.getAbstractFileByPath(${JSON.stringify(cachePath)}))`
			);
			lastBack = back;
			lastSrcs = srcs;
			if (back && srcs.some((src) => src.startsWith("app://"))) {
				refetched = true;
				break;
			}
		}
		if (!refetched) log(`  诊断：文件回来了=${lastBack}，src=${JSON.stringify(lastSrcs.slice(0, 2))}`);
		check("④ 副本删掉后被重新取回（签名 GET 打真实服务端）并换回 app://", refetched);

		// ── ⑤ 仅内部 + 不留副本 ⇒ 预签名地址，且**服务端认**它 ──
		//
		// ⚠️ 这里刻意换一条**带查询串**的地址：同一个对象、但索引里没有这条 URL。
		// 原因：判定先查索引，**有副本的 URL 永远走本地副本**（那是"已有的照用"）。
		// 带查询串 = "这台设备还没登记过的链接"，正是预签名那一档要覆盖的场景。
		const signedTestUrl = `${remoteUrl}?acc-probe=1`;
		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				// ⚠️ 不 saveSettings：那会触发切档询问与后台轮换，这里只要渲染判定读到新值
				plugin.settings.linkAccess = "private";
				plugin.settings.localCopy = "trash";
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				if (file) await app.vault.modify(file, "# real private probe\\n\\n![](" + ${JSON.stringify(signedTestUrl)} + ")\\n");
				return true;
			})()`
		);
		let signedSrc = "";
		for (let i = 0; i < 8; i += 1) {
			await rerender(client, NOTE);
			const srcs = await snapshot(client, NOTE, 400);
			signedSrc = srcs.find((src) => src.includes("X-Amz-Signature")) ?? "";
			if (signedSrc) break;
		}
		check("⑤ 仅内部 + 不留副本：img.src 是预签名地址", Boolean(signedSrc), signedSrc.slice(0, 110));

		if (signedSrc) {
			const signedResponse = await fetch(signedSrc, { signal: AbortSignal.timeout(20000) });
			const bytes = new Uint8Array(await signedResponse.arrayBuffer());
			check(
				"⑤ 预签名地址被真实服务端接受且字节数对得上",
				signedResponse.status === 200 && (size <= 0 || bytes.length === size),
				`HTTP ${signedResponse.status} / ${bytes.length} 字节（索引记 ${size}）`
			);
			check(
				"⑤ 同一条地址去掉签名后仍然是 403（一条地址两种命运）",
				(await fetch(remoteUrl, { method: "HEAD", signal: AbortSignal.timeout(15000) })).status === 403
			);
			// 载荷摘要那条最容易写错：在这里再核一遍 URL 里没有凭据
			check("⑤ 地址里不含凭据（没有 AccessKey / 秘密）", !/AccessKeyId=|acceskey/i.test(signedSrc) && !signedSrc.includes("X-Amz-Credential=undefined"));
		}

		// ── 收尾 ──
		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				plugin.settings = ${JSON.stringify(info.original)};
				await plugin.saveSettings();
				for (const path of ${JSON.stringify([NOTE, BLANK])}) {
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
	}

	const failed = results.filter((item) => !item.ok);
	log("");
	log("═".repeat(84));
	log(failed.length === 0 ? `✓ 真实私有桶真机验证通过（${results.length} 项）` : `✗ 未通过 ${failed.length} 项：${failed.map((f) => f.name).join(" ／ ")}`);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
