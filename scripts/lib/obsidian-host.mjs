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
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * 探调试端口时单次请求的上限（毫秒）。
 *
 * ⚠️ **为什么必须给超时**：Obsidian（Electron）在启动的那几秒里会把 DevTools 的
 * 监听套接字**先建好、但不应答** —— 实测 `curl` 能连上、然后一直收不到任何字节。
 * 而 `fetch` 默认**没有超时**，于是"等端口就绪"那个循环会**卡在第一次 await 上**，
 * 永远走不到 `waitSeconds` 那一步：症状是脚本既不出结果也不报错，静默挂住
 * （2026-10-09 实测：挂了 4 分多钟，日志里宿主停在 `Loaded updated app … asar`）。
 * 有了超时之后，这种"半开"状态会被当成"还没就绪"继续重试，最终按期报错。
 */
const PORT_PROBE_TIMEOUT_MS = 2000;

/** 一条 CDP 命令的上限。给得宽松：页面里那段"等插件加载"的循环本身就要跑 30 秒。 */
const CDP_COMMAND_TIMEOUT_MS = 90_000;

/**
 * 带超时的 `fetch` + JSON 解析。
 *
 * 返回值/异常与直接写 `(await fetch(url)).json()` 一致，只是**不会永久挂住**。
 */
async function fetchJson(url, { timeoutMs = PORT_PROBE_TIMEOUT_MS } = {}) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	return response.json();
}

/**
 * 本机 Obsidian 认得哪些 vault —— **只用于报错时提示**。
 *
 * 默认 vault 名是中性值，而大多数人的库另叫别的名字。名字不对的症状是
 * "停在 vault 选择界面"，看起来像 Obsidian 坏了；把可用名字列出来，改一行环境变量就好。
 *
 * 读不到就返回空数组 —— 这只是提示，不该因为它让验证失败。
 */
export function knownVaultNames() {
	return [...new Set(knownVaultEntries().map((entry) => entry.name))].sort();
}

/**
 * 本机 Obsidian 认得的库：`{ name, path }` 列表。
 *
 * ⚠️ **名字不唯一**（2026-10-28 实测踩到）：本机同时登记了
 * `E:\svn\obsidian-plugins\ObsidianVault` 和 `E:\svn\obsidian-plugins-codebuddy\ObsidianVault`，
 * 而 `obsidian://open?vault=ObsidianVault` 打开的是**后者**（`open: true` 那个）。
 * 只核对 `app.vault.getName()` 会**通过** —— 于是整轮探针都在验证另一份旧版插件
 * （症状：命令数 8 条、`plugin.sampleObjectKey` 不存在、设置页 0 个分组，全像插件坏了）。
 * ⇒ 名字只能用来**提示**，判据必须是目录：`adapter.basePath`。
 */
export function knownVaultEntries() {
	if (!process.env.APPDATA) return [];
	const configPath = join(process.env.APPDATA, "obsidian", "obsidian.json");
	if (!existsSync(configPath)) return [];
	try {
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		return Object.values(config.vaults ?? {})
			.map((entry) => {
				if (typeof entry?.path !== "string" || entry.path === "") return null;
				const name = entry.path.split(/[\\/]/).filter(Boolean).pop();
				return name ? { name, path: entry.path } : null;
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** 名字 → 目录（同名多份时返回多条，调用方必须自己判歧义）。 */
export function vaultPathsFor(name) {
	return knownVaultEntries()
		.filter((entry) => entry.name === name)
		.map((entry) => entry.path);
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
export async function connect(port, options = {}) {
	return connectTo(port, options);
}

/**
 * 连到**任意**一个页面目标：`probeExpression` 在候选页面里求值为 `true` 的那个就是要找的。
 *
 * ## 为什么需要它（2026-10-09 实测）
 *
 * Obsidian 1.14 的**设置界面是一个独立的窗口**（`body.mod-windows`，CDP 目标标题形如
 * 「设置 - ObsidianVault - …」），`app.setting.modalEl.ownerDocument` **不是**主窗的 document。
 * 于是：
 *  - 在主窗页面里 `Input.dispatchMouseEvent` 打那个按钮的坐标，命中的是编辑器
 *    （实测 `elementFromPoint` 返回 `div.cm-scroller`）⇒ 一次点击都到不了按钮，
 *    判据全是**假阴性**；
 *  - `Page.setInterceptFileChooserDialog` / `Page.fileChooserOpened` 也必须开在
 *    **那个窗口**的会话上。
 *
 * ⇒ 要测"用户的真实点击"，就必须连到那个窗口。默认仍然挑主窗（`connect` 的行为不变）。
 */
export async function connectTo(
	port,
	{ tries = 25, gapMs = 1200, probeExpression = 'Boolean(document.querySelector(".workspace"))' } = {}
) {
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
						params: { expression: probeExpression, returnByValue: true },
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
		let list;
		try {
			list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
		} catch {
			// 连不上 / 超时 / 应答不是 JSON —— 都当成"还没就绪"，等下一次
			await delay(gapMs);
			continue;
		}
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
	/** 事件订阅：`方法名 → 回调集合`（见下面 `on` 的说明）。 */
	const listeners = new Map();
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

	// 事件订阅：有些 CDP 能力**只有事件、没有查询接口**（例如
	// `Page.fileChooserOpened` —— 它回答"那次 click 到底有没有弹出文件选择器"）。
	// 没有这条路就只能靠猜，而"猜"在本项目是不被接受的。
	for (const handler of listeners.get(msg.method) ?? []) {
		try {
			handler(msg.params);
		} catch {
			/* 订阅者自己出错不该影响 CDP 循环 */
		}
	}
});

	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const messageId = ++id;
			// ⚠️ 命令也要有上限：页面若因为某种原因彻底卡死（例如宿主正在自更新重启），
			// 不设上限的话 `evaluate` 会永久挂住 —— 而"探针自己挂住"比"探针报错"
			// 难处理得多（没有任何信号说明它在等什么）。
			const timer = setTimeout(() => {
				pending.delete(messageId);
				reject(new Error(`CDP 命令 ${method} 超过 ${CDP_COMMAND_TIMEOUT_MS} ms 没有应答`));
			}, CDP_COMMAND_TIMEOUT_MS);
			pending.set(messageId, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			ws.send(JSON.stringify({ id: messageId, method, params }));
		});

	/**
	 * 订阅一个 CDP 事件（有些能力**只有事件、没有查询接口**）。
	 *
	 * 目前唯一的使用场景是 `Page.fileChooserOpened`：它回答
	 * "刚才那次 click **到底有没有**弹出文件选择器" —— 这正是
	 * "把 `<input type="file">` 改成游离节点之后还弹不弹"的唯一判据。
	 * 没有它就只能猜，而"猜"在本项目是不被接受的。
	 */
	const on = (method, handler) => {
		if (!listeners.has(method)) listeners.set(method, new Set());
		listeners.get(method).add(handler);
		return () => listeners.get(method)?.delete(handler);
	};

	await send("Runtime.enable");
	return { send, on, consoleErrors, close: () => ws.close() };
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
/**
 * ⭐ 2026-10-22（D-82）：`path` 给了就用 `obsidian://open?path=` 打开**一个目录**
 *（不必先在 `obsidian.json` 里注册它）。
 *
 * 用途：需要一个**干净且完全可控**的库的探针 —— 自己造、自己扫，不碰用户的
 *（用户库里一个读不到的文件就会让"严格口径"那条链整条取消。那是对的，但也意味着
 * 探针什么都量不到）。
 */
export async function launchAndAttach({ exe, port, vault, path, waitSeconds, log = () => {} }) {
	if (!existsSync(exe)) throw new Error(`找不到 Obsidian：${exe}`);

	/**
	 * 我们**期望**打开的目录。
	 *
	 * - 显式给了 `path` ⇒ 就是它；
	 * - 否则看 `OBSIDIAN_VAULT_DIR`（多个脚本已经用它指库目录）⇒ 就按它核对；
	 * - 都没有 ⇒ 从 `obsidian.json` 反查出唯一那个目录（同名多份时下面会直接报错）。
	 * ⇒ 之后无论走哪条路，判据都是 `adapter.basePath`，不是名字。
	 */
	const envDir = String(process.env.OBSIDIAN_VAULT_DIR ?? "").trim();
	let expectedPath = path ?? (envDir === "" ? null : resolve(envDir));

	// ⭐ 名字不对时**立刻**失败，别等 60 秒超时（2026-10-25）。
	//
	// 起因：两个脚本的默认值还是早已不存在的 `TestVault`，而 Obsidian 在名字对不上时
	// **不报错** —— 它退回上次打开的库或停在选择界面 ⇒ 现象是"等满一分钟，然后说插件没加载"。
	// 本机能列出库名时，这件事在启动前就能判断完。
	//
	// ⚠️ `knownVaultNames()` 读不到（没有 obsidian.json）就返回空数组 ⇒ 那条路直接跳过，
	// 不许因为"列不出来"就拦住启动 —— 提示不该让验证失败。
	if (!path) {
		const known = knownVaultNames();
		if (known.length > 0 && !known.includes(vault)) {
			throw new Error(
				`OBSIDIAN_VAULT=「${vault}」在本机 Obsidian 里不存在（大小写敏感）。\n` +
					`  本机认得这些 vault：${known.map((name) => `「${name}」`).join("、")}\n` +
					"  用 OBSIDIAN_VAULT=<上面其中一个> 重跑。"
			);
		}
		// ⭐ 名字撞车时必须当场拦住（2026-10-28 实测）。见 `knownVaultEntries` 的说明：
		// 同名两份库时，按名字打开会拿到**另一个目录**，而名字核对仍然通过 ⇒ 整轮白跑。
		// ⚠️ 已经拿到期望目录（`OBSIDIAN_VAULT_DIR` / `path`）时不报错 —— 那条路会用 basePath 核对。
		const candidates = vaultPathsFor(vault);
		if (!expectedPath && candidates.length > 1) {
			throw new Error(
				`OBSIDIAN_VAULT=「${vault}」在本机对应 **${candidates.length} 个目录**，按名字打开分不清：\n` +
					candidates.map((item) => `    · ${item}`).join("\n") +
					"\n  用 OBSIDIAN_VAULT_DIR=<上面某个**完整路径**> 重跑（目录模式会用 `adapter.basePath` 核对）。"
			);
		}
		if (!expectedPath && candidates.length === 1) expectedPath = candidates[0];
	}

	// ⚠️ 参数缺一不可：只给 remote-debugging-port 会因 GPU 进程崩溃而退出。
	// 末尾那个 URI 用来**显式打开目标 vault** —— 不指定就可能停在 vault 选择界面
	//（那时 `app` 在、`app.plugins` 不在，报出来的却像是"插件没加载"）。
	const child = spawn(
		exe,
		[
			`--remote-debugging-port=${port}`,
			"--disable-gpu",
			"--no-sandbox",
			// ⚠️ 有期望目录时**一律按目录打开**（2026-10-28）：同名库并存时
			// `?vault=<名字>` 会挑错目录，而 `?path=` 是唯一的。
			...(expectedPath
				? [`obsidian://open?path=${encodeURIComponent(expectedPath)}`]
				: [`obsidian://open?vault=${encodeURIComponent(vault)}`]),
		],
		{ stdio: "ignore", detached: false }
	);
	child.on("exit", (code) => log(`  （Obsidian 退出，code=${code}）`));

	// ⚠️ 失败路径必须**收掉这个子进程**，否则它会活到自己退出为止 —— 而 Obsidian 是单实例的，
	// 下一次运行就会看到"系统里有 2 个 Obsidian 进程在跑"然后干等 90 秒（实测连撞三次）。
	// 父进程（本脚本）一退出它也会跟着走，但那有几秒延迟，足够把下一轮卡死。
	const killOnFailure = () => {
		try {
			child.kill();
		} catch {
			// 已经退了
		}
	};

	// 等 CDP 起来（Node 的 fetch 不走 HTTP_PROXY，正好能直连 localhost）
	//
	// ⚠️ 用**截止时刻**而不是"轮数 × 1 秒"：每次探测自己有 2 秒上限，
	// 按轮数算会让总等待变成 waitSeconds 的好几倍（那正是上一版静默挂住的形态之一）。
	let portReady = false;
	const portDeadline = Date.now() + waitSeconds * 1000;
	while (Date.now() < portDeadline) {
		try {
			const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
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
		killOnFailure();
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
		killOnFailure();
		throw new Error(
			`宿主在 60 秒内没有就绪（app.plugins 一直不可用）。\n  实际状态：${JSON.stringify(state)}\n  ${hint}`
		);
	}
	log("  ✓ 宿主已就绪（app.plugins 可用）");

	// ⭐⭐ 判据是**目录**，不是名字（2026-10-28）。
	//
	// 这个名字对得上、目录却是另一个库的组合真实存在（本机就有两个 `ObsidianVault`），
	// 而症状极具误导性：插件是旧版 ⇒ 命令少/多、设置页空、字段不存在，看起来像"新代码坏了"。
	// ⇒ 只核对 `app.vault.getName()` 是一句**必然会假绿**的断言。
	const normalizePath = (value) => String(value).split("\\").join("/").replace(/\/$/, "").toLowerCase();
	if (expectedPath) {
		const basePath = await evaluate(client, `String(app?.vault?.adapter?.basePath ?? "")`);
		const actual = normalizePath(basePath);
		const want = normalizePath(expectedPath);
		if (actual !== want && !actual.endsWith(want) && !want.endsWith(actual)) {
			killOnFailure();
			throw new Error(
				`请求打开的目录是 ${expectedPath}，实际打开的是 ${basePath || "（空）"}。\n` +
					"  ⚠️ 名字相同的库可能有好几个 —— 用 OBSIDIAN_VAULT=<完整路径> 指定，别用名字。"
			);
		}
		log(`  ✓ 打开的确实是指定的目录：${basePath}`);
	}

	// ⭐ 实际打开的是不是我们**请求**的那个 vault？（见文件头第 4 点）
	// ⚠️ 名字这一层只在**没有目录可比**时才单独用；目录已经核对过的话它只是附注。
	const actualVault = await evaluate(client, `app?.vault?.getName?.() ?? null`);
	if (vault && actualVault !== vault) {
		const available = knownVaultNames();
		const availableHint =
			available.length > 0 ? `本机 Obsidian 认得这些 vault：${available.join("、")}。` : "";
		killOnFailure();
		throw new Error(
			`请求打开的 vault 是「${vault}」，实际打开的是「${actualVault}」。\n` +
				`  ⚠️ Obsidian 在名字对不上时**不会报错**，它会退回上次打开的 vault —— 于是这一轮\n` +
				`  探针验证的是另一个 vault。${availableHint}用 OBSIDIAN_VAULT=<正确的名字> 重跑。`
		);
	}
	log(`  ✓ 打开的确实是指定的 vault：「${actualVault}」`);

	return { client, child };
}
