/**
 * 真机烟雾验证：在**真实 Obsidian** 里确认插件能加载、命令注册、原型拦截不炸。
 *
 * ## 为什么非要做这一步
 *
 * 自动化测试里最"非主流"的两处改动只有真机能判：
 * 1. **拦截 `HTMLImageElement.prototype.src` 的 setter** —— 真实 WebView 里
 *    `Object.defineProperty` 会不会抛错、会不会与宿主自己的逻辑打架，
 *    Node 里的假元素说不了话；
 * 2. **`registerMarkdownPostProcessor` + `getResourcePath`** 的真实行为 ——
 *    后者只声明在 `FileSystemAdapter`（桌面）/ `CapacitorAdapter`（移动）上，
 *    基类没有，用错在真实环境里直接抛。
 *
 * 这一步**只验证"不炸 + 接线在册"**，不验证交互（粘贴/拖拽要人工）。
 *
 * ## 两个环境要点（都踩过）
 *
 * - 启动必须带 `--disable-gpu --no-sandbox`：只带 `--remote-debugging-port` 会以
 *   `GPU process isn't usable. Goodbye.` 退出（看起来就像"进程被环境回收了"）。
 * - 启动它的**父进程必须活着**：保持者一退出，Obsidian 8 秒内消失。
 *
 * 用法：node verify-obsidian-smoke.mjs [--port 9222]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9222)
);
/** Obsidian 可执行文件位置；换机器/换安装位置时用环境变量覆盖。 */
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const PLUGIN_ID = "attachment-cloud-cache";

const log = (line = "") => console.log(line);

/** 极简 CDP 客户端（Node 18+ 自带 WebSocket，零依赖）。 */
async function connect(port) {
	const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = list.find((t) => t.type === "page");
	if (!page) throw new Error("没找到可调试的页面目标");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", reject, { once: true });
	});

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
async function evaluate(client, expression) {
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

async function main() {
	if (!existsSync(OBSIDIAN)) throw new Error(`找不到 Obsidian：${OBSIDIAN}`);

	log("═".repeat(72));
	log("真机烟雾验证：插件能否在真实 Obsidian 里加载并接线");
	log("═".repeat(72));

	// ⚠️ 参数缺一不可：只给 remote-debugging-port 会因 GPU 进程崩溃而退出
	const child = spawn(OBSIDIAN, [`--remote-debugging-port=${PORT}`, "--disable-gpu", "--no-sandbox"], {
		stdio: "ignore",
		detached: false,
	});
	child.on("exit", (code) => log(`  （Obsidian 退出，code=${code}）`));

	let client = null;
	try {
		// 等 CDP 起来（Node 的 fetch 不走 HTTP_PROXY，正好能直连 localhost）
		for (let i = 0; i < 60; i += 1) {
			try {
				const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
				log(`  ✓ 调试端口已就绪：${version.Browser}`);
				break;
			} catch {
				await delay(1000);
			}
		}

		client = await connect(PORT);

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
		if (!hostReady) throw new Error("宿主在 60 秒内没有就绪（app.plugins 一直不可用）");
		log("  ✓ 宿主已就绪（app.plugins 可用）");

		// 等插件加载完（Obsidian 会异步加载社区插件）
		const loaded = await evaluate(
			client,
			`(async () => {
				for (let i = 0; i < 60; i += 1) {
					const plugin = app?.plugins?.plugins?.[${JSON.stringify(PLUGIN_ID)}];
					if (plugin?._loaded) return true;
					await new Promise((r) => setTimeout(r, 500));
				}
				return false;
			})()`
		);
		log(`  ${loaded ? "✓" : "✗"} 插件已加载（_loaded = true）`);
		if (!loaded) throw new Error("插件没有加载成功 —— 看下面的控制台输出");

		// 命令是否注册（接线在册的最直接证据）
		const commands = await evaluate(
			client,
			`Object.keys(app.commands.commands).filter((id) => id.startsWith(${JSON.stringify(`${PLUGIN_ID}:`)}))`
		);
		log(`  ✓ 已注册命令：${JSON.stringify(commands)}`);

		// ⭐ 原型拦截是否真的装上了、且 setter 没有把普通赋值搞坏
		const patch = await evaluate(
			client,
			`(() => {
				const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
				const hasSetter = typeof descriptor?.set === "function";
				// 造一个真实 <img>，赋一个**站外**地址：不该被改写（我们只管自己的存储）
				const img = document.createElement("img");
				img.src = "https://example.com/not-ours.png";
				const untouched = img.getAttribute("src") === "https://example.com/not-ours.png";
				// 再赋一个本地地址：也不该被改写（幂等）
				img.src = "app://local/abc.png";
				const idempotent = img.getAttribute("src") === "app://local/abc.png";
				return { hasSetter, untouched, idempotent };
			})()`
		);
		log(`  ${patch.hasSetter ? "✓" : "✗"} HTMLImageElement.prototype.src 有 setter（拦截的前提）`);
		log(`  ${patch.untouched ? "✓" : "✗"} 站外地址原样通过（没动别人的图）`);
		log(`  ${patch.idempotent ? "✓" : "✗"} 本地地址原样通过（幂等）`);

		// 渲染路径的宿主 API 在真机上真的存在（桌面走 FileSystemAdapter）
		const apis = await evaluate(
			client,
			`(() => ({
				postProcessor: typeof app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].registerMarkdownPostProcessor === "function",
				getResourcePath: typeof app.vault.getResourcePath === "function",
				secretStorage: typeof app.secretStorage?.getSecret === "function",
			}))()`
		);
		log(`  ${apis.getResourcePath ? "✓" : "✗"} Vault.getResourcePath 存在（本地副本改写的落点）`);
		log(`  ${apis.secretStorage ? "✓" : "✗"} app.secretStorage 存在（凭据不进明文）`);

		// 真实设置页能否产出定义（声明式 API 在真机上的形状）。
		//
		// ⚠️ 这里用的是**内部结构** `app.setting.*` —— 它不在公开类型里，
		// 所以插件代码里绝不能用（那条纪律由 lint 兜着）。
		// 但**调试探针不是随插件发布的代码**：它跑在 DevTools 控制台里，
		// 用内部结构正是它存在的意义。两者不能混为一谈 ——
		// 一开始我用的是替身里的记账字段（`plugin.settingTabs`），
		// 那只存在于测试替身里，真机上自然找不到。
		const settings = await evaluate(
			client,
			`(() => {
				const internals = app.setting ?? {};
				const tabs = [...(internals.pluginTabs ?? []), ...(internals.settingTabs ?? [])];
				const tab = tabs.find((t) => t?.plugin?.manifest?.id === ${JSON.stringify(PLUGIN_ID)});
				if (!tab) return { ok: false, reason: "内部设置页列表里找不到本插件（共 " + tabs.length + " 个）" };
				const definitions = tab.getSettingDefinitions?.();
				if (!Array.isArray(definitions)) return { ok: false, reason: "getSettingDefinitions 没返回数组" };
				const items = definitions.reduce((sum, g) => sum + (g.items?.length ?? 0), 0);
				return { ok: true, groups: definitions.length, items };
			})()`
		);
		log(
			`  ${settings.ok ? "✓" : "✗"} 设置页可渲染：${settings.groups ?? "-"} 组 / ${settings.items ?? "-"} 项${
				settings.reason ? `（${settings.reason}）` : ""
			}`
		);

		const relevantErrors = client.consoleErrors.filter((line) => /attachment-cloud-cache|cloud-cache/i.test(line));
		log();
		log(`  控制台里与本插件相关的报错：${relevantErrors.length === 0 ? "无 ✓" : relevantErrors.join(" | ")}`);
		if (client.consoleErrors.length > 0) {
			log(`  （控制台共 ${client.consoleErrors.length} 条报错，前 3 条：）`);
			for (const line of client.consoleErrors.slice(0, 3)) log(`    - ${String(line).slice(0, 160)}`);
		}

		const ok =
			loaded &&
			commands.length >= 4 &&
			patch.hasSetter &&
			patch.untouched &&
			patch.idempotent &&
			apis.getResourcePath &&
			apis.secretStorage &&
			settings.ok &&
			relevantErrors.length === 0;

		log();
		log(ok ? "✓ 真机烟雾验证通过" : "✗ 真机烟雾验证未通过");
		process.exitCode = ok ? 0 : 1;
	} finally {
		try {
			client?.close();
		} catch {
			// 尽力而为
		}
		// 关掉 Obsidian（我们起的，我们收）
		try {
			child.kill();
		} catch {
			// 已经退了
		}
	}
}

main().catch((error) => {
	log();
	log(`✗ ${error.message}`);
	process.exitCode = 1;
});
