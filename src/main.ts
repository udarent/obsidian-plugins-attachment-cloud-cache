/**
 * 插件入口。
 *
 * ⚠️ 当前是 **Phase 1 骨架**：只做"加载设置 + 落盘设置"这条最小闭环，
 * 上传、缓存、渲染钩子等功能按 docs/SCOPE.md 的阶段表逐个 TDD 加入。
 * 这样每个阶段都能独立验证，而不是先堆一大坨再一起调。
 */

import { Notice, Plugin, getLanguage } from "obsidian";

import { SETTINGS_DEFAULTS, mergePluginSettings } from "./settings";
import { PluginSettings } from "./types";
import { I18N, detectLocale, translate } from "./i18n";

export default class AttachmentCloudCachePlugin extends Plugin {
	settings: PluginSettings = { ...SETTINGS_DEFAULTS };
	locale = "en";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.locale = detectLocale(getLanguage());

		this.addRibbonIcon("cloud-upload", this.t("ribbonOpenSettings"), () => {
			// 设置页在下一阶段随功能一起提供；先给一个明确反馈而不是静默无响应
			new Notice(this.t("settingsComingSoon"));
		});
	}

	onunload(): void {
		// 目前没有需要清理的资源。渲染观察器/事件钩子会在后续阶段登记到这里。
	}

	/** 供各模块统一的文案查询入口。 */
	t(key: string, params?: Record<string, unknown>): string {
		return translate(this.locale, key, params ?? {});
	}

	async loadSettings(): Promise<void> {
		// ⚠️ 走 mergePluginSettings 而不是直接赋值：data.json 可能是手改的、
		// 旧版本的、或被别的工具写坏的，必须逐字段校验后再用。
		this.settings = mergePluginSettings(SETTINGS_DEFAULTS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

// 让 I18N 被打进产物（后续阶段会用到；此处显式引用避免被 tree-shaking 掉）
void I18N;
