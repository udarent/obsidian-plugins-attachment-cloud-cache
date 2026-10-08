/**
 * 真实服务商上的**上传 / 下载回环**验证。
 *
 * ## 它验证什么（三层独立取证，而不是只看插件自己报的成功）
 *
 * 1. **链路**：在真机上触发一次真实的 `editor-paste` 事件 → 插件走完
 *    判定 → 上传 → 本地副本 → 插入链接 → 渲染；
 * 2. **key 由脚本自己算**：默认模板 `{hash}.{ext}` 下，key = sha256(内容) + 扩展名。
 *    所以脚本**预计算**期望的 key，再去问"插件写进笔记的是不是这个" ——
 *    拿插件自己的输出当判据等于自证（`hash-suite.mjs` 用 `node:crypto` 当 oracle 是同一个道理）。
 *    这一条同时钉住了"模板设置真的被应用了"；
 * 3. **桶侧**：匿名 GET 那个链接 → 与**本地副本**、与**上传的字节**三方比对。
 *    ⚠️ 必须匿名 —— 带上凭据去请求就等于拿"我能打开"冒充"**别人**能打开"。
 *
 * ## 为什么要在真机上做，而不是用 `withLoadedTs` 直接调客户端
 *
 * `ingestAttachment` 是模块级函数、插件没有对外暴露上传入口（只有 `sampleObjectKey()`）；
 * 上传只能由粘贴/拖拽触发。而凭据在宿主的 `secretStorage` 里（落盘在 Obsidian 的
 * LevelDB），脚本**不该**去挖它 —— 让宿主自己交出来才干净。
 *
 * ## 为什么不能只在 DOM 上 dispatch 一个 paste
 *
 * 插件用的是宿主的 `workspace.on("editor-paste")`（见 `src/host/editor-bridge.ts`
 * 的头注释），那是 Obsidian 在处理完 DOM 粘贴后转发的**带类型事件**。
 * 所以这里直接 `app.workspace.trigger("editor-paste", …)` ——
 * 模拟的是**宿主事件**，不是真剪贴板。这一点在报告里如实写出。
 *
 * ## ⚠️ 它会**写远端**
 *
 * 每次运行都会往你的桶里上传一个对象（合法 PNG，内容含时间戳所以唯一），
 * 并在 vault 里留下 `_acc-realcheck.md` 与缓存副本。脚本**不自动清理** ——
 * 末尾会打印 key，自行决定是否删除。
 *
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_DEBUG_PORT / OBSIDIAN_DEBUG_WAIT
 *          OBSIDIAN_VAULT_DIR（vault 的绝对路径；用于在 Node 侧读本地副本）
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { crc32 } from "node:zlib";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9333)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const VAULT = process.env.OBSIDIAN_VAULT ?? "TestVault";
/** 测试笔记：用完留在 vault 里（用户可能想点开看那张图），脚本不自动删。 */
const NOTE = "_acc-realcheck.md";
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 60);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (line = "") => console.log(line);

/**
 * 造一张**合法且内容唯一**的 PNG：在 IEND 之前插一个 `tEXt` 块。
 *
 * 为什么不直接用 vault 里已有的图：那些内容已经在索引里，贴上去会**命中缓存直接跳过**，
 * 那就不是在上传了。`tEXt` 是合法 PNG 的辅助块（解码器会忽略它），
 * 里面放时间戳 ⇒ 每次内容都不同 ⇒ 一定走真实上传。
 *
 * IEND 是最后一个 chunk：length(4) + type(4) + crc(4) = 12 字节。
 */
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

/** 从 vault 里取一张真 PNG 当底图（两处都试，都拿不到就报错 —— 不退回假字节）。 */
function loadBasePng(vaultDir) {
	for (const dir of [join(vaultDir, "attachments"), join(vaultDir, "attachments-cache")]) {
		let name = null;
		try {
			name = readdirSync(dir).find((f) => f.endsWith(".png")) ?? null;
		} catch {
			// 目录不存在就试下一个
		}
		if (name) return readFileSync(join(dir, name));
	}
	throw new Error(`找不到可作为底图的 PNG —— 试过 ${vaultDir}/attachments 与 attachments-cache`);
}

async function main() {
	const vaultDir = process.env.OBSIDIAN_VAULT_DIR ?? join(process.cwd(), "..", VAULT);

	const others = await countObsidianProcesses();
	if (others === null || others > 0) {
		throw new Error(
			`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑 —— 单实例锁会让调试端口永远起不来，先关掉它们。`
		);
	}

	// 造图 + **自己**算 key（不问插件）
	const base = loadBasePng(vaultDir);
	const stamp = new Date().toISOString();
	const png = pngWithText(base, "ACC-Verify", stamp);
	const expectedKey = `${sha256(png)}.png`;

	log("═".repeat(84));
	log("真实存储回环验证（会在你的桶里上传一个对象）");
	log("═".repeat(84));
	log(`  vault：${VAULT}（${vaultDir}）`);
	log(`  测试图：${png.length} 字节（底图 ${base.length} + tEXt "${stamp}"）`);
	log(`  预计算的 key：${expectedKey}`);

	const { client, child } = await launchAndAttach({
		exe: OBSIDIAN,
		port: PORT,
		vault: VAULT,
		waitSeconds: WAIT_SECONDS,
		log,
	});

	let failed = false;
	// ⚠️ 声明在 try **之外**：Node 侧的匿名复核要用它 —— 写在 try 里出了块就没了
	let noteText = "";
	try {
		const loaded = await evaluate(
			client,
			`(async () => {
				for (let i = 0; i < 60; i += 1) {
					if (app?.plugins?.plugins?.["attachment-cloud-cache"]?._loaded) return true;
					await new Promise((r) => setTimeout(r, 500));
				}
				return false;
			})()`
		);
		if (!loaded) throw new Error("插件没有加载成功");
		log("  ✓ 插件已加载");

		// ── 准备一个干净的测试笔记并打开（编辑器必须挂载，否则没有 activeEditor）──
		await evaluate(
			client,
			`(async () => {
				const path = ${JSON.stringify(NOTE)};
				const existing = app.vault.getAbstractFileByPath(path);
				if (existing) await app.vault.delete(existing, true);
				await app.vault.create(path, "# 真实上传验证\\n\\n");
				await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(path));
				return true;
			})()`
		);
		await delay(1500);
		if (!(await evaluate(client, `Boolean(app.workspace.activeEditor?.editor)`))) {
			throw new Error("编辑器没有挂载（activeEditor.editor 不可用）");
		}
		log(`  ✓ 测试笔记已打开：${NOTE}`);

		// ── 触发**宿主**的编辑器粘贴事件（不是 DOM 事件，理由见文件头）──
		await evaluate(
			client,
			`(() => {
				const editor = app.workspace.activeEditor?.editor;
				const info = app.workspace.activeEditor;
				const bytes = new Uint8Array(${JSON.stringify(Array.from(png))});
				const dt = new DataTransfer();
				dt.items.add(new File([bytes], "acc-verify.png", { type: "image/png" }));
				app.workspace.trigger("editor-paste", { clipboardData: dt, preventDefault() {}, type: "paste" }, editor, info);
				return true;
			})()`
		);
		log("  ✓ 已触发 editor-paste");

		// ── 轮询笔记内容 ──
		let elapsed = 0;
		while (elapsed < 45000) {
			await delay(1000);
			elapsed += 1000;
			noteText = await evaluate(
				client,
				`(async () => {
					const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
					return f ? await app.vault.read(f) : "";
				})()`
			);
			if (noteText.includes(expectedKey)) break;
			// 插进来了别的地址 ⇒ 不可能是我们要的，不必等满
			if (/https?:\/\//.test(noteText)) break;
		}
		log(`  笔记内容（${elapsed}ms）：${JSON.stringify(noteText.slice(0, 200))}`);
		if (!noteText.includes(expectedKey)) {
			failed = true;
			log("  ✗ 笔记里没有出现预计算的 key —— 上传没成功，或模板没被应用");
		}

		// ── 渲染路径：图片的 src 是否指向**本地副本**（"断网也能看"的物证）──
		await delay(1500);
		const srcs = await evaluate(
			client,
			`[...document.querySelectorAll(".markdown-source-view img, .markdown-preview-view img, .cm-content img")]
				.map((i) => i.getAttribute("src") ?? "").filter((s) => s.length > 0)`
		).catch(() => []);
		for (const src of srcs.slice(0, 3)) log(`    <img src>：${src.slice(0, 110)}`);
		const usesLocal = srcs.some((s) => s.includes("attachments-cache") || s.startsWith("app://"));
		const usesRemote = srcs.some((s) => s.startsWith("http"));
		log(`  ${usesLocal ? "✓" : "✗"} 至少一张图指向**本地副本**（离线可用的物证）`);
		log(`  ${usesRemote ? "⚠️" : "✓"} ${usesRemote ? "有图仍指向远端 URL（在线正常，断网就没了）" : "没有图指向远端 URL"}`);
		if (!usesLocal) failed = true;

		if (client.consoleErrors.length > 0) {
			log(`  ⚠️ 控制台有 ${client.consoleErrors.length} 条报错：${client.consoleErrors[0].split("\n")[0]}`);
		}
	} finally {
		try {
			client.close();
		} catch {
			// 尽力而为
		}
		try {
			child.kill();
		} catch {
			// 已经退了
		}
	}

	// ── Node 侧独立复核：匿名 GET + 本地副本（**不带凭据**）──
	log("");
	log("─".repeat(84));
	log("Node 侧独立复核（匿名，不带凭据）");
	log("─".repeat(84));

	// 链接**从笔记里取**（而不是自己拼）—— 这样连"模板是否正确应用"一起验了
	const match = /https?:\/\/[^\s)]+/.exec(noteText);
	if (!match) {
		failed = true;
		log("  ✗ 笔记里没有可验证的链接");
	} else {
		const url = match[0];
		log(`  链接：${url}`);
		if (!url.includes(expectedKey)) failed = true;

		const res = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch((error) => ({ ok: false, status: `网络失败：${error.cause?.code ?? error.message}` }));
		if (typeof res.status !== "number") {
			failed = true;
			log(`  ✗ 匿名 GET ${res.status}`);
		} else {
			log(`  匿名 GET：HTTP ${res.status}  content-type=${res.headers.get("content-type") ?? "—"}`);
			if (res.ok) {
				const remote = new Uint8Array(await res.arrayBuffer());
				const same = sha256(remote) === sha256(png);
				log(`  远端字节：${remote.length}（上传的是 ${png.length}）${same ? "  ✓ 逐字节相同" : "  ✗ **不一致**"}`);
				if (!same) failed = true;
			} else {
				failed = true;
				log("  ✗ 匿名打不开 —— 别人看不到这张图");
			}
		}
	}

	// 本地副本（"字节已安全落到 vault"的物证）
	const localCopy = join(vaultDir, "attachments-cache", expectedKey);
	try {
		const localBytes = new Uint8Array(readFileSync(localCopy));
		const same = sha256(localBytes) === sha256(png);
		log(`  ${same ? "✓" : "✗"} 本地副本 attachments-cache/${expectedKey.slice(0, 12)}…：${localBytes.length} 字节${same ? "，逐字节相同" : "，**不一致**"}`);
		if (!same) failed = true;
	} catch (error) {
		failed = true;
		log(`  ✗ 本地副本读不到：${error.message}`);
	}

	log("");
	log("═".repeat(84));
	log(failed ? "✗ 有未通过的项" : "✓ 上传/下载回环全部通过");
	log(`  桶里的对象（自行决定是否删除）：${expectedKey}`);
	log("═".repeat(84));
	process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
