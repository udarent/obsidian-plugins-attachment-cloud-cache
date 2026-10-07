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
 * ## 四个环境要点（都踩过）
 *
 * - 启动必须带 `--disable-gpu --no-sandbox`：只带 `--remote-debugging-port` 会以
 *   `GPU process isn't usable. Goodbye.` 退出（看起来就像"进程被环境回收了"）。
 * - 启动它的**父进程必须活着**：保持者一退出，Obsidian 8 秒内消失。
 * - ⭐ **别的地方已经开着一个 Obsidian 时，本脚本一定会失败，而且失败得很难看**：
 *   Obsidian 是单实例的，新实例会把命令行参数（含调试端口）交给已在运行的那个
 *   然后**自己退出**，而那个实例不会因为别人要求就开调试端口。
 *   症状是"只打出标题，然后静默等满 60 秒超时"—— 连续两轮我都把这个现象
 *   误当成"环境限制"，其实是**已经有实例在跑**。
 *   所以下面在端口没起来时会**主动数一下进程**并把这句话打出来，而不是让人猜。
 *   遇到时的处理：关掉所有 Obsidian 窗口（或用 `-- --port 9231` 换端口并确认
 *   那个端口空闲）后重跑。⚠️ 结束别人的进程前先问一句 —— 那可能是用户正在用的
 *   Obsidian，强行结束有丢未保存内容的风险。
 * - ⭐⭐ **必须显式指定要打开的 vault**（本脚本用 `obsidian://open?vault=…`）。
 *   否则会依赖一个环境里**会消失**的状态：`obsidian.json` 里那个 vault 的 `open: true`。
 *   实测踩到 —— 手动关掉 Obsidian 之后那个标记就没了，于是再启动时 Obsidian 停在
 *   **vault 选择界面**：`app` 在、`app.plugins` 不在，本脚本报"宿主 60 秒内没有就绪"，
 *   而真实原因与"宿主起不来"完全无关（看起来像 Obsidian 坏了）。
 *   显式指定之后，无论之前打开过哪个 vault 都能跑。
 *
 * 用法：node verify-obsidian-smoke.mjs [--port 9222]
 * 环境变量：OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_DEBUG_PORT / OBSIDIAN_DEBUG_WAIT
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(
	process.argv.includes("--port")
		? process.argv[process.argv.indexOf("--port") + 1]
		: (process.env.OBSIDIAN_DEBUG_PORT ?? 9222)
);
/** Obsidian 可执行文件位置；换机器/换安装位置时用环境变量覆盖。 */
const OBSIDIAN = process.env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
/**
 * 要打开的 vault 名字（**必须显式指定**）。
 *
 * 为什么不能省：不指定就依赖 `obsidian.json` 里那个 vault 的 `open: true` 标记，
 * 而那个标记**会消失**（手动关掉 Obsidian 之后就没了）。届时 Obsidian 会停在
 * vault 选择界面 —— `app` 在、`app.plugins` 不在，本脚本报出来的却是
 * "宿主 60 秒内没有就绪"，与真实原因（没打开 vault）毫无关系。
 *
 * ⚠️ 名字要**与 Obsidian 里显示的完全一致**（大小写敏感）。写错了同样会停在选择界面，
 * 所以下面的报错里会把用到的名字打出来。
 */
const VAULT = process.env.OBSIDIAN_VAULT ?? "ObsidianVault";
/**
 * 等调试端口的秒数。
 *
 * 可覆盖是为了**能验证"端口没起来"那条失败路径**（否则测一次要干等 60 秒），
 * 也为了在本机排查时不用空等。
 */
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 60);
const PLUGIN_ID = "attachment-cloud-cache";

const log = (line = "") => console.log(line);

/**
 * 数一下系统里有多少个 Obsidian 进程（数不出来时返回 `null`）。
 *
 * ⚠️ 用**不带过滤**的 `tasklist` 再自己数：带 `/FI "IMAGENAME eq X.exe"` 在中文
 * Windows 上会返回一句本地化的提示（"没有运行的任务匹配指定标准"），`/NH` 也匹配不到，
 * 于是**计数恒为 0** —— 那会让人得出"没有别的实例在跑"的相反结论。
 */
function countObsidianProcesses() {
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
	log(`  打开的 vault：${VAULT}（可用 OBSIDIAN_VAULT 覆盖）`);

	// ⚠️ 参数缺一不可：只给 remote-debugging-port 会因 GPU 进程崩溃而退出。
	// 末尾那个 URI 用来**显式打开目标 vault** —— 不指定就可能停在 vault 选择界面
	//（原因见文件头第四个环境要点）。
	const child = spawn(
		OBSIDIAN,
		[
			`--remote-debugging-port=${PORT}`,
			"--disable-gpu",
			"--no-sandbox",
			`obsidian://open?vault=${encodeURIComponent(VAULT)}`,
		],
		{
			stdio: "ignore",
			detached: false,
		}
	);
	child.on("exit", (code) => log(`  （Obsidian 退出，code=${code}）`));

	let client = null;
	try {
		// 等 CDP 起来（Node 的 fetch 不走 HTTP_PROXY，正好能直连 localhost）
		let portReady = false;
		for (let i = 0; i < WAIT_SECONDS; i += 1) {
			try {
				const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
				log(`  ✓ 调试端口已就绪：${version.Browser}`);
				portReady = true;
				break;
			} catch {
				await delay(1000);
			}
		}

		// ⭐ 端口没起来时，先**分清是哪一种失败**再说别的。
		// 这两种原因的处置完全不同，而症状一模一样（都是"等满 60 秒"）：
		//   ① 已经有 Obsidian 在跑 → 单实例锁把参数吃掉了 → 去关掉它；
		//   ② 没有别的实例 → 是我们的实例自己的问题（GPU 崩溃等）。
		if (!portReady) {
			const others = await countObsidianProcesses();
			if (others !== null && others > 0) {
				throw new Error(
					`调试端口 ${PORT} 在 ${WAIT_SECONDS} 秒内没有就绪，而系统里有 ${others} 个 Obsidian 进程在跑。\n` +
						"  Obsidian 是单实例的：新实例会把命令行参数（含调试端口）交给已在运行的那个，然后自己退出\n" +
						"  （退出码 0 —— 上面若有一行「Obsidian 退出，code=0」，就是它）。而那个实例不会因为\n" +
						"  别人要求就开调试端口，所以这个组合下**永远**等不到端口。\n" +
						"  处理：关掉所有 Obsidian 窗口后重跑（若那个实例是用户正在用的，先问一句再结束它）。"
				);
			}
			throw new Error(
				`调试端口 ${PORT} 在 ${WAIT_SECONDS} 秒内没有就绪，且没有别的 Obsidian 实例在跑。\n` +
					`  这更像是我们启动的实例自己没能起来：确认 ${OBSIDIAN} 能正常打开，\n` +
					"  并检查启动参数里是否有 --disable-gpu --no-sandbox（GPU 进程崩溃会让它立刻退出）。"
			);
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
		if (!hostReady) {
			// ⚠️ 这个现象有两个**完全不同**的原因，而它们的处置也不同 —— 所以先把当前的
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
			const hint =
				state && !state.vault
					? `看起来**没有打开任何 vault**（停在 vault 选择界面）—— 本脚本请求打开的是「${VAULT}」，` +
						`请确认这个名字与 Obsidian 里显示的完全一致（大小写敏感），或用 OBSIDIAN_VAULT 指定。`
					: "vault 已经打开了，所以更像是插件本身没加载起来 —— 看上面的控制台输出。";
			throw new Error(
				`宿主在 60 秒内没有就绪（app.plugins 一直不可用）。\n  实际状态：${JSON.stringify(state)}\n  ${hint}`
			);
		}
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

		// ⭐ 删除原语：本轮新增了「直接删除」这一档，它用的 `Vault.delete` 是**新引入的宿主 API**。
		//
		// 为什么非验不可：类型声明里有、运行时没有的 API 在本项目**真实存在**
		// （`adapter.getBasePath` 就是 —— 移动端类型里有、跑起来抛错）。
		// 若 `vault.delete` 也是这种，删缓存的唯一那条路径会在第一次淘汰时抛错，
		// 而那时报告里写的是"跳过"，用户只会看到"缓存一直不降"。
		//
		// ⭐ 同时验证**去掉的那个备选确实不在了**：设置页里不该再有 `deleteMode` 这一项。
		// 这条非真机不可 —— 声明式设置页有哪些项，只有宿主渲染时才知道；
		// 单元套件验的是我们自己的数据（`SETTINGS_DEFAULTS`），
		// 而"界面上真的没那一项"要在真机上看。
		const removal = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const internals = app.setting ?? {};
				const tabs = [...(internals.pluginTabs ?? []), ...(internals.settingTabs ?? [])];
				const tab = tabs.find((t) => t?.plugin?.manifest?.id === ${JSON.stringify(PLUGIN_ID)});
				const defs = tab?.getSettingDefinitions?.() ?? [];
				const items = defs.flatMap((g) => g.items ?? []);
				// 认键不看文案：文案会随语言变，键不会
				return {
					vaultDelete: typeof app.vault.delete === "function",
					// trashFile 仍被使用：上传后不留本地副本那条路径（删的是用户自己的文件）。
					// ⚠️ 注入的这段代码里**不能出现反引号** —— 它会把外层模板字符串提前闭合，
					// 报错却指向后面某一行（"missing ) after argument list"），极难归因。
					trashFile: typeof app.fileManager?.trashFile === "function",
					hasDeleteModeSetting: "deleteMode" in (plugin?.settings ?? {}),
					deleteModeControl: items.some((i) => i?.control?.key === "deleteMode"),
					// ⭐ 访问密钥 ID 的形态：必须在设置里、且必须是一个**普通控件**
					//（而不是密钥选择器）。这条非真机不可 —— 声明式设置页的控件类型
					// 只有宿主渲染时才知道，而"它到底是不是密钥选择器"正是那个缺陷的定义。
					// ⚠️ 注意上面这几行注释里一个反引号都没有：这段代码是模板字符串的内容，
					// 里面出现反引号会把模板提前闭合（症状是 SyntaxError 指向后面十几行）。
					// 这条纪律由 npm run check 里的 check-injected-snippets 兜着。
					hasAccessKeyIdSetting: "accessKeyId" in (plugin?.settings?.s3 ?? {}),
					accessKeyControlType:
						items.find((i) => i?.control?.key === "s3.accessKeyId")?.control?.type ?? null,
					controlKeys: items.map((i) => i?.control?.key).filter(Boolean),
				};
			})()`
		);
		log(`  ${removal.vaultDelete ? "✓" : "✗"} Vault.delete 存在（删缓存的唯一落点）`);
		log(
			`  ${removal.trashFile ? "✓" : "✗"} FileManager.trashFile 存在（仍被「上传后不留本地副本」使用）`
		);
		log(
			`  ${!removal.hasDeleteModeSetting && !removal.deleteModeControl ? "✓" : "✗"} ` +
				`「缓存删除方式」这个备选确实不在了（设置值与设置项都不该有）`
		);
		// ⭐ 访问密钥 ID 必须是**普通文本框**：它的值可以含大写，
		// 而 Obsidian 的密钥选择器只接受小写 ID —— 早期版本把它做成选择器，
		// 结果是用户**根本填不进去**（实测那个字段一直是空的）。
		const accessKeyIsPlainText = removal.hasAccessKeyIdSetting && removal.accessKeyControlType === "text";
		log(
			`  ${accessKeyIsPlainText ? "✓" : "✗"} 访问密钥 ID 是普通文本框` +
				`（在设置里：${removal.hasAccessKeyIdSetting}，控件类型：${JSON.stringify(removal.accessKeyControlType)}）`
		);
		log(`    （设置页现有的 control key：${JSON.stringify(removal.controlKeys)}）`);

		// ⭐⭐ 一对凭据必须在**同一处**、且都是普通输入框 —— 这条非真机不可：
		// 它是 DOM 事实，只有宿主把设置页渲染出来才看得到。
		//
		// 为什么值得单独验：这两项是**成对签发、成对轮换**的（MinIO / AWS 都如此），
		// 早先秘密走的是"从钥匙串里选择/新建一条**具名**密钥"的选择器，
		// 于是这一对被拆到了两个地方 —— 用户报的正是这件事。
		//
		// 顺带再确认一次：**秘密的值不落在设置里**（只允许存槽位名）。
		const credsProbe = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const s3 = plugin?.settings?.s3 ?? {};
				const shape = {
					hasSecretValue: "secretAccessKey" in s3,
					slotLength: String(s3.secretAccessKeyRef ?? "").length,
				};
				try {
					app.setting.openTabById(${JSON.stringify(PLUGIN_ID)});
				} catch (error) {
					return { ...shape, opened: false, reason: String(error?.message ?? error) };
				}
				for (let i = 0; i < 40; i += 1) {
					const el = document.querySelector(".acc-secret-input");
					if (el) return { ...shape, opened: true, found: true, type: el.type, disabled: !!el.disabled };
					await new Promise((r) => setTimeout(r, 250));
				}
				return { ...shape, opened: true, found: false };
			})()`
		);
		const pairOk = credsProbe.found && credsProbe.type === "password" && !credsProbe.disabled;
		log(
			`  ${pairOk ? "✓" : "✗"} 秘密访问密钥是**普通输入框**（与访问密钥 ID 并排，同一处改）` +
				`（找到：${credsProbe.found}，类型：${JSON.stringify(credsProbe.type)}）` +
				(credsProbe.reason ? `（打开设置页失败：${credsProbe.reason}）` : "")
		);
		log(
			`  ${credsProbe.hasSecretValue ? "✗" : "✓"} 秘密的值不在插件设置里（只存钥匙串槽位名，长度 ${credsProbe.slotLength}）`
		);

		const ok =
			loaded &&
			commands.length >= 4 &&
			patch.hasSetter &&
			patch.untouched &&
			patch.idempotent &&
			apis.getResourcePath &&
			apis.secretStorage &&
			settings.ok &&
			removal.vaultDelete &&
			removal.trashFile &&
			!removal.hasDeleteModeSetting &&
			!removal.deleteModeControl &&
			accessKeyIsPlainText &&
			pairOk &&
			!credsProbe.hasSecretValue &&
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
