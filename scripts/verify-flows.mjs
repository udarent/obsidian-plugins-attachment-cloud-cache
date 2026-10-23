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
import { DOM_HELPERS, closeDialog, dialogSnapshot, runCommand, waitForDialog } from "./lib/verify-dom.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9223)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
/** 插件 id（与 manifest 一致）。 */
const PLUGIN_ID = "attachment-cloud-cache";
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

		// ── 3) 上传附件：标题 / 顶部一段 / 行内标签 / 失效行图标 / 只看当前笔记 ──
		// ⚠️ 命令取消之后，「上传」这条入口只剩**设置页那颗按钮**（与原来那条命令
		// 是**同一个实现** `runUploadAttachments`）。所以这一段改成点那颗按钮 ——
		// 下面那些断言（标题 / 顶部一段 / 失效行 / 只看当前笔记 / aria-label）测的是
		// 同一个清单壳，判据一个字没变，换的只是“谁去按”。
		// ⚠️ **为什么直接调 `runUploadAttachments()` 而不是点设置页那颗按钮**：
		// 这个宿主（1.14.4）里 `app.setting.open()` 明明返回了、`app.setting` 也在，
		// 但设置弹窗**没有生成**（三条路都试过：`setting.open` / `app:open-settings` 命令 /
		// `openTabById`，`document` 里始终 0 个 modal）。与其把一条真机断言押在“设置页能不能开”
		// 这种与我们无关的宿主行为上，不如直接调**那颗按钮绑定的同一个函数**：
		// 按钮的 onClick 只有这一句（`void this.plugin.runUploadAttachments()`），
		// 所以下面这些断言测的仍然是同一条流程、同一个清单壳。
		// ⚠️ 代价要说清：这一节**不再证明“设置页那颗按钮还在”** —— 那一点由
		// `settings-tab.ts` 的 `renderUploadAll` 与 mock 层（acceptance 也调这个函数）守着。
		const uploadStarted = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				if (!plugin || typeof plugin.runUploadAttachments !== "function") return false;
				void plugin.runUploadAttachments();
				return true;
			})()`
		);
		check("上传入口（设置页按钮绑定的同一个函数）能启动清单", uploadStarted === true);
		const { appeared, notices: seen1 } = await waitForDialog(client);
		check("「上传附件」弹出清单", appeared);
		if (!appeared) {
			const hint = await evaluate(
				client,
				`(async () => {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					return {
						notices: Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent),
						modals: document.querySelectorAll(".modal-container .modal").length,
						files: app.vault.getFiles().map((file) => file.path),
						hasClient: Boolean(plugin?.buildClient?.()),
						orphanAsk: plugin?.settings?.orphanAsk,
						errors: window.__accErrors ?? [],
					};
				})()`
			);
			throw new Error(`上传清单没有出现（轮询期间的通知：${JSON.stringify(seen1)}）：${JSON.stringify(hint)}`);
		}

		const upload = await dialogSnapshot(client);
		check(
			"标题＝命令名",
			upload.title.trim() === "上传附件",
			`实际：${JSON.stringify(upload.title)}`
		);
		check(
			"顶部只有一段，且不含数字",
			upload.lines.length === 1 && !/\d/.test(upload.lines.join(" ")),
			`${upload.lines.length} 段：${JSON.stringify(upload.lines).slice(0, 120)}`
		);

		const goneRow = upload.rows.find((row) => row.name.includes("x.png"));
		check("失效的本机文件进了清单", Boolean(goneRow), `行：${upload.rows.map((r) => r.name).join(" | ")}`);
		if (goneRow) {
			check("失效行有警示图标（真的画出了 svg）", goneRow.hasIcon && goneRow.iconSvg, `hasIcon=${goneRow.hasIcon} svg=${goneRow.iconSvg}`);
			check("失效行勾不了", goneRow.boxDisabled === true, `disabled=${goneRow.boxDisabled}`);
			check("失效行的链接写的是「打开笔记」", goneRow.openText.trim() === "打开笔记", `实际：${goneRow.openText}`);
			check("失效行副标题是完整本机路径", goneRow.meta.includes("acc-verify-does-not-exist"), goneRow.meta);
		}
		check(
			"勾选框有 aria-label（读屏能读出这一行）",
			upload.rows.every((row) => typeof row.aria === "string" && row.aria.length > 0),
			upload.rows.map((row) => `${row.name}=${row.aria}`).join(" / ")
		);
		const strayRow = upload.rows.find((row) => row.name.includes("stray.png"));
		check(
			"没人引用的附件带「没有笔记引用」标签且默认不勾",
			Boolean(strayRow) && strayRow.hint.length > 0 && strayRow.boxChecked === false,
			strayRow ? `hint=${strayRow.hint} checked=${strayRow.boxChecked}` : "没找到那一行"
		);

		const onlyNote = upload.filters.find((item) => item.name.includes("当前笔记"));
		check("有「只看当前笔记」开关", Boolean(onlyNote), upload.filters.map((f) => f.name).join(" / "));
		if (onlyNote) {
			const before = upload.rows.length;
			await evaluate(
				client,
				`(() => {
					${DOM_HELPERS}
					toggleFor("当前笔记")?.click();
					return true;
				})()`
			);
			await delay(900);
			const filtered = await dialogSnapshot(client);
			check(
				"勾上之后清单只剩这一篇里的东西",
				filtered.rows.length < before && filtered.rows.some((row) => row.name.includes("x.png")),
				`${before} 行 → ${filtered.rows.length} 行`
			);
			// 还原（否则下一条命令读到的还是过滤后的状态）
			await evaluate(
				client,
				`(() => {
					${DOM_HELPERS}
					toggleFor("当前笔记")?.click();
					return true;
				})()`
			);
			await delay(700);
		}
		check("上传弹窗能取消（取消按钮存在且点了关窗）", await closeDialog(client));

		// ⚠️ **顺序有讲究**：视图这一节放在清理之前。清理那一节在这个库里会被 `skip`，
		// 而它的跳过分支是 `return finishRun()` —— 放在它后面的断言**一条都不会跑**
		// （实测踩过：视图断言加在末尾 ⇒ 全被吞掉、汇总里看不出来）。
		// ⚠️ 设置页还在清单弹窗下面开着：先关掉，否则后面的视图断言会撞上两层 modal。
		await evaluate(client, `(() => { app.setting.close(); return true; })()`);
		await delay(400);

		// ── 4) 附件管理视图（R24 / F22）：能开、标题、筛选、动作数字 ──
		// ⚠️ 这一节**只读**：只点筛选与勾选框，**不点上传 / 删除**（那个库没配存储也会真去连远端）。
		// 视图层没有可编程 DOM 单测（替身里 `createEl` 全是桩）⇒ 这里是它唯一的证据。
		await evaluate(
			client,
			`(async () => {
				await app.commands.executeCommandById(${JSON.stringify(`${PLUGIN_ID}:manage-attachments`)});
				return true;
			})()`
		);
		await delay(1600);
		// ⚠️ **必须先点一次刷新**：视图在 `onOpen` 里取一次 `vault.getFiles()`，之后不会自动追新文件。
		// 而这一轮脚本造的两个夹具（`acc-verify/*`）是刚写进去的 ⇒ 不刷新时“视图的行数”与
		// “我这一刻数到的库内附件数”来自两个时刻，会间歇性地差两行（实测 16 与 18 交替）。
		// 点刷新既让两边同一时刻，也顺带验了那个按钮有用。
		await evaluate(
			client,
			`(() => {
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
				const button = root.querySelector(".acc-gallery-refresh");
				if (button) button.click();
				return Boolean(button);
			})()`
		);
		await delay(1200);

		const gallery = await evaluate(
			client,
			`(() => {
				const leaf = app.workspace.getLeavesOfType("acc-gallery")[0];
				const view = leaf && leaf.view;
				const root = view && view.contentEl;
				if (!root) return null;
				const attachments = app.vault
					.getFiles()
					.filter((f) => !["md", "canvas", "base"].includes(String(f.extension || "").toLowerCase()));
				const toolbar = root.querySelector(".acc-task-toolbar");
				const list = root.querySelector(".acc-task-list");
				// ⚠️ 按**结构化**字段读，不按中文文案读：文案改一次，断言就假红一次。
				const label = (el) => ((el && el.textContent) || "").trim();
				return {
					title: view.getDisplayText ? view.getDisplayText() : "",
					filters: Array.from(root.querySelectorAll(".acc-gallery-filter")).map((el) => ({
						key: el.getAttribute("data-filter") || "",
						label: label(el.querySelector(".acc-gallery-filter-label")),
						count: Number(label(el.querySelector(".acc-gallery-filter-count"))),
						// 「按下 / 弹起」两个来源都必须一致：属性（读屏）与类名（视觉）
						pressed: el.getAttribute("aria-pressed") === "true",
						activeClass: el.classList.contains("is-active"),
					})),
					// 清单自己那一行标题
					heading: label(root.querySelector(".acc-task-heading")),
					// 顶部工具按钮（应当是「全选」「全不选」两颗）
					tools: Array.from(root.querySelectorAll(".acc-task-tools button")).map(label),
					// ⭐ 结构：工具栏必须在清单**之前**（DOM 顺序，不是 CSS order）
					toolbarBeforeList: Boolean(
						toolbar && list && (toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
					),
					// 动作区里不该再出现这两颗（它们曾经被排到动作按钮下面）
					toolsInFooter: root.querySelectorAll(".acc-task-actions .acc-task-tool").length,
					names: Array.from(root.querySelectorAll(".acc-task-row .acc-task-name")).map((el) => el.textContent || ""),
					hints: Array.from(root.querySelectorAll(".acc-task-row .acc-task-hint")).map((el) => el.textContent || ""),
					lines: Array.from(root.querySelectorAll(".acc-task-lines > div")).map((el) => el.textContent || ""),
					checkboxes: root.querySelectorAll(".acc-task-check").length,
					expected: attachments.length,
				};
			})()`
		);

		check("「附件管理」命令能打开视图", Boolean(gallery), gallery ? "已打开" : "没找到 acc-gallery 的 leaf");
		check("视图标题＝附件管理", gallery?.title === "附件管理", `实际：${JSON.stringify(gallery?.title)}`);
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
			"清单有一行自己的标题（附件清单）",
			gallery?.heading === "附件清单",
			`实际：${JSON.stringify(gallery?.heading)}`
		);
		check(
			"「全选 / 全不选」在清单**上方**，且不在动作区里",
			(gallery?.tools ?? []).join(",") === "全选,全不选" &&
				gallery?.toolbarBeforeList === true &&
				gallery?.toolsInFooter === 0,
			`tools=${JSON.stringify(gallery?.tools ?? [])} beforeList=${gallery?.toolbarBeforeList} inFooter=${gallery?.toolsInFooter}`
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
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
				const rows = Array.from(root.querySelectorAll(".acc-task-row"));
				const target = rows.find((row) => {
					const hint = row.querySelector(".acc-task-hint")?.textContent || "";
					const box = row.querySelector(".acc-task-check");
					return hint.indexOf("云端有本地无") === 0 && box && !box.disabled;
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
			"每行都有状态标签（不是只列文件名）",
			gallery?.names.length === gallery?.hints.length && (gallery?.hints ?? []).every((hint) => hint.trim().length > 0),
			`${gallery?.hints.length} 个标签，例：${JSON.stringify((gallery?.hints ?? [])[0] ?? "")}`
		);

		// 动作按钮的数字＝**能作用的件数**；重命名只对单选成立（§5.5 的判据在真机上的落点）
		const perAction = await evaluate(
			client,
			`(() => {
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
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
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
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
						hints: Array.from(root.querySelectorAll(".acc-task-row .acc-task-hint")).map((el) => el.textContent || ""),
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
			? { rows: byFilter["to-clean"].rows, hints: byFilter["to-clean"].hints }
			: null;
		check(
			"「待清理」里每一行都带「没人引用」",
			toClean !== null && toClean.rows > 0 && toClean.hints.every((hint) => hint.includes("没人引用")),
			toClean === null ? "没有「待清理」胶囊" : `${toClean.rows} 行：${JSON.stringify(toClean.hints.slice(0, 3))}`
		);

		// 顶部两颗工具按钮真的管用（它们从动作区下面搬到了清单上方 ⇒ 先证接线没断）
		const selectionTools = await evaluate(
			client,
			`(() => {
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
				const pick = () =>
					Array.from(root.querySelectorAll(".acc-task-tools button")).reduce((acc, el) => {
						const text = (el.textContent || "").trim();
						if (text === "全选" || text === "全不选") acc[text] = el;
						return acc;
					}, {});
				const checked = () =>
					Array.from(root.querySelectorAll(".acc-task-check")).filter((box) => box.checked && !box.disabled).length;
				const before = { tools: pick(), checked: checked() };
				if (!before.tools["全不选"] || !before.tools["全选"]) return { error: "顶部没有这两颗按钮" };
				// ⚠️ 顺序：先全选、再全不选。视图打开时一件都没勾 ⇒ 「全不选」是**灰的**，
				// 先点它什么也不会发生（那条"灰着"本身就是另一条断言，见下）。
				before.tools["全选"].click();
				const afterAll = checked();
				before.tools["全不选"].click();
				const afterNone = checked();
				return {
					selectedAtOpen: before.checked,
					afterNone,
					afterAll,
					pickable: root.querySelectorAll(".acc-task-check:not(:disabled)").length,
					noneDisabledWhenEmpty: (() => {
						const el = Array.from(root.querySelectorAll(".acc-task-tools button")).find(
							(b) => (b.textContent || "").trim() === "全不选"
						);
						return el ? el.disabled === true : null;
					})(),
				};
			})()`
		);
		check(
			"「全不选」清空勾选、「全选」把能勾的都勾上",
			selectionTools?.afterNone === 0 &&
				selectionTools?.afterAll === selectionTools?.pickable &&
				selectionTools?.pickable > 0,
			JSON.stringify(selectionTools ?? null)
		);
		check(
			"一件没勾时「全不选」是灰的（点下去不会有反应 ⇒ 不许看着能点）",
			selectionTools?.noneDisabledWhenEmpty === true,
			JSON.stringify(selectionTools ?? null)
		);

		// 「删除（云端）」的默认档（CR-05）：没人引用的可删，仍被引用的**灰掉**
		const cloudAction = await evaluate(
			client,
			`(() => {
				const root = app.workspace.getLeavesOfType("acc-gallery")[0].view.contentEl;
				const rows = Array.from(root.querySelectorAll(".acc-task-row"));
				const textOf = (row) => ({
					name: row.querySelector(".acc-task-name")?.textContent || "",
					hint: row.querySelector(".acc-task-hint")?.textContent || "",
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
				const free = all.find((row) => row.hint.includes("没人引用") && row.hint.includes("云端有本地无"));
				// ⚠️ 不用精确等号：同一个状态后面可能还缀着「· 没人引用」。
				// 要的是“已上传 **且仍被引用**”那一行（CR-05 只对它禁用删云端）。
				const used = all.find((row) => row.hint.indexOf("已上传") === 0 && row.hint.indexOf("没人引用") < 0);
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

		// ── 5) 清理：**手动入口已并入视图**（CR-02）──
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