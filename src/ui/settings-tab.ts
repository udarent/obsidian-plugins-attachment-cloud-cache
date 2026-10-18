/**
 * 设置界面（声明式）。
 *
 * ## 为什么用声明式 API
 *
 * Obsidian **1.13.0** 起提供 `getSettingDefinitions()`：把设置**描述**成一个数组，
 * 框架负责渲染、双向绑定与保存。相比命令式地在 `display()` 里逐个 `new Setting(...)`：
 *
 * - 简单项**不用写读写代码**（`control.key` 直接指向设置项）；
 * - 条件显示用 `visible` **谓词**表达，框架会在每次改动后自动重算，
 *   不必像命令式那样整页重渲染；
 * - 设置项会进入 Obsidian 的**设置搜索**（`aliases` 还能补同义词）；
 * - 分组、样式与 Obsidian 自身设置页一致。
 *
 * 代价是 minAppVersion 必须 ≥ 1.13.0 —— 这是明确接受的取舍，不是疏忽。
 *
 * ## 什么时候仍然用 `render`
 *
 * 官方给的判断是："custom layout, async preview, **secret controls**, dynamic
 * dropdowns with side effects, or controls that need extra Obsidian Setting APIs"。
 * 本项目用到两处：
 * 1. **凭据**（`SecretComponent`）—— 它必须拿到 `App` 实例，且返回的是密钥的**名字**；
 * 2. **测试连接** —— 一个带异步状态与结果文案的按钮，不是普通输入控件。
 *
 * ## 绑定由我们自己实现
 *
 * `getControlValue` / `setControlValue` 走 `settings-bindings.ts` 的纯函数，
 * 而不是依赖框架默认的"点号键"行为 —— 那条行为没写进类型定义、本机也无法验证，
 * 而绑定错了的症状是设置**静默存不进**。理由详见那个模块的头注释。
 */

import { ButtonComponent, Notice, PluginSettingTab } from "obsidian";
import type { App, Setting, SettingDefinitionItem, SettingGroupItem } from "obsidian";

import type AttachmentCloudCachePlugin from "../main";
import { createS3Client, objectBaseFor } from "../s3/client";
import { connectionReadiness } from "../s3/credentials";
import type { ConnectionState } from "../link-access";
import { fromControlValue, isWritableValue, readByKey, toControlValue, writeByKey } from "./settings-bindings";
import {
	classifyConnectionFailure,
	classifyPublicLink,
	connectionFailureKey,
	ensureSecretSlot,
	externalSiteModeOptions,
	connectionStateKey,
	connectionStateTone,
	localCopyOptions,
	orphanAskOptions,
	probeStepFailureKey,
	publicLinkKey,
	publicLinkTone,
	randomSlotPart,
	shouldShowCacheLimit,
	shouldShowFallbackDownload,
	shouldShowReleaseSpace,
	shouldShowSiteList,
} from "./settings-logic";

/** 一次连接测试的**一行**结果（已翻成文案 key，界面只负责显示）。 */
interface TestLine {
	key: string;
	params?: Record<string, unknown>;
	/**
	 * 呈现语气。分四档是有意的：`warn` 表示"知道了就好"（例如桶私有 —— 那是正当选择，
	 * 只是链接对外是死的），`error` 表示"该去改点什么"，`info` 是**事实说明**
	 *（例如"这次是用临时探针对象测的"—— 既不是好消息也不是坏消息）。
	 * 都涂成红色会让用户去改没坏的东西；把 `info` 涂成绿色会被误读成"这一项也通过了"。
	 */
	tone: "ok" | "warn" | "error" | "info";
}

export class SettingsTab extends PluginSettingTab {
	private readonly plugin: AttachmentCloudCachePlugin;
	/** 状态那一行的 DOM 句柄（测试结束后要就地刷新它）。 */
	private statusEl: HTMLElement | null = null;

	constructor(app: App, plugin: AttachmentCloudCachePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private t(key: string, params?: Record<string, unknown>): string {
		return this.plugin.t(key, params);
	}

	// ─────────────────────── 与设置对象的绑定 ───────────────────────

	getControlValue(key: string): unknown {
		return toControlValue(key, readByKey(this.plugin.settings, key));
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		// 少数"空值会让功能静默失效"的字段不接受空值（如缓存目录）：
		// 此时**保留原值**，而不是写进一个坏值等着用户下次重启才发现。
		if (!isWritableValue(key, value)) return;

		if (!writeByKey(this.plugin.settings, key, fromControlValue(key, value))) return;

		await this.plugin.saveSettings();
	}

	// ─────────────────────── 定义 ───────────────────────

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: "group", heading: this.t("sectionStorage"), items: this.storageItems() },
			{ type: "group", heading: this.t("sectionUpload"), items: this.uploadItems() },
			{ type: "group", heading: this.t("sectionOffline"), items: this.offlineItems() },
			{ type: "group", heading: this.t("sectionCleanup"), items: this.cleanupItems() },
			{ type: "group", heading: this.t("sectionAdvanced"), items: this.advancedItems() },
		];
	}

	// ─────────────────────── 存储连接 ───────────────────────

	private storageItems(): SettingGroupItem[] {
		return [
			{
				name: this.t("s3Endpoint"),
				desc: this.t("s3EndpointDesc"),
				// 别名让用户在设置搜索里用服务商的名字也能找到这一项
				aliases: ["S3", "R2", "MinIO", "B2", "Wasabi", "url"],
				control: {
					type: "text",
					key: "s3.endpoint",
					placeholder: "https://<account>.r2.cloudflarestorage.com",
				},
			},
			{
				name: this.t("s3Bucket"),
				control: { type: "text", key: "s3.bucket" },
			},
			{
				name: this.t("s3Region"),
				desc: this.t("s3RegionDesc"),
				control: { type: "text", key: "s3.region" },
			},

			// ⚠️ 访问密钥 ID 用**普通文本框**，不是 SecretComponent。
			//
			// 早期版本把它做成密钥选择器，结果用户根本填不进去：那是"选择/新建具名密钥"的
			// 控件，而 Obsidian 的密钥 **ID** 只能是小写字母数字加短横线
			//（`SecretStorage.setSecret` 的 `@param id`，非法直接抛错），
			// 而访问密钥 ID 常规就带大写（AWS 的 `AKIA…`、MinIO 生成的那种）。
			//
			// 它本来也不该进钥匙串：那是**标识符**（"是谁"），会出现在请求签名与服务端
			// 日志里，单独拿到它对签名毫无用处。真正的秘密是下面那一项。
			// 详细理由见 `types.ts` 的文件头。
			{
				name: this.t("s3AccessKey"),
				desc: this.t("s3AccessKeyDesc"),
				aliases: ["access key", "minio", "key id", "访问密钥", "密钥"],
				control: { type: "text", key: "s3.accessKeyId" },
			},
			// ⚠️ 秘密访问密钥**紧挨着**上一项，也是普通输入框（值写穿到钥匙串）。
			//
			// 这两项是**成对签发、成对轮换**的（MinIO / AWS 都如此），所以必须能在一处改完。
			// 早先把它交给 `SecretComponent`（"选择或新建一条**具名**密钥"）时，
			// 这一对就被拆开了：ID 在文本框里，秘密却要先给钥匙串条目起个名字 ——
			// 用户报的正是这件事（"没有一起修改是不对的"）。
			{
				name: this.t("s3SecretKey"),
				desc: this.t("s3SecretKeyDesc"),
				aliases: ["secret", "credential", "密钥"],
				render: (setting) => this.renderSecretInput(setting),
			},

			{
				name: this.t("s3PublicUrlBase"),
				desc: this.t("s3PublicUrlBaseDesc"),
				aliases: ["CDN", "domain", "公开地址"],
				// ⭐ placeholder 是**推导出来的**（改端点或桶它就跟着变），直接告诉用户
				// "留空会用哪个地址" —— 比在说明文字里解释一遍有效得多。
				//
				// ⚠️ 只展示、**不写回设置**：写死就失去自适应性（以后改端点/桶，链接不再跟着变），
				// 而链接是要写进用户笔记的、事后极难改。推导不出来时给 `undefined`（宁可不显示，
				// 也不显示一个半截地址 —— 那会被当成"系统建议你用这个"）。
				control: {
					type: "text",
					key: "s3.publicUrlBase",
					placeholder: objectBaseFor(this.plugin.settings.s3) || undefined,
				},
			},

			{
				// ⭐ 状态与按钮**在同一项里**（2026-10-18）：用户问的是"现在通不通"，
				// 而按钮就是让这个答案变成"刚才"的那个动作 —— 分成两项，用户得在两处
				// 之间来回对照，还会以为它们是两件不相干的事。
				name: this.t("testConnection"),
				desc: this.t("testConnectionDesc"),
				// 别名覆盖用户会搜的词：他们要的是"能不能给别人看"，不一定知道"ACL / 匿名读"
				aliases: ["status", "test", "link", "share", "public", "private", "acl", "permission", "公开", "私有", "权限", "外链", "分享", "别人", "状态"],
				render: (setting) => this.renderConnectionTest(setting),
			},

			// ⚠️ 放在这两栏**之后**：导入是"一次性的省事入口"，而上面那几项才是
			// 用户真要核对/修改的地方。顺序也由 `test-settings-ui.mjs` 的静态守卫钉着 ——
			// 访问密钥 ID 与秘密访问密钥必须是**相邻的前两项**（成对编辑的前提）。
			{
				name: this.t("s3Import"),
				desc: this.t("s3ImportDesc"),
				aliases: ["minio", "credentials", "json", "import", "凭据", "导入"],
				render: (setting) => this.renderCredentialImport(setting),
			},
		];
	}

	/**
	 * 「导入凭据文件」—— MinIO 控制台建完密钥后点「下载凭据」给的就是那个 json。
	 *
	 * ## 为什么是 `<input type="file">`
	 *
	 * 宿主**没有公开的**"让用户选一个文件"API —— `obsidian@1.13.0` 的公开面里查过，
	 * 一个都没有（它内部那个 Electron `showOpenDialog` 既没进类型面、移动端也没有）。
	 * 所以只能用 `<input type="file">`：桌面端弹系统文件对话框，移动端弹文件选择器，
	 * 而且我们**只读它的内容、不碰路径**（移动端本来也拿不到路径）。
	 *
	 * ## 结构：控件区里只有**一个**子元素（一个包裹层）
	 *
	 * ```
	 * controlEl
	 *   └── div.acc-credentials-import   ← 唯一的子元素
	 *         ├── button                 ← 皮肤：宿主自己的 ButtonComponent（只有外观）
	 *         └── input[type=file]       ← **真控件**：铺满同一小块区域，点击落在它身上
	 * ```
	 *
	 * `input[type=file]` **自己会渲染**（"选择文件 / 未选择任何文件"），而我们要的是与设置页
	 * 一致的按钮外观 ⇒ 直接放进控件区就会**并排出现两个控件**（用户最初报的就是这件事）。
	 * 这个元素又不能不要（宿主没有别的选文件 API），于是只有两条出路，而两条我都试过、都不对：
	 *
	 *  ① 放进控件区再用 CSS 藏起来 —— 成因（控件区里多了一个会渲染的元素）还在，只靠一层
	 *     样式挡着，换个主题/样式表没加载症状就回来；
	 *  ② 造一个**游离**的 input（`document.createElement`、从不 append），靠按钮的
	 *     `onClick` 调 `input.click()` —— ⚠️⚠️ **实测这条路不通，真机上就是"点了没反应"**：
	 *     Chromium 只对**在文档里的**文件控件打开选择器。取证：真实鼠标点击那个按钮，
	 *     点击确实到达了按钮、`input.click()` 也确实调了，但 `Page.fileChooserOpened`
	 *     **一次都不来**；把同一个 input 挂进文档，同一条中继路径立刻正常
	 *     （2026-10-09 的真机 A/B 对照）。
	 *
	 * ⇒ 现在它**在文档里**，而且就是被点的那个东西：**没有 `input.click()` 这条会静默失效的中继**。
	 *
	 * ## ⚠️ 要用**这一行自己的文档**去造
	 *
	 * 设置界面是**独立窗口**（`body.mod-windows`）。插件模块作用域里的 `document` 属于主窗，
	 * 而按钮在设置窗口里 —— 用主窗的 `document` 造出来的 input 跨了文档，同样不可靠。
	 * 所以取 `setting.controlEl.ownerDocument`。
	 *
	 * ## 可访问性：读屏与键盘只该看到一个控件
	 *
	 * 皮肤按钮只作外观，挂 `aria-hidden` 与 `tabindex=-1`；控件是那个 input
	 * （名字由 `aria-label` 给，文案走 i18n）。真机探针靠 `.acc-credentials-file-input` 找它。
	 */
	private renderCredentialImport(setting: Setting): void {
		// 控件区里只放这一个包裹层 —— "只有一个控件"由**结构**决定，不靠样式
		const wrap = setting.controlEl.createDiv({ cls: "acc-credentials-import" });

		// 皮肤：宿主自己的按钮组件（外观与设置页其余按钮一致），**不参与交互**
		const skin = new ButtonComponent(wrap);
		skin.setButtonText(this.t("s3ImportButton"));
		skin.buttonEl.setAttribute("aria-hidden", "true");
		skin.buttonEl.tabIndex = -1;

		// ⚠️ 用**这一行自己的元素**去 `createEl`：宿主的 `createEl` 契约是"**建好并挂到这个节点里**"，
		// 所以在一个属于设置窗口的元素上调用它，同时满足两件事：
		//   ① 创建在**这一行所在的窗口**里（设置界面是独立窗口，模块作用域的 `document` 是主窗的）；
		//   ② 直接挂进包裹层 —— 游离的文件控件**开不了**选择器（见上面那段）。
		// ⚠️ 不要写成 `ownerDocument.createEl(...)`：那等于在**文档**上调用它，宿主会试图把元素
		// 挂到 `document` 上 ⇒ `HierarchyRequestError: Only one element on document allowed`
		// —— 真机实测：设置页整行渲染失败（那一行直接看不见）。
		const input = wrap.createEl("input", { cls: "acc-credentials-file-input" });
		input.type = "file";
		// ⚠️ 只作提示、不作强制：用户完全可能把文件存成别的名字或后缀。
		// 挡在对话框里只会让人以为"我的文件不对"，而真正该判的是内容。
		input.accept = ".json,application/json";
		input.setAttribute("aria-label", this.t("s3ImportButton"));
		input.addEventListener("change", () => void this.handleCredentialFile(input));
		// ⭐ 不用再 append：上面的 `createEl` 已经把它挂进包裹层（= 挂进文档）了。
		// 游离的文件控件**开不了**选择器 —— 那正是上一版的错，见上面那段取证。
	}

	/** 读到文件内容 → 交给插件导入 → **如实**报告改了什么、以及为什么没成。 */
	private async handleCredentialFile(input: HTMLInputElement): Promise<void> {
		const file = input.files?.[0] ?? null;
		let text = "";
		try {
			text = file ? await file.text() : "";
		} catch (error) {
			new Notice(
				this.t("s3ImportFailed", { reason: error instanceof Error ? error.message : String(error) })
			);
			return;
		} finally {
			// ⚠️ 失败路径也要清。这里面是明文秘密，没理由留在 DOM 上。
			input.value = "";
		}
		// 用户打开了对话框又取消 —— 不是错误，什么都不做
		if (!file) return;

		const outcome = await this.plugin.importCredentialsFile(text);
		if (!outcome.ok) {
			new Notice(
				outcome.problem === "secretStoreFailed"
					? // 文件没问题，是钥匙串写不进去 —— 复用现有的那条文案（修法不是"换一份文件"）
						this.t("s3SecretStoreFailed", { error: outcome.detail ?? "" })
					: this.t("s3ImportFailed", { reason: this.t(`s3ImportProblem_${outcome.problem}`) })
			);
			return;
		}

		const lines = [this.t("s3ImportDone"), ...outcome.applied.map((key) => `· ${this.t(key)}`)];
		// 文件里那几项用不上的（如 MinIO 的 `api`）如实列出来：否则用户会去琢磨
		// "我明明给它了 s3v4，怎么没反应"。一句话比让他猜强。
		if (outcome.ignored.length > 0) {
			lines.push(this.t("s3ImportIgnored", { fields: outcome.ignored.join(", ") }));
		}

		// ⚠️ 必须让设置页重新取值。上面那几栏（服务地址 / 访问密钥 ID / 秘密）是
		// 我们**绕过控件**直接写进设置的，宿主没有任何理由自己重渲染 ——
		// 不刷新的话它们会继续显示**导入前**的内容，用户看到的正是
		// "通知说导入成功、可框里还是空的"，会以为没成、于是再手输一遍。
		// `update()` 是公开 API 里为这件事准备的（其文档：dynamic tabs when their data changes）。
		this.update();

		new Notice(lines.join("\n"));
	}

	/**
	 * 秘密访问密钥的输入框 —— 与上面的访问密钥 ID **并排**，两个都在这里改。
	 *
	 * ## 为什么不用 `SecretComponent`
	 *
	 * 那是"从钥匙串里选择或新建一条**具名**密钥"的控件。用它就意味着：
	 * 访问密钥 ID 在文本框里填，秘密却要先给钥匙串条目**起个名字** ——
	 * 而这两项是**成对签发、成对轮换**的（MinIO / AWS 都如此），
	 * 一对凭据被拆到两个地方去改，用户报的正是这件事。
	 *
	 * ## 值写穿到钥匙串（设置里只有槽位名）
	 *
	 * 秘密**不能**进设置：`data.json` 是明文，且会随 vault 同步、备份、分享出去。
	 * 所以这里输入的值直接 `setSecret` 进钥匙串，槽位名由 `ensureSecretSlot` 自动生成
	 *（一次生成、此后沿用）—— 用户看不到也不用管这个名字。
	 */
	private renderSecretInput(setting: Setting): void {
		const s3 = this.plugin.settings.s3;
		setting.addText((text) => {
			// 掩码显示：避免肩窥，也提醒这是秘密。内容仍可从钥匙串读回（见下）。
			text.inputEl.type = "password";
			// 稳定的钩子：真机探针靠它确认"这个字段是普通输入框"，而不必猜 DOM 结构
			text.inputEl.addClass("acc-secret-input");
			text.setPlaceholder(this.t("s3SecretKeyPlaceholder"));
			// ⚠️ 设置里存的是**槽位名**，值要从钥匙串读回来 —— 不读的话，
			// 用户每次打开设置页都会看到一个空框，以为自己的密钥没存上、于是再填一次。
			text.setValue(this.readStoredSecret(s3.secretAccessKeyRef));
			text.onChange(async (value) => {
				const slot = ensureSecretSlot(s3.secretAccessKeyRef, randomSlotPart());
				s3.secretAccessKeyRef = slot;
				try {
					this.app.secretStorage.setSecret(slot, String(value ?? ""));
				} catch (error) {
					// ⚠️ 写不进钥匙串必须**如实说**。静默的话，用户以为存上了，
					// 而"测试连接"会报"凭据被拒" —— 于是他会去怀疑密钥本身写错了。
					new Notice(
						this.t("s3SecretStoreFailed", { error: error instanceof Error ? error.message : String(error) })
					);
				}
				await this.plugin.saveSettings();
			});
		});
	}

	/**
	 * 从钥匙串读回已存的秘密。
	 *
	 * 槽位名为空（从未存过）或读取出错（宿主实现差异、锁定等）一律当空串 ——
	 * 设置页要能显示"读不到"，而不是整个崩掉。
	 */
	private readStoredSecret(slot: string): string {
		const trimmed = String(slot ?? "").trim();
		if (trimmed === "") return "";
		try {
			return this.app.secretStorage.getSecret(trimmed) ?? "";
		} catch {
			return "";
		}
	}

	/** 测试那一轮结束后把状态写回那一行（`state` 来自返回值，不是全局）。 */
	private refreshStatusLine(state: ConnectionState): void {
		if (this.statusEl) this.paintStatus(this.statusEl, state);
	}

	/**
	 * 把状态画成**一行带指示灯的话**。
	 *
	 * 颜色不在这里挑：`acc-test-${tone}` 已经按语气给容器上了色，灯用
	 * `background-color: currentColor` 跟着走 —— 于是"灯的颜色"与"文字的颜色"
	 * 不可能分叉。⚠️ 分两处各挑一次，错的那次一定是红绿颠倒，而灯一旦说谎
	 * 比没有灯更糟（用户会看一眼颜色就不再读字）。
	 */
	private paintStatus(el: HTMLElement, state: ConnectionState): void {
		el.empty();
		const head = el.createDiv({ cls: `acc-status-head acc-test-${connectionStateTone(state)}` });
		head.createSpan({ cls: `acc-status-dot acc-status-${state}` });
		head.createSpan({ text: this.t(connectionStateKey(state)) });
	}

	/**
	 * 「测试连接」—— 状态指示灯 + 按钮 + 逐行证据，**同一项**里。
	 *
	 * 它做**三步**，回答三个不同的问题：
	 * 1. 真的发一条 `HEAD /桶` 出去 —— 「**我**这边连得上吗？」（只做静态校验就不叫测试连接了）
	 * 2. **探针回路**（写 → 读回核对 → 删）—— 「上传、取回、删除这三件事还通吗？」
	 * 3. **匿名**请求一次「当前配置会写进笔记的那个地址」—— 「**别人**打得开我笔记里的链接吗？」
	 *
	 * 第 3 步才是最容易被漏掉的一半：前两步全绿、而发给别人的链接全是死的，
	 * 是最能长期不被察觉的状态（本项目就出过一次 —— 公开前缀根本没生效，谁都没发现）。
	 *
	 * 结果**就地逐行显示**在说明下方：用 Notice 会一闪而过，而排查连接时用户需要
	 * 对照着改（Notice 只在第一步通过时补一条，免得重复打扰）。
	 */
	private renderConnectionTest(setting: Setting): void {
		// ① 状态行（灯 + 一句话）：只显示、不可选 —— 桶公开不公开是一个**事实**，不是偏好。
		const statusEl = setting.descEl.createDiv({ cls: "acc-connection-status acc-status" });
		this.statusEl = statusEl;
		this.paintStatus(statusEl, this.plugin.currentConnectionState());

		// ② 结果行**另起一个容器**：测试期间要清空重画，不能连状态行一起擦掉 ——
		// 那正好是用户最想看灯的时候（"正在检测…"）。
		const resultEl = setting.descEl.createDiv({ cls: "acc-connection-status" });

		setting.addButton((button) => {
			button.setButtonText(this.t("testConnection")).onClick(async () => {
				button.setDisabled(true);
				button.setButtonText(this.t("testing"));
				resultEl.empty();
				resultEl.createDiv({ cls: "acc-test-line acc-test-pending", text: this.t("testing") });

				try {
					const lines = await this.runConnectionTest();
					resultEl.empty();
					for (const line of lines) {
						resultEl.createDiv({
							cls: `acc-test-line acc-test-${line.tone}`,
							text: this.t(line.key, line.params),
						});
					}
					if (lines[0]?.tone === "ok") {
						new Notice(lines.map((line) => this.t(line.key, line.params)).join("\n"));
					}
				} finally {
					button.setDisabled(false);
					button.setButtonText(this.t("testConnection"));
				}
			});
		});
	}

	private async runConnectionTest(): Promise<TestLine[]> {
		const readiness = connectionReadiness(this.app.secretStorage, this.plugin.settings);
		if (!readiness.ready) {
			// ⚠️ 这里**不改**状态：配置还没填完时一次测量都没发生（凭据都没发出去过），
			// 把它说成"无法访问"是替用户下了个我们没验过的结论。
			return [{ key: "testFail_notReady", params: { problem: readiness.problem }, tone: "error" }];
		}

		try {
			const client = createS3Client(readiness.config);
			const { exists } = await client.headBucket();
			if (!exists) {
				// 桶不在 ⇒ 从"现在能不能用"的角度就是不可达。**顺手把灯也改掉**：
				// 否则上面那盏灯还绿着，而紧挨着的这一行说桶不存在 —— 同一次测试里自相矛盾。
				this.refreshStatusLine(this.plugin.noteConnectionUnreachable());
				return [{ key: "testFail_bucketMissing", tone: "error" }];
			}
		} catch (error) {
			// 只取**归类**，不把原始 message 抛给用户：那是给排查用的（可能带一屏 XML），
			// 而用户此刻需要的是"下一步改哪儿"。
			this.refreshStatusLine(this.plugin.noteConnectionUnreachable());
			return [{ key: connectionFailureKey(classifyConnectionFailure(error)), tone: "error" }];
		}

		// 第一步过了，第二步才有参考价值（凭据/桶都不对时，公开地址的结论说明不了什么）
		return [{ key: "testOk", tone: "ok" }, ...(await this.runAccessCheck())];
	}

	/**
	 * 第二步：**探针回路 + 匿名可达性**。回答四件事（逐行显示）：
	 *
	 * 1. **写得进去吗**（`testFail_probeWrite`）—— 上传靠它；
	 * 2. **取得回来吗**（`testProbe_roundTrip` / `testFail_probeRead` / `testFail_probeMismatch`）——
	 *    私有桶取副本、离线渲染靠它；
	 * 3. **删得掉吗**（`testProbe_tempLeftBehind`）—— 云端清理靠它，也关系到"有没有留下垃圾"；
	 * 4. **别人打得开吗**（`testPublic_*`）与**我们据此走哪条路**（`testAccess_*`）。
	 *
	 * ⚠️ 第 4 问必须试**真的要写的那个地址**：`probeUrlFor` 与写链接同一套推导（`publicUrlFor`）。
	 * 自己另拼一个地址来测，测的就不是用户笔记里那条链接了 —— 而本项目刚因为
	 * "推导与写入不同源"吃过一次亏（公开前缀根本没传到客户端）。
	 *
	 * ⚠️ 走 `plugin.runConnectionProbe()` 而不是这里自己发请求：这样"界面上显示的结论"与
	 * "渲染判定用的结论"来自**同一次**探测。分成两份的话，用户会看到"测试说公开、图却按私有取"
	 * 这种自相矛盾的表现。
	 *
	 * ⭐ 回路本身（写/读/删）在 `main.ts::connectionProbeOnce`，判据与善后只有那一处；
	 * 这一层只负责把**每一段的实测结果**说成人话。为什么每次都要写：
	 * 借一条旧对象只能证明"读"，而只有读权限的密钥会在这里全绿通过、第一次上传才炸。
	 */
	private async runAccessCheck(): Promise<TestLine[]> {
		// ⭐ 用**返回值**而不是回头读全局字段：连点 / 与自动探测并发时，全局那一格可能已被
		// 另一轮覆盖（对象名、字节数、删除状态都会错位，而界面上看不出来）。
		const { probe, sample, url, state } = await this.plugin.runConnectionProbe();
		this.refreshStatusLine(state);
		const lines: TestLine[] = [];

		// ① 写不进去 ⇒ 回路没跑起来（探测没发生）。这时说"没有链接可检查"是错的：
		// 连接是通的、桶也在，坏的是**写**（上传同样会失败）—— 该去查那把密钥的写权限。
		if (sample?.writeError) {
			return [{ key: probeStepFailureKey("write", sample.writeError), tone: "error" }];
		}
		// ⚠️ 走到这里说明回路跑起来了；状态已由插件写入（下面那两项显示的就是它）

		// ② 读回：三段结果各自一句话（只有在"写成功了"之后才谈得上）
		if (sample?.readError) {
			lines.push({ key: probeStepFailureKey("read", sample.readError), tone: "error" });
		} else if (sample?.sizeMismatch) {
			lines.push({ key: "testFail_probeMismatch", params: { ...sample.sizeMismatch }, tone: "error" });
		} else if (typeof sample?.readBytes === "number") {
			// 一条就够：这个对象是谁、写了多少字节读回多少字节、已经删掉了。
			// 用户不该去猜那个陌生的对象名（它不是他上传的）。
			lines.push({
				key: "testProbe_roundTrip",
				params: { key: sample.key, bytes: sample.readBytes },
				tone: "info",
			});
		}

		// ③ 匿名可达性（别人的视角）
		if (probe.kind === "unknown") {
			// 没有可用的探测对象：**如实说无从验证**，而不是报一个假的通过
			lines.push({ key: "testPublic_noSample", tone: "warn" });
			return lines;
		}

		const kind = classifyPublicLink(probe.status);
		lines.push({
			key: publicLinkKey(kind),
			// 地址取**这一轮真正探测过的那一条**（返回值里的 `url`），不在这里重推一遍：
			// 重推就可能与探测用的地址不同源，而那种差异只会在用户对照时暴露。
			params: { status: probe.status ?? "-", url: url ?? "-" },
			tone: publicLinkTone(kind),
		});

		// ④ 删不掉**必须**单独说：对象还在用户的桶里，而他自己不会想到去查（带 key 他才删得掉）
		if (sample?.leftBehind) {
			lines.push({ key: "testProbe_tempLeftBehind", params: { key: sample.key }, tone: "warn" });
		}

		// ⑤ **结论**：状态（公开 / 私有 / 无法访问），也就是上面那一项显示的同一个东西。
		// ⚠️ 用返回值里的 `state`（这一轮的实测），不是回头读全局。
		lines.push({
			key: connectionStateKey(state),
			tone: connectionStateTone(state),
		});

		// 探测不出来（超时 / 连不上）时把话说准：这不是"桶私有"，是"我们不知道"。
		if (probe.kind === "unreachable") {
			lines.push({ key: probe.timedOut ? "testAccess_timedOut" : "testAccess_unreachable", tone: "warn" });
		}
		return lines;
	}

	// ─────────────────────── 上传 ───────────────────────

	private uploadItems(): SettingGroupItem[] {
		return [
			{
				name: this.t("autoUpload"),
				desc: this.t("autoUploadDesc"),
				aliases: ["paste", "drop", "粘贴", "拖拽"],
				control: { type: "toggle", key: "autoUpload" },
			},
		];
	}

	// ─────────────────────── 离线副本 ───────────────────────

	private offlineItems(): SettingGroupItem[] {
		const items: SettingGroupItem[] = [
			{
				name: this.t("localCopy"),
				desc: this.t("localCopyDesc"),
				aliases: ["offline", "cache", "离线", "缓存", "delete"],
				control: {
					type: "dropdown",
					key: "localCopy",
					// 选项直接由类型清单生成，保证"能选的值"与"合法的值"同源
					options: localCopyOptions((value) => this.t(`localCopy_${value}`)),
				},
			},
			{
				name: this.t("releaseSpaceName"),
				desc: this.t("releaseSpaceDesc"),
				aliases: ["free", "space", "disk", "clean", "delete", "空间", "磁盘", "清理", "释放"],
				// ⚠️ 判据是 `localCopyCleanupTarget`（与流程算目标**同一处**，见 `settings-logic.ts`）：
				// 「不留副本」档（清掉这批 = 这一档的含义）**或**已设上限（清到上限以内）。
				// 1.2.2 及以前只在「不留副本」档显示 —— 那时按钮的含义是"全删"，
				// 在保留档显示它与"我要留副本"自相矛盾；现在它清的是**用户自己设的上限**，
				// 那条矛盾消失了，而"设了上限却没有手动入口"才是真缺口（用户 2026-10-15 报的）。
				visible: () =>
					shouldShowReleaseSpace(this.plugin.settings.localCopy, this.plugin.settings.cacheLimitMb),
				render: (setting) => this.renderReleaseSpace(setting),
			},
			{
				name: this.t("revertName"),
				desc: this.t("revertDesc"),
				aliases: ["revert", "export", "local", "undo", "回退", "导出", "本地", "退出"], 
				render: (setting) => this.renderRevertLinks(setting),
			},
			{
				name: this.t("cacheLimit"),
				desc: this.t("cacheLimitDesc"),
				// ⭐ P7 的关闭方式（1.2.0 / D-17）：可见性跟着"**这一档会不会产生副本**"走
				// （见 `shouldShowCacheLimit`）—— 从前它只在「移入缓存」档显示，而后台只看
				// `cacheLimitMb > 0` ⇒ 「留在附件目录」档**看不见的开关却在生效**。
				aliases: ["limit", "quota", "size", "rotate", "上限", "轮换", "容量", "空间"],
				visible: () => shouldShowCacheLimit(this.plugin.settings.localCopy),
				control: { type: "text", key: "cacheLimitMb", placeholder: this.t("cacheLimitPlaceholder") },
			},
			{
				name: this.t("fallbackDownload"),
				desc: this.t("fallbackDownloadDesc"),
				aliases: ["download", "sync", "下载", "同步"],
				// ⚠️ 选「不留副本」时那一档等于关闭缓存，这一项永远不会动手 ——
				// 显示一个不起作用的开关比不显示更糟。
				// ⚠️ 但「留在附件目录」时它**仍然有用**（副本在附件目录，换设备要它补回来），
				// 所以只能按"缓存是否被关掉"判，不能复用上面那个"会不会产生副本"。
				visible: () => shouldShowFallbackDownload(this.plugin.settings.localCopy),
				control: { type: "toggle", key: "fallbackDownload" },
			},
			{
				name: this.t("externalImageCache"),
				desc: this.t("externalImageCacheDesc"),
				// 别名要覆盖用户会搜的词：默认关，所以"找不到它"就等于"功能不存在"
				aliases: ["external", "hotlink", "third-party", "站外", "外链", "图床", "自动"],
				control: { type: "toggle", key: "externalImageCache" },
			},
			{
				name: this.t("externalSiteMode"),
				desc: this.t("externalSiteModeDesc"),
				aliases: ["site", "allowlist", "blocklist", "filter", "站点", "名单", "白名单", "黑名单", "过滤"],
				// ⚠️ 条件显示：功能关着时名单没有任何意义（自动那一路整个不跑）。
				// 与「缓存目录」那条同一个纪律：**看不见的字段不会产生矛盾组合**。
				visible: () => this.plugin.settings.externalImageCache,
				control: {
					type: "dropdown",
					key: "externalSiteMode",
					options: externalSiteModeOptions((value) => this.t(`externalSite_${value}`)),
				},
			},
			{
				name: this.t("externalSiteList"),
				desc: this.t("externalSiteListDesc"),
				aliases: ["site", "list", "domain", "host", "站点", "名单", "域名"],
				// ⚠️ 两重条件：功能关着时整段站外都没意义；`off` 档下名单**不生效**
				//（判定层根本不读它）—— 显示一个不起作用的框比不显示更糟。
				visible: () =>
					this.plugin.settings.externalImageCache && shouldShowSiteList(this.plugin.settings.externalSiteMode),
				render: (setting) => this.renderSiteList(setting),
			},
			{
				name: this.t("externalPickName"),
				desc: this.t("externalPickDesc"),
				aliases: ["pick", "choose", "select", "选择", "挑选", "缓存"],
				// ⚠️ **刻意不挂在开关上**：它是显式动作，判定层对它走 `purpose: "manual"` ——
				// 开关与名单都**只管自动那一路**。关掉自动处理的人照样该能到这里手动挑。
				// （从前挂过 `visible: externalImageCache`，那依据的是"功能关着时候选会被全部判掉"
				// 这条**已废弃**的语义；R18 之后候选照旧列得出来。少了这一行，"合并成一个开关"
				// 会把设置页这个入口一起关掉，而命令 `pick-external-images` 还开着 —— 两个入口
				// 行为不一致，且文案承诺的"始终可用"就成了空话。）
				render: (setting) => this.renderExternalPicker(setting),
			},
		];

		return items;
	}

	// ─────────────────────── 云端清理 ───────────────────────

	/**
	 * 云端清理那一段。
	 *
	 * 现在只有一项，但仍然**单独成组**而不是塞进「离线副本」：
	 * 它管的是**云端对象**（删了找不回来），与"本地副本"是两件风险等级不同的事 ——
	 * 混在一组里会让人以为它们是同一类开关。
	 */
	private cleanupItems(): SettingGroupItem[] {
		return [
			{
				name: this.t("orphanAsk"),
				desc: this.t("orphanAskDesc"),
				aliases: ["orphan", "unused", "cleanup", "delete", "孤儿", "无人引用", "清理", "删除"],
				control: {
					type: "dropdown",
					key: "orphanAsk",
					// 选项由类型清单生成（与"合法的值"同源）
					options: orphanAskOptions((value) => this.t(`orphanAsk_${value}`)),
				},
			},
		];
	}

	// ─────────────────────── 高级 ───────────────────────

	private advancedItems(): SettingGroupItem[] {
		return [
			{
				name: this.t("forcePathStyle"),
				desc: this.t("forcePathStyleDesc"),
				aliases: ["path-style", "virtual-host", "兼容", "寻址"],
				control: { type: "toggle", key: "s3.forcePathStyle" },
			},
		];
	}

	/**
	 * 站点名单的输入框（多行，一行一条）。
	 *
	 * ⚠️ 用 `render` 而不是声明式的 `control: { type: "text" }`：那个控件是**单行**输入框，
	 * 而名单天然是多条。转换仍然走 `settings-bindings.ts` 那张表
	 *（`formatSiteListText` / `parseSiteListText`）—— "文本 ↔ 数组"只有一处定义，
	 * 不在这里另写一份 split/join（那正是这类字段最容易出的静默错：
	 * 存进去的类型和读回来的不是同一个，症状是"改了设置、重启就没了"）。
	 */
	private renderSiteList(setting: Setting): void {
		setting.addTextArea((area) => {
			// 稳定的钩子：真机探针靠它确认"这个字段是多行输入框"，而不必猜 DOM 结构
			area.inputEl.addClass("acc-site-list-input");
			area.inputEl.rows = 4;
			area.setPlaceholder(this.t("externalSiteListPlaceholder"));
			// `getControlValue` 走的是绑定表里的 `formatSiteListText`（数组 → "一行一条"）。
			// 显式判类型而不是 `String(...)`：后者对非字符串会给出 `[object Object]`（lint 也会拦）。
			const text = this.getControlValue("externalSiteList");
			area.setValue(typeof text === "string" ? text : "");
			area.onChange((value) => {
				void this.setControlValue("externalSiteList", value);
			});
		});
	}

	/**
	 * 「挑选要缓存的文件」那颗按钮。
	 *
	 * 用 `render` 而不是 `control`：这是一个**动作**，不是一个要存下来的值
	 *（官方给 `render` 的场景之一就是这类"不是普通输入控件"的东西）。
	 *
	 * ⚠️ 它调的**就是命令那条链的实现**（`plugin.cachePickedExternalImages`）——
	 * 设置页只是"另一个入口"，候选范围、勾选逻辑、汇总提示都不另写一份。
	 * 两个入口行为不同是这类功能最典型的坏法：按钮能用、命令不能用（或反之），
	 * 而且没人会发现。
	 *
	 * ⚠️ 1.2.0 起它**不要求**先打开上面那个开关（候选判定走 `purpose: "manual"`）——
	 * 关掉自动处理的人，照样能到这里手动挑。
	 */
	private renderExternalPicker(setting: Setting): void {
		setting.addButton((button) =>
			button
				.setButtonText(this.t("externalPickButton"))
				.setCta()
				.onClick(() => {
					void this.plugin.cachePickedExternalImages();
				})
		);
	}

	/**
	 * 「释放本地空间」按钮（F18）。
	 *
	 * ⚠️ 标成**破坏性**：它删的文件**不进回收站**（空间要立刻释放，而回收站不释放），
	 * 所以它是设置页里唯一一个不可撤销的按钮 —— 样式必须与"点开一个选择框"看起来不同。
	 * 真正的确认在弹窗那一步（清单 + 总字节 + 不可撤销的说明）。
	 */
	/**
	 * 「把链接改回本地路径」按钮（退出路径）。
	 *
	 * ⚠️ **不**标成破坏性：它不删文件、不删对象，只把链接换回库内路径 ——
	 * 把它染成警示色会和"腾出空间"那颗按钮混成同一类动作。
	 */
	private renderRevertLinks(setting: Setting): void {
		setting.addButton((button) =>
			button.setButtonText(this.t("revertButton")).onClick(() => {
				void this.plugin.revertLinksToLocal();
			})
		);
	}

	private renderReleaseSpace(setting: Setting): void {
		setting.addButton((button) =>
			button
				.setButtonText(this.t("releaseSpaceButton"))
				.setDestructive()
				.onClick(() => {
					void this.plugin.freeUpLocalSpace();
				})
		);
	}
}
