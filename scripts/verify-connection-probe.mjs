/**
 * 真机探针：「测试连接」探针回路（D-53 / D-54 的连接状态）。
 *
 * 与 `test-probe-sample` 的分工：那个用替身验**生命周期编排**；
 * 这个打真实服务端，回答三件只有真机才能回答的事：
 *   ① 真实私有桶下，五轮回路是否**每次同一结论**（用户 2026-10-18 报过"连点出错误结果"）；
 *   ② 界面上那盏灯与结果行是否跟着**本轮**结果走（按钮 → `runConnectionProbe` → `paintStatus` 的接线）；
 *   ③ 桶里是否**没有残留**（每轮临时对象都要删掉）。
 *
 * 会写远端：每轮 PUT 一个几十字节的临时对象，随后删掉（这正是被测行为）。
 * 跑完用插件自己的客户端列举一遍 `.acc-connection-probe-` 前缀，确认清空。
 *
 * 用法：`node scripts/verify-connection-probe.mjs [--port 9240]`
 * 前提：**关掉所有 Obsidian**（单实例锁）。跑完脚本会杀掉自己起的那个实例。
 */

import { setTimeout as delay } from "node:timers/promises";

import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9240)
);
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const VAULT = process.env.OBSIDIAN_VAULT ?? "ObsidianVault";
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 90);
const PLUGIN_ID = "attachment-cloud-cache";

const log = (line = "") => console.log(line);
const DUMP = process.argv.includes("--dump");
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: Boolean(ok) });
	log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

/**
 * 界面那一路：开设置页 → 连点按钮五次 → 每次读灯与结果行。
 *
 * ⚠️ 两条实测出来的坑（2026-10-18）：
 * ① 设置页的 DOM **不在 `document` 里**（`document.querySelectorAll(".modal-container")` 是 0），
 *    要从 `app.setting.modalEl` 往下找；
 * ② `app.setting.openTabById(id)` 在这个宿主版本（1.14.4）**不换页**，得点左侧导航项
 *    （导航项也没有 `data-id`，只能按显示名匹配 —— 名字取 `app.plugins.manifests[id].name`）。
 *
 * ⚠️ 按钮在测试期间是 disabled 的，所以"连点"要**等它重新可用**再点下一次 ——
 * 用户报的"快速连点"就是这个形态（点完等结果、结果没出又点）。
 */
const UI_ROUNDS = `(async () => {
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const name = (app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}] || {}).name;
	const tabName = name || ${JSON.stringify(PLUGIN_ID)};

	await app.setting.open();
	await new Promise((r) => setTimeout(r, 900));
	const root = app.setting.modalEl;
	const nav = Array.from(root.querySelectorAll(".vertical-tab-nav-item")).find((n) =>
		(n.textContent ?? "").trim() === tabName
	);
	if (!nav) return { error: "设置页左侧找不到「" + tabName + "」这一项" };
	nav.click();
	await new Promise((r) => setTimeout(r, 1500));

	const findButton = () =>
		Array.from(root.querySelectorAll("button")).find((b) =>
			/^(Test connection|测试连接)$/.test((b.textContent ?? "").trim())
		);
	const readStatus = () => {
		const head = root.querySelector(".acc-status-head");
		const dot = head ? head.querySelector(".acc-status-dot") : null;
		return {
			headClass: head ? head.className : "",
			dotClass: dot ? dot.className : "",
			text: head ? (head.innerText ?? "").trim().replace(/\\n+/g, " / ") : "",
			lines: Array.from(root.querySelectorAll(".acc-test-line")).map((e) => (e.textContent ?? "").trim()),
		};
	};
	const waitIdle = async (timeout) => {
		const from = Date.now();
		while (Date.now() - from < timeout) {
			const b = findButton();
			if (b && !b.disabled) return true;
			await new Promise((r) => setTimeout(r, 150));
		}
		return false;
	};

	if (!findButton()) {
		return {
			error: "设置页里找不到「测试连接」按钮",
			items: root.querySelectorAll(".setting-item").length,
			buttons: Array.from(root.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()).filter(Boolean).slice(0, 20),
		};
	}
	if (!(await waitIdle(20000))) return { error: "测试连接按钮一直不可用" };
	const rounds = [];
	for (let i = 0; i < 5; i += 1) {
		const button = findButton();
		button.click();
		// 立刻再点两下：按钮此刻已是 disabled，点它不该再开一轮（D-53 修的就是这个并发）
		button.click();
		button.click();
		const settled = await waitIdle(30000);
		rounds.push({ round: i + 1, settled, status: readStatus() });
		await new Promise((r) => setTimeout(r, 250));
	}
	return { rounds, final: readStatus(), state: plugin.currentConnectionState() };
})()`;

/** API 那一路：五轮顺序调用 + 一轮三连并发（单飞必须共用同一轮）。 */
const API_ROUNDS = `(async () => {
	const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
	const describe = (r) => ({
		state: r.state,
		kind: r.probe ? r.probe.kind : null,
		status: r.probe ? r.probe.status : null,
		contentType: r.probe ? r.probe.contentType : null,
		url: r.url,
		bytes: r.sample ? r.sample.bytes : null,
		sizeMismatch: r.sample ? r.sample.sizeMismatch : null,
		leftBehind: r.sample ? r.sample.leftBehind : null,
		key: r.sample ? r.sample.key : null,
		writeError: r.sample && r.sample.writeError ? String(r.sample.writeError.message ?? r.sample.writeError) : null,
		readError: r.sample && r.sample.readError ? String(r.sample.readError.message ?? r.sample.readError) : null,
	});

	const rounds = [];
	for (let i = 0; i < 5; i += 1) rounds.push(describe(await plugin.runConnectionProbe()));

	const shared = await Promise.all([plugin.runConnectionProbe(), plugin.runConnectionProbe(), plugin.runConnectionProbe()]);
	const sharedKeys = shared.map((r) => (r.sample ? r.sample.key : null));

	let residue = null;
	let residueError = null;
	try {
		const client = plugin.buildClient();
		const listed = await client.listObjects({ prefix: ".acc-connection-probe-", maxKeys: 100 });
		residue = listed.objects.map((o) => o.key);
	} catch (error) {
		residueError = String(error && error.message ? error.message : error);
	}

	return {
		rounds,
		sharedKeys,
		sharedSameRound: new Set(sharedKeys).size === 1,
		residue,
		residueError,
		state: plugin.currentConnectionState(),
		endpoint: plugin.settings.s3.endpoint,
		bucket: plugin.settings.s3.bucket,
		connectivity: {
			autoUpload: plugin.settings.autoUpload,
			localCopy: plugin.settings.localCopy,
		},
	};
})()`;

async function main() {
	const others = await countObsidianProcesses();
	if (others === null || others > 0) throw new Error(`系统里有 ${others ?? "未知"} 个 Obsidian 进程在跑（单实例锁）`);

	log("═".repeat(84));
	log("真机探针：「测试连接」探针回路（写 → 读回 → 匿名问两次 → 删）");
	log("═".repeat(84));

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

		// `--dump`：只把设置页的 DOM 长什么样打出来（排查"按钮找不到"用，不改任何东西）
		if (DUMP) {
			const dump = await evaluate(
				client,
				`(async () => {
					await app.setting.open();
					await new Promise((r) => setTimeout(r, 900));
					const root = app.setting.modalEl;
					const name = (app.plugins.manifests[${JSON.stringify(PLUGIN_ID)}] || {}).name;
					const nav = Array.from(root.querySelectorAll(".vertical-tab-nav-item")).find(
						(n) => (n.textContent ?? "").trim() === (name || ${JSON.stringify(PLUGIN_ID)})
					);
					if (nav) nav.click();
					await new Promise((r) => setTimeout(r, 1500));
					const items = Array.from(root.querySelectorAll(".setting-item"));
					return {
						foundNav: Boolean(nav),
						navText: nav ? (nav.textContent ?? "").trim() : null,
						itemCount: items.length,
						itemNames: items.map((i) => (i.querySelector(".setting-item-name")?.textContent ?? "").trim()).slice(0, 40),
						buttons: Array.from(root.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim()).filter(Boolean).slice(0, 40),
						hasHead: Boolean(root.querySelector(".acc-status-head")),
						headClass: (root.querySelector(".acc-status-head") || {}).className ?? null,
					};
				})()`
			);
			log(JSON.stringify(dump, null, 2));
			return;
		}

		const api = await evaluate(client, API_ROUNDS);
		log(`  存储：${api.endpoint} / ${api.bucket}`);
		if (api.residueError) log(`  ⚠️ 列举残留失败：${api.residueError}`);

		// ── ① 五轮顺序调用：结论必须每次一样 ──
		const states = new Set(api.rounds.map((r) => r.state));
		const kinds = new Set(api.rounds.map((r) => r.kind));
		const noErrors = api.rounds.every((r) => !r.writeError && !r.readError && !r.sizeMismatch);
		const nothingLeft = api.rounds.every((r) => r.leftBehind === false);
		check("① 五轮结论完全一致", states.size === 1 && kinds.size === 1, `state=${[...states].join("/")} kind=${[...kinds].join("/")}`);
		check("② 每一轮都真的写完读回（无写入/读取/字节错误）", noErrors, noErrors ? "" : JSON.stringify(api.rounds.find((r) => r.writeError || r.readError || r.sizeMismatch)));
		check("③ 每一轮都报「已删掉」", nothingLeft);
		check("④ 每轮用的是**不同**的探针 key（随机）", new Set(api.rounds.map((r) => r.key)).size === api.rounds.length, api.rounds.map((r) => (r.key ?? "").slice(0, 24)).join(" | "));
		check("⑤ 三连并发共用**同一轮**（单飞）", api.sharedSameRound, api.sharedKeys.map((k) => (k ?? "").slice(0, 24)).join(" | "));
		if (api.residue) check("⑥ 桶里没有 `.acc-connection-probe-` 残留", api.residue.length === 0, api.residue.join(", "));

		// ── ② 界面那一路：连点五次，灯与结果行必须跟着本轮走 ──
		const ui = await evaluate(client, UI_ROUNDS);
		if (ui.error) {
			check("⑦ 设置页能连点五次", false, ui.error);
		} else {
			const texts = new Set(ui.rounds.map((r) => r.status.text));
			const lines = ui.rounds.map((r) => r.status.lines.join(" ⏐ "));
			const dotStates = new Set(ui.rounds.map((r) => r.status.dotClass));
			check("⑦ 五次都跑完了（按钮每次都能回到可用）", ui.rounds.every((r) => r.settled));
			check("⑧ 灯上那句话每次都一样", texts.size === 1, [...texts].join(" / "));
			check("⑨ 灯的状态类每次都一样（不闪回 checking）", dotStates.size === 1, [...dotStates].join(" / "));
			check("⑩ 成功时只有一句（不展示探针名 / 字节数 / 匿名问过几次）", ui.rounds.every((r) => r.status.lines.length === 1), lines[0]);
			check("⑪ 结果里没有出现「对象不在」（那是并发抢 key 的假结论）", lines.every((l) => !/对象不在|object is not there/i.test(l)));
			log(`     灯：${ui.final.headClass} → ${ui.final.text}`);
			log(`     结果：${ui.final.lines.join(" ⏐ ")}`);
			// ⚠️ 灯那句话是「私有访问 —— 链接只能在本插件里打开…」，所以按**前缀**比，
			// 不要求整句相等（解释句可以改，结论不该改）。
			const expected = api.state === "private" ? "私有访问" : api.state === "public" ? "公开访问" : null;
			check(
				"⑫ 灯的语义与探测结论一致",
				expected === null || ui.final.text.startsWith(expected),
				`state=${api.state}，灯上说「${ui.final.text}」`
			);
		}

		const failed = results.filter((r) => !r.ok);
		log("");
		log("-".repeat(84));
		log(`${results.length - failed.length}/${results.length} 通过`);
		if (failed.length > 0) {
			log("未通过：");
			for (const item of failed) log(`  · ${item.name}`);
			process.exitCode = 1;
		}
	} finally {
		await delay(500);
		try {
			client.close();
		} catch {
			// 关闭失败无所谓：下面会杀进程
		}
		child.kill();
	}
}

await main();
