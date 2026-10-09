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
import { createS3Client, objectBaseFor, probePublicLink, publicUrlFor } from "../s3/client";
import type { S3ClientConfig } from "../s3/client";
import { connectionReadiness } from "../s3/credentials";
import { fromControlValue, isWritableValue, readByKey, toControlValue, writeByKey } from "./settings-bindings";
import {
	classifyConnectionFailure,
	classifyPublicLink,
	connectionFailureKey,
	ensureSecretSlot,
	externalImageDefaultOptions,
	localCopyOptions,
	publicLinkKey,
	publicLinkTone,
	randomSlotPart,
	shouldShowCacheFolder,
} from "./settings-logic";

/** 一次连接测试的**一行**结果（已翻成文案 key，界面只负责显示）。 */
interface TestLine {
	key: string;
	params?: Record<string, unknown>;
	/**
	 * 呈现语气。分三档是有意的：`warn` 表示"知道了就好"（例如桶私有 —— 那是正当选择，
	 * 只是链接对外是死的），`error` 表示"该去改点什么"。都涂成红色会让用户去改没坏的东西。
	 */
	tone: "ok" | "warn" | "error";
}

export class SettingsTab extends PluginSettingTab {
	private readonly plugin: AttachmentCloudCachePlugin;

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
				name: this.t("testConnection"),
				desc: this.t("testConnectionDesc"),
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
	 *     （`dev-notes/_archive/.probe-file-chooser-truth.mjs` 的 A/B 对照）。
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

	/**
	 * 「测试连接」按钮。
	 *
	 * 它做**两步**，回答两个不同的问题：
	 * 1. 真的发一条 `HEAD /桶` 出去 —— 「**我**这边连得上吗？」（只做静态校验就不叫测试连接了）
	 * 2. **匿名**请求一次「当前配置会写进笔记的那个地址」—— 「**别人**打得开我笔记里的链接吗？」
	 *
	 * 第 2 步才是最容易被漏掉的一半：前一步全绿、而发给别人的链接全是死的，
	 * 是最能长期不被察觉的状态（本项目就出过一次 —— 公开前缀根本没生效，谁都没发现）。
	 *
	 * 结果**就地逐行显示**在说明下方：用 Notice 会一闪而过，而排查连接时用户需要
	 * 对照着改（Notice 只在第一步通过时补一条，免得重复打扰）。
	 */
	private renderConnectionTest(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({ cls: "acc-connection-status" });

		setting.addButton((button) => {
			button.setButtonText(this.t("testConnection")).onClick(async () => {
				button.setDisabled(true);
				button.setButtonText(this.t("testing"));
				statusEl.empty();
				statusEl.createDiv({ cls: "acc-test-line acc-test-pending", text: this.t("testing") });

				try {
					const lines = await this.runConnectionTest();
					statusEl.empty();
					for (const line of lines) {
						statusEl.createDiv({
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
			return [{ key: "testFail_notReady", params: { problem: readiness.problem }, tone: "error" }];
		}

		try {
			const client = createS3Client(readiness.config);
			const { exists } = await client.headBucket();
			if (!exists) return [{ key: "testFail_bucketMissing", tone: "error" }];
		} catch (error) {
			// 只取**归类**，不把原始 message 抛给用户：那是给排查用的（可能带一屏 XML），
			// 而用户此刻需要的是"下一步改哪儿"。
			return [{ key: connectionFailureKey(classifyConnectionFailure(error)), tone: "error" }];
		}

		// 第一步过了，第二步才有参考价值（凭据/桶都不对时，公开地址的结论说明不了什么）
		return [{ key: "testOk", tone: "ok" }, await this.runPublicLinkCheck(readiness.config)];
	}

	/**
	 * 第二步：**匿名**试着打开「当前配置会写进笔记的那个地址」，回答「别人打得开吗」。
	 *
	 * ⚠️ 必须试**真的要写的那个地址**（用 `publicUrlFor` 算，与写链接同一套推导）。
	 * 自己另拼一个地址来测，测的就不是用户笔记里那条链接了 —— 而本项目刚因为
	 * "推导与写入不同源"吃过一次亏（公开前缀根本没传到客户端）。
	 */
	private async runPublicLinkCheck(config: S3ClientConfig): Promise<TestLine> {
		const key = this.plugin.sampleObjectKey();
		if (!key) {
			// 没有对象可试：**如实说无从验证**，而不是报一个假的通过
			return { key: "testPublic_noSample", tone: "warn" };
		}

		const url = publicUrlFor(config, key);
		const probe = await probePublicLink(url);
		const kind = classifyPublicLink(probe.status);
		return {
			key: publicLinkKey(kind),
			params: { status: probe.status ?? "-", url },
			tone: publicLinkTone(kind),
		};
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
			{
				name: this.t("extensions"),
				desc: this.t("extensionsDesc"),
				aliases: ["png", "jpg", "file types", "扩展名", "文件类型"],
				// 设置里是数组、控件是文本框 → 转换在 settings-bindings.ts 里
				control: { type: "textarea", key: "enabledExtensions", rows: 2 },
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
				name: this.t("cacheFolder"),
				desc: this.t("cacheFolderDesc"),
				// ⚠️ 条件显示：只有选了「移入缓存」它才有意义。
				// 用谓词表达而不是整页重渲染 —— 框架会在改动后自动重算。
				// 一个看不见的字段不会和别的字段产生矛盾组合。
				visible: () => shouldShowCacheFolder(this.plugin.settings.localCopy),
				control: { type: "text", key: "cacheFolder" },
			},
			{
				name: this.t("cacheLimit"),
				desc: this.t("cacheLimitDesc"),
				aliases: ["limit", "quota", "size", "rotate", "上限", "轮换", "容量", "空间"],
				// ⚠️ 与缓存目录同一个显示条件：副本不在缓存目录里时（`keep`），
				// 这个上限永远不会触发 —— 显示一个永远不起作用的开关比不显示更糟。
				visible: () => shouldShowCacheFolder(this.plugin.settings.localCopy),
				control: { type: "text", key: "cacheLimitMb", placeholder: this.t("cacheLimitPlaceholder") },
			},
			{
				name: this.t("fallbackDownload"),
				desc: this.t("fallbackDownloadDesc"),
				aliases: ["download", "sync", "下载", "同步"],
				control: { type: "toggle", key: "fallbackDownload" },
			},
			{
				name: this.t("externalImageCache"),
				desc: this.t("externalImageCacheDesc"),
				// 别名要覆盖用户会搜的词：默认关，所以"找不到它"就等于"功能不存在"
				aliases: ["external", "hotlink", "third-party", "站外", "外链", "图床"],
				control: { type: "toggle", key: "externalImageCache" },
			},
			{
				name: this.t("externalImageDefault"),
				desc: this.t("externalImageDefaultDesc"),
				aliases: ["cache", "auto", "default", "默认", "自动", "外链"],
				// ⚠️ 条件显示：功能关着时这一档没有任何意义（判定层第一步就忽略了）。
				// 与「缓存目录」那条同一个纪律：**看不见的字段不会产生矛盾组合**。
				visible: () => this.plugin.settings.externalImageCache,
				control: {
					type: "dropdown",
					key: "externalImageDefault",
					options: externalImageDefaultOptions((value) => this.t(`externalDefault_${value}`)),
				},
			},
			{
				name: this.t("externalPickName"),
				desc: this.t("externalPickDesc"),
				aliases: ["pick", "choose", "select", "选择", "挑选", "缓存"],
				// 同上：功能关着时连候选都挑不出来（判定层会全部判掉）
				visible: () => this.plugin.settings.externalImageCache,
				render: (setting) => this.renderExternalPicker(setting),
			},
		];

		return items;
	}

	// ─────────────────────── 高级 ───────────────────────

	private advancedItems(): SettingGroupItem[] {
		return [
			{
				name: this.t("attachmentFolder"),
				desc: this.t("attachmentFolderDesc"),
				aliases: ["attachment folder", "附件目录"],
				control: {
					type: "text",
					key: "attachmentFolder",
					placeholder: this.t("attachmentFolderPlaceholder"),
				},
			},
			{
				name: this.t("objectKeyTemplate"),
				desc: this.t("objectKeyTemplateDesc"),
				aliases: ["key", "template", "path", "命名", "模板"],
				control: { type: "text", key: "s3.objectKeyTemplate" },
			},
			{
				name: this.t("forcePathStyle"),
				desc: this.t("forcePathStyleDesc"),
				aliases: ["path-style", "virtual-host", "兼容", "寻址"],
				control: { type: "toggle", key: "s3.forcePathStyle" },
			},
		];
	}

	/**
	 * 「选择要缓存的外链图片」那颗按钮。
	 *
	 * 用 `render` 而不是 `control`：这是一个**动作**，不是一个要存下来的值
	 *（官方给 `render` 的场景之一就是这类"不是普通输入控件"的东西）。
	 *
	 * ⚠️ 它调的**就是命令那条链的实现**（`plugin.cachePickedExternalImages`）——
	 * 设置页只是"另一个入口"，候选范围、勾选逻辑、汇总提示都不另写一份。
	 * 两个入口行为不同是这类功能最典型的坏法：按钮能用、命令不能用（或反之），
	 * 而且没人会发现。
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
}
