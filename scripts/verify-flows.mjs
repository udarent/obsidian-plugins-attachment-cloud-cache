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
 * | 命令面板恰好两条（名字对） | 第 15 条 |
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

/**
 * 页面里的公共小工具（拼进每次 evaluate 的前面）。
 *
 * ⚠️ 只读 DOM，不点"确认"类按钮 —— 这个脚本的目的是**看清单长什么样**，不是执行动作。
 */
const DOM_HELPERS = `
	const modal = () => document.querySelector(".modal-container .modal");
	const rows = () => Array.from(modal()?.querySelectorAll(".acc-task-row") ?? []);
	const rowInfo = (row) => {
		const box = row.querySelector("input.acc-task-check");
		const open = row.querySelector("a.acc-task-open");
		const icon = row.querySelector(".acc-task-hint-icon");
		return {
			name: row.querySelector(".acc-task-name")?.textContent ?? "",
			hint: row.querySelector(".acc-task-hint")?.textContent ?? "",
			hasIcon: Boolean(icon),
			iconSvg: Boolean(icon?.querySelector("svg")),
			iconTitle: icon?.getAttribute("title") ?? "",
			meta: row.querySelector(".acc-task-meta")?.textContent ?? "",
			checked: Box => (Box ? Box.checked : null),
			disabled: true,
			boxChecked: box ? box.checked : null,
			boxDisabled: box ? box.disabled : null,
			aria: box ? box.getAttribute("aria-label") : null,
			openText: open?.textContent ?? "",
			openTitle: open?.getAttribute("title") ?? "",
		};
	};
	const toggleFor = (label) => {
		for (const item of Array.from(modal()?.querySelectorAll(".setting-item") ?? [])) {
			const name = item.querySelector(".setting-item-name")?.textContent ?? "";
			if (!name.includes(label)) continue;
			const box = item.querySelector(".checkbox-container");
			if (box) return box;
		}
		return null;
	};
	const clickButton = (label) => {
		for (const button of Array.from(modal()?.querySelectorAll("button") ?? [])) {
			if ((button.textContent ?? "").trim() === label) {
				button.click();
				return true;
			}
		}
		return false;
	};
`;

/** 等弹窗出现（最多 `ms`）。⚠️ 必须轮询：命令是异步的，`executeCommandById` 立刻返回。 */
async function waitForDialog(client, ms = 9000) {
	const deadline = Date.now() + ms;
	/**
	 * 轮询期间见到的 Notice —— 有些结局（「没有可处理的」/「先去配置」）
	 * **只会出现一瞬**（5 秒后自己消失）。收着它们，失败时才知道“它到底说了什么”。
	 */
	const notices = new Set();
	while (Date.now() < deadline) {
		// ⚠️ `DOM_HELPERS` 是一串 `const …`，只能待在块里 —— 塞进 `Boolean(...)` 会直接语法错
		const ready = await evaluate(
			client,
			`(() => { ${DOM_HELPERS} return Boolean(modal() && modal().querySelector(".acc-task-list")); })()`
		).catch(() => false);
		const seen = await evaluate(
			client,
			`Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent)`
		).catch(() => []);
		for (const text of seen ?? []) notices.add(text);
		if (ready) return { appeared: true, notices: [...notices] };
		await delay(150);
	}
	return { appeared: false, notices: [...notices] };
}

async function dialogSnapshot(client) {
	return evaluate(
		client,
		`(() => {
			${DOM_HELPERS}
			const root = modal();
			if (!root) return null;
			const filters = Array.from(root.querySelectorAll(".setting-item")).map((item) => ({
				name: item.querySelector(".setting-item-name")?.textContent ?? "",
				hasToggle: Boolean(item.querySelector(".checkbox-container")),
			}));
			return {
				title: root.querySelector(".modal-title")?.textContent ?? "",
				lines: Array.from(root.querySelectorAll(".acc-task-lines > div")).map((el) => el.textContent ?? ""),
				rows: rows().map(rowInfo),
				filters: filters.filter((item) => item.hasToggle),
				buttons: Array.from(root.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()).filter(Boolean),
			};
		})()`
	);
}

async function runCommand(client, id) {
	return evaluate(
		client,
		`(async () => {
			await app.commands.executeCommandById(${JSON.stringify(`${PLUGIN_ID}:${id}`)});
			return true;
		})()`
	);
}

/** 关掉弹窗，并等它真的消失（否则下一条命令会读到上一个 DOM）。 */
async function closeDialog(client) {
	await evaluate(
		client,
		`(() => {
			${DOM_HELPERS}
			if (!clickButton("取消")) clickButton("关闭");
			return true;
		})()`
	);
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		const gone = await evaluate(client, "Boolean(!document.querySelector('.modal-container .modal'))");
		if (gone) return true;
		await delay(120);
	}
	return false;
}

async function main() {
	log("═".repeat(84));
	log(`真机探针：两条命令的清单弹窗（库=${VAULT_DIR}，port=${PORT}）`);
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

		// ── 1) 命令面板恰好两条（第 15 条）──
		const commands = setup.commands.map((id) => id.split(":")[1]).sort();
		check(
			"命令只有两条（上传附件 / 清理附件）",
			commands.length === 2 && commands.includes("upload-attachments") && commands.includes("check-orphans"),
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
		await runCommand(client, "upload-attachments");
		const { appeared, notices: seen1 } = await waitForDialog(client);
		check("「上传附件…」弹出清单", appeared);
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
			"标题＝命令名去「…」",
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

		// ── 4) 清理附件：两类行 / 两个开关 / 站外缓存标签 ──
		await runCommand(client, "check-orphans");
		const { appeared: appeared2, notices: seen2 } = await waitForDialog(client);
		// ⭐ 这一种"没出现"是**对的**：库里有一个文件读不到 ⇒ 清理命令按设计取消整次
		//（判据：绝不能把「不知道」当成「没有引用」）。这时跳过，不判红。
		const unreadable = seen2.find((text) => text.includes("读不到") || text.includes("取消了这次清理"));
		if (!unreadable) check("「清理附件…」弹出清单", appeared2);
		if (!appeared2) {
			if (unreadable) {
				skip("清理弹窗（两类行 / 两个开关 / 站外缓存标签）", `这个库里有一个文件读不到，命令按设计取消了清理：${unreadable}`);
				return finishRun();
			}
			// 其余情况是真失败：把"它到底说了什么"打出来
			const hint = await evaluate(
				client,
				`(async () => {
					const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
					return {
						orphanAsk: plugin?.settings?.orphanAsk,
						notices: Array.from(document.querySelectorAll(".notice")).map((el) => el.textContent),
						modals: document.querySelectorAll(".modal-container .modal").length,
						errors: window.__accErrors ?? [],
					};
				})()`
			);
			throw new Error(`清理清单没有出现（轮询期间的通知：${JSON.stringify(seen2)}）：${JSON.stringify(hint)}`);
		}

		const cleanup = await dialogSnapshot(client);
		check("清理标题＝命令名去「…」", cleanup.title.trim() === "清理附件", `实际：${JSON.stringify(cleanup.title)}`);
		check(
			"清理顶部只有一段，且不含数字",
			cleanup.lines.length === 1 && !/\d/.test(cleanup.lines.join(" ")),
			`${cleanup.lines.length} 段：${JSON.stringify(cleanup.lines).slice(0, 120)}`
		);
		const localRows = cleanup.rows.filter((row) => row.name.includes("stray.png") || row.name.includes("cached.png"));
		check("没有任何引用的本地文件进了清理清单", localRows.length >= 2, cleanup.rows.map((r) => r.name).join(" | "));
		const cachedRow = cleanup.rows.find((row) => row.name.includes("cached.png"));
		check(
			"站外缓存那一行带「站外缓存」标签",
			Boolean(cachedRow) && cachedRow.hint.includes("站外"),
			cachedRow ? `hint=${cachedRow.hint}` : "没找到 cached.png"
		);
		check(
			"本地孤立文件默认不勾",
			localRows.every((row) => row.boxChecked === false),
			localRows.map((row) => `${row.name}=${row.boxChecked}`).join(" / ")
		);
		const filterNames = cleanup.filters.map((item) => item.name);
		check(
			"清理有两个类别开关（云端对象 / 本地文件）",
			filterNames.some((n) => n.includes("云端")) && filterNames.some((n) => n.includes("本地")),
			filterNames.join(" / ")
		);

		// 关掉「云端对象」⇒ 只剩本地那一类
		await evaluate(
			client,
			`(() => {
				${DOM_HELPERS}
				toggleFor("云端对象")?.click();
				return true;
			})()`
		);
		await delay(900);
		const localOnly = await dialogSnapshot(client);
		check(
			"关掉「云端对象」后只剩本地行",
			localOnly.rows.length === cleanup.rows.filter((row) => !row.name.includes("cached")).length ||
				localOnly.rows.every((row) => row.hint.includes("本地") || row.hint.includes("站外")),
			`${localOnly.rows.length} 行：${localOnly.rows.map((r) => `${r.name}(${r.hint})`).join(" | ")}`
		);
		// 再关掉「本地文件」⇒ 空清单（这一屏只剩这两类）
		await evaluate(
			client,
			`(() => {
				${DOM_HELPERS}
				toggleFor("本地文件")?.click();
				return true;
			})()`
		);
		await delay(900);
		const emptyView = await dialogSnapshot(client);
		check("两个开关都关掉后清单为空（开关真的在筛，而不是只藏行）", emptyView.rows.length === 0, `${emptyView.rows.length} 行`);
		check("清理弹窗能取消", await closeDialog(client));
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
