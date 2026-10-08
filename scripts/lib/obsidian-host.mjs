/**
 * 真机验证的**宿主启动与 CDP 连接**（被多个验证脚本共用）。
 *
 * ## 为什么单独一层
 *
 * `verify-obsidian-smoke.mjs`（宿主 API / 接线存在性）与 `verify-real-storage.mjs`
 * （真实服务商上传下载回环）要做的前置动作**完全一样**：起一个带调试端口的
 * Obsidian、挑对窗口、等宿主就绪、确认打开的是**指定**的 vault。
 * 而这些恰恰是最容易踩坑的地方 —— 复制一份就等于把"踩过的坑"复制一份，
 * 且两份会逐渐分叉（一边修了、另一边没修）。
 *
 * ## 这一层里集中了四个实测过的坑
 *
 * 1. **启动参数缺一不可**：只给 `--remote-debugging-port` 会因 GPU 进程崩溃而退出，
 *    必须 `--disable-gpu --no-sandbox`（见 `binaries` 那段的说明）；
 * 2. **必须选对窗口**：CDP 会同时列出多个 `type: "page"` 目标，
 *    `find` 拿到的第一个往往是空窗 —— `app` 全局照样能用，
 *    但任何 DOM 级检查都会连错对象；
 * 3. **`connect` 要重试**：调试端口响应得比渲染进程初始化**早得多**，
 *    第一次问的时候主窗的 `.workspace` 往往还没渲染出来 ——
 *    直接判定"没有主窗"会误报（这也是从 smoke 脚本抽出来时才补上的）；
 * 4. **必须回读 vault 名**：请求一个**不存在**的 vault 时 Obsidian 不报错，
 *    而是**退回上次打开的 vault** ⇒ 整轮验证跑在另一个 vault 上、全部通过，
 *    而人以为"验证过了"。
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 本机 Obsidian 认得哪些 vault —— **只用于报错时提示**。
 *
 * 默认 vault 名是中性值，而大多数人的库另叫别的名字。名字不对的症状是
 * "停在 vault 选择界面"，看起来像 Obsidian 坏了；把可用名字列出来，改一行环境变量就好。
 *
 * 读不到就返回空数组 —— 这只是提示，不该因为它让验证失败。
 */
export function knownVaultNames() {
	if (!process.env.APPDATA) return [];
	const configPath = join(process.env.APPDATA, "obsidian", "obsidian.json");
	if (!existsSync(configPath)) return [];
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		const names = Object.values(config.vaults ?? {})
			.map((entry) => (typeof entry?.path === "string" ? entry.path.split(/[\\/]/).filter(Boolean).pop() : null))
			.filter(Boolean);
		return [...new Set(names)].sort();
	} catch {
		return [];
	}
}

/**
 * 数一下系统里有多少个 Obsidian 进程（数不出来时返回 `null`）。
 *
 * ⚠️ 用**不带过滤**的 `tasklist` 再自己数：带 `/FI "IMAGENAME eq X.exe"` 在中文
 * Windows 上会返回一句本地化的提示（"没有运行的任务匹配指定标准"），`/NH` 也匹配不到，
 * 于是**计数恒为 0** —— 那会让人得出"没有别的实例在跑"的相反结论。
 */
export function countObsidianProcesses() {
	return new Promise((resolve) => {
		execFile("tasklist", [], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error || typeof stdout !== "string") {
				resolve(null); // 数不出来不该让验证失败，只是少一条诊断线索
				return;
			}
			resolve((stdout.match(/Obsidian\.exe/gi) ?? []).length);
		});
	});
}

/**
 * 极简 CDP 客户端（Node 18+ 自带 WebSocket，零依赖）。
 *
 * 逐个试候选目标，挑出**主窗**（有 `.workspace` 的那个）；一个都不像就退回第一个，
 * 别把验证卡死。`tries` 次轮询是为了等主窗渲染出来（见文件头第 3 点）。
 */
export async function connect(port, { tries = 25, gapMs = 1200 } = {}) {
	const pickMainWindow = async (target) => {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		try {
			await new Promise((resolve, reject) => {
				socket.addEventListener("open", resolve, { once: true });
				socket.addEventListener("error", reject, { once: true });
			});
			const answer = await new Promise((resolve) => {
				socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true });
				socket.send(
					JSON.stringify({
						id: 1,
						method: "Runtime.evaluate",
						params: { expression: 'Boolean(document.querySelector(".workspace"))', returnByValue: true },
					})
				);
			});
			const isMain = answer?.result?.result?.value === true;
			if (!isMain) socket.close();
			return isMain ? socket : null;
		} catch {
			try {
				socket.close();
			} catch {
				// 尽力而为
			}
			return null;
		}
	};

	let candidates = [];
	let ws = null;
	for (let attempt = 0; attempt < tries && !ws; attempt += 1) {
		const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
		candidates = list.filter((target) => target.type === "page");
		for (const target of candidates) {
			ws = await pickMainWindow(target);
			if (ws) break;
		}
		if (!ws) await delay(gapMs);
	}

	// 一个都不像主窗（老版本没有 `.workspace`？）就退回原行为
	if (!ws) {
		if (candidates.length === 0) throw new Error("没找到可调试的页面目标");
		ws = new WebSocket(candidates[0].webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve, { once: true });
			ws.addEventListener("error", reject, { once: true });
		});
	}

	let id = 0;
	const pending = new Map();
	const consoleErrors = [];
	ws.addEventListener("message", (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			return;
		}
		// 收集控制台报错 —— 原型补丁若在真实 WebView 里出问题，这里会看到
		if (msg.method === "Runtime.exceptionThrown") {
			consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "(无描述)");
		}
		if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
			consoleErrors.push((msg.params.args ?? []).map((a) => a.description ?? a.value).join(" "));
		}
	});

	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const messageId = ++id;
			pending.set(messageId, resolve);
			ws.send(JSON.stringify({ id: messageId, method, params }));
		});

	await send("Runtime.enable");
	return { send, consoleErrors, close: () => ws.close() };
}

/** 在页面里求值，返回结构化结果（`returnByValue` 让对象能直接拿回来）。 */
export async function evaluate(client, expression) {
	const response = await client.send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (response.result?.exceptionDetails) {
		throw new Error(response.result.exceptionDetails.exception?.description ?? "页面求值失败");
	}
	return response.result?.result?.value;
}

/**
 * 起 Obsidian → 等调试端口 → 连 CDP → 等宿主就绪 → **回读 vault 名并断言相等**。
 *
 * @returns `{ client, child }`；调用方负责在自己结束时 `client.close()` 与 `child.kill()`。
 */
export async function launchAndAttach({ exe, port, vault, waitSeconds, log = () => {} }) {
	if (!existsSync(exe)) throw new Error(`找不到 Obsidian：${exe}`);

	// ⚠️ 参数缺一不可：只给 remote-debugging-port 会因 GPU 进程崩溃而退出。
	// 末尾那个 URI 用来**显式打开目标 vault** —— 不指定就可能停在 vault 选择界面
	//（那时 `app` 在、`app.plugins` 不在，报出来的却像是"插件没加载"）。
	const child = spawn(
		exe,
		[
			`--remote-debugging-port=${port}`,
			"--disable-gpu",
			"--no-sandbox",
			`obsidian://open?vault=${encodeURIComponent(vault)}`,
		],
		{ stdio: "ignore", detached: false }
	);
	child.on("exit", (code) => log(`  （Obsidian 退出，code=${code}）`));

	// 等 CDP 起来（Node 的 fetch 不走 HTTP_PROXY，正好能直连 localhost）
	let portReady = false;
	for (let i = 0; i < waitSeconds; i += 1) {
		try {
			const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
			log(`  ✓ 调试端口已就绪：${version.Browser}`);
			portReady = true;
			break;
		} catch {
			await delay(1000);
		}
	}

	// ⭐ 端口没起来时，先**分清是哪一种失败**再说别的。
	// 这两种原因的处置完全不同，而症状一模一样（都是"等满 N 秒"）：
	//   ① 已经有 Obsidian 在跑 → 单实例锁把参数吃掉了 → 去关掉它；
	//   ② 没有别的实例 → 是我们的实例自己的问题（GPU 崩溃等）。
	if (!portReady) {
		const others = await countObsidianProcesses();
		if (others !== null && others > 0) {
			throw new Error(
				`调试端口 ${port} 在 ${waitSeconds} 秒内没有就绪，而系统里有 ${others} 个 Obsidian 进程在跑。\n` +
					"  Obsidian 是单实例的：新实例会把命令行参数（含调试端口）交给已在运行的那个，然后自己退出\n" +
					"  （退出码 0 —— 上面若有一行「Obsidian 退出，code=0」，就是它）。而那个实例不会因为\n" +
					"  别人要求就开调试端口，所以这个组合下**永远**等不到端口。\n" +
					"  处理：关掉所有 Obsidian 窗口后重跑（若那个实例是用户正在用的，先问一句再结束它）。"
			);
		}
		throw new Error(
			`调试端口 ${port} 在 ${waitSeconds} 秒内没有就绪，且没有别的 Obsidian 实例在跑。\n` +
				`  这更像是我们启动的实例自己没能起来：确认 ${exe} 能正常打开，\n` +
				"  并检查启动参数里是否有 --disable-gpu --no-sandbox（GPU 进程崩溃会让它立刻退出）。"
		);
	}

	const client = await connect(port);

	// ⚠️ 必须先等宿主自己就绪：调试端口响应得比渲染进程初始化早得多，
	// 这时求值会得到 `ReferenceError: app is not defined` ——
	// 看起来像"插件没加载"，其实是问得太早。
	const hostReady = await evaluate(
		client,
		`(async () => {
			for (let i = 0; i < 120; i += 1) {
				if (typeof app !== "undefined" && app?.plugins?.plugins) return true;
				await new Promise((r) => setTimeout(r, 500));
			}
			return false;
		})()`
	);
	if (!hostReady) {
		// ⚠️ 这个现象有两个**完全不同**的原因，处置也不同 —— 所以先把当前的
		// 实际状态取回来再报，别只丢一句"没就绪"（那会让人去查 Obsidian 是不是坏了）：
		//   ① 没有打开任何 vault（停在 vault 选择界面）⇒ `app` 在、`app.plugins` 不在；
		//   ② vault 打开了但插件加载卡住/报错 ⇒ 那就是真的插件问题。
		const state = await evaluate(
			client,
			`({
				hasAppGlobals: typeof app !== "undefined",
				hasPlugins: Boolean(app?.plugins?.plugins),
				vault: app?.vault?.getName?.() ?? null,
			})`
		).catch(() => null);
		const known = knownVaultNames();
		const hint =
			state && !state.vault
				? `看起来**没有打开任何 vault**（停在 vault 选择界面）—— 本脚本请求打开的是「${vault}」，` +
					`请确认这个名字与 Obsidian 里显示的完全一致（大小写敏感）。` +
					(known.length > 0
						? `本机 Obsidian 认得这些 vault：${known.map((name) => `「${name}」`).join("、")} —— ` +
							`用 OBSIDIAN_VAULT=<名字> 指定其中之一。`
						: `也可以用 OBSIDIAN_VAULT 指定别的名字。`)
				: "vault 已经打开了，所以更像是插件本身没加载起来 —— 看上面的控制台输出。";
		throw new Error(
			`宿主在 60 秒内没有就绪（app.plugins 一直不可用）。\n  实际状态：${JSON.stringify(state)}\n  ${hint}`
		);
	}
	log("  ✓ 宿主已就绪（app.plugins 可用）");

	// ⭐ 实际打开的是不是我们**请求**的那个 vault？（见文件头第 4 点）
	const actualVault = await evaluate(client, `app?.vault?.getName?.() ?? null`);
	if (actualVault !== vault) {
		const available = knownVaultNames();
		const availableHint =
			available.length > 0 ? `本机 Obsidian 认得这些 vault：${available.join("、")}。` : "";
		throw new Error(
			`请求打开的 vault 是「${vault}」，实际打开的是「${actualVault}」。\n` +
				`  ⚠️ Obsidian 在名字对不上时**不会报错**，它会退回上次打开的 vault —— 于是这一轮\n` +
				`  探针验证的是另一个 vault。${availableHint}用 OBSIDIAN_VAULT=<正确的名字> 重跑。`
		);
	}
	log(`  ✓ 打开的确实是指定的 vault：「${actualVault}」`);

	return { client, child };
}
