/**
 * 真机探针：**点「确认」之后**发生的事（§5.4 B 组第 1 / 2 / 8 条 ＋ D-80 完成态）。
 *
 * ## 它补的是哪个洞
 *
 * `verify-flows` 只读清单、**从不点确认** —— 因为确认会真上传、真改笔记。于是
 * 「点了之后到底成不成功」这条最重要的路径，一直是靠人勾的（§5.4 B 组 1/2/8/9），
 * 而 B 组那 9 条正是「不会每次都看」的那批。D-80 的完成态更是**只有人看过一次**。
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
 * | 断言 | §5.4 条目 |
 * |---|---|
 * | 括号文件名（`%20`）进了清单，确认后**链接真的变成远端地址** | 第 1 条（D-56） |
 * | 把链接改回本地再传一次：**零上传**、链接改回远端、完成文案说「已存在 1 个」 | 第 2 条（D-57） |
 * | `.srt` / `.py` / `.tif` 的 `Content-Type` 分别是 `text/plain` / `text/plain` / `image/tiff` | 第 8 条（D-64） |
 * | 跑完**不关窗**：清单留着、按钮区只剩一颗「关闭」、进度行是"已结束：…" | D-80（评审 3-1） |
 *
 * 用法：`node scripts/verify-confirm.mjs [--port 9224]`
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_DEBUG_WAIT / ACC_CONFIRM_VAULT_DIR
 *
 * ⚠️ 跑之前**必须关掉所有 Obsidian**（宿主单实例；有残留会连到旧实例，断言全错位）。
 */

import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";
import { createMockS3 } from "./lib/mock-s3.mjs";
import { clickCta, closeDialog, dialogSnapshot, setToggle, waitForDialog, waitSettled } from "./lib/verify-dom.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9224)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PLUGIN_ID = "attachment-cloud-cache";
const VAULT_DIR = process.env.ACC_CONFIRM_VAULT_DIR ?? "E:/svn/obsidian-plugins/ObsidianVault";
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
 * 启动「上传附件」清单。
 *
 * ⚠️ CR-02（2026-10-23）取消了两条命令 ⇒ 这条入口只剩设置页那颗按钮，
 * 而它绑定的就是 `plugin.runUploadAttachments()`（onClick 只有这一句）。
 * 这里直接调同一个函数：测的仍是同一条流程与同一套清单壳。
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

async function checkAllRows(client) {
	// ⚠️ 返回**最终勾上的行数**，不是"点了几下"：上传链路的默认是**全选**，
	// 所以"点 0 个"完全可能是对的（实测就把它当成失败了一次）。
	return evaluate(
		client,
		`(() => {
			const modal = document.querySelector(".modal-container .modal");
			const boxes = Array.from(modal?.querySelectorAll(".acc-task-row input.acc-task-check") ?? []);
			for (const box of boxes) if (!box.disabled && !box.checked) box.click();
			return boxes.filter((box) => box.checked && !box.disabled).length;
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
					plugin.settings.localCopy = "keep";      // 别让"删本地副本"碰夹具
					plugin.settings.orphanAsk = "always";

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
		await startUpload(client);
		const { appeared, notices } = await waitForDialog(client);
		if (!appeared) {
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
			throw new Error(`上传清单没有出现（轮询期间的通知：${JSON.stringify(notices)}）：${JSON.stringify(hint)}`);
		}
		// 缩到这一篇（否则清单里是整库的东西，勾"全选"会连用户自己的附件一起传）
		await setToggle(client, "当前笔记", true);
		await delay(900);

		const listed = await dialogSnapshot(client);
		const names = listed.rows.map((row) => row.name);
		check(
			"括号文件名的附件进了清单（D-56）",
			names.some((name) => name.includes("报告")),
			names.join(" | ")
		);
		check(
			"只看当前笔记之后，清单只有这一篇的 4 个文件",
			listed.rows.length === 4,
			`${listed.rows.length} 行：${names.join(" | ")}`
		);

		const clickedRows = await checkAllRows(client);
		check("清单里 4 行都是勾上的（默认全选）", clickedRows === 4, `勾上 ${clickedRows} 行`);
		await delay(300);
		const ctaClicked = await clickCta(client);
		check("主按钮可点（勾选后不再是灰的）", ctaClicked);

		const first = await waitSettled(client, 120_000);
		check("跑完停在完成态（没自动关窗）", first.settled, first.settled ? "" : `进度行：${first.snapshot?.progress ?? "(没读到)"}`);
		if (first.settled) {
			const actions = first.snapshot.actions;
			check(
				"完成态按钮区只剩一颗「关闭」（D-80）",
				actions.length === 1 && /^(关闭|Close)$/.test(actions[0].text),
				JSON.stringify(actions)
			);
			check(
				"完成态清单还留着（4 行都在）",
				first.snapshot.rows.length === 4,
				`${first.snapshot.rows.length} 行`
			);
			check(
				"进度行是「已结束：完成 4 个」",
				/已结束：完成 4 个/.test(first.snapshot.progress) || /Finished: 4 done/.test(first.snapshot.progress),
				first.snapshot.progress
			);
		}

		const puts = mock.requests.filter((request) => request.method === "PUT");
		check("mock 收到 4 个 PUT（真上传了）", puts.length === 4, `${puts.length} 个：${puts.map((p) => p.key).join(" | ")}`);
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
		const second = await waitForDialog(client);
		if (!second.appeared) {
			throw new Error(`第二次上传没弹清单（通知：${JSON.stringify(second.notices)}）`);
		}
		await setToggle(client, "当前笔记", true);
		await delay(900);
		const reuseList = await dialogSnapshot(client);
		check(
			"改回本地之后，清单里只有它（1 行）",
			reuseList.rows.length === 1 && reuseList.rows[0].name.includes("报告"),
			reuseList.rows.map((row) => row.name).join(" | ")
		);
		// 那一行的 hint 就是"它早就传过"的证据（D-57：不当成新文件重传一遍）
		log(`  · 这一行的提示：${JSON.stringify(reuseList.rows[0]?.hint ?? "")}`);

		await checkAllRows(client);
		await delay(300);
		await clickCta(client);
		const settled = await waitSettled(client, 120_000);
		check("第二次也停在完成态", settled.settled, settled.snapshot?.progress ?? "");
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
