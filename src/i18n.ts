/**
 * 文案（中 / 英）。
 *
 * 与 `settings.ts` 的合并逻辑同样的纪律：**英文表是基准**，
 * 中文表缺键会退化成英文，而不是显示成空白或 key 本身。
 * 由 `test-i18n.mjs` 钉住"两表键名一致 + 无空串 + 占位符对称"。
 *
 * 设置界面的文案遵循 Obsidian 的 UI 准则：句子式大小写；
 * 标题里**不出现 "settings" 字样**（整页都是设置，重复它没有信息量）；
 * 说明写"这个选项**做什么**"，而不是复述选项名。
 */

export interface Locale {
	[key: string]: string;
}

export const I18N: Record<string, Locale> = {
	en: {
		// ── 设置界面：分组标题 ──
		// 按用户的使用顺序排列：先能连上，再谈上传，然后是离线，最后是少数人才动的高级项。
		sectionStorage: "Storage connection",
		sectionUpload: "Upload",
		sectionOffline: "Offline copies",
		sectionAdvanced: "Advanced",

		// ── 存储连接 ──
		s3Endpoint: "Endpoint",
		s3EndpointDesc: "The S3-compatible service address, for example https://<account>.r2.cloudflarestorage.com.",
		s3Bucket: "Bucket",
		s3Region: "Region",
		s3RegionDesc: "Use auto for Cloudflare R2.",
		s3AccessKey: "Access key ID",
		s3AccessKeyDesc:
			"Pick a secret from your keychain, or create one there. Only the secret's name is saved in the plugin's data.",
		s3SecretKey: "Secret access key",
		s3SecretKeyDesc: "Same keychain secret can be shared with other plugins, and updated in one place.",
		s3PublicUrlBase: "Public URL prefix",
		s3PublicUrlBaseDesc: "Image links are built from this prefix plus the object path.",
		testConnection: "Test connection",
		testConnectionDesc: "Sends one HEAD request to the bucket.",
		testing: "Testing…",
		testOk: "Connected, and the bucket is reachable.",
		testFail_notReady: "Not ready to test yet: {problem}",
		testFail_bucketMissing: "Reached the service, but the bucket was not found. Check the bucket name.",
		testFail_auth: "The service rejected the credentials. Check the keys and the bucket permissions.",
		testFail_network: "Could not reach the service. Check the address and your network.",
		testFail_throttled: "The service is rate-limiting requests. Try again in a moment.",
		testFail_server: "The service reported an internal error. Try again later.",
		testFail_other: "The test failed. Check the address, the bucket name and the credentials.",

		// ── 上传 ──
		autoUpload: "Upload on paste and drop",
		autoUploadDesc:
			"When off, pasting and dropping are left to Obsidian, so files are saved locally as usual. Images already cached still render offline.",
		extensions: "File types",
		extensionsDesc:
			"Separated by commas or spaces, without dots. Clearing the field restores the default image list.",

		// ── 离线副本 ──
		localCopy: "Where the local copy goes",
		localCopyDesc:
			"Where the local copy of an uploaded file is kept. Without a local copy, images cannot be shown offline.",
		localCopy_cache: "Move into the cache folder (offline works)",
		localCopy_keep: "Leave in the attachments folder (offline works)",
		localCopy_trash: "Do not keep a local copy (offline unavailable)",
		cacheFolder: "Cache folder",
		cacheFolderDesc:
			"Relative to the vault root. This folder is disposable: deleting it only costs one re-download.",
		fallbackDownload: "Download missing copies",
		fallbackDownloadDesc:
			"For images from this storage that have no local copy, such as ones synced from another device. Images from other sites are never downloaded.",

		// ── 高级 ──
		attachmentFolder: "Attachments folder override",
		attachmentFolderPlaceholder: "Follow Obsidian",
		attachmentFolderDesc: "Leave empty to follow Obsidian's own attachment setting.",
		objectKeyTemplate: "Object key template",
		objectKeyTemplateDesc:
			"Available: {hash}, {ext}, {filename}, {date}. Changing this affects new uploads only; existing links keep working.",
		forcePathStyle: "Compatibility mode",
		forcePathStyleDesc:
			"Addresses objects as endpoint/bucket/key. Keep this on for Cloudflare R2, MinIO and most self-hosted services; turn it off only if your provider requires bucket subdomains.",

		// ── 出错 ──
		uploadFailed: "The storage rejected this upload ({status}): {text}",
		hookUploadFailedKeptLocal: "Upload failed, so the file was kept locally instead: {error}",
		hookLocalFallbackFailed: "Could not save the file locally either: {error}",
		// 未配置就粘贴：**没有接管**，图由 Obsidian 照常保存。
		// 文案要说清这两件事 —— 否则用户会以为图丢了，而其实它好好地躺在附件目录里。
		hookNotConfigured: "Not uploaded ({problem}). The file was saved to your vault as usual. — {where}",
		hookFixConnection: "Fill in the storage connection settings.",
		hookFixCredentials: "Pick your access keys in the storage connection settings.",
		hookLostFiles: "⚠️ {count} file(s) could not be saved anywhere — neither uploaded nor kept locally.",
		hookUnexpectedFailure: "Image upload failed unexpectedly: {error}",

		// ── 缓存索引 ──
		indexLoadFailed: "Local-copy index could not be read, so offline copies will be rebuilt: {error}",
		indexSkipped: "{count} entries in the local-copy index were unusable and have been dropped.",
	},
	zh: {
		sectionStorage: "存储连接",
		sectionUpload: "上传",
		sectionOffline: "离线副本",
		sectionAdvanced: "高级",

		s3Endpoint: "服务地址",
		s3EndpointDesc: "S3 兼容服务的地址，例如 https://<account>.r2.cloudflarestorage.com。",
		s3Bucket: "存储桶",
		s3Region: "区域",
		s3RegionDesc: "Cloudflare R2 填 auto。",
		s3AccessKey: "访问密钥 ID",
		s3AccessKeyDesc: "从钥匙串里选择一条密钥，或在那里新建。插件数据里只保存这条密钥的名字。",
		s3SecretKey: "秘密访问密钥",
		s3SecretKeyDesc: "同一条钥匙串密钥可以和其他插件共用，改动只需改一处。",
		s3PublicUrlBase: "公开访问前缀",
		s3PublicUrlBaseDesc: "笔记里的图片链接由这个前缀加上对象路径拼成。",
		testConnection: "测试连接",
		testConnectionDesc: "会向存储桶发一次 HEAD 请求。",
		testing: "测试中…",
		testOk: "连接正常，存储桶可访问。",
		testFail_notReady: "还无法测试：{problem}",
		testFail_bucketMissing: "能连上服务，但找不到这个存储桶 —— 请检查桶名。",
		testFail_auth: "服务拒绝了凭据 —— 请检查密钥与桶的权限。",
		testFail_network: "连不上服务 —— 请检查地址与网络。",
		testFail_throttled: "服务正在限流，请稍后再试。",
		testFail_server: "服务端出错，请稍后再试。",
		testFail_other: "测试失败 —— 请检查地址、桶名与凭据。",

		autoUpload: "粘贴或拖入时自动上传",
		autoUploadDesc:
			"关闭后粘贴与拖拽交回 Obsidian 处理，文件照常存在本地。已经缓存的图片仍然离线可见。",
		extensions: "参与的文件类型",
		extensionsDesc: "用逗号或空格分隔，不带点。清空则恢复默认的图片清单。",

		localCopy: "本地副本的处理",
		localCopyDesc: "上传后，本地副本放在哪里。不留副本时，断网就看不到图片。",
		localCopy_cache: "移入缓存目录（离线可用）",
		localCopy_keep: "留在附件目录（离线可用）",
		localCopy_trash: "不留本地副本（离线不可用）",
		cacheFolder: "缓存目录",
		cacheFolderDesc: "相对 vault 根目录。这个目录是可丢弃的：删掉只会导致重新下载一次。",
		fallbackDownload: "缺本地副本时自动下载",
		fallbackDownloadDesc:
			"属于本存储、却没有本地副本的图片（例如从另一台设备同步来的）会自动下载。站外图片永不下载。",

		attachmentFolder: "附件目录覆盖",
		attachmentFolderPlaceholder: "跟随 Obsidian",
		attachmentFolderDesc: "留空表示跟随 Obsidian 自己的附件设置。",
		objectKeyTemplate: "对象 key 模板",
		objectKeyTemplateDesc:
			"可用占位符：{hash}、{ext}、{filename}、{date}。改动只影响之后的上传，已有链接不受影响。",
		forcePathStyle: "兼容模式",
		forcePathStyleDesc:
			"以「地址/桶/键」的方式寻址。Cloudflare R2、MinIO 与多数自建服务都需要开着；只有服务商要求用桶名做子域时才关掉。",

		uploadFailed: "对象存储拒绝了这次上传（{status}）：{text}",
		hookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{error}",
		hookLocalFallbackFailed: "本地文件也没能保存：{error}",
		hookNotConfigured: "未上传（{problem}）。文件已按 Obsidian 的原有方式保存，不会丢。— {where}",
		hookFixConnection: "请到「存储连接」里补全设置。",
		hookFixCredentials: "请到「存储连接」里选择访问密钥。",
		hookLostFiles: "⚠️ 有 {count} 个文件既没能上传、也没能保存到本地。",
		hookUnexpectedFailure: "图片上传出现未预期的错误：{error}",
		indexLoadFailed: "本地副本索引读取失败，离线副本将被重建：{error}",
		indexSkipped: "本地副本索引里有 {count} 条记录无法使用，已丢弃。",
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
 *
 * 用 `switch` 而不是一串 `if`：这样"哪些类型可格式化"是一张**看得见的清单**，
 * 将来加类型（比如 `bigint`）时不会漏在某个 `||` 的缝隙里。
 */
function formatParam(value: unknown): string | null {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
			return String(value);
		default:
			// 对象、数组、null、undefined、symbol、bigint、function……
			// 一律不替换 —— 见上面"看得见"的理由
			return null;
	}
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
