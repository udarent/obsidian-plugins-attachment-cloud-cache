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
 * ⚠️ 有一条例外，它连"行为"一起验：**编辑态（实时预览）里的站外图必须被交给编排层**。
 * 理由是这一条**只能真机验** —— 后处理器在实时预览下不跑（官方文档写明它只作用于
 * reading mode，实测同一篇笔记阅读视图 5 次、编辑态 0 次），而候选是从
 * `src` 拦截的 setter 里来的，那条路在 Node 里没有真 WebView 可测。
 * 于是脚本在 vault 里临时造一篇带站外图的笔记、用编辑态打开、断言候选确实被送出，
 * 然后删掉笔记并把两处接缝都还原（询问接缝换成"永不答复"，所以不会弹通知、
 * 不会写站点记忆、更不会下载 —— 在别人的 vault 上跑也不留痕迹）。
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

// 宿主启动 / 调试端口 / 挑主窗 / 等就绪 / vault 回读 —— 与真实存储回环脚本共用同一份。
// 那些坑（GPU 崩溃、连错窗口、静默退回别的 vault）只写一遍，避免两边逐渐分叉。
import { evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

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
 *
 * 默认值是**中性名字** `TestVault`，刻意不写开发者自己的 vault 目录名 —— 脚本会进仓库、
 * 也会在别的机器上跑，默认值不该带上某个人的本地环境。你自己的库用
 * `OBSIDIAN_VAULT=<你的 vault 名>` 指定；名字不对时报错会列出本机已知的 vault。
 */
const VAULT = process.env.OBSIDIAN_VAULT ?? "TestVault";

/**
 * 等调试端口的秒数。
 *
 * 可覆盖是为了**能验证"端口没起来"那条失败路径**（否则测一次要干等 60 秒），
 * 也为了在本机排查时不用空等。
 */
const WAIT_SECONDS = Number(process.env.OBSIDIAN_DEBUG_WAIT ?? 60);
const PLUGIN_ID = "attachment-cloud-cache";

const log = (line = "") => console.log(line);

// 宿主启动 / 调试端口 / 挑主窗 / 等就绪 / **vault 回读** / 页面求值 —— 全部搬到了
// `lib/obsidian-host.mjs`（与 `verify-real-storage.mjs` 共用）。那里集中了四个实测过的坑：
// 启动参数缺一不可、必须挑对窗口、连接要重试、以及"请求不存在的 vault 会静默退回别的 vault"。

async function main() {
	log("═".repeat(72));
	log("真机烟雾验证：插件能否在真实 Obsidian 里加载并接线");
	log("═".repeat(72));
	log(`  打开的 vault：${VAULT}（可用 OBSIDIAN_VAULT 覆盖）`);

	const { client, child } = await launchAndAttach({
		exe: OBSIDIAN,
		port: PORT,
		vault: VAULT,
		waitSeconds: WAIT_SECONDS,
		log,
	});

	try {
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
				sampleObjectKey: typeof app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}].sampleObjectKey === "function",
			}))()`
		);
		log(`  ${apis.getResourcePath ? "✓" : "✗"} Vault.getResourcePath 存在（本地副本改写的落点）`);
		log(`  ${apis.secretStorage ? "✓" : "✗"} app.secretStorage 存在（凭据不进明文）`);
		// 「测试连接」第二步要用它取一个已存在的对象来探测公开地址 ——
		// 改个名字不会有任何编译错误（设置页是运行时才调它的），所以在这里钉一下
		log(`  ${apis.sampleObjectKey ? "✓" : "✗"} plugin.sampleObjectKey 存在（公开链接检查取样用）`);

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

		// ⭐⭐ 一对凭据必须在**同一处**、且秘密那一项不能是"声明式控件"。
		//
		// 为什么值得单独验：这两项是**成对签发、成对轮换**的（MinIO / AWS 都如此），
		// 早先秘密走的是"从钥匙串里选择/新建一条**具名**密钥"的选择器，
		// 于是这一对被拆到了两个地方 —— 用户报的正是这件事。
		//
		// ⚠️ 为什么不断言 DOM（第一版是找 `.acc-secret-input` 那个 `<input>`）：
		// 实测在本机这个 Obsidian 版本上，**设置弹窗不在 CDP 连到的 document 里** ——
		// `app.setting.open()` 之后 `activeTabId` 已是本插件，但 `modalCount` / `itemCount`
		// 都是 0（现场诊断打出来的）。也就是说那条断言会永远红，**而它红的原因是驱动方式，
		// 不是被测对象**。这种"看起来在验一件事、其实验不了"的断言比没有更糟。
		//
		// 所以改成两条**各自可核实**的：
		// ① 真机（这里）：紧跟访问密钥 ID 的那一项存在、且是**自定义渲染**（有 `render`、无 `control`）
		//    ⇒ 它不可能是一个声明式控件，也就是**不可能把值写进设置**；
		// ② 源码（`test-settings-ui.mjs` 的静态守卫）：那一项用 `addText`、且全文件不构造
		//    `SecretComponent` ⇒ 它是个普通输入框，而不是密钥选择器。
		//
		// ③ 另外顺带再确认一次：**秘密的值不落在设置里**（只允许存槽位名）。
		const credsProbe = await evaluate(
			client,
			`(() => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const s3 = plugin?.settings?.s3 ?? {};
				const internals = app.setting ?? {};
				const tabs = [...(internals.pluginTabs ?? []), ...(internals.settingTabs ?? [])];
				const tab = tabs.find((t) => t?.plugin?.manifest?.id === ${JSON.stringify(PLUGIN_ID)});
				const items = (tab?.getSettingDefinitions?.() ?? []).flatMap((g) => g.items ?? []);
				const accessIndex = items.findIndex((i) => i?.control?.key === "s3.accessKeyId");
				const next = accessIndex >= 0 ? items[accessIndex + 1] : null;
				return {
					hasSecretValue: "secretAccessKey" in s3,
					slotLength: String(s3.secretAccessKeyRef ?? "").length,
					accessIndex,
					hasNextItem: Boolean(next),
					nextIsCustomRender: Boolean(next) && typeof next.render === "function" && !next.control,
					nextHasControl: Boolean(next?.control),
				};
			})()`
		);
		const pairOk = credsProbe.accessIndex >= 0 && credsProbe.nextIsCustomRender;
		log(
			`  ${pairOk ? "✓" : "✗"} 秘密访问密钥紧跟访问密钥 ID，且是**自定义渲染**（不可能把值写进设置）` +
				`（访问密钥 ID 的下标：${credsProbe.accessIndex}，下一项存在：${credsProbe.hasNextItem}，` +
				`自定义渲染：${credsProbe.nextIsCustomRender}，带声明式控件：${credsProbe.nextHasControl}）`
		);
		log(
			`  ${credsProbe.hasSecretValue ? "✗" : "✓"} 秘密的值不在插件设置里（只存钥匙串槽位名，长度 ${credsProbe.slotLength}）`
		);

		// ⭐ 实时预览（编辑态）里的站外图**必须**被解析出归属并交给编排层。
		//
		// 这条检查守的是一个真实缺陷：站外缓存原先只有后处理器一个入口，而那个钩子
		// **在实时预览下不跑**（真机实测：同一篇笔记阅读视图 5 次、编辑态 0 次）——
		// 于是编辑态里那个功能完全没反应（既不问也不缓存，连站点记忆文件都不生成）。
		//
		// ⚠️ 刻意**不依赖用户的配置**：`externalHook.process()` 是无条件被调用的
		// （要不要问由它内部判定），所以即便这个 vault 还没配好存储，这条接线检查照样成立。
		// 配置没配好时下面的"询问到的站点"会是空的 —— 那是正常的，不算失败。
		const livePreview = await evaluate(
			client,
			`(async () => {
				const plugin = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}];
				const TEMP = "_acc-smoke-live-preview.md";
				const URL = "https://example.com/acc-smoke-external.png";
				const undo = [];
				try {
					// ⚠️ 第二参 force = true 会**绕过回收站**：这篇临时笔记是我们自己造的，
					// 不该在用户的 .trash 里留一条。默认行为是进回收站 —— 实测跑完
					// .trash 的修改时间会变，说明确实留了东西。
					const stale = app.vault.getAbstractFileByPath(TEMP);
					if (stale) await app.vault.delete(stale, true);
					const note = await app.vault.create(TEMP, "![](" + URL + ")\\\\n");
					undo.push(async () => {
						const f = app.vault.getAbstractFileByPath(TEMP);
						if (f) await app.vault.delete(f, true);
					});

					// 记录编排层被谁调用过（带上来源笔记）—— 这就是"候选真的送到了"的证据
					const originalProcess = plugin.externalHook.process;
					const delivered = [];
					plugin.externalHook.process = (root, ctx) => {
						delivered.push(ctx?.sourcePath ?? null);
						return originalProcess.call(plugin.externalHook, root, ctx);
					};
					undo.push(() => { plugin.externalHook.process = originalProcess; });

					// 询问接缝换成"只记录、永不答复"：不弹通知、不写站点记忆、更不会下载。
					// 于是这条检查在别人的 vault 上跑也不会留下任何痕迹。
					const originalAsk = plugin.askExternalCache;
					const askedHosts = [];
					plugin.askExternalCache = (info) => {
						askedHosts.push(info.host);
						return new Promise(() => {});
					};
					undo.push(() => { plugin.askExternalCache = originalAsk; });

					const leaf = app.workspace.getLeaf("tab");
					await leaf.openFile(note);
					const view = leaf.view;
					// 强制**实时预览（编辑态）**—— 后处理器不跑的就是这个模式
					view.setState({ ...view.getState(), mode: "source" }, { history: false });
					await new Promise((r) => setTimeout(r, 3000));

					const imgs = [...view.containerEl.querySelectorAll(".cm-editor img")].map((i) =>
						i.getAttribute("src")
					);

					// ⭐ 第二条：清除站点记忆必须让**当前打开着的**笔记重新被看一遍。
					// 缺了它，用户点完「清除站点记忆」什么都看不到（已经渲染出来的图
					// 不会自己重跑判定），只会以为按钮坏了 —— 实测踩到过。
					// 这里刻意**不回答**任何询问（接缝永不答复）⇒ 不写站点记忆、不下载，
					// 于是这条检查在别人的 vault 上跑也不留任何痕迹。
					const deliveredBeforeClear = delivered.length;
					plugin.clearSiteDecisions();
					await new Promise((r) => setTimeout(r, 1500));
					const deliveredAfterClear = delivered.length - deliveredBeforeClear;

					leaf.detach();
					return { delivered, askedHosts, imgs, tempPath: TEMP, deliveredAfterClear };
				} finally {
					for (const step of undo.reverse()) {
						try {
							await step();
						} catch (e) {
							/* 清理尽力而为 */
						}
					}
				}
			})()`
		);
		const liveDelivered = (livePreview.delivered ?? []).filter((path) => path === livePreview.tempPath).length;
		const liveOk = liveDelivered >= 1;
		log(
			`  ${liveOk ? "✓" : "✗"} 编辑态（实时预览）里的站外图被交给了编排层` +
				`（${liveDelivered} 次；收到过的来源：${JSON.stringify(livePreview.delivered)}）`
		);
		log(
			`  ${livePreview.askedHosts.length > 0 ? "✓" : "-"} 询问到的站点：${JSON.stringify(livePreview.askedHosts)}` +
				(livePreview.askedHosts.length === 0 ? "（存储未就绪时不问，属正常）" : "")
		);
		// ⭐ 清除站点记忆之后必须**重看当前打开的笔记**，否则用户点完按钮毫无反馈
		const reAskOk = livePreview.deliveredAfterClear >= 1;
		log(
			`  ${reAskOk ? "✓" : "✗"} 清除站点记忆后重看当前打开的笔记（又送来 ${livePreview.deliveredAfterClear} 次候选）`
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
			liveOk &&
			reAskOk &&
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
