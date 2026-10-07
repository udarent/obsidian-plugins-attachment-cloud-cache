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

import { Notice, PluginSettingTab, SecretComponent } from "obsidian";
import type { App, Setting, SettingDefinitionItem, SettingGroupItem } from "obsidian";

import type AttachmentCloudCachePlugin from "../main";
import { createS3Client } from "../s3/client";
import { connectionReadiness } from "../s3/credentials";
import { fromControlValue, isWritableValue, readByKey, toControlValue, writeByKey } from "./settings-bindings";
import {
	classifyConnectionFailure,
	connectionFailureKey,
	describeRememberedSites,
	localCopyOptions,
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

			// 凭据走 SecretComponent：它返回密钥的**名字**，值由 Obsidian 存进钥匙串。
			// 用 render 是因为它需要 App 实例，而 control 的写法拿不到。
			{
				name: this.t("s3AccessKey"),
				desc: this.t("s3AccessKeyDesc"),
				aliases: ["credential", "key", "token", "密钥"],
				render: (setting) => this.renderSecret(setting, "accessKeyIdRef"),
			},
			{
				name: this.t("s3SecretKey"),
				desc: this.t("s3SecretKeyDesc"),
				render: (setting) => this.renderSecret(setting, "secretAccessKeyRef"),
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

	/** 一个凭据选择器。用 `addComponent` 而不是 `addText`：`SecretComponent` 需要 `App`。 */
	private renderSecret(setting: Setting, field: "accessKeyIdRef" | "secretAccessKeyRef"): void {
		const s3 = this.plugin.settings.s3;
		setting.addComponent((el) =>
			new SecretComponent(this.app, el)
				.setValue(s3[field])
				.onChange(async (value) => {
					s3[field] = String(value ?? "").trim();
					await this.plugin.saveSettings();
				})
		);
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
