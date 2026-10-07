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
 * 代价是 minAppVersion 必须 ≥ 1.13.0 —— 这是明确接受的取舍（见 `docs/SCOPE.md`）。
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

import { Notice, PluginSettingTab } from "obsidian";
import type { App, Setting, SettingDefinitionItem, SettingGroupItem } from "obsidian";

import type AttachmentCloudCachePlugin from "../main";
import { createS3Client } from "../s3/client";
import { connectionReadiness } from "../s3/credentials";
import { fromControlValue, isWritableValue, readByKey, toControlValue, writeByKey } from "./settings-bindings";
import {
	classifyConnectionFailure,
	connectionFailureKey,
	describeRememberedSites,
	ensureSecretSlot,
	localCopyOptions,
	randomSlotPart,
	shouldShowCacheFolder,
} from "./settings-logic";

/** 一次连接测试的结果（已翻成文案 key，界面只负责显示）。 */
interface TestOutcome {
	ok: boolean;
	key: string;
	params?: Record<string, unknown>;
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
				control: { type: "text", key: "s3.publicUrlBase" },
			},

			{
				name: this.t("testConnection"),
				desc: this.t("testConnectionDesc"),
				render: (setting) => this.renderConnectionTest(setting),
			},
		];
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
	 * 真的发一条 `HEAD /桶` 出去 —— 只做静态校验的话它就不叫"测试连接"了。
	 * 结果**就地显示**在说明下方：用 Notice 会一闪而过，而排查连接时
	 * 用户需要对照着改（Notice 只在成功时补一条，免得重复打扰）。
	 */
	private renderConnectionTest(setting: Setting): void {
		const statusEl = setting.descEl.createDiv({ cls: "acc-connection-status" });

		setting.addButton((button) => {
			button.setButtonText(this.t("testConnection")).onClick(async () => {
				button.setDisabled(true);
				button.setButtonText(this.t("testing"));
				statusEl.setText(this.t("testing"));
				statusEl.removeClass("acc-ok", "acc-error");

				try {
					const outcome = await this.runConnectionTest();
					statusEl.setText(this.t(outcome.key, outcome.params));
					statusEl.addClass(outcome.ok ? "acc-ok" : "acc-error");
					if (outcome.ok) new Notice(this.t(outcome.key, outcome.params));
				} finally {
					button.setDisabled(false);
					button.setButtonText(this.t("testConnection"));
				}
			});
		});
	}

	private async runConnectionTest(): Promise<TestOutcome> {
		const readiness = connectionReadiness(this.app.secretStorage, this.plugin.settings);
		if (!readiness.ready) {
			return { ok: false, key: "testFail_notReady", params: { problem: readiness.problem } };
		}

		try {
			const client = createS3Client(readiness.config);
			const { exists } = await client.headBucket();
			return exists ? { ok: true, key: "testOk" } : { ok: false, key: "testFail_bucketMissing" };
		} catch (error) {
			// 只取**归类**，不把原始 message 抛给用户：那是给排查用的（可能带一屏 XML），
			// 而用户此刻需要的是"下一步改哪儿"。
			return { ok: false, key: connectionFailureKey(classifyConnectionFailure(error)) };
		}
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
			{
				name: this.t("rememberedSites"),
				desc: this.t("rememberedSitesDesc"),
				aliases: ["sites", "ask", "站点", "询问"],
				// 放这里而不是"离线副本"组：这是一个**查看与撤销**已经做过的决定的地方，
				// 不是一个日常会调的开关。
				render: (setting) => this.renderRememberedSites(setting),
			},
		];
	}

	/**
	 * 「已记住的站点」列表 + 清除按钮。
	 *
	 * 这个列表存在的意义是**让用户能撤销**：选了「不再询问」之后，
	 * 除了这里没有别的地方能把它改回来（而人一定会误点一次）。
	 */
	private renderRememberedSites(setting: Setting): void {
		const records = this.plugin.siteDecisionsSnapshot().toArray();
		setting.setDesc(
			describeRememberedSites(records, {
				allow: this.t("rememberedSiteAllow"),
				deny: this.t("rememberedSiteDeny"),
				empty: this.t("rememberedSitesEmpty"),
			})
		);
		if (records.length === 0) return;

		setting.addButton((button) =>
			button.setButtonText(this.t("rememberedSitesClear")).onClick(async () => {
				const cleared = this.plugin.clearSiteDecisions();
				await this.plugin.persistSiteDecisions();
				// ⚠️ 提示里带上条数：这正是 `clear()` 返回计数的用途
				new Notice(this.t("rememberedSitesCleared", { count: cleared }));
				// ⚠️ 用 `update()` 而不是 `display()`：1.13 起设置页是**声明式**的，
				// 重新调 `display()` **不会**刷新（lint 也拦这一条）。结果是
				// "清掉了、提示也弹了，但列表还挂着旧内容" —— 用户会以为没生效。
				this.update();
			})
		);
	}
}
