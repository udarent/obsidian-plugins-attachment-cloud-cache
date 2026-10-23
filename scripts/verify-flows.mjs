/**
 * 真机探针：**两条命令的清单弹窗**（D-69 ~ D-77 那批改动里"必须看一眼界面"的部分）。
 *
 * ## 它替代了哪些人工步骤
 *
 * 这批改动里有八件事原来只写着"去界面上看一眼"：标题、顶部段数、行内标签、
 * 失效行的图标、灰着的勾选框、「打开笔记」、两个过滤开关、命令条数。人工勾选的问题是
 * **不会每次都看**（尤其改一处文案之后），而它们恰恰是最容易悄悄退回旧样子的。
 *
 * ⇒ 这里用 CDP 驱动**真实 Obsidian**：造数据 → 执行命令 → 读真实 DOM → 逐条断言 → 还原。
 * 不点"确认"（那会真的上传 / 真的删东西），所以整轮只读 + 只碰自己造的文件。
 *
 * ## 它会动什么（都在演示库上，跑完还原）
 *
 * - 库用**演示库**（默认 `E:/svn/obsidian-plugins/ObsidianVault`，可用 `ACC_FLOWS_VAULT_DIR` 改）；
 * - 只往里放三个 `acc-verify/` 文件，跑完删掉；`data.json` / `.cache-index.json` **先备份后写回**；
 * - ⚠️ 不碰你自己的笔记库：默认指向演示库，而且只动带 `acc-verify/` 前缀的东西；
 * - ⚠️ **不碰任何远端**：全程没有配置存储也能跑（候选是从库与索引算出来的）。
 *
 * ## 断言与 §5.4 的对应
 *
 * | 断言 | 对应条目 |
 * |---|---|
 * | 命令面板恰好三条（名字对；R24 后并为一条见 CR-02） | 第 15 条 |
 * | 附件管理视图：能打开、标题、五个筛选、三态行数之和＝全部 | R24 / F22 |
 * | 附件管理：「上传 / 删除」数字＝能作用的件数；重命名勾两行就灰 | R24 / §5.5 |
 * | 上传弹窗标题＝命令名、顶部只有一段且不含数字 | 第 12/13 条 |
 * | 失效本机文件那一行：图标 ＋ 灰勾选 ＋ 「打开笔记」 | 第 11 条 |
 * | 「只看当前笔记」开关存在，勾上后清单只剩这一篇 | 第 10 条 |
 * | 清理弹窗：两类行 ＋ 两个开关各生效 ＋ 站外缓存那一行带标签 | 第 14/17 条 |
 * | 行内标签（没有笔记引用 / 只改链接）画出来了 | 第 12 条 |
 * | 勾选框有 `aria-label` | 评审 3-3（D-80） |
 *
 * 用法：`node scripts/verify-flows.mjs [--port 9223]`
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_DEBUG_WAIT（库是自己造的，不需要 OBSIDIAN_VAULT）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";
// ⚠️ 页面内的选择器与弹窗操作统一在 `lib/verify-dom.mjs`：两份探针共用，类名就不会分叉。
import { DOM_HELPERS, closeDialog, dialogSnapshot, runCommand, waitForConfirm, waitForDialog } from "./lib/verify-dom.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9223)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
/** 插件 id（与 manifest 一致）。 */
const PLUGIN_ID = "attachment-cloud-cache";
/**
 * 附件管理**弹窗**根节点（页面内 JS 表达式）。
 *
 * ⚠️ 2026-10-23：它从侧边栏视图改成了弹窗（手机端判据），所以定位方式从
 * `getLeavesOfType(...).view.contentEl` 换成"按弹窗类名找内容区"。
 * 类名与 `ui/gallery-modal.ts` 的 `GALLERY_MODAL_CLASS` 是同一件事 —— 改一个要改两个。
 */
const GALLERY_ROOT = 'document.querySelector(".acc-gallery-modal .modal-content")';
/** 仓库根（构建产物在它里）。 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 用哪个库。
 *
 * ⚠️ 默认是**演示库**（`install:demo` 写的那个），不是用户自己的笔记库。
 * 这个探针会往里放三个 `acc-verify/` 文件、并改两条设置，跑完**全部还原**
 *（`data.json` / `.cache-index.json` 先备份后写回）。
 */
const VAULT_DIR = process.env.ACC_FLOWS_VAULT_DIR ?? "E:/svn/obsidian-plugins/ObsidianVault";
const VAULT_NAME = VAULT_DIR.split(/[\\/]/).filter(Boolean).pop() ?? "";
const PLUGIN_DIR = join(VAULT_DIR, ".obsidian", "plugins", PLUGIN_ID);

/**
 * 怎么打开库：**`obsidian://open?path=<目录>`**（`launchAndAttach` 的 `path` 分支）。
 *
 * ⚠️ 这里原本写着「`path` 打开的是**文件**、不是文件夹，实测走不通」，于是留了一个
 * `OBSIDIAN_JSON` 常量，准备"造库之后临时注册它、跑完把注册表原样写回去"。
 * 2026-10-23 复测：**对已经打开过的库这条路是通的**（`adapter.basePath` 逐字校验通过），
 * 所以注册表那条不需要 —— 不碰用户的 Obsidian 配置。
 *
 * 🚨 但**不要**指望它打开一个**从没打开过**的库：那次实测等满 90 秒也拿不到 CDP ——
 * 主进程卡在"是否信任此库的作者"那一步（信任提示**不在渲染进程里**，所以 CDP 的
 * HTTP 端点根本不回应，`clickTrustIfAsked` 也就永远轮不到）。⇒「造一个全新库来跑探针」
 * 这条路走不通。
 *
 * ⚠️ 也用不着指望宿主的「排除的文件」（`app.json` 的 `userIgnoreFilters`）：2026-10-23
 * 实测排除了那个读不到的文件，清理命令**照样**读到它、照样取消整次 —— 那个设置只影响
 * 搜索与链接建议，不影响 `getMarkdownFiles()`。所以「库里有一个读不到的文件」在本机
 * 是**只能如实跳过**的情形（跳过会打印原因，别把它当通过）。
 */
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);
/** 造在库里的东西 —— 名字都带 `acc-verify` 前缀，清理时按前缀兜底（中途失败也不会留垃圾）。 */
const NOTE = "acc-verify/gone-note.md";
const GONE_URL = "file:///D:/acc-verify-does-not-exist/x.png";
const STRAY = "acc-verify/stray.png";
const CACHED = "acc-verify/cached.png";
const CACHED_KEY = "acc-cached-stray.png";

const PNG = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
	0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
];

const log = (line = "") => console.log(line);
const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok: Boolean(ok), detail });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

/**
 * **跳过**一项（不是失败）。
 *
 * ⚠️ 只有一种情况用它：**被测的库本身让插件拒绝工作**，而那是**正确行为**。
 * 例：库里有一个文件读不到 ⇒ 清理命令按设计**取消整次清理**（那条判据写着
 * 「绝不能把不知道当成没有引用」）。这时探针什么都量不到，但不该判红 ——
 * 判红会让人以为插件坏了，而去「修」那条正确的判据。
 * 跳过必须带**具体原因**，并且会打印出来（静默跳过就等于没测）。
 */
function skip(name, reason) {
	results.push({ name, ok: true, skipped: true, detail: reason });
	log(`  ~ ${name} —— 跳过：${reason}`);
}

async function main() {
	log("═".repeat(84));
	log(`真机探针：两条命令的弹窗 ＋ 附件管理视图（库=${VAULT_DIR}，port=${PORT}）`);
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
		throw new Error(`找不到库 ${VAULT_DIR}（没有 .obsidian/）—— 用 ACC_FLOWS_VAULT_DIR 指定演示库`);
	}
	// 会改两条设置，所以先备份这两个文件（跑完原样写回）
	const backups = [];
	for (const name of ["data.json", ".cache-index.json"]) {
		const from = join(PLUGIN_DIR, name);
		if (!existsSync(from)) continue;
		const to = `${from}.acc-flows-bak`;
		copyFileSync(from, to);
		backups.push({ from, to });
	}

	let client = null;
	let child = null;
	try {
		const attached = await launchAndAttach({
			exe: OBSIDIAN,
			port: PORT,
			vault: VAULT_NAME,
			// ⭐ 按**目录**打开：`ACC_FLOWS_VAULT_DIR` 指向的库不必先注册到 `obsidian.json`
			//（干净库是脚本/临时流程自己造的，用户配置里不该出现它）。
			path: VAULT_DIR,
			waitSeconds: WAIT_SECONDS,
			log,
		});
		client = attached.client;
		child = attached.child;

		/**
		 * ⚠️ **新库第一次打开会问「是否信任此库的作者」**（不答就不加载社区插件）。
		 * 这里替用户点「信任并启用」—— 库是**我们自己造的**，所以没有安全问题。
		 * 找不到那个弹窗时什么都不做（有些版本/设置下不会问）。
		 */
		async function clickTrustIfAsked() {
			const clicked = await evaluate(
				client,
				`(() => {
					const buttons = Array.from(document.querySelectorAll(".modal-container button"));
					const target = buttons.find((button) => /(Trust|信任)/i.test(button.textContent ?? ""));
					if (!target) return false;
					target.click();
					return true;
				})()`
			);
			if (clicked) log("  · 已点「信任此库」");
			return clicked;
		}

		// ⚠️ 插件是**宿主就绪之后**才异步加载的：`app.plugins` 可用 ≠ 本插件已注册。
		// 实测（第一次跑）就撞上了：拿不到 plugin 对象、报「插件没加载」，而它几秒后才到。
		let pluginReady = false;
		const pluginDeadline = Date.now() + 20000;
		while (Date.now() < pluginDeadline) {
			pluginReady = await evaluate(
				client,
				`Boolean(app.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}]?.currentIndex)`
			);
			if (pluginReady) break;
			// 第一轮还没加载 ⇒ 很可能被信任弹窗挡着（每轮都试一次，点不到就算了）
			await clickTrustIfAsked();
			await delay(200);
		}
		check("插件在临时库里加载了", pluginReady);
		if (!pluginReady) throw new Error("插件没有加载（20 秒内没等到）");

		// ── 0) 夹具：一个失效本机链接的笔记 ＋ 两份没人引用的附件 ＋ 一条站外缓存索引 ──
		const setup = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				if (!plugin) return { error: "插件没加载" };
				const bytes = new Uint8Array(${JSON.stringify(PNG)});
				// 目录：宿主的 create 不会建父目录
				for (const dir of ["acc-verify"]) {
					if (!app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
				}
				const noteText = ${JSON.stringify(`# 探针\n\n![失效](${GONE_URL})\n`)};
				if (app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)})) {
					await app.vault.modify(app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)}), noteText);
				} else {
					await app.vault.create(${JSON.stringify(NOTE)}, noteText);
				}
				for (const path of [${JSON.stringify(STRAY)}, ${JSON.stringify(CACHED)}]) {
					const existing = app.vault.getAbstractFileByPath(path);
					if (existing) await app.vault.delete(existing, true);
					await app.vault.createBinary(path, bytes);
				}
				// 站外缓存的索引条目（只为让清理清单能分出"站外缓存"那一类）
				const index = plugin.currentIndex();
				index.set({
					key: ${JSON.stringify(CACHED_KEY)},
					cachePath: ${JSON.stringify(CACHED)},
					remoteUrl: "https://offsite.test/cached.png",
					size: bytes.length,
					contentType: "image/png",
					uploadedAt: "2026-01-01T00:00:00.000Z",
					sourceName: "cached.png",
					origin: "external",
				});
				await plugin.hostContext().persistIndex();
				// ⚠️ 「上传附件」在**没有配置存储**时会直接弹一句「先去配置」并返回
				//（upload-existing-flow.ts 第一行就是 if (!ctx.buildClient()) 就返回）。
				// 这里给它一套**指向本机回环**的假配置：候选是从库与索引算出来的，
				// 全程不点确认 ⇒ 一次请求都不会发出去。
				plugin.settings.s3 = {
					endpoint: "http://127.0.0.1:1",
					region: "auto",
					bucket: "probe",
					accessKeyId: "probe-key",
					secretAccessKeyRef: "acc-probe-secret",
					publicUrlBase: "",
					forcePathStyle: true,
				};
				try {
					app.secretStorage?.setSecret?.("acc-probe-secret", "probe-secret-value");
				} catch {}
				// ⚠️ 命令路只有 orphanAsk=always 时才弹**清单**（另两档只发一句通知）。
				// 这个改动不落盘也行（命令读的是内存里的 settings），而 data.json 有备份兜底。
				plugin.settings.orphanAsk = "always";
				// 命令体是 fire-and-forget 的（runCommand 返回 void）⇒ 抛出的错只会进
				// console.error。把它收进一个数组，失败诊断里就能看到"到底为什么没弹窗"。
				window.__accErrors = [];
				const originalError = console.error;
				console.error = (...args) => {
					window.__accErrors.push(args.map((arg) => String(arg)).join(" "));
					originalError(...args);
				};
				return { ok: true, commands: Object.keys(app.commands.commands).filter((id) => id.startsWith(${JSON.stringify(`${PLUGIN_ID}:`)})) };
			})()`
		);
		if (setup.error) throw new Error(setup.error);

		// ── 1) 命令面板恰好三条（第 15 条）──
		// ⚠️ R24（2026-10-23）加了第三条 `manage-attachments`；CR-02 会把它变成**唯一**一条，
		// 那一步要同步改这里、烟雾的 EXPECTED_COMMANDS、验收套件的命令集合三处。
		// ⭐ R24 / CR-02：命令面板**只有一条**。旧的两条连同 id 一并取消，
		// 它们的能力变成视图里的「待上传」「待清理」筛选与动作栏。
		const commands = setup.commands.map((id) => id.split(":")[1]).sort();
		check(
			"命令只有一条（附件管理）",
			commands.length === 1 && commands[0] === "manage-attachments",
			commands.join(" / ")
		);

		// ── 2) 打开那篇笔记（"只看当前笔记"只在 md 活动文件时才有）──
		await evaluate(
			client,
			`(async () => {
				const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE)});
				let leaf = app.workspace.getLeavesOfType("markdown").find((item) => item.view?.file?.path === ${JSON.stringify(NOTE)});
				if (!leaf) leaf = app.workspace.getLeaf(true);
				await leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
				app.workspace.setActiveLeaf(leaf, { focus: true });
				return app.workspace.getActiveFile()?.path ?? "";
			})()`
		);

		// ── 3) 「上传全部附件」：**一次确认，没有清单**（2026-10-23）──
		//
		// 用户要求「设置界面的"上传附件"改成与"恢复本地链接"相反的对应功能，取消弹窗
		// 选择的复杂交互」⇒ 这一节从"读清单"改成"读确认框"。判据只剩三条，但都是这次的要点：
		// ① 弹的是确认框（`.acc-task-row` 一行都没有）；
		// ② 说清**几件**与「文件留在原处」；
		// ③ 取消之后有回话，而且**什么都不做**。
		// ⚠️ **需要一个"待上传"的夹具**：这个演示库里的附件早就都传过了，而新流程
		// 只收**库内被引用**的附件 —— 没有夹具时它一条候选都没有（直接一句"没有需要上传"）。
		// 造一份"笔记引用着的、还没传过的"图，用完立刻删掉（不能留到第 4 节，那里数行数）。
		const PENDING_NOTE = "acc-verify/pending-note.md";
		const PENDING_FILE = "acc-verify/pending.png";
		await evaluate(
			client,
			`(async () => {
				// ⚠️ 必须先关掉「自动上传」：否则**造文件的瞬间**就被自动接管那条链抢走，
				// 而它指向的是假端点 ⇒ 这里得到的是"刚加入库的附件上传失败"，而不是"待上传候选"。
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				plugin.__accAutoUpload = plugin.settings.autoUpload;
				plugin.settings.autoUpload = false;
				const folder = app.vault.getAbstractFileByPath("acc-verify");
				if (!folder) await app.vault.createFolder("acc-verify").catch(() => {});
				const bytes = new Uint8Array(${JSON.stringify(PNG)});
				const existing = app.vault.getAbstractFileByPath(${JSON.stringify(PENDING_FILE)});
				if (existing) await app.vault.modifyBinary(existing, bytes.buffer);
				else await app.vault.createBinary(${JSON.stringify(PENDING_FILE)}, bytes.buffer);
				const text = "![[pending.png]]\\n";
				const note = app.vault.getAbstractFileByPath(${JSON.stringify(PENDING_NOTE)});
				if (note) await app.vault.modify(note, text);
				else await app.vault.create(${JSON.stringify(PENDING_NOTE)}, text);
				return true;
			})()`
		);
		await delay(800);

		await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				if (!plugin || typeof plugin.runUploadAttachments !== "function") return false;
				void plugin.runUploadAttachments();
				return true;
			})()`
		);
		// ⚠️ **不能用 `waitForDialog`**：它等的是"清单出现了"（`.acc-task-list`），
		// 而这一趟弹的是**确认框**（`confirm-modal.ts`，正文是一串 `<div>`，没有清单）。
		const confirmSeen = await waitForConfirm(client, 12_000);
		check("「上传全部附件」弹出确认框", Boolean(confirmSeen), JSON.stringify(confirmSeen?.text ?? ""));
		if (confirmSeen) {
			check(
				"确认框里**没有清单**（用户要求取消勾选）",
				confirmSeen.rows === 0,
				`${confirmSeen.rows} 行`
			);
			check(
				"确认框说清「几件」与「文件留在原处」",
				// ⚠️ 两种语种都要认：真机的语种跟着宿主走（这台是中文），
				// 只写英文那句会在中文环境里永远假红。
				/\d/.test(confirmSeen.text) && /留在原处|stay where they are/i.test(confirmSeen.text),
				JSON.stringify(confirmSeen.text)
			);
		}
		// ⭐ 取消：必须**有回话**，且笔记与存储都不许动（取消是结构保证的：动手在确认之后）
		const beforeCancel = await evaluate(client, `app.vault.getFiles().map((f) => f.path).length`);
		await closeDialog(client);
		await delay(600);
		const afterCancel = await evaluate(client, `app.vault.getFiles().map((f) => f.path).length`);
		const cancelSaid = await evaluate(
			client,
			`Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent || "").join(" ｜ ")`
		);
		check("取消之后有回话（不是一片安静）", /取消|Cancel/i.test(String(cancelSaid)), JSON.stringify(cancelSaid));
		check("取消之后什么都没动", afterCancel === beforeCancel, `${beforeCancel} → ${afterCancel}`);

		// 夹具用完就删（第 4 节要数库里的附件行数）
		await evaluate(
			client,
			`(async () => {
				for (const path of [${JSON.stringify(PENDING_NOTE)}, ${JSON.stringify(PENDING_FILE)}]) {
					const file = app.vault.getAbstractFileByPath(path);
					if (file) await app.vault.delete(file, true).catch(() => {});
				}
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				if (typeof plugin.__accAutoUpload === "boolean") plugin.settings.autoUpload = plugin.__accAutoUpload;
				return true;
			})()`
		);
		await delay(400);

		// ── 4) 附件管理**弹窗**（R24 / F22）：能开、标题、筛选、动作数字 ──
		// ⚠️ 这一节**只读**：只点筛选与勾选框，**不点上传 / 删除**（那个库没配存储也会真去连远端）。
		// 弹窗层没有可编程 DOM 单测（替身里 `createEl` 全是桩）⇒ 这里是它唯一的证据。
		await runCommand(client, PLUGIN_ID, "manage-attachments");
		const opened = await waitForDialog(client, 12_000);
		check("「附件管理」命令能打开弹窗", opened.appeared, JSON.stringify(opened.notices));
		// ⚠️ **必须先点一次刷新**：弹窗在 `onOpen` 里取一次 `vault.getFiles()`，之后不会自动追新文件。
		// 而这一轮脚本造的两个夹具（`acc-verify/*`）是刚写进去的 ⇒ 不刷新时“清单的行数”与
		// “我这一刻数到的库内附件数”来自两个时刻，会间歇性地差两行（实测 16 与 18 交替）。
		// 点刷新既让两边同一时刻，也顺带验了那个按钮有用。
		await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const button = root && root.querySelector(".acc-gallery-refresh");
				if (button) button.click();
				return Boolean(button);
			})()`
		);
		await delay(1200);

		const gallery = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				if (!root) return null;
				const title = root.closest(".modal")?.querySelector(".modal-title")?.textContent || "";
				const attachments = app.vault
					.getFiles()
					.filter((f) => !["md", "canvas", "base"].includes(String(f.extension || "").toLowerCase()));
				const head = root.querySelector(".acc-task-headrow");
				const list = root.querySelector(".acc-task-list");
				// ⚠️ 按**结构化**字段读，不按中文文案读：文案改一次，断言就假红一次。
				const label = (el) => ((el && el.textContent) || "").trim();
				return {
					title: title.trim(),
					filters: Array.from(root.querySelectorAll(".acc-gallery-filter")).map((el) => ({
						key: el.getAttribute("data-filter") || "",
						label: label(el.querySelector(".acc-gallery-filter-label")),
						count: Number(label(el.querySelector(".acc-gallery-filter-count"))),
						// 「按下 / 弹起」两个来源都必须一致：属性（读屏）与类名（视觉）
						pressed: el.getAttribute("aria-pressed") === "true",
						activeClass: el.classList.contains("is-active"),
					})),
					// 标题栏：在清单**里面**、是清单的第一个子节点
					heading: label(root.querySelector(".acc-task-headrow .acc-task-heading")),
					// 粘顶容器（headwrap）在清单里且是第一个子节点；列标题行与标题行都在它里面
					headInsideList: Boolean(head && list && head.closest(".acc-task-list") === list),
					headIsFirst: (() => {
						const wrap = head && head.closest(".acc-task-headwrap");
						return Boolean(wrap && list && wrap.parentElement === list && wrap === list.firstElementChild);
					})(),
					headCheck: (() => {
						const box = root.querySelector(".acc-task-check-all");
						if (!box) return null;
						return {
							checked: box.checked === true,
							indeterminate: box.indeterminate === true,
							ariaLabel: box.getAttribute("aria-label") || "",
						};
					})(),
					headCount: label(root.querySelector(".acc-task-count")),
					// 动作区里不该再出现全选（它曾经被排到动作按钮下面）
					buttonsInHead: root.querySelectorAll(".acc-task-headrow button").length,
					names: Array.from(root.querySelectorAll(".acc-task-row .acc-task-name")).map((el) => el.textContent || ""),
					// ⭐ 表格模式（2026-10-23）：状态与"引用"各自一列 —— 不再有合并的 acc-task-hint
					states: Array.from(root.querySelectorAll(".acc-task-row .acc-cell-state .acc-cell-text")).map(
						(el) => (el.textContent || "").trim()
					),
					refs: Array.from(root.querySelectorAll(".acc-task-row .acc-cell-ref .acc-cell-text")).map(
						(el) => (el.textContent || "").trim()
					),
					folders: Array.from(root.querySelectorAll(".acc-task-row .acc-cell-folder .acc-cell-text")).map(
						(el) => (el.textContent || "").trim()
					),
					sizes: Array.from(root.querySelectorAll(".acc-task-row .acc-cell-size .acc-cell-text")).map(
						(el) => (el.textContent || "").trim()
					),
					cols: Array.from(root.querySelectorAll(".acc-task-headcols .acc-col")).map((el) => (el.textContent || "").trim()),
					// 网格模板：表头与行**共用一份**（--acc-cols 写在清单元素上）
					gridTemplate: (() => {
						const cls = (sel) => {
							const el = root.querySelector(sel);
							return el ? getComputedStyle(el).gridTemplateColumns : "";
						};
						return { row: cls(".acc-task-row"), head: cls(".acc-task-headcols") };
					})(),
					lines: Array.from(root.querySelectorAll(".acc-task-lines > div")).map((el) => el.textContent || ""),
					rows: root.querySelectorAll(".acc-task-row").length,
					expected: attachments.length,
				};
			})()`
		);

		check("（弹窗内容读得到）", Boolean(gallery), gallery ? "已读到" : "没找到 .acc-gallery-modal 的内容区");
		check("弹窗标题＝附件管理", gallery?.title === "附件管理", `实际：${JSON.stringify(gallery?.title)}`);
		check(
			"筛选栏六个胶囊，默认「全部」**按下**（视觉类名与 aria 同一件事）",
			gallery?.filters.length === 6 &&
				gallery.filters[0]?.label === "全部" &&
				gallery.filters[0]?.pressed === true &&
				gallery.filters[0]?.activeClass === true &&
				gallery.filters.filter((f) => f.pressed).length === 1,
			(gallery?.filters ?? []).map((f) => `${f.label}${f.pressed ? " [按下]" : ""}${f.activeClass ? " *" : ""}`).join(" / ")
		);
		check(
			"标题栏在**清单里面**、是第一个子节点，且带一行标题（附件清单）",
			gallery?.heading === "附件清单" && gallery?.headInsideList === true && gallery?.headIsFirst === true,
			`heading=${JSON.stringify(gallery?.heading)} inList=${gallery?.headInsideList} first=${gallery?.headIsFirst}`
		);
		check(
			"标题栏里放的是**全选复选框**（不是文字按钮），初始未勾、读屏名是「全选」",
			Boolean(gallery?.headCheck) &&
				gallery.headCheck.checked === false &&
				gallery.headCheck.indeterminate === false &&
				gallery.headCheck.ariaLabel === "全选" &&
				gallery?.buttonsInHead === 0,
			JSON.stringify({ check: gallery?.headCheck, buttons: gallery?.buttonsInHead })
		);
		// ⚠️ 用**解析出来的两个数字**比，不用 endsWith：`已选 0 / 18` 与 rows=8 会被 endsWith 骗过。
		const headCountMatch = /^已选 (\d+) \/ (\d+)$/.exec(gallery?.headCount ?? "");
		check(
			"标题栏右侧报「已选 0 / 共 N」，N＝清单行数",
			Boolean(headCountMatch) && headCountMatch[1] === "0" && Number(headCountMatch[2]) === gallery?.rows,
			JSON.stringify({ text: gallery?.headCount, rows: gallery?.rows })
		);
		check(
			"顶部有一句固定说明，且不含数字（D-76）",
			gallery?.lines.length === 1 && gallery.lines[0].trim().length > 0 && !/\d/.test(gallery.lines[0]),
			JSON.stringify(gallery?.lines ?? [])
		);

		// 「改为本地引用」是“删云端”的前置（用户 2026-10-23 定的顺序）：云端有本地无的行应当可点
		const localize = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const rows = Array.from(root.querySelectorAll(".acc-task-row"));
				const target = rows.find((row) => {
					const state = row.querySelector(".acc-cell-state .acc-cell-text")?.textContent || "";
					const box = row.querySelector(".acc-task-check");
					return state.indexOf("云端有本地无") === 0 && box && !box.disabled;
				});
				if (!target) return null;
				const box = target.querySelector(".acc-task-check");
				box.checked = true;
				box.dispatchEvent(new Event("change"));
				const read = (prefix) => {
					const button = Array.from(root.querySelectorAll(".acc-task-actions button")).find((b) =>
						(b.textContent || "").trim().indexOf(prefix) === 0
					);
					return button ? { text: (button.textContent || "").trim(), disabled: button.disabled === true } : null;
				};
				const state = { localize: read("改为本地引用"), cloud: read("删除云端") };
				box.checked = false;
				box.dispatchEvent(new Event("change"));
				return state;
			})()`
		);
		check(
			"「云端有本地无」的行 ⇒「改为本地引用」可点且数字 ≥ 1",
			Boolean(localize?.localize) && localize.localize.disabled === false && /\([1-9]/.test(localize.localize.text),
			JSON.stringify(localize?.localize ?? null)
		);

		check(
			"表格有六列，列标题齐全（名称 / 位置 / 状态 / 引用 / 大小 / 操作）",
			(gallery?.cols ?? []).filter((c) => c !== "").join("|") === "名称|位置|状态|引用|大小|操作",
			JSON.stringify(gallery?.cols ?? [])
		);
		check(
			"每行都有状态与引用两格（不再是合并成一句的小标签）",
			gallery?.names.length === gallery?.states.length &&
				gallery.names.length === gallery?.refs.length &&
				(gallery?.states ?? []).every((text) => text.trim().length > 0) &&
				(gallery?.refs ?? []).every((text) => text.trim().length > 0),
			`${gallery?.names.length} 行 / ${gallery?.states.length} 个状态 / ${gallery?.refs.length} 个引用格，例：${JSON.stringify(
				[gallery?.states?.[0], gallery?.refs?.[0]]
			)}`
		);
		check(
			"位置与大小两列有内容（大小形如 `12 MB`）",
			(gallery?.folders ?? []).length === gallery?.names.length &&
				(gallery?.sizes ?? []).every((text) => text === "—" || /^\d+(\.\d+)? (B|KB|MB|GB)$/.test(text)),
			`位置例：${JSON.stringify((gallery?.folders ?? [])[0] ?? "")} 大小例：${JSON.stringify((gallery?.sizes ?? [])[0] ?? "")}`
		);
		check(
			"表头与行**共用同一份列宽**（网格模板逐字相同）",
			Boolean(gallery?.gridTemplate?.row) && gallery.gridTemplate.row === gallery.gridTemplate.head,
			JSON.stringify(gallery?.gridTemplate ?? null)
		);

		// 动作按钮的数字＝**能作用的件数**；重命名只对单选成立（§5.5 的判据在真机上的落点）
		const perAction = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const boxes = Array.from(root.querySelectorAll(".acc-task-check"));
				const read = () =>
					Array.from(root.querySelectorAll(".acc-task-actions button")).map((b) => ({
						text: (b.textContent || "").trim(),
						disabled: b.disabled === true,
					}));
				const renameOf = (list) => list.find((b) => b.text.indexOf("重命名") === 0) || null;
				const toggle = (box, on) => {
					box.checked = on;
					box.dispatchEvent(new Event("change"));
				};
				if (boxes.length < 2) return { error: "行数不够，勾不了两行" };
				toggle(boxes[0], true);
				const one = read();
				toggle(boxes[1], true);
				const two = read();
				for (const box of boxes) if (box.checked) toggle(box, false);
				return { single: renameOf(one), pair: renameOf(two), buttons: one.map((b) => b.text) };
			})()`
		);
		check(
			"勾一行 ⇒「重命名」可用",
			perAction?.single?.disabled === false,
			JSON.stringify(perAction?.single ?? perAction?.error ?? null)
		);
		check(
			"勾两行 ⇒「重命名」灰掉（不能给多个文件改同一个名字）",
			perAction?.pair?.disabled === true,
			JSON.stringify(perAction?.pair ?? perAction?.error ?? null)
		);

		// 三态互斥且不遗漏 ＋ 胶囊上的**件数与点开后的行数同源**（一份判据）
		const byFilter = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const pick = (key) =>
					Array.from(root.querySelectorAll(".acc-gallery-filter")).find(
						(el) => el.getAttribute("data-filter") === key
					) || null;
				const rows = () => root.querySelectorAll(".acc-task-row").length;
				const out = {};
				for (const key of ["all", "to-clean", "not-uploaded", "uploaded", "cloud-only", "unreferenced"]) {
					const button = pick(key);
					if (!button) { out[key] = null; continue; }
					const badge = button.querySelector(".acc-gallery-filter-count");
					const declared = Number(((badge && badge.textContent) || "").trim());
					button.click();
					const after = pick(key);
					out[key] = {
						declared,
						rows: rows(),
						pressed: Boolean(after && after.getAttribute("aria-pressed") === "true"),
						pressedCount: root.querySelectorAll(".acc-gallery-filter[aria-pressed='true']").length,
						refs: Array.from(root.querySelectorAll(".acc-task-row .acc-cell-ref .acc-cell-text")).map(
							(el) => (el.textContent || "").trim()
						),
					};
				}
				const all = pick("all");
				if (all) all.click();
				return out;
			})()`
		);
		const byState = byFilter
			? {
					all: byFilter.all?.rows ?? -1,
					notUploaded: byFilter["not-uploaded"]?.rows ?? -1,
					uploaded: byFilter.uploaded?.rows ?? -1,
					cloudOnly: byFilter["cloud-only"]?.rows ?? -1,
				}
			: null;

		check(
			"胶囊上的件数＝点开后真的有几行（同一份判据）",
			Boolean(byFilter) &&
				Object.values(byFilter).every((entry) => entry && entry.declared === entry.rows),
			Object.entries(byFilter ?? {})
				.map(([key, entry]) => `${key}:${entry?.declared}/${entry?.rows}`)
				.join(" ")
		);
		check(
			"按下的胶囊**有且只有一个**（分段控件，不是多选筛子）",
			Boolean(byFilter) && Object.values(byFilter).every((entry) => entry && entry.pressed && entry.pressedCount === 1),
			Object.entries(byFilter ?? {})
				.map(([key, entry]) => `${key}:${entry?.pressed ? "按下" : "弹起"}/${entry?.pressedCount}`)
				.join(" ")
		);

		// 「待清理」＝ R17 的三类候选；它们的**共同点**就是“没人引用”（判据复用 `selectLocalOrphans`）
		const toClean = byFilter?.["to-clean"]
			? { rows: byFilter["to-clean"].rows, refs: byFilter["to-clean"].refs }
			: null;
		check(
			"「待清理」里每一行都带「没人引用」",
			toClean !== null && toClean.rows > 0 && toClean.refs.every((ref) => ref === "没人引用"),
			toClean === null ? "没有「待清理」胶囊" : `${toClean.rows} 行：${JSON.stringify(toClean.refs.slice(0, 3))}`
		);

		// 标题栏那颗复选框真的管用：空 → 全选 → 全不选 → 只勾一行（半选）
		const selectionTools = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const box = root.querySelector(".acc-task-check-all");
				if (!box) return { error: "标题栏里没有全选复选框" };
				const rowBoxes = () => Array.from(root.querySelectorAll(".acc-task-row .acc-task-check"));
				const checked = () => rowBoxes().filter((b) => b.checked && !b.disabled).length;
				const state = () => ({
					checked: box.checked === true,
					indeterminate: box.indeterminate === true,
					title: box.getAttribute("title") || "",
					count: ((root.querySelector(".acc-task-count") || {}).textContent || "").trim(),
				});
				const pickable = () => rowBoxes().filter((b) => !b.disabled).length;
				const initial = { ...state(), checkedRows: checked(), pickable: pickable() };

				box.click(); // 全选
				const afterAll = { ...state(), checkedRows: checked() };

				box.click(); // 全不选
				const afterNone = { ...state(), checkedRows: checked() };

				// 只勾一行 ⇒ 半选（indeterminate），这就是"三态"的第三态
				const first = rowBoxes().find((b) => !b.disabled);
				if (first) {
					first.checked = true;
					first.dispatchEvent(new Event("change"));
				}
				const partial = { ...state(), checkedRows: checked() };
				if (first) {
					first.checked = false;
					first.dispatchEvent(new Event("change"));
				}
				const restored = state();
				return { initial, afterAll, afterNone, partial, restored };
			})()`
		);
		check(
			"点一下全选复选框 ⇒ 所有能勾的行都勾上，自己也变成「已勾」",
			selectionTools?.afterAll?.checkedRows > 0 &&
				selectionTools.afterAll.checkedRows === selectionTools?.initial?.pickable &&
				selectionTools.afterAll.checked === true &&
				selectionTools.afterAll.indeterminate === false &&
				selectionTools.afterAll.title === "全不选",
			JSON.stringify(selectionTools?.afterAll ?? selectionTools?.error ?? null)
		);
		check(
			"再点一下 ⇒ 全部取消，计数回到 0",
			selectionTools?.afterNone?.checkedRows === 0 &&
				selectionTools.afterNone.checked === false &&
				/^已选 0 \//.test(selectionTools.afterNone.count ?? ""),
			JSON.stringify(selectionTools?.afterNone ?? null)
		);
		check(
			"只勾一行 ⇒ 复选框是**半选**（indeterminate），计数跟着变",
			selectionTools?.partial?.indeterminate === true &&
				selectionTools.partial.checked === false &&
				/^已选 1 \//.test(selectionTools.partial.count ?? ""),
			JSON.stringify(selectionTools?.partial ?? null)
		);
		check(
			"取消那一行 ⇒ 复选框回到未勾（不是卡在半选）",
			selectionTools?.restored?.indeterminate === false &&
				selectionTools.restored.checked === false &&
				/^已选 0 \//.test(selectionTools.restored.count ?? ""),
			JSON.stringify(selectionTools?.restored ?? null)
		);

		// 标题栏"粘顶"要真粘住：清单一滚，全选就滚走的话"随时可点"是句空话。
		// ⚠️ 这个库里行数不一定撑满 45vh，所以临时压小 `max-height` 造出溢出（测完还原）。
		const sticky = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const list = root.querySelector(".acc-task-list");
				const head = root.querySelector(".acc-task-headwrap");
				if (!list || !head) return { error: "没有清单 / 标题栏" };
				const gap = () => Math.round(head.getBoundingClientRect().top - list.getBoundingClientRect().top);
				const original = list.style.maxHeight;
				list.style.maxHeight = "90px";
				const before = gap();
				list.scrollTop = 200;
				const after = gap();
				const moved = list.scrollTop;
				list.scrollTop = 0;
				list.style.maxHeight = original;
				return { before, after, moved, position: getComputedStyle(head).position };
			})()`
		);
		check(
			"标题栏滚动时**粘在清单顶部**（全选随时点得到）",
			// ⚠️ 判据是"**没动**"而不是"恰好是 0"：表头与清单外框之间有 1px 边框
			// （实测 before=after=1）。真正要抓住的是"滚了 200px、表头却还在原位"。
			sticky?.position === "sticky" &&
				sticky?.moved > 0 &&
				sticky?.after === sticky?.before &&
				sticky?.before >= 0 &&
				sticky?.before <= 2,
			JSON.stringify(sticky ?? null)
		);

		// 「删除（云端）」的默认档（CR-05）：没人引用的可删，仍被引用的**灰掉**
		const cloudAction = await evaluate(
			client,
			`(() => {
				const root = ${GALLERY_ROOT};
				const rows = Array.from(root.querySelectorAll(".acc-task-row"));
				const textOf = (row) => ({
					name: row.querySelector(".acc-task-name")?.textContent || "",
					state: row.querySelector(".acc-cell-state .acc-cell-text")?.textContent || "",
					ref: row.querySelector(".acc-cell-ref .acc-cell-text")?.textContent || "",
					box: row.querySelector(".acc-task-check"),
				});
				const readCloud = () => {
					const button = Array.from(root.querySelectorAll(".acc-task-actions button")).find((b) =>
						(b.textContent || "").trim().indexOf("删除云端") === 0
					);
					return button ? { text: (button.textContent || "").trim(), disabled: button.disabled === true } : null;
				};
				const toggle = (box, on) => {
					if (!box) return;
					box.checked = on;
					box.dispatchEvent(new Event("change"));
				};
				const all = rows.map(textOf);
				const free = all.find((row) => row.ref === "没人引用" && row.state.includes("云端有本地无"));
				// ⚠️ 不用精确等号：同一个状态后面可能还缀着「· 没人引用」。
				// 要的是“已上传 **且仍被引用**”那一行（CR-05 只对它禁用删云端）。
				const used = all.find((row) => row.state.indexOf("已上传") === 0 && row.ref !== "没人引用");
				let freeState = null;
				let usedState = null;
				if (free && !free.box.disabled) {
					toggle(free.box, true);
					freeState = readCloud();
					toggle(free.box, false);
				}
				if (used && !used.box.disabled) {
					toggle(used.box, true);
					usedState = readCloud();
					toggle(used.box, false);
				}
				return { freeState, usedState, hasUsed: Boolean(used) };
			})()`
		);
		check(
			"勾「没人引用的云端对象」⇒ 删除云端可用且数字 ≥ 1",
			Boolean(cloudAction?.freeState) && cloudAction.freeState.disabled === false && /\([1-9]/.test(cloudAction.freeState.text),
			JSON.stringify(cloudAction?.freeState ?? null)
		);
		if (!cloudAction?.hasUsed) {
			// 这个库里所有“已上传”的都恰好没人引用 ⇒ 这条判据在这里没有样本，按原因跳过。
			skip("勾「仍被引用的已上传」⇒ 删除云端灰掉（CR-05 默认档）", "这个库里没有“已上传且仍被引用”的行");
		} else {
			check(
				"勾「仍被引用的已上传」⇒ 删除云端灰掉（CR-05 默认档）",
				Boolean(cloudAction?.usedState) && cloudAction.usedState.disabled === true,
				JSON.stringify(cloudAction?.usedState ?? null)
			);
		}

		check(
			"三态行数之和＝「全部」（互斥且不遗漏）",
			byState !== null && byState.notUploaded + byState.uploaded + byState.cloudOnly === byState.all,
			JSON.stringify(byState)
		);

		// ⭐ 「全部」＝库里的附件 ∪ 台账里“云端有本地无”的对象。
		// ⚠️ 一开始我把期望写成“= 库里附件数”，实测 18 vs 6 才看清：那 12 条只有云端、
		// 本地没有 —— 它们**本来就该**出现在「全部」里（§5.5 的第三态）。
		check(
			"「全部」＝库里附件 ＋ 云端有本地无",
			byState !== null && byState.uploaded + byState.notUploaded === gallery?.expected,
			`本地 ${byState?.uploaded} ＋ ${byState?.notUploaded} 应等于库里 ${gallery?.expected} 份附件`
		);
		check(
			"「全部」行数＝本地附件 ＋ 仅云端对象",
			byState !== null && byState.all === gallery?.expected + byState.cloudOnly,
			`${byState?.all} 行 = 本地 ${gallery?.expected} ＋ 仅云端 ${byState?.cloudOnly}`
		);

		// ⭐⭐ 跑完**收起窗口** ＋ 通知报结果（D-80 的唯一例外，见 `gallery-modal.ts` 文件头）
		//
		// ⚠️ 这一段会**真的按一次「上传」**。为了不真的连远端，只在**没配存储**的库上跑：
		// 那种情况下每一项都会按"未配置"失败，零网络请求。配了存储就按原因跳过
		//（这台机器上的演示库恰好没配，所以它是真跑过的；换机器跑要先看这一条有没有跳过）。
		const storageConfigured = await evaluate(
			client,
			`(() => {
				const settings = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}]?.settings ?? {};
				return Boolean(settings.endpoint && settings.bucket);
			})()`
		);
		if (storageConfigured) {
			skip("跑完自动收窗并用通知报结果", "这个库配了存储 —— 按一次「上传」会真的连远端，不在这里验");
		} else {
			// 全选 → 按「上传」→ 等窗口消失 → 读通知
			const ran = await evaluate(
				client,
				`(() => {
					const root = ${GALLERY_ROOT};
					const all = root && root.querySelector(".acc-task-check-all");
					if (!all) return { error: "没有全选复选框" };
					if (!all.checked) all.click();
					const button = Array.from(root.querySelectorAll(".acc-task-actions button")).find(
						(el) => (el.textContent || "").trim().indexOf("上传") === 0
					);
					if (!button) return { error: "动作区没有「上传」" };
					if (button.disabled) return { error: "「上传」是灰的（一件可传的都没有）" };
					const label = (button.textContent || "").trim();
					button.click();
					return { clicked: label };
				})()`
			);
			// 窗口应当在跑完后自己消失（不是被谁点掉的）
			let closed = false;
			const closeDeadline = Date.now() + 20_000;
			while (Date.now() < closeDeadline) {
				closed = await evaluate(client, `!document.querySelector(".acc-gallery-modal")`).catch(() => false);
				if (closed) break;
				await delay(200);
			}
			const noticeText = await evaluate(
				client,
				`Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent || "").join(" ｜ ")`
			);
			check(
				"跑完**自动收起窗口**（不留在原地挡人）",
				closed === true,
				`closed=${closed} clicked=${JSON.stringify(ran?.clicked ?? ran?.error ?? null)} notices=${JSON.stringify(noticeText)}`
			);
			check(
				"收起之后**通知把结果说清**（三类计数，不是一句「完成」）",
				/已处理：完成 \d+, 跳过 \d+, 失败 \d+/.test(String(noticeText ?? "")) &&
					/失败 [1-9]/.test(String(noticeText ?? "")),
				JSON.stringify(noticeText)
			);
		}


		// ⚠️ 这一屏是**模态弹窗**（不是标签页）：后面还要开设置页 / 别的弹窗，
		// 不关掉就会撞上两层 modal（实测踩过：断言在两层 modal 里读到空数组，报成"面板没了"）。
		// 上面那段"跑完自动收窗"已经把窗口收掉了（配了存储的库里则会跳过）⇒ 这里再关一次是**幂等**的。
		await closeDialog(client);
		await delay(400);

		// ── 5) 清理：**手动入口已并入附件管理**（CR-02）──
		// ⚠️ 原来这里跑 `check-orphans` 并断言弹窗的两类行 / 两个开关 / 站外缓存标签。
		// 命令连同 id 取消之后，云端清理的手动入口是「待清理」筛选 ＋ 动作栏 ——
		// 那几条判据（待清理 ⊆ 没人引用、删云端的数字、改为本地引用、站外缓存标签）
		// 已经在第 4 节按视图验过。这里只留一句记录，避免以后有人以为漏测了。
		skip(
			"清理命令的清单弹窗",
			"命令已并入附件管理（CR-02）：清单形态不存在了；等价判据在「待清理」筛选与动作栏上（第 4 节已验）"
		);

	} finally {
		// 还原：先删造出来的文件（**按前缀兜底**：中途失败也留不下垃圾）
		try {
			await evaluate(
				client,
				`(async () => {
					for (const path of [${JSON.stringify(NOTE)}, ${JSON.stringify(STRAY)}, ${JSON.stringify(CACHED)}]) {
						const file = app.vault.getAbstractFileByPath(path);
						if (file) await app.vault.delete(file, true).catch(() => {});
					}
					const folder = app.vault.getAbstractFileByPath("acc-verify");
					if (folder && folder.children && folder.children.length === 0) await app.vault.delete(folder, true).catch(() => {});
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					if (plugin) {
						plugin.currentIndex().remove(${JSON.stringify(CACHED_KEY)});
						await plugin.hostContext().persistIndex().catch(() => {});
						// 记下这一条删除，避免下一次自检把它当成幽灵记录
					}
					return true;
				})()`
			);
		} catch (error) {
			// ⚠️ `client` 可能是 `null`（端口没起来 / 宿主没连上）：那种情况下**没有东西可清**，
			// 而在这里报一句"清理失败"会把上面那条真正的失败原因淹掉（实测撞过一次：
			// 端口被上一轮残留实例占着 ⇒ 真因在下面，最上面却先喊"清理夹具失败"）。
			if (client) {
				log(`  ⚠️ 清理夹具失败（下次跑之前手动删掉 acc-verify/ 即可）：${error.message}`);
			}
		}
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
		await delay(2500);
		// ⭐ 备份原样写回（设置与索引）
		for (const { from, to } of backups) {
			try {
				copyFileSync(to, from);
				unlinkSync(to);
			} catch (error) {
				log(`  ⚠️ 恢复 ${from} 失败：${error.message}`);
			}
		}
		log("  · 已还原设置与索引");
	}

	await finishRun();
}

/** 汇总并退出（正常路径与"提前跳过"路径共用）。 */
async function finishRun() {
	const failed = results.filter((item) => !item.ok);
	const skipped = results.filter((item) => item.skipped);
	const passed = results.length - failed.length - skipped.length;
	log("");
	log("═".repeat(84));
	log(
		failed.length === 0
			? `✓ 真机探针通过：${passed} 项${skipped.length > 0 ? `（另有 ${skipped.length} 项跳过，原因见上）` : ""}`
			: `✗ 未通过 ${failed.length} / ${results.length} 项：${failed.map((f) => f.name).join(" ／ ")}`
	);
	log("═".repeat(84));
	process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});