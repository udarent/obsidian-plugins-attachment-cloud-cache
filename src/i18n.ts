/**
 * 文案（中 / 英）。
 *
 * 与 `settings.ts` 的合并逻辑同样的纪律：**英文表是基准**，
 * 中文表缺键会退化成英文，而不是显示成空白或 key 本身。
 * 由 `test-i18n.mjs` 钉住"两表键名一致 + 无空串 + 占位符对称"。
 */

export interface Locale {
	[key: string]: string;
}

export const I18N: Record<string, Locale> = {
	en: {
		ribbonOpenSettings: "Attachment Cloud Cache — settings",
		settingsComingSoon: "Settings UI arrives with the next phase (upload + cache).",

		// 设置页（后续阶段使用）
		settingsTitle: "Attachment Cloud Cache",
		settingsStorage: "Storage",
		settingsCache: "Cache",
		settingsUpload: "Upload",

		// 出错
		uploadFailed: "S3 upload failed ({status}): {text}",
		hookUploadFailedKeptLocal:
			"Upload failed, so the image was kept locally instead: {error}",
		hookLocalFallbackFailed: "Could not save the file locally either: {error}",
	},
	zh: {
		ribbonOpenSettings: "附件云缓存 — 设置",
		settingsComingSoon: "设置界面随下一阶段（上传 + 缓存）一起提供。",

		settingsTitle: "附件云缓存",
		settingsStorage: "存储",
		settingsCache: "缓存",
		settingsUpload: "上传",

		uploadFailed: "S3 上传失败（{status}）：{text}",
		hookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{error}",
		hookLocalFallbackFailed: "本地文件也没能保存：{error}",
	},
};

/** 把 Obsidian 的语言代码映射到我们支持的语种。 */
export function detectLocale(language: string | undefined): "en" | "zh" {
	return language && language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/**
 * 把占位符实参转成文本；**非标量返回 null**（表示"不替换"）。
 *
 * ⚠️ 不能直接 `String(value)`：传入对象会得到 `"[object Object]"`，
 * 然后被塞进用户可见的提示里（如"上传失败（[object Object]）"），
 * 既没信息量又掩盖了调用方传错参数这件事。
 * 而 `params` 的类型是 `Record<string, unknown>` —— 类型系统给不了保护。
 *
 * 返回 null 让调用方**保留 `{name}` 原样**：提示里会明显看出有个占位符没填上，
 * 比静默显示一段废话更容易定位。
 */
function formatParam(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

/**
 * 取文案并替换 `{占位符}`。
 *
 * 未知 key 返回 key 本身（方便一眼看出漏了哪条）；
 * 缺失或不可格式化的占位符保持 `{name}` 原样 —— 都主张"看得见"，
 * 而不是静默变空。
 */
export function translate(
	locale: string,
	key: string,
	params: Record<string, unknown> = {}
): string {
	const table = I18N[locale] ?? I18N.en;
	const template = table[key] ?? I18N.en[key] ?? key;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const formatted = formatParam(params[name]);
		return formatted === null ? match : formatted;
	});
}
