/**
 * 真实服务商上的**上传回环 ＋ 共享桶声明**验证（R25 的最后一块真机缺口）。
 *
 * ## 它验证什么（四层独立取证，而不是只看插件自己报的成功）
 *
 * 1. **链路**：在真机上触发一次真实的 `editor-paste` 事件 → 插件走完
 *    判定 → 登记声明 → 上传 → 插入链接 → 渲染；
 * 2. **key 由脚本自己算，且断言形状**：共享桶档（CR-14）下 key 必须是
 *    `<sha256>.<ext>` **完全相等**，不是"包含 hash" —— 后者在单桶档
 *    （`<名字>-<hash>.<ext>`）下也会通过，等于没验。拿插件自己的输出当判据是自证，
 *    所以这里用 `node:crypto` 当 oracle；
 * 3. **桶侧**：匿名 GET 那个链接 → 与**上传的字节**逐字节比对。
 *    ⚠️ 必须匿名 —— 带上凭据去请求就等于拿"我能打开"冒充"**别人**能打开"；
 * 4. **声明侧（R25 / CR-13）**：`_acc/v1/<vault>/<device>/head.json` 里
 *    `refs[<sha256>]` 真的存在、`name` 是**原名**而不是 key、`ext` 是 `png`。
 *    这一层此前只有 mock 证据（`verify:confirm` §9），真实桶上是空的。
 *
 * ## 为什么要在真机上做，而不是用 `withLoadedTs` 直接调客户端
 *
 * `ingestAttachment` 是模块级函数、插件没有对外暴露上传入口（只有 `sampleObjectKey()`）；
 * 上传只能由粘贴/拖拽触发。而凭据在宿主的 `secretStorage` 里（落盘在 Obsidian 的
 * LevelDB），脚本**不该**去挖它 —— 让宿主自己交出来才干净。读声明同样走宿主代理
 * （`lib/host-s3-client.mjs`），密钥不出宿主。
 *
 * ## 为什么不能只在 DOM 上 dispatch 一个 paste
 *
 * 插件用的是宿主的 `workspace.on("editor-paste")`（见 `src/host/editor-bridge.ts`
 * 的头注释），那是 Obsidian 在处理完 DOM 粘贴后转发的**带类型事件**。
 * 所以这里直接 `app.workspace.trigger("editor-paste", …)` ——
 * 模拟的是**宿主事件**，不是真剪贴板。这一点在报告里如实写出。
 *
 * ## ⚠️ 它会**写远端**，但会自己收拾
 *
 * 每次运行往桶里上传一个对象（合法 PNG，内容含时间戳所以唯一）＋ 写一条声明引用；
 * 结束时按 key 精确删对象、把 `head.json` **原样还原**（跑前没有就删掉）、删掉测试笔记。
 * **跑完桶里与库里都不留东西**。
 *
 * ⚠️ 为什么是"整体还原"而不是"摘掉本次那条"：临时打开共享桶会让插件顺手做一次
 * **整份引用对账**，把整个库的引用都写进声明（实测写进 6 条真实附件，2026-10-25）。
 * 逐条摘是摘不干净的 —— 而且脚本本来就不该解析、改写用户的声明。
 *
 * ⚠️ 共享桶开关：若当前是关的，本次**只在内存里打开**（不写 `data.json`），
 * 因为这条链要在共享桶档下才走"先登记、后上传"。
 *
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_DEBUG_PORT / OBSIDIAN_DEBUG_WAIT
 *          OBSIDIAN_VAULT_DIR（vault 的绝对路径；用于在 Node 侧找落盘的附件）
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import { createHostClient } from "./lib/host-s3-client.mjs";
import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

/** 仓库根 —— 默认库路径按「仓库的同级目录」算，不写死某台机器的绝对路径。 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN_ID = "attachment-cloud-cache";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9333)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
/**
 * 库的**目录** —— 按它打开（`obsidian://open?path=`），也是 Node 侧找落盘附件的根。
 *
 * ⚠️ 为什么是目录而不是名字：本机可以有两个同名 `ObsidianVault`
 *（`…\obsidian-plugins\` 与 `…\obsidian-plugins-codebuddy\`），`?vault=` 挑哪个取决于
 * 注册表里的 `open` 标记 —— 挑错了会拿另一份旧插件跑完一轮还全绿。目录模式下
 * `launchAndAttach` 用 `adapter.basePath` 逐字核对。
 */
const VAULT_DIR = process.env.OBSIDIAN_VAULT_DIR ?? resolve(REPO, "..", "ObsidianVault");
/** vault 名字 —— 从目录名推，必须与目录**同源**（回读 `getName()` 时要逐字相等）。 */
const VAULT = process.env.OBSIDIAN_VAULT ?? (VAULT_DIR.split(/[\\/]/).filter(Boolean).pop() || "ObsidianVault");
/** 测试笔记：跑完删掉 —— 它连同远端对象一起清，留着就是一条死链。 */
const NOTE = "_acc-realcheck.md";
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 60);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (line = "") => console.log(line);

function check(label, ok, detail = "") {
	log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  —— ${detail}` : ""}`);
	return ok;
}

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
	for (const dir of [join(vaultDir, "attachments"), join(vaultDir, "assets")]) {
		let name = null;
		try {
			name = readdirSync(dir).find((f) => f.endsWith(".png")) ?? null;
		} catch {
			// 目录不存在就试下一个
		}
		if (name) return readFileSync(join(dir, name));
	}
	throw new Error(`找不到可作为底图的 PNG —— 试过 ${vaultDir}/attachments 与 assets`);
}

/**
 * 落盘那份附件现在叫什么、在哪。
 *
 * ⚠️ 1.2.0（D-17）起**没有缓存目录**了：本地副本就是附件本身、原地不动；而
 * `localCopy: "trash"` 档下刚落的文件中转完就被丢进回收站 ⇒ 库里**不该**有它。
 * 所以这条判据必须按档位分支 —— 旧版脚本固定读 `attachments-cache/<key>`，
 * 那个目录从 D-17 起就不存在了，它在 2026-10-14 之后每次都是红的（没人发现）。
 */
function findKeptAttachment(vaultDir, hash) {
	for (const dir of [join(vaultDir, "attachments"), join(vaultDir, "assets")]) {
		let names = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.toLowerCase().endsWith(".png")) continue;
			const bytes = readFileSync(join(dir, name));
			if (sha256(bytes) === hash) return join(dir, name);
		}
	}
	return null;
}

/** 从笔记里那条远端地址取出对象 key（path-style 与 virtual-host 都认）。 */
function keyFromUrl(url) {
	try {
		const path = new URL(url).pathname.replace(/^\/+/, "");
		const parts = path.split("/");
		// path-style：/<bucket>/<key…>；virtual-host：/<key…>
		const key = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
		return decodeURIComponent(key);
	} catch {
		return "";
	}
}

async function main() {
	const vaultDir = VAULT_DIR;

	const others = await countObsidianProcesses();
	if (others === null || others > 0) {
		throw new Error(
			`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑 —— 单实例锁会让调试端口永远起不来，先关掉它们。`
		);
	}

	// 造图 + **自己**算 hash（不问插件）
	const base = loadBasePng(vaultDir);
	const stamp = new Date().toISOString();
	const png = pngWithText(base, "ACC-Verify", stamp);
	const hash = sha256(png);
	const expectedKey = `${hash}.png`;

	log("═".repeat(84));
	log("真实存储回环 ＋ 共享桶声明验证（会往你的桶里写一个对象和一条声明）");
	log("═".repeat(84));
	log(`  vault：${VAULT}（${vaultDir}）`);
	log(`  测试图：${png.length} 字节（底图 ${base.length} + tEXt "${stamp}"）`);
	log(`  预计算的 key：${expectedKey}（共享桶档：纯内容寻址，key 里没有名字）`);

	const { client, child } = await launchAndAttach({
		exe: OBSIDIAN,
		port: PORT,
		vault: VAULT,
		path: VAULT_DIR,
		waitSeconds: WAIT_SECONDS,
		log,
	});
	const host = createHostClient({ evaluate, client });

	let failed = false;
	// ⚠️ 声明在 try **之外**：Node 侧复核与清理要用它 —— 写在 try 里出了块就没了
	let noteText = "";
	let actualKey = "";
	let identity = { vaultId: "", deviceId: "", localCopy: "keep" };
	let headKey = "";
	/** 跑前 `head.json` 是否存在：决定清理时"删掉"还是"恢复"。 */
	let headExistedBefore = false;
	/** 跑前那份 `head.json` 的**原始字节**：跑完要一字不差地写回。 */
	let headSnapshot = null;
	/** 跑后读到的声明。⚠️ 必须声明在 try **外面**：清理段要用它（2026-10-25 踩过 —— 写在里面就是 `not defined`）。 */
	let declaration = null;

	try {
		const loaded = await evaluate(
			client,
			`(async () => {
				for (let i = 0; i < 60; i += 1) {
					if (app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}]?._loaded) return true;
					await new Promise((r) => setTimeout(r, 500));
				}
				return false;
			})()`
		);
		if (!loaded) throw new Error("插件没有加载成功");
		log("  ✓ 插件已加载");

		// ── 身份与档位（读设置是允许的：它是**输入**，key 才是输出）──
		identity = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const settings = plugin?.settings ?? {};
				return {
					vaultId: String(settings.vaultId ?? ""),
					// ⚠️ 设备身份**不在 settings 上**（1.12.0 起存在宿主本机存储，不随库同步）
					deviceId: String(plugin?.deviceId ?? ""),
					localCopy: String(settings.localCopy ?? "keep"),
				};
			})()`
		);
		if (!identity.vaultId || !identity.deviceId) {
			throw new Error("读不到库/设备标识（settings.vaultId / plugin.deviceId）—— 声明路径算不出来");
		}
		headKey = `_acc/v1/${identity.vaultId}/${identity.deviceId}/head.json`;
		log(`  档位：localCopy=${identity.localCopy}／跨设备保护：常开（1.12.0 起不是可选）`);
		log(`  声明：${headKey}`);

		// 跑前把声明**原样抄一份** —— 跑完要还原，脚本不许改用户的状态。
		// ⚠️ 不能只记"在不在"：临时打开共享桶会让插件顺手做一次整份引用对账，
		// 把**整个库**的引用都写进声明（实测写进 6 条真实附件，2026-10-25）。
		// 所以清理不能"逐条摘"，只能整体还原。
		try {
			headSnapshot = (await host.getObject(headKey)).data;
			headExistedBefore = true;
			const existing = Object.keys(JSON.parse(headSnapshot.toString("utf8")).refs ?? {}).length;
			log(`  跑前 head.json：已存在（${existing} 条 ref，跑完原样恢复）`);
		} catch {
			headExistedBefore = false;
			log("  跑前 head.json：不存在（跑完删掉）");
		}

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
			if (noteText.includes(hash)) break;
			// 插进来了别的地址 ⇒ 不可能是我们要的，不必等满
			if (/https?:\/\//.test(noteText)) break;
		}
		log(`  笔记内容（${elapsed}ms）：${JSON.stringify(noteText.slice(0, 200))}`);

		const link = /https?:\/\/[^\s)]+/.exec(noteText);
		actualKey = link ? keyFromUrl(link[0]) : "";
		log("");
		log("─".repeat(84));
		log("一、笔记里那条链接");
		log("─".repeat(84));
		failed = !check(
			"★ key **完全等于** `<sha256>.png`（CR-14 的判据：不是「包含 hash」，后者在单桶档下也成立）",
			actualKey === expectedKey,
			actualKey ? `实际 ${actualKey}` : "笔记里没有链接"
		) || failed;

		// ── 渲染路径：图片的 src 是否指向**远端**（trash 档不留本地副本）──
		await delay(1500);
		const srcs = await evaluate(
			client,
			`[...document.querySelectorAll(".markdown-source-view img, .markdown-preview-view img, .cm-content img")]
				.map((i) => i.getAttribute("src") ?? "").filter((s) => s.length > 0)`
		).catch(() => []);
		for (const src of srcs.slice(0, 3)) log(`    <img src>：${src.slice(0, 110)}`);

		// ── 二、声明（R25 的核心：key 不带名，名字由声明承载）──
		log("");
		log("─".repeat(84));
		log("二、共享桶声明（真桶上的 `_acc/v1/`）");
		log("─".repeat(84));
		declaration = null;
		try {
			const raw = await host.getObject(headKey);
			declaration = JSON.parse(raw.data.toString("utf8"));
		} catch (error) {
			failed = check("★★ 声明写进了真实桶（`head.json` 读得到）", false, error?.message ?? String(error)) || failed;
		}
		if (declaration) {
			const ref = declaration.refs?.[hash];
			failed = !check("★★ `refs[<sha256>]` 存在（先登记、后上传）", Boolean(ref), JSON.stringify(ref ?? null)) || failed;
			if (ref) {
				failed = !check("★ `name` 是**原名**（key 里没有名字，名字只在声明里）", typeof ref.name === "string" && ref.name.length > 0 && ref.name !== actualKey, `name=${ref.name}`) || failed;
				failed = !check("★ `ext` = png（不带点）", ref.ext === "png", `ext=${JSON.stringify(ref.ext)}`) || failed;
				failed = !check("`addedAt` 是合法 ISO 时间", !Number.isNaN(Date.parse(String(ref.addedAt))), String(ref.addedAt)) || failed;
			}
			failed = !check("声明自报的身份与设置一致", declaration.vault === identity.vaultId && declaration.device === identity.deviceId, `${declaration.vault}/${declaration.device}`) || failed;
		}

		// ── 三、桶侧：对象真的在（HEAD，带凭据）──
		log("");
		log("─".repeat(84));
		log("三、桶里的对象");
		log("─".repeat(84));
		const head = await host.headObject(expectedKey).catch(() => null);
		failed = !check("★ 对象真的在桶里，长度与上传一致", Boolean(head) && head.size === png.length, JSON.stringify(head ?? null)) || failed;
	} catch (error) {
		failed = true;
		log(`  ✗ 运行中断：${error?.stack ?? error}`);
	}

	// ⚠️ 收尾（四、五、清理）单独包一层：它里面的任何一步抛错都不能挡住关闭连接 ——
	// **WebSocket 开着 Node 就不会退出**，现象是"脚本早跑完了、命令却一直不返回"。
	try {
		// ── 四、Node 侧独立复核：匿名 GET（**不带凭据**）──
		log("");
	log("─".repeat(84));
	log("四、Node 侧独立复核（匿名，不带凭据）");
	log("─".repeat(84));
	if (!actualKey) {
		failed = true;
		log("  ✗ 没有可验证的链接");
	} else {
		const match = /https?:\/\/[^\s)]+/.exec(noteText);
		const url = match ? match[0] : "";
		log(`  链接：${url}`);
		const res = await fetch(url, { signal: AbortSignal.timeout(30000) }).catch((error) => ({
			ok: false,
			status: `网络失败：${error.cause?.code ?? error.message}`,
		}));
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

	// ── 五、本地那份的处置（按档位，D-17）──
	log("");
	log("─".repeat(84));
	log("五、本地那份（D-17：没有缓存目录，副本就是附件本身）");
	log("─".repeat(84));
	const kept = findKeptAttachment(vaultDir, hash);
	if (identity.localCopy === "trash") {
		failed = !check("不留副本档 ⇒ 中转文件已被处置（库里找不到它）", kept === null, kept === null ? "库里确实没有" : kept) || failed;
	} else {
		failed = !check("留副本档 ⇒ 库里那份逐字节相同", kept !== null, kept ?? "找不到") || failed;
	}

	// ── 清理：对象 + 声明 + 测试笔记（跑完不留脏东西）──
	log("");
	log("─".repeat(84));
	log("清理");
	log("─".repeat(84));
	// ⚠️ 先摘声明再删对象：反过来的话，中途崩了会留下一条指向不存在对象的 ref
	if (headKey) {
		try {
			if (!headExistedBefore) {
				await host.deleteObject(headKey);
				log("  ✓ 删掉跑出来的 head.json（跑前本来没有）");
			} else if (headSnapshot) {
				await host.putObject(headKey, headSnapshot, "application/json");
				log("  ✓ head.json 恢复成跑前的样子（原字节写回）");
			}
		} catch (error) {
			log(`  ⚠️ 声明没还原（手工处理 ${headKey}）：${error?.message ?? error}`);
		}
	}
	// 对象名是脚本自己算的 ⇒ 不管前面走到哪一步都按它删（不依赖"成功拿到链接"）
	{
		try {
			await host.deleteObject(expectedKey);
			const gone = await host.headObject(expectedKey).catch(() => null);
			log(`  ${gone === null ? "✓" : "✗"} 删掉桶里的对象${gone === null ? "" : "（还在）"}`);
		} catch (error) {
			log(`  ⚠️ 对象没删掉（手工删 ${expectedKey}）：${error?.message ?? error}`);
		}
	}
	try {
		await evaluate(
			client,
			`(async () => {
				const f = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				if (f) await app.vault.delete(f, true);
				return true;
			})()`
		);
		log("  ✓ 删掉测试笔记");
	} catch {
		log(`  ⚠️ 测试笔记没删掉：${NOTE}`);
	}

	} catch (error) {
		failed = true;
		log(`  ✗ 收尾阶段出错：${error?.stack ?? error}`);
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

	log("");
	log("═".repeat(84));
	log(failed ? "✗ 有未通过的项" : "✓ 上传回环 ＋ 共享桶声明全部通过");
	log("═".repeat(84));
	process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
