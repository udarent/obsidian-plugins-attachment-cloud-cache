/**
 * 真机探针：**点「确认」之后**发生的事（D-56 括号文件名、D-57 重修零上传、完成通知的措辞）。
 *
 * ## 它补的是哪个洞
 *
 * `verify-flows` 读的是**界面**（弹窗骨架、表头、筛选、全选、按钮数字、完成态），
 * 但它**从不点确认** —— 因为确认会真上传、真改笔记。于是「点了之后到底成不成功」这条最重要的
 * 路径一直靠人勾（D-56 / D-57 那几条），而那几条正是「不会每次都看」的那批。
 *
 * ⇒ 这里给插件接一个**本地 mock S3**（`lib/mock-s3.mjs`，真 HTTP 服务 ＋ 独立重算签名），
 * 然后**真的去点确认**。远端是本机回环，所以：
 *
 * - 上传真发生了（能断言 PUT 次数、字节、`Content-Type`）；
 * - 笔记**真的**被改写（能读回正文）；
 * - 但一个字节都没有离开这台机器，也不碰用户配的真桶。
 *
 * ## 会动什么
 *
 * - 库用**演示库**（可用 `ACC_CONFIRM_VAULT_DIR` 改）；
 * - 只在 `acc-verify-confirm/` 下造文件与笔记，跑完整个目录删掉；
 * - `data.json` / `.cache-index.json` **先备份后写回**（索引会被上传路径改写）；
 * - 设置只在**内存**里改（`plugin.settings` 不落盘）：`s3` 指向 mock、`autoUpload=false`
 *  （否则造文件会被自动上传）、`localCopy="keep"`（不让任何"删本地副本"的动作碰夹具）。
 *
 * ## 三条判据（对应 §5.4）
 *
 * | 断言 | 对应决策 |
 * |---|---|
 * | 括号文件名（`%20`）进了清单，确认后**链接真的变成远端地址** | D-56 |
 * | 把链接改回本地再传一次：**零上传**、链接改回远端、完成文案说「已存在 1 个」 | D-57 |
 * | **共享桶（R25）**：开关打开后上传 ⇒ key 是纯哈希、`_acc/` 里先有声明；桶里放一份"另一台设备也引用了它"的声明后点「删除云端」⇒ **DELETE = 0**、对象还在、通知说「跳过 1 个：别的设备或别的库还在用」 | CR-13 / CR-14 |
 *
 * ⚠️ 共享桶那一节是**唯一**在真插件链上跑到"另一台设备挡住删除"的地方（此前只有单测）。
 * 它打的是本机 mock，`_acc/` 也写在 mock 里 —— 一个字节都不去真实存储。
 * | `.srt` / `.py` / `.tif` 的 `Content-Type` 分别是 `text/plain` / `text/plain` / `image/tiff` | 第 8 条（D-64） |
 * | 跑完**不关窗**：清单留着、按钮区只剩一颗「关闭」、进度行是"已结束：…" | D-80（评审 3-1） |
 *
 * 用法：`node scripts/verify-confirm.mjs [--port 9224]`
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_DEBUG_WAIT / ACC_CONFIRM_VAULT_DIR
 *
 * ⚠️ 跑之前**必须关掉所有 Obsidian**（宿主单实例；有残留会连到旧实例，断言全错位）。
 */

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";
import { createMockS3 } from "./lib/mock-s3.mjs";
import { checkRow, clickModalCta, closeDialog, runCommand, waitForConfirm, waitForDialog } from "./lib/verify-dom.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9224)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PLUGIN_ID = "attachment-cloud-cache";
// ⚠️ 默认值是**仓库的同级目录**（`../ObsidianVault`），不写某台机器的绝对路径 ——
// 那种路径会随仓库一起公开，对别人也毫无用处。
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_DIR = process.env.ACC_CONFIRM_VAULT_DIR ?? resolve(REPO, "..", "ObsidianVault");
const VAULT_NAME = VAULT_DIR.split(/[\\/]/).filter(Boolean).pop() ?? "";
const PLUGIN_DIR = join(VAULT_DIR, ".obsidian", "plugins", PLUGIN_ID);
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);

/** 夹具根 —— 全部东西都在它下面，跑完整个删掉。 */
const DIR = "acc-verify-confirm";
const NOTE = `${DIR}/note.md`;
const ASSETS = `${DIR}/assets`;
/** 括号 ＋ 空格的文件名（D-56 的样本）；另外三份验 Content-Type（D-64）。 */
const BRACKET = "报告 (1).pdf";
const SUBTITLE = "log.srt";
const SCRIPT = "tool.py";
const SCAN = "scan.tif";

/** mock 的凭据 —— 插件侧必须用同一套，否则签名验不过（那是**故意**的：证明真的在验签）。 */
const MOCK_KEY_ID = "acc-confirm-key";
const MOCK_SECRET = "acc-confirm-secret";
const MOCK_SECRET_REF = "acc-confirm-secret-ref";
const MOCK_BUCKET = "acc-confirm-bucket";

const log = (line = "") => console.log(line);
const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

/** 页面内的三个动作：勾**所有可勾的行**、点主按钮、读笔记正文。 */
/**
 * 等到插件真的加载完（`app.plugins.plugins[<id>]` 出现），最多等 `ms`。
 *
 * ⚠️ 别退回"立刻读一次"：宿主启动快慢不稳定，读到空的那一刻并不代表插件坏了。
 */
async function waitForPlugin(client, ms) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const ready = await evaluate(
			client,
			`Boolean(app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}])`
		).catch(() => false);
		if (ready) return true;
		await delay(250);
	}
	return false;
}


/**
 * 启动「上传全部附件」。
 *
 * ⚠️ CR-02（2026-10-23）取消了两条命令 ⇒ 这条入口只剩设置页那颗按钮，
 * 而它绑定的就是 `plugin.runUploadAttachments()`（onClick 只有这一句）。
 * ⚠️ 2026-10-23 起它**不再弹清单**：弹出的是**一次确认**（`confirm-modal.ts`）。
 * （宿主 1.14.4 里 `app.setting.open()` 不生成设置弹窗，所以走 DOM 点按钮不可行。）
 */
async function startUpload(client) {
	return evaluate(
		client,
		`(async () => {
			const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
			if (!plugin || typeof plugin.runUploadAttachments !== "function") return false;
			void plugin.runUploadAttachments();
			return true;
		})()`
	);
}

async function readNote(client, path) {
	return evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (!file) return null;
			return await app.vault.read(file);
		})()`
	);
}

async function writeNote(client, path, text) {
	return evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (!file) return false;
			await app.vault.modify(file, ${JSON.stringify(text)});
			return true;
		})()`
	);
}

async function openNote(client, path) {
	return evaluate(
		client,
		`(async () => {
			const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
			if (!file) return "";
			let leaf = app.workspace.getLeavesOfType("markdown").find((item) => item.view?.file?.path === ${JSON.stringify(path)});
			if (!leaf) leaf = app.workspace.getLeaf(true);
			await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
			app.workspace.setActiveLeaf(leaf, { focus: true });
			return app.workspace.getActiveFile()?.path ?? "";
		})()`
	);
}

/** 笔记正文里的链接写法（D-56 那条原文就是裸括号 ＋ `%20`）。 */
function noteTextFor(entries) {
	return ["# 确认路径", "", ...entries.map(([label, file]) => `[${label}](assets/${file})`), ""].join("\n");
}

async function main() {
	log("═".repeat(84));
	log(`真机探针：点「确认」之后（库=${VAULT_DIR}，port=${PORT}）`);
	log("═".repeat(84));

	// ⚠️ 它是 async（要跑 tasklist）—— 忘了 await 会让这个守卫**永远不生效**
	if ((await countObsidianProcesses()) > 0) {
		log("");
		log("⚠️ 本机已经有 Obsidian 在跑 —— 它是单实例的，新实例会把参数交给它然后自己退出。");
		log("   请先关掉所有 Obsidian 窗口再跑这一个脚本（不要从脚本里替用户结束进程）。");
		process.exitCode = 1;
		return;
	}
	if (!existsSync(join(VAULT_DIR, ".obsidian"))) {
		throw new Error(`找不到库 ${VAULT_DIR}（没有 .obsidian/）—— 用 ACC_CONFIRM_VAULT_DIR 指定演示库`);
	}

	// 索引会被上传路径改写 ⇒ 先备份（设置只改内存，不落盘）
	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = `${from}.acc-confirm-bak`;
		copyFileSync(from, to);
		backups.push({ from, to });
	}

	const mock = createMockS3({
		accessKeyId: MOCK_KEY_ID,
		secretAccessKey: MOCK_SECRET,
		bucket: MOCK_BUCKET,
	});
	const endpoint = await mock.start();
	log(`  · mock S3 在 ${endpoint}（桶 ${MOCK_BUCKET}）`);

	let client = null;
	let child = null;
	try {
		const attached = await launchAndAttach({
			exe: OBSIDIAN,
			port: PORT,
			vault: VAULT_NAME,
			path: VAULT_DIR,
			waitSeconds: WAIT_SECONDS,
			log,
		});
		client = attached.client;
		child = attached.child;

		// ⚠️ **必须等插件加载完**：宿主启动变快时（缓存热），读到 `app.plugins` 的那一刻
		// 社区插件可能还没 onload —— 原来这里是"立刻读一次"，于是间歇性报"插件没加载"，
		// 而真正的原因只是"还没轮到它"。实测：同一份构建，13 秒那轮通过、5 秒那轮失败。
		await waitForPlugin(client, 20_000);

		// ── 0) 准备夹具 + 把存储指向 mock（全在内存里）──
		const setup = await evaluate(
			client,
			`(async () => {
				try {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					if (!plugin) return { error: "插件没加载（先 npm run install:demo 并重载）" };

					// 目录与文件：全部在 ${DIR}/ 下 —— 失败也只在夹具里
					for (const dir of [${JSON.stringify(DIR)}, ${JSON.stringify(ASSETS)}]) {
						if (!app.vault.getAbstractFileByPath(dir)) {
							await app.vault.createFolder(dir).catch(() => {});
						}
					}
					const enc = new TextEncoder();
					const files = {
						[${JSON.stringify(`${ASSETS}/${BRACKET}`)}]: enc.encode("%PDF-1.4\\n1 0 obj<</Type/Catalog>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF\\n"),
						[${JSON.stringify(`${ASSETS}/${SUBTITLE}`)}]: enc.encode("1\\n00:00:01,000 --> 00:00:02,000\\nacc confirm\\n"),
						[${JSON.stringify(`${ASSETS}/${SCRIPT}`)}]: enc.encode("print('acc confirm')\\n"),
						[${JSON.stringify(`${ASSETS}/${SCAN}`)}]: new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
					};
					for (const [path, bytes] of Object.entries(files)) {
						const existing = app.vault.getAbstractFileByPath(path);
						if (existing) await app.vault.delete(existing, true);
						await app.vault.createBinary(path, bytes.buffer);
					}
					const noteText = ${JSON.stringify(noteTextFor([["括号", BRACKET], ["字幕", SUBTITLE], ["脚本", SCRIPT], ["扫描", SCAN]]))};
					const noteFile = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
					if (noteFile) await app.vault.modify(noteFile, noteText);
					else await app.vault.create(${JSON.stringify(NOTE)}, noteText);

					// 存储指向 mock；其余两条是为了"别让别的机制碰夹具"
					plugin.settings.s3 = {
						endpoint: ${JSON.stringify(endpoint)},
						region: "auto",
						bucket: ${JSON.stringify(MOCK_BUCKET)},
						accessKeyId: ${JSON.stringify(MOCK_KEY_ID)},
						secretAccessKeyRef: ${JSON.stringify(MOCK_SECRET_REF)},
						publicUrlBase: "",
						forcePathStyle: true,
					};
					try {
						app.secretStorage?.setSecret?.(${JSON.stringify(MOCK_SECRET_REF)}, ${JSON.stringify(MOCK_SECRET)});
					} catch (error) {
						return { error: "secretStorage 写不进：" + String(error) };
					}
					plugin.settings.autoUpload = false;      // 造文件不该触发自动上传
					// ⚠️ 两个**库外开关**也关掉：演示库里 externalImageCache 是开着的（早先测试留下的），
					// 不关掉这条链会顺手去下载库里的站外图 —— 多出 PUT、多出失败项，
					// 而这一节要验的是"库内那批"的对象层面事实。
					plugin.settings.externalImageCache = false;
					plugin.settings.uploadLocalFiles = false;
					plugin.settings.localCopy = "keep";      // 别让"删本地副本"碰夹具

					window.__accErrors = [];
					const originalError = console.error;
					console.error = (...args) => {
						window.__accErrors.push(args.map((arg) => String(arg)).join(" "));
						originalError(...args);
					};
					return {
						ok: true,
						hasClient: Boolean(plugin.buildClient?.()),
						files: Object.keys(files),
					};
				} catch (error) {
					return { error: String(error?.stack ?? error) };
				}
			})()`
		);
		if (setup?.error) throw new Error(`夹具准备失败：${setup.error}`);
		if (!setup?.hasClient) throw new Error("插件报告「没有可用的存储客户端」 —— settings.s3 没生效");
		log(`  · 夹具就绪（${setup.files.length} 个文件）`);

		const opened = await openNote(client, NOTE);
		if (opened !== NOTE) throw new Error(`打开笔记失败（活动文件是 ${JSON.stringify(opened)}）`);

		// ── 1) 第一次上传：括号文件名 ＋ 三种 Content-Type（§5.4 第 1 / 8 条）──
		//
		// ⚠️ 2026-10-23：这条入口**没有清单**了（用户要求「取消弹窗选择的复杂交互」）——
		// 现在弹出的是**一次确认**。所以这里换三件事：
		// ① 断言"弹的是确认框、不是清单"（`acc-task-row` 一行都没有）；
		// ② 断言确认框说清了**几件**与**文件留在原处**；
		// ③ 点确认之后**没有窗口可等** ⇒ 改成轮询"笔记真的被改写"。
		await startUpload(client);
		const asked = await waitForConfirm(client, 20_000);
		if (!asked) {
			const hint = await evaluate(
				client,
				`(async () => {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					return {
						notices: Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent),
						modals: document.querySelectorAll(".modal-container .modal").length,
						hasClient: Boolean(plugin?.buildClient?.()),
						errors: window.__accErrors ?? [],
					};
				})()`
			);
			throw new Error(`上传确认框没有出现：${JSON.stringify(hint)}`);
		}
		check(
			"上传入口弹的是**一次确认**，没有清单（`acc-task-row` 一行都没有）",
			asked.rows === 0,
			`${asked.rows} 行`
		);
		check(
			"确认框说清了「几件」与「文件留在原处」",
			// ⚠️ `waitForConfirm` 交的是**一段合并文本**（`text`），不是 `lines` 数组；
			// 语种跟着宿主走 ⇒ 两种语言都要认。
			/\d/.test(asked.text) && /留在原处|stay where they are/i.test(asked.text),
			JSON.stringify(asked.text)
		);

		const ctaClicked = await clickModalCta(client);
		check("确认按钮可点", ctaClicked);

		// 点完窗口就没了（这条链不留窗）⇒ 只能轮询"笔记真的被改写"
		let rewritten = "";
		const rewriteDeadline = Date.now() + 120_000;
		while (Date.now() < rewriteDeadline) {
			const text = await readNote(client, NOTE);
			if (typeof text === "string" && text.includes(endpoint)) {
				rewritten = text;
				break;
			}
			await delay(300);
		}
		check(
			"确认之后链接真的变成了远端地址（D-56）",
			rewritten.includes(endpoint),
			rewritten.split("\n").filter((line) => line.includes("](")).join(" | ") || "(还没改写)"
		);
		check("跑完不留窗（这条链自己收起）", await evaluate(client, `!document.querySelector(".modal-container .modal")`));

		const puts = mock.requests.filter((request) => request.method === "PUT");
		// ⚠️ 不再断言"恰好 4 个"：没有「只看当前笔记」之后，这一趟处理的是**全库**候选
		// （演示库里还有别的附件）。判据改成"**这四个夹具**都传上去了" —— 那才是这一节要的。
		check("真上传了（PUT 至少 4 个）", puts.length >= 4, `${puts.length} 个：${puts.map((p) => p.key).join(" | ")}`);
		check(
			"每次 PUT 的签名都被服务端独立验过",
			puts.every((request) => request.signatureOk),
			puts.map((request) => `${request.key}:${request.signatureOk ? "ok" : request.signatureReason}`).join(" / ")
		);

		// Content-Type（D-64）：浏览器"直接显示"还是"下载框"就看这一个头
		const contentTypeOf = (suffix) => {
			const found = [...mock.objects.entries()].find(([key]) => key.endsWith(suffix));
			return found ? found[1].contentType : "";
		};
		check("`.srt` 的 Content-Type 是 text/plain", contentTypeOf(".srt") === "text/plain", contentTypeOf(".srt"));
		check("`.py` 的 Content-Type 是 text/plain（不是可执行类型）", contentTypeOf(".py") === "text/plain", contentTypeOf(".py"));
		check("`.tif` 的 Content-Type 是 image/tiff", contentTypeOf(".tif") === "image/tiff", contentTypeOf(".tif"));

		// 链接真的被改写了（D-56 的核心：传了但链接不动 = 用户以为没传）
		const afterFirst = await readNote(client, NOTE);
		check(
			"笔记里的括号链接变成了远端地址（D-56）",
			typeof afterFirst === "string" && afterFirst.includes(endpoint) && !afterFirst.includes("%20(1).pdf"),
			(afterFirst ?? "(读不到笔记)").split("\n").filter((line) => line.includes("](")).join(" | ")
		);

		check("关掉完成态窗口", await closeDialog(client));

		// ── 2) 改回本地再传一次：应当**零上传**（§5.4 第 2 条 / D-57）──
		await writeNote(client, NOTE, noteTextFor([["括号", BRACKET]]));
		const localAgain = await readNote(client, NOTE);
		check(
			"夹具已改回本地链接",
			// ⚠️ 夹具里写的是**字面空格**（`assets/报告 (1).pdf`），不是 `%20`：
			// 断言找 `%20` 会稳定失败，与上传逻辑无关。
			typeof localAgain === "string" &&
				(localAgain.includes("assets/报告 (1).pdf") || localAgain.includes("assets/报告%20(1).pdf")),
			(localAgain ?? "").trim()
		);

		const putsBefore = mock.countByMethod("PUT");
		await startUpload(client);
		const second = await waitForConfirm(client, 20_000);
		if (!second) {
			throw new Error("第二次上传没弹确认框");
		}
		// ⚠️ 这里**不再看清单**（没有清单）：判据是"这一趟到底传没传"——
		// 那一份早在存储里、而正文刚被改回本地 ⇒ 它属于"只差改链接"，
		// 于是应当 **零 PUT**、链接照样被改回远端（D-57）。
		await clickModalCta(client);
		let secondOk = false;
		const secondDeadline = Date.now() + 120_000;
		while (Date.now() < secondDeadline) {
			const text = await readNote(client, NOTE);
			if (typeof text === "string" && text.includes(endpoint)) {
				secondOk = true;
				break;
			}
			await delay(300);
		}
		check("第二次也把链接改回了远端地址", secondOk);
		check(
			"零上传（PUT 次数没变）",
			mock.countByMethod("PUT") === putsBefore,
			`跑前 ${putsBefore} 次 → 跑后 ${mock.countByMethod("PUT")} 次`
		);

		const afterSecond = await readNote(client, NOTE);
		check(
			"链接被改回远端地址",
			typeof afterSecond === "string" && afterSecond.includes(endpoint),
			(afterSecond ?? "").split("\n").filter((line) => line.includes("](")).join(" | ")
		);
		// ⚠️ 「已存在 N 个」出现在**通知**里（`taskProgressFinished` 只报 完成/跳过/失败，
		// 不带 reused 之分）⇒ 断言要读 `.notice`，读进度行会稳定失败。
		// ⭐ **先关窗**：`askTaskList` 的 summary 是关窗那一刻才返回的，通知在那之后才弹
		// （实测：在完成态就去找通知，读到的还是**上一轮**那条）。
		check("关掉第二次的窗口", await closeDialog(client));
		// ⚠️ 通知在"完成态"之后才弹出，而且 `.notice` 会为**上一轮**那条停留几秒
		// （实测读到的是第一轮的「上传 4 个、已存在 0 个」）⇒ 轮询到这一轮的那条为止。
		let noticeText = "";
		for (let attempt = 0; attempt < 25; attempt += 1) {
			const noticesNow = await evaluate(
				client,
				`(() => Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent || ""))()`
			);
			noticeText = (noticesNow ?? []).join(" ‖ ");
			if (/已存在 1 个/.test(noticeText) || /already there 1/i.test(noticeText)) break;
			await delay(200);
		}
		check(
			"完成通知说「已存在 1 个」（reused 与 uploaded 分开报）",
			/已存在 1 个/.test(noticeText) || /already there 1/i.test(noticeText),
			noticeText || "(没有通知)"
		);

		// ══════════════════════════════════════════════════════════════════
		// §9 共享桶（R25）：上传前写声明 → 删除时被别的设备挡下
		// ══════════════════════════════════════════════════════════════════
		//
		// 这一节第一次把**共享桶自己的路径**端到端跑一遍（此前只有单测）：
		// ① 打开开关后上传 ⇒ key 变纯哈希、`_acc/` 里出现本设备的声明；
		// ② 桶里放一份"另一台设备也引用了这个对象"的声明；
		// ③ 删云端 ⇒ 那一条被**跳过**、对象还在、通知说清原因。
		// ⚠️ 全程打的是本机 mock（内存里的桶），跑完随进程消失 —— 不碰任何真实存储。
		{
			const sharedPath = `${ASSETS}/shared.txt`;
			const sharedText = `acc shared probe ${randomBytes(6).toString("hex")}`;
			const sharedHash = createHash("sha256").update(Buffer.from(sharedText)).digest("hex");
			const ownHead = "_acc/v1/probevault/probedev/head.json";
			const foreignHead = "_acc/v1/probevault/otherdev/head.json";
			const sharedKey = `${sharedHash}.txt`;

			/** 轮询到条件成立为止（最多 ms）；返回最后一次的值。 */
			const poll = async (read, ok, ms = 20_000) => {
				const deadline = Date.now() + ms;
				let value = null;
				while (Date.now() < deadline) {
					value = await read().catch(() => null);
					if (ok(value)) return value;
					await delay(300);
				}
				return value;
			};

			const sharedSetup = await evaluate(
				client,
				`(async () => {
					try {
						const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
						// 固定身份（身份本由首次启动生成，这里固定住才好断言）
						// ⚠️ 设备身份不在 settings 上（1.12.0 起存宿主本机存储）；
						// 跨设备保护也不再是开关，所以这里不用"打开"任何东西。
						plugin.settings.vaultId = "probevault";
						plugin.deviceId = "probedev";
						const body = new TextEncoder().encode(${JSON.stringify(sharedText)});
						const prior = app.vault.getAbstractFileByPath(${JSON.stringify(sharedPath)});
						if (prior) await app.vault.delete(prior, true);
						await app.vault.createBinary(${JSON.stringify(sharedPath)}, body.buffer);
						const note = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
						const text = await app.vault.read(note);
						await app.vault.modify(note, text + "\\n\\n[共享](" + ${JSON.stringify(sharedPath)} + ")\\n");
						return { ok: true };
					} catch (error) {
						return { error: String(error?.stack ?? error) };
					}
				})()`
			);
			if (sharedSetup?.error) throw new Error(`共享桶夹具失败：${sharedSetup.error}`);

			// ① 上传（这一次走的就是共享桶档：key 纯哈希、PUT 之前先写声明）
			await startUpload(client);
			const sharedAsked = await waitForConfirm(client, 20_000);
			check(
				"共享桶：上传仍是一次确认（没有清单）",
				Boolean(sharedAsked) && sharedAsked.rows === 0,
				sharedAsked ? `${sharedAsked.rows} 行` : "没等到确认框"
			);
			if (sharedAsked) await clickModalCta(client);

			const headText = await poll(
				() =>
					evaluate(
						client,
						`(async () => {
							const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
							try {
								const got = await plugin.buildClient().getObject(${JSON.stringify(ownHead)});
								return new TextDecoder().decode(got.data);
							} catch {
								return "";
							}
						})()`
					),
				(text) => typeof text === "string" && text.includes(sharedHash)
			);
			check(
				"★ 共享桶：上传前写下了本设备的引用声明（`_acc/` 里查得到这个哈希）",
				typeof headText === "string" && headText.includes(sharedHash),
				typeof headText === "string" && headText !== "" ? headText.slice(0, 120) : "(读不到 head.json)"
			);
			let headRefs = {};
			try {
				headRefs = JSON.parse(headText ?? "{}").refs ?? {};
			} catch {
				headRefs = {};
			}
			check(
				"★ 共享桶：声明里记着**原始文件名**（key 里已经没有名字了）",
				headRefs?.[sharedHash]?.name === "shared.txt",
				JSON.stringify(headRefs?.[sharedHash] ?? null)
			);

			// ② key 形状（CR-14 在真插件链上的证据：不是单测里的纯函数）
			const storedKeys = [...mock.objects.keys()];
			check(
				"★ 共享桶：新对象名是纯内容哈希（`<sha256>.txt`）",
				storedKeys.includes(sharedKey),
				storedKeys.filter((key) => key.endsWith(".txt")).join(" | ") || "(没有 .txt 对象)"
			);

			// ③ 种一份"另一台设备也引用了它"的声明（模拟同一个桶上的另一个库/设备）
			await evaluate(
				client,
				`(async () => {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					const now = new Date().toISOString();
					const body = JSON.stringify({
						v: 1,
						vault: "probevault",
						device: "otherdev",
						updatedAt: now,
						refs: { [${JSON.stringify(sharedHash)}]: { name: "shared.txt", ext: "txt", addedAt: now } },
					});
					await plugin.buildClient().putObject(${JSON.stringify(foreignHead)}, new TextEncoder().encode(body), "application/json");
					return true;
				})()`
			);
			check("共享桶：桶里有了另一台设备的声明", mock.objects.has(foreignHead), foreignHead);

			// ④ 让这个对象变成"没人引用"（上传时链接已被改写成云端地址，按哈希整行删掉）
			await evaluate(
				client,
				`(async () => {
					const note = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
					const text = await app.vault.read(note);
					await app.vault.modify(note, text.split("\\n").filter((line) => !line.includes(${JSON.stringify(sharedHash)})).join("\\n"));
					return true;
				})()`
			);

			// ⚠️ 等上传那个窗口**自己收起**（D-80 自动收窗）再开附件管理：
			// 否则 `waitForDialog` 会抓到还留在屏幕上的进度窗，后面全是错的元素。
			await poll(
				() => evaluate(client, `!document.querySelector(".modal-container .modal")`),
				(gone) => gone === true,
				10_000
			);
			// ⑤ 附件管理 → 待清理 → 勾那一行 → 删除云端 → 确认
			await runCommand(client, PLUGIN_ID, "manage-attachments");
			const galleryOpen = await waitForDialog(client, 15_000);
			check("共享桶：附件管理能打开", Boolean(galleryOpen), galleryOpen ? "已打开" : "没等到弹窗");
			await evaluate(
				client,
				`(() => {
					const chip = Array.from(document.querySelectorAll(".acc-gallery-filter")).find((el) =>
						(el.textContent ?? "").includes("全部")
					);
					if (!chip) return false;
					chip.click();
					return true;
				})()`
			);
			await delay(500);
			// ⚠️ 名字有两种可能：本地那份还在 ⇒ 用文件名；只有台账 ⇒ 用 key（纯哈希）。
			// 而且"待清理"这个胶囊在中文界面才叫这个名字 ⇒ 先 dump 一次，失败时看得到现场。
			const galleryDump = await evaluate(
				client,
				`(() => ({
					chips: Array.from(document.querySelectorAll(".acc-gallery-filter")).map((el) => (el.textContent ?? "").trim()),
					rows: Array.from(document.querySelectorAll(".acc-task-row")).map((row) => ({
						name: (row.querySelector(".acc-task-name")?.textContent ?? "").trim(),
						state: (row.querySelector(".acc-cell-state .acc-cell-text")?.textContent ?? "").trim(),
						ref: (row.querySelector(".acc-cell-ref .acc-cell-text")?.textContent ?? "").trim(),
					})),
					actions: Array.from(document.querySelectorAll(".acc-task-actions button")).map((el) => (el.textContent ?? "").trim() + (el.disabled ? "(灰)" : "")),
				}))()`
			);
			let rowPicked = await checkRow(client, "shared.txt");
			if (!rowPicked) rowPicked = await checkRow(client, sharedHash);
			check(
				"共享桶：那一行出现在清单里并可勾选",
				rowPicked,
				`${galleryDump.chips?.length ?? 0} 个胶囊；行 ${galleryDump.rows?.length ?? 0}；
				  含 shared.txt=${(galleryDump.rows ?? []).some((row) => row.name === "shared.txt")}`
			);
			const deleteClicked = await evaluate(
				client,
				`(() => {
					const button = Array.from(document.querySelectorAll(".acc-task-actions button")).find((el) =>
						(el.textContent ?? "").includes("删除云端")
					);
					if (!button || button.disabled) return false;
					button.click();
					return true;
				})()`
			);
			check("共享桶：「删除云端」可点", deleteClicked);
			// ⚠️ **不能用 `waitForConfirm`**：它取的是 DOM 里**第一个** `.modal`，而此时附件管理
			// 那个弹窗还开着（确认框叠在它上面）⇒ 读到的是清单、点到的也是清单里的按钮。
			// 这里按"不在 `.acc-gallery-modal` 里面"挑出确认框，再点它自己的主按钮。
			const confirmModal = `(() => {
				const list = Array.from(document.querySelectorAll(".modal-container .modal")).filter(
					(el) => !el.closest(".acc-gallery-modal")
				);
				return list[list.length - 1] ?? null;
			})()`;
			const destructive = await poll(
				() =>
					evaluate(client, `(() => {
						const modal = ${confirmModal};
						if (!modal) return null;
						return { title: (modal.querySelector(".modal-title")?.textContent ?? "").trim() };
					})()`),
				(value) => Boolean(value && value.title)
			);
			const confirmed = destructive
				? await evaluate(
					client,
					`(() => {
						const modal = ${confirmModal};
						if (!modal) return false;
						const buttons = Array.from(modal.querySelectorAll("button")).filter((el) => (el.textContent ?? "").trim() !== "");
						const button = buttons.find((el) => el.classList.contains("mod-cta")) ?? buttons.find((el) => !/^(取消|Cancel)$/.test((el.textContent ?? "").trim()));
						if (!button) return false;
						button.click();
						return true;
					})()`
				)
				: false;
			check(
				"共享桶：删除确认框出现了并点了确认",
				Boolean(destructive) && confirmed,
				destructive ? destructive.title : "没等到确认框"
			);

			// ⑥ 结论：对象没被删、通知说清原因
			const deleted = mock.requests.filter(
				(request) => request.method === "DELETE" && String(request.key ?? "").includes(sharedHash)
			);
			check(
				"★★ 共享桶：被别的设备引用的对象**没有删**（DELETE = 0）",
				deleted.length === 0 && mock.objects.has(sharedKey),
				`DELETE ${deleted.length} 次；对象还在=${mock.objects.has(sharedKey)}`
			);
			const deniedNotice = await poll(
				() =>
					evaluate(
						client,
						`(() => Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent || "").join(" ‖ "))()`
					),
				(text) => typeof text === "string" && /还在用|still uses/i.test(text)
			);
			check(
				"★ 共享桶：通知说清「别的设备还在用」（不是只说跳过）",
				typeof deniedNotice === "string" && /还在用|still uses/i.test(deniedNotice),
				deniedNotice || "(没有通知)"
			);
			await closeDialog(client).catch(() => false);
		}

		// 夹具按前缀兜底删（中途失败也不留垃圾）
		await evaluate(
			client,
			`(async () => {
				const dir = app.vault.getAbstractFileByPath(${JSON.stringify(DIR)});
				if (dir) await app.vault.delete(dir, true);
				return true;
			})()`
		).catch((error) => log(`  ⚠️ 清理夹具失败（下次跑之前手动删 ${DIR}/）：${error.message}`));
	} finally {
		try {
			client?.close();
		} catch {
			// 尽力而为
		}
		try {
			child?.kill();
		} catch {
			// 已经退了
		}
		await delay(2000);
		await mock.close();
		for (const { from, to } of backups) {
			try {
				copyFileSync(to, from);
				unlinkSync(to);
			} catch (error) {
				log(`  ⚠️ 恢复 ${from} 失败：${error.message}`);
			}
		}
		log("  · 已还原设置与索引，mock 已关闭");
	}

	finish();
}

function finish() {
	const failed = results.filter((item) => !item.ok);
	const passed = results.length - failed.length;
	log("");
	log("═".repeat(84));
	log(
		failed.length === 0
			? `✓ 确认路径探针通过：${passed} 项`
			: `✗ 未通过 ${failed.length} / ${results.length} 项：${failed.map((item) => item.name).join(" ／ ")}`
	);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
