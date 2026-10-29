/**
 * 真机探针：设置页（「统一对象名」按钮 ＋ 连接自检，外加一条"那一项已删"的否定式守卫）。
 *
 * ## 它补的是哪个洞
 *
 * R25 的四块代码在 2026-10-25 全部落地，但**入口**只有单测与 mock 上的证据：
 *
 * | 入口 | 此前只有 | 真机回答不了的问题 |
 * |---|---|---|
 * | 「内容寻址 key」那一项 | `settings-ui-suite` 的**结构**守卫 | ⚠️ 1.12.0 已删（key 形状固定纯哈希）⇒ 现在钉的是**它不许回来** |
 * | 「测试连接」 | 单测里的替身客户端 | 真密钥够不够列 `_acc/v1/`？⭐ 2026-10-28 起**无条件**列（跨设备保护不再可选）⇒ 缺 `ListBucket` 会在这里就红，不等用户点了清理才发现 |
 * | 「统一对象名」按钮 | `migrate-flow` 的**替身**确认框 | 按钮在不在、点下去弹不弹、弹出来的**数字与句子**对不对、"不做"那颗按钮是不是本地化的（D-96）？ |
 *
 * 单测能证明"传进去的 `confirmMaintenance` 被调用了"，证明不了"用户看到的是这几句话"。
 *
 * ## 它**不做什么**（有意）
 *
 * - **不确认**统一对象名：那会真复制、真删旧、真改写笔记。这里只走到确认框，然后**点取消**，
 *   并断言"取消＝什么都没发生"（`migrationState` 与文件数不变）。
 * - **不往桶里写声明**：上传前登记（`IngestDeps.declareRef`）那条链需要真的上传一个附件，
 *   而在用户自己的库/桶上做这件事不是这个探针该干的 —— 那条链的证据在
 *   `verify:confirm` §9（mock 上端到端）与 `verify:migrate` §7（真实桶上的声明读写）。
 *
 * 唯一碰远端的是「测试连接」自己那一轮（写一个几十字节的探针对象、立刻删掉，D-53 的被测行为），
 * 外加一次只读的 `listObjects({ prefix: "_acc/v1/" })`。
 *
 * ## 会动什么
 *
 * - **不改任何设置项**（那个开关已删）。唯一可能落盘的是 `migrationState`，
 *   结束时用备份还原并复核 —— 不还原会让下一次跑撞上"上一轮留下脏状态"。
 * - 设置页会被打开、导航到本插件那一页；跑完关掉。
 *
 * 用法：`npm run verify:settings`（`node scripts/verify-settings-real.mjs [--port 9242]`）
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_DEBUG_PORT / OBSIDIAN_DEBUG_WAIT / ACC_SETTINGS_VAULT_DIR
 *
 * ⚠️ 跑之前**必须关掉所有 Obsidian**（宿主单实例；有残留会连到旧实例，断言全错位）。
 * ⚠️ 跑之前**必须** `npm run build && npm run install:demo`：探针读的是演示库里的那份 `main.js`，
 *    它就是构建产物 —— 忘了拷就是拿旧版在测（症状是"断言全对，但改动根本没生效"）。
 */

import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9242)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PLUGIN_ID = "attachment-cloud-cache";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT_DIR = process.env.ACC_SETTINGS_VAULT_DIR ?? resolve(REPO, "..", "ObsidianVault");
const VAULT = process.env.OBSIDIAN_VAULT ?? (VAULT_DIR.split(/[\\/]/).filter(Boolean).pop() || "ObsidianVault");
const PLUGIN_DIR = join(VAULT_DIR, ".obsidian", "plugins", PLUGIN_ID);
const DATA_JSON = join(PLUGIN_DIR, "data.json");
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);

const log = (line = "") => console.log(line);
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: Boolean(ok) });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

/** 读盘上那份 `data.json`（解析失败给 `null`：正在写的瞬间可能读到半截）。 */
function readDataJson() {
	try {
		return JSON.parse(readFileSync(DATA_JSON, "utf8"));
	} catch {
		return null;
	}
}

/**
 * 打开设置页并落到本插件那一页。
 *
 * ⚠️ 两条实测坑（2026-10-18，`verify-connection-probe` 里也写着）：
 * ① 设置页的 DOM 不在主 `document` 里，要从 `app.setting.modalEl` 往下找；
 * ② `app.setting.openTabById(id)` 在这个宿主版本**不换页**，得点左侧导航项（按显示名匹配）。
 */
const OPEN_SETTINGS = `(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	await app.setting.open();
	await sleep(900);
	const root = app.setting.modalEl;
	if (!root) return { error: "读不到 app.setting.modalEl" };
	const name = (app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}] || {}).name;
	const tabName = name || ${JSON.stringify(PLUGIN_ID)};
	const nav = Array.from(root.querySelectorAll(".vertical-tab-nav-item")).find(
		(n) => (n.textContent ?? "").trim() === tabName
	);
	if (!nav) return { error: "设置页左侧找不到「" + tabName + "」这一项" };
	nav.click();
	await sleep(1500);
	return { ok: true, tabName };
})()`;

/** 结构：「统一对象名」在「测试连接」之前；已删的「内容寻址 key」不许出现。 */
const READ_STRUCTURE = `(() => {
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const root = app.setting.modalEl;
	const rows = Array.from(root.querySelectorAll(".setting-item"));
	const names = rows.map((r) => (r.querySelector(".setting-item-name")?.textContent ?? "").trim());
	const at = (label) => names.indexOf(label);

	const labels = {
		unify: plugin.t("unifyNamesName"),
		test: plugin.t("testConnection"),
	};

	return {
		labels,
		names,
		// ⚠️ 1.12.0：「内容寻址 key」那一项**已删**（key 形状固定纯哈希，不再是决策）。
		// 这条是**否定式守卫** —— 它回来就意味着"一个实现机制又被摆成用户要判断的选择题"。
		contentAddressedRow:
			at("内容寻址 key") >= 0 || at("Content-addressed keys") >= 0 || at("contentAddressed") >= 0,
		unify: at(labels.unify),
		test: at(labels.test),
		unifyButton: (() => {
			const index = at(labels.unify);
			if (index < 0) return null;
			const button = Array.from(rows[index].querySelectorAll("button")).find(
				(b) => (b.textContent ?? "").trim() === plugin.t("unifyNamesButton")
			);
			return button ? { text: (button.textContent ?? "").trim(), disabled: button.disabled } : null;
		})(),
	};
})()`;

/**
 * 点「测试连接」并读结果（一次点击 + 等按钮回到可用）。
 *
 * 1.12.0 起自检**无条件**跑 `_acc/v1/` 的 `ListBucket` 探测（跨设备保护默认生效）——
 * 权限不够会多出一行原因（`testFail_listPermission`），所以"**只有一句结论**"本身就是自检通过的证据。
 */
const RUN_CONNECTION_TEST = `(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const root = app.setting.modalEl;
	const label = plugin.t("testConnection");
	const row = Array.from(root.querySelectorAll(".setting-item")).find(
		(r) => (r.querySelector(".setting-item-name")?.textContent ?? "").trim() === label
	);
	if (!row) return { error: "设置页里找不到「" + label + "」这一行" };
	const find = () =>
		Array.from(row.querySelectorAll("button")).find((b) => /^(Test connection|测试连接)$/.test((b.textContent ?? "").trim()));
	const button = find();
	if (!button) return { error: "「测试连接」那一行没有按钮" };
	const idle = async (timeout) => {
		const from = Date.now();
		while (Date.now() - from < timeout) {
			const b = find();
			if (b && !b.disabled) return true;
			await sleep(150);
		}
		return false;
	};
	if (!(await idle(20000))) return { error: "测试连接按钮一直不可用" };
	button.click();
	const settled = await idle(30000);
	const head = root.querySelector(".acc-status-head");
	const dot = head ? head.querySelector(".acc-status-dot") : null;
	return {
		settled,
		state: plugin.currentConnectionState(),
		headClass: head ? head.className : null,
		dotClass: dot ? dot.className : null,
		text: head ? (head.innerText ?? "").trim().replace(/\\n+/g, " / ") : "",
		lines: Array.from(root.querySelectorAll(".acc-test-line")).map((e) => (e.textContent ?? "").trim()),
		lineClasses: Array.from(root.querySelectorAll(".acc-test-line")).map((e) => e.className),
	};
})()`;

/**
 * 确认框在**哪个文档**里？—— 这件事只能问运行时。
 *
 * ⚠️⚠️ 设置页是**独立窗口**（`app.setting.modalEl` 在那个窗口的 document 里），
 * 而 `new Modal(app)` 挂到的是**当前活动窗口**的 body 上。实测（2026-10-25 第一次跑）：
 * 只查主 `document` 的 `.modal-container .modal` 会**什么都找不到** ——
 * 症状是"点了没弹框"，而实际上框早就开着、`unifyObjectNames` 正 `await` 它，
 * 于是那条 CDP 命令一直不返回、最后撞上 90 秒的超时（看起来像宿主卡死）。
 *
 * ⇒ 三个候选文档都查一遍（主窗、`activeDocument`、设置页自己的文档），去重。
 */
const FINDER = `
	const documents = () => {
		const set = new Set();
		try { if (typeof document !== "undefined" && document) set.add(document); } catch (e) {}
		try { if (typeof activeDocument !== "undefined" && activeDocument) set.add(activeDocument); } catch (e) {}
		try { const d = app.setting.modalEl && app.setting.modalEl.ownerDocument; if (d) set.add(d); } catch (e) {}
		return Array.from(set);
	};
	const settingsModal = app.setting.modalEl;
	const findConfirm = () => {
		for (const doc of documents()) {
			const found = Array.from(doc.querySelectorAll(".modal-container .modal")).find((m) => {
				if (settingsModal && settingsModal.ownerDocument === doc && settingsModal.contains(m)) return false;
				return (m.querySelector(".modal-title")?.textContent ?? "").trim().length > 0;
			});
			if (found) return found;
		}
		return null;
	};
	const readNotices = () => {
		const out = [];
		for (const doc of documents()) {
			for (const n of doc.querySelectorAll(".notice")) {
				const text = (n.textContent ?? "").trim();
				if (text && !out.includes(text)) out.push(text);
			}
		}
		return out;
	};
`;

/** 点一下「统一对象名」（**不等待**：预检可能要几十秒，而单条 CDP 命令 90 秒就超时）。 */
const CLICK_UNIFY = `(() => {
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const root = app.setting.modalEl;
	const label = plugin.t("unifyNamesName");
	const row = Array.from(root.querySelectorAll(".setting-item")).find(
		(r) => (r.querySelector(".setting-item-name")?.textContent ?? "").trim() === label
	);
	if (!row) return { error: "设置页里找不到「" + label + "」这一行" };
	const button = Array.from(row.querySelectorAll("button")).find(
		(b) => (b.textContent ?? "").trim() === plugin.t("unifyNamesButton")
	);
	if (!button) return { error: "那一行没有「" + plugin.t("unifyNamesButton") + "」按钮" };
	if (button.disabled) return { error: "按钮是 disabled 的" };
	button.click();
	return { clicked: true };
})()`;

/** 读一眼：确认框开了没 / 有没有通知（短命令，由 Node 侧反复调）。 */
const READ_UNIFY = `(() => {${FINDER}
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const modal = findConfirm();
	const notices = readNotices();
	const expected = {
		title: plugin.t("unifyNamesConfirmTitle"),
		cta: plugin.t("unifyNamesConfirmCta"),
		cancel: plugin.t("maintainCancel"),
		nothing: plugin.t("unifyNamesNothing"),
		testOk: plugin.t("testOk"),
	};
	if (!modal) {
		return {
			confirm: false,
			notices,
			expected,
			migrating: plugin.unifying === true,
			docs: documents().length,
			modals: documents().map((d) => d.querySelectorAll(".modal-container .modal").length),
		};
	}
	const buttons = Array.from(modal.querySelectorAll("button"));
	const content = modal.querySelector(".modal-content");
	const lines = content
		? Array.from(content.children)
				.filter((el) => el.tagName === "DIV" && !el.classList.contains("setting-item"))
				.map((el) => (el.textContent ?? "").trim())
				.filter(Boolean)
		: [];
	return {
		confirm: true,
		title: (modal.querySelector(".modal-title")?.textContent ?? "").trim(),
		lines,
		buttons: buttons.map((b) => (b.textContent ?? "").trim()),
		classes: buttons.map((b) => b.className),
		expected,
	};
})()`;

/** 点确认框里那颗「不做」的按钮，等它消失。 */
const CANCEL_UNIFY = `(() => {${FINDER}
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const modal = findConfirm();
	if (!modal) return { error: "确认框已经不见了（无法断言取消路径）" };
	const cancelText = plugin.t("maintainCancel");
	const button = Array.from(modal.querySelectorAll("button")).find(
		(b) => (b.textContent ?? "").trim() === cancelText
	);
	if (!button) {
		return {
			error: "找不到「" + cancelText + "」那颗按钮",
			buttons: Array.from(modal.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()),
		};
	}
	button.click();
	return { clicked: true };
})()`;

/** 只问"确认框还在吗"（取消之后等它消失）。 */
const CONFIRM_GONE = `(() => {${FINDER}
	return { gone: findConfirm() === null };
})()`;

async function main() {
	const others = await countObsidianProcesses();
	if (others === null || others > 0) {
		throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑（单实例锁）—— 先全部关掉`);
	}
	if (!existsSync(join(VAULT_DIR, ".obsidian"))) {
		throw new Error(`找不到库 ${VAULT_DIR}（没有 .obsidian/）—— 用 ACC_SETTINGS_VAULT_DIR 指定`);
	}
	if (!existsSync(DATA_JSON)) throw new Error(`找不到 ${DATA_JSON} —— 这个库里还没配置过本插件`);

	// 备份：正常路径会按原值点回去，这份只在"中途崩了"时兜底
	const backup = `${DATA_JSON}.acc-settings-bak`;
	copyFileSync(DATA_JSON, backup);
	const original = JSON.parse(readFileSync(DATA_JSON, "utf8"));

	log("═".repeat(84));
	log("真机探针：设置页（那一项已删 ⇒ 否定式守卫 / 统一对象名 / 连接自检）");
	log("═".repeat(84));
	log(`  库   ${VAULT_DIR}`);
	log(`  桶   ${original?.s3?.bucket ?? "?"} @ ${original?.s3?.endpoint ?? "?"}`);
	log(`  起始 migrationState=${original.migrationState ?? "idle"}`);
	log();

	let client = null;
	let child = null;

	try {
		const attached = await launchAndAttach({ exe: OBSIDIAN, port: PORT, vault: VAULT, waitSeconds: WAIT_SECONDS, log });
		client = attached.client;
		child = attached.child;

		const loaded = await evaluate(
			client,
			`(async () => {
				for (let i = 0; i < 90; i += 1) {
					const p = app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
					if (p?._loaded) return { ok: true, state: p.settings.migrationState };
					await new Promise((r) => setTimeout(r, 500));
				}
				return { ok: false };
			})()`
		);
		if (!loaded.ok) throw new Error("插件没有加载成功");
		check("插件已加载（migrationState 可读）", typeof loaded.state === "string", `migrationState=${loaded.state}`);

		const opened = await evaluate(client, OPEN_SETTINGS);
		if (opened.error) throw new Error(opened.error);
		log(`  设置页已打开（导航项「${opened.tabName}」）`);

		// ── §1 结构：那一项已删、统一对象名的按钮在、顺序对 ──
		//
		// ⚠️ 2026-10-29：①–⑧ 里有六条是「内容寻址 key 开关点一下真落盘」，而那一项已删
		// （key 形状固定纯哈希）⇒ 整段作废。后面 ⑨–⑫ 的编号**故意不重排**：
		// 它们与验收证据里记录的编号一一对应，重排会让历史记录对不上当前脚本。
		const structure = await evaluate(client, READ_STRUCTURE);
		if (structure.error) throw new Error(structure.error);
		const { labels } = structure;
		check(
			"① ★ 「内容寻址 key」那一项**不存在**（形状固定，不该是给用户的选择题）",
			structure.contentAddressedRow === false,
			`设置页共 ${structure.names.length} 行，未命中该标题`
		);
		check(
			"② 「统一对象名」那一行的按钮在且可用",
			Boolean(structure.unifyButton) && structure.unifyButton.disabled === false,
			JSON.stringify(structure.unifyButton)
		);
		check(
			"③ 顺序是「统一对象名 → 测试连接」（动作排在组尾）",
			structure.unify >= 0 && structure.test > structure.unify,
			`下标 unify=${structure.unify} test=${structure.test}`
		);

		// ── §3 连接自检：ListBucket 探测**无条件**跑（跨设备保护默认生效）──		const conn = await evaluate(client, RUN_CONNECTION_TEST);
		if (conn.error) throw new Error(conn.error);
		check("⑨ 测试连接跑完了（按钮回到可用）", conn.settled);
		check(
			"⑩ 结论是通的",
			conn.state === "private" || conn.state === "public",
			`state=${conn.state} 灯=「${conn.text}」`
		);
		// ⚠️ 只数行数是**不够**的：`ListBucket` 失败也只是一行（换成了错误那一句）。
		// 判据要落在**档位**上 —— 成功那行的 class 是 `acc-test-ok`，失败是 `acc-test-error`。
		check(
			"⑪ ★ 那一行是「连上了」，不是「不能列桶」（`ListBucket` 权限够）",
			conn.lines.length === 1 && String(conn.lineClasses[0] ?? "").includes("acc-test-ok"),
			`${conn.lineClasses.join(" ／ ")} → ${conn.lines.join(" ⏐ ")}`
		);
		const listPermission = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const client = plugin.buildClient();
				if (!client) return { error: "buildClient() 为 null" };
				try {
					const listed = await client.listObjects({ prefix: "_acc/v1/", maxKeys: 5 });
					return { ok: true, keys: listed.objects.length };
				} catch (error) {
					return { error: String(error && error.message ? error.message : error) };
				}
			})()`
		);
		check(
			"⑫ ★ 密钥真的带 `ListBucket`（独立问一次 `_acc/v1/`）",
			listPermission.ok === true,
			listPermission.ok ? `列出 ${listPermission.keys} 个 key` : listPermission.error
		);

		// ── §4 「统一对象名」：点到确认框，逐字核对 ──
		//
		// ⚠️ 分两段：点一下是短命令，之后由**这一侧**反复问"弹出来了没"。
		// 把等待写在注入的代码里会让那条 CDP 命令活过 90 秒上限（实测过一次，
		// 报的是"命令没有应答"——像宿主卡死，其实是框早开了、我们没找到它）。
		const clicked = await evaluate(client, CLICK_UNIFY);
		if (clicked.error) throw new Error(clicked.error);
		const startedAt = Date.now();
		// ⚠️ 基线：§3「测试连接」成功时那条通知会挂 5 秒左右，**别把它当成"预检提前返回了"**
		//（第一版就是这么挂的：循环在第一轮就退出，报"通知是［连接正常…］"，像极了没弹框）。
		const baseline = (await evaluate(client, READ_UNIFY)).notices ?? [];
		const fresh = (state) =>
			(state.notices ?? []).filter((text) => !baseline.includes(text) && text !== state.expected?.testOk);
		let unify = await evaluate(client, READ_UNIFY);
		while (!unify.confirm && fresh(unify).length === 0 && Date.now() - startedAt < 150000) {
			await delay(700);
			unify = await evaluate(client, READ_UNIFY);
		}
		const noticed = fresh(unify);
		const elapsed = Date.now() - startedAt;
		let cancelChecked = false;
		if (!unify.confirm) {
			// 两种正当理由都要如实说出来；不能算通过
			check(
				"⑬ 弹出了确认框（或如实说明为什么不弹）",
				false,
				noticed.length > 0
					? `没弹确认框，通知是：${JSON.stringify(noticed)}`
					: `等了 ${(elapsed / 1000).toFixed(0)} 秒还是没弹（preflight 仍在跑：${unify.migrating}；文档 ${unify.docs} 个、其中 .modal ${JSON.stringify(unify.modals)} 个）`
			);
		} else {
			log(`  · 预检用了 ${(elapsed / 1000).toFixed(1)} 秒（读全库笔记 + 列整个桶）`);
			check("⑬ 弹出了确认框，标题与文案表一致", unify.title === unify.expected.title, `「${unify.title}」`);
			check(
				"⑭ 正文里没有漏掉的占位符（`{count}` 之类必须被替换）",
				unify.lines.length >= 4 && unify.lines.every((line) => !line.includes("{") && !line.includes("}")),
				unify.lines.join(" ⏐ ")
			);
			const ctaIndex = unify.buttons.indexOf(unify.expected.cta);
			const cancelIndex = unify.buttons.indexOf(unify.expected.cancel);
			check(
				"⑮ 两颗按钮都在：确认那颗 + 「不做」那颗（后者按语种翻译）",
				ctaIndex >= 0 && cancelIndex >= 0,
				`按钮 ${JSON.stringify(unify.buttons)}（期望取消＝「${unify.expected.cancel}」）`
			);
			check(
				"⑯ ★ 「不做」不是硬编码英文（D-96）",
				cancelIndex >= 0 && unify.buttons[cancelIndex] !== "Cancel",
				`实际「${unify.buttons[cancelIndex] ?? "（无）"}」`
			);
			check(
				"⑰ 破坏性动作看得出来（确认那颗的 class 与「不做」不同）",
				ctaIndex >= 0 && cancelIndex >= 0 && unify.classes[ctaIndex] !== unify.classes[cancelIndex],
				`${unify.classes[ctaIndex]} ≠ ${unify.classes[cancelIndex]}`
			);

			// ── §5 取消 ＝ 什么都没发生 ──
			const snapshot = `(() => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				return { state: plugin.settings.migrationState, files: app.vault.getFiles().length };
			})()`;
			const before = await evaluate(client, snapshot);
			const cancelled = await evaluate(client, CANCEL_UNIFY);
			if (cancelled.error) throw new Error(cancelled.error);
			let gone = false;
			for (let i = 0; i < 20 && !gone; i += 1) {
				await delay(200);
				gone = (await evaluate(client, CONFIRM_GONE)).gone === true;
			}
			await delay(600);
			const after = await evaluate(client, snapshot);
			check("⑱ 取消后确认框关掉了", gone);
			check(
				"⑲ ★ 取消没有启动迁移（`migrationState` 没变 running）",
				after.state === before.state,
				`${before.state} → ${after.state}`
			);
			check("⑳ 取消没有动库里的文件", after.files === before.files, `${before.files} → ${after.files}`);
			cancelChecked = true;
		}

		// ── §6 收尾：本脚本**不改任何设置**（那个开关已删）──
		//
		// ⚠️ 1.12.0 之前这里要"把开关关回去并读盘复核"，因为脚本改过它。
		// 现在唯一可能落盘的是 `migrationState`（统一对象名留下的），由 finally 里的备份还原兜住。

		await evaluate(client, "app.setting.close()").catch(() => undefined);

		log("");
		log(`  · 取消路径${cancelChecked ? "已验证" : "**本轮未覆盖**（见 ⑬ 的原因）"}`);
	} finally {
		// 兜底：本脚本不再改设置，只有 `migrationState` 可能被动过 ⇒ 靠备份还原
		if (client) {
			try {
				await evaluate(client, "app.quit()");
			} catch {
				/* 已经退了 */
			}
		}
		if (child) {
			try {
				child.kill();
			} catch {
				/* 已经退了 */
			}
		}
		await delay(1200);
		// ⭐ 只有「统一对象名」可能改盘（`migrationState` / 索引）。脚本不动任何设置项，
		// 所以判据从"contentAddressed 值变了没"改成"migrationState 回到 idle 了没"。
		const onDisk = readDataJson();
		if (onDisk && (onDisk.migrationState ?? "idle") !== (original.migrationState ?? "idle")) {
			try {
				copyFileSync(backup, DATA_JSON);
				log(`  · 盘上 migrationState 仍是 ${onDisk.migrationState}，已用备份盖回`);
			} catch (error) {
				log(`  ⚠️ 还原 data.json 失败：${error.message}（备份在 ${backup}）`);
			}
		}
		if (existsSync(backup)) {
			try {
				unlinkSync(backup);
			} catch {
				/* 留着也无害 */
			}
		}
		client?.close?.();
	}

	const failed = results.filter((item) => !item.ok);
	const passed = results.length - failed.length;
	log("");
	log("═".repeat(84));
	log(failed.length === 0 ? `✓ 设置页探针通过：${passed} 项` : `✗ 未通过 ${failed.length} / ${results.length} 项`);
	for (const item of failed) log(`  · ${item.name}`);
	process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
