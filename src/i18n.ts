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
			"Your storage's Access Key (MinIO's “Access Key”, AWS's “Access Key ID”). It is an identifier, not a secret, so it is typed here and may contain capital letters.",
		s3SecretKey: "Secret access key",
		s3SecretKeyDesc:
			"The other half of the pair — change it here, next to the Access Key above. It is kept in your OS keychain, never in the plugin's data.",
		s3SecretKeyPlaceholder: "Stored in your keychain",
		s3SecretStoreFailed: "Could not save the secret to your keychain: {error}",
		s3PublicUrlBase: "Public URL prefix",
		s3PublicUrlBaseDesc:
			"Image links are built from this prefix plus the object path. You can leave it empty: links then use the object address (endpoint + bucket), which needs the bucket to allow anonymous reads. On a CDN or a custom domain, fill this in.",
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

		// ── 回退下载（补齐本地副本）──
		// 只在"用户能采取行动"的失败上出现：配置/权限类。离线失败刻意不提示，
		// 因为那正是用户此刻的状态，弹提示没有信息量。
		fallbackDownloadFailed: "Could not fetch a missing local copy: {error}",
		fallbackNoCacheFolder: "No cache folder is set, so a fetched copy has nowhere to go.",
		fallbackWriteFailed: "Fetched a copy but could not save it into the vault: {error}",
		fallbackIndexPersistFailed: "The copy was saved, but the local-copy index could not be written: {error}",

		// ── 维护命令 ──
		cmdAuditCache: "Show cache usage",
		cmdRepairIndex: "Repair the local-copy index",
		cmdCleanCache: "Clean up unused cache files",
		cmdUploadAttachments: "Upload existing attachments",

		maintainUsageReport:
			"Cache: {totalMb} MB in {count} files. Reclaimable: {reclaimableMb} MB — {orphans} orphaned, {unused} unused, {missing} entries pointing at missing files. Limit: {limit}.",
		maintainRepaired: "Index repaired: {healed} stale entries removed, {skipped} file(s) skipped.",
		maintainNothingToClean: "Nothing to clean up. {healed} stale index entries were repaired.",
		maintainCleanTitle: "Clean up cache files",
		// 缓存清理只有一种方式：直接删除。所以文案不需要按模式分叉 ——
		// 这三条只需说清"删了、空间立刻释放、图会重新下载"。
		maintainCleanSummary: "This deletes {count} file(s) ({mb} MB) from the cache folder.",
		maintainCleanMore: "…and {count} more",
		// 这条必须写清楚"不能撤销" —— 它是用户按下确认前唯一的安全信息。
		maintainCleanSafety:
			"Deleted files are gone — this cannot be undone, and the disk space is freed right away. The images are downloaded again when you next view them. Copies still referenced by a note are never touched.",
		maintainCleanCta: "Delete permanently",
		maintainCancelled: "Cancelled — nothing was changed.",
		maintainCleaned: "Cleaned {removed} file(s); repaired {healed} index entries; {skipped} skipped.",
		maintainPersistFailed: "Could not save the index after repairing it: {error}",
		maintainSkipOutsideCache: "Not inside the cache folder",
		maintainSkipNotIndexed: "Obsidian cannot see this file yet — skipped instead of deleting it directly",
		maintainNotConfigured: "The storage connection is not set up yet, so nothing was uploaded.",
		maintainBatchNothing: "No attachments to upload (all images are already handled).",
		maintainBatchTitle: "Upload existing attachments",
		maintainBatchSummary: "Upload {count} file(s) and rewrite note links to point at your storage.",
		// ⚠️ 必须说清"原文件不删"，否则用户会以为磁盘腾出来了、以为命令没生效。
		maintainBatchKeepsOriginals:
			"Your original files are left in place on purpose — nothing is deleted, so nothing can be lost.",
		maintainBatchCta: "Upload and rewrite links",
		maintainBatchDone:
			"Uploaded {uploaded}, already there {reused}, failed {failed}. Rewrote {links} link(s) across {notes} note(s).",

		// ── 站外图片 ──
		externalImageCache: "Cache images from other sites",
		externalImageCacheDesc:
			"When you open a note containing an image from another site, you are asked once per site whether to download it, upload it to your storage and rewrite the link. Off by default. Cached copies are always kept locally.",
		rememberedSites: "Sites you have answered for",
		rememberedSitesDesc:
			'Sites you have answered for. "Cache" sites are handled automatically; "never ask" sites are left alone.',
		rememberedSitesEmpty: "No sites remembered yet.",
		rememberedSitesClear: "Clear",
		rememberedSitesCleared: "Cleared {count} remembered site(s).",
		rememberedSiteAllow: "cache",
		rememberedSiteDeny: "never ask",
		externalAskMessage: "Image from {host} — cache it into your storage?",
		externalAskCache: "Cache and remember this site",
		externalAskNever: "Don't ask for this site",
		externalCached: "Cached the image from {host} and rewrote the link.",
		externalCachedNoRewrite: "The image was uploaded, but the link in this note could not be rewritten: {error}",
		externalNoNote: "Could not read the note this image is in, so nothing was downloaded or changed.",
		externalFetchForbidden: "Could not download the image from {host}: the site blocks direct downloads (hotlink protection).",
		externalFetchMissing: "The image is no longer available ({status}).",
		externalNotImage: "That address is not an image ({contentType}), so it was not uploaded.",
		externalTooLarge: "The image is larger than the {mb} MB limit, so it was not uploaded.",
		externalUploadFailed: "Downloaded the image but could not upload it: {error}",

		// ── 缓存上限与自动轮换 ──
		cacheLimit: "Cache size limit (MB)",
		cacheLimitDesc:
			"Once the cache folder grows past this, the least recently used copies are deleted in the background and the disk space is freed right away — they are downloaded again the next time you view them. 0 means no limit.",
		cacheLimitPlaceholder: "0 = no limit",
		cacheLimitNone: "unlimited",
		cacheLimitValue: "{mb} MB",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"Cache is over its limit: deleted {count} least recently used copies ({mb} MB). They will be downloaded again when you view them.",
		cacheEvictedPartial:
			"Cache is over its limit: deleted {count} copies ({mb} MB), still {overMb} MB over the limit.",
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
		s3AccessKeyDesc:
			"填存储服务上的 Access Key（MinIO 的「Access Key」、AWS 的「Access Key ID」）。它是标识符、不是密钥，所以直接填在这里，可以含大写字母。",
		s3SecretKey: "秘密访问密钥",
		s3SecretKeyDesc:
			"与上面那一项成对使用 —— 换密钥时在同一处改完即可。它存在系统钥匙串里，不会写进插件的数据。",
		s3SecretKeyPlaceholder: "已存入系统钥匙串",
		s3SecretStoreFailed: "无法把该密钥写入系统钥匙串：{error}",
		s3PublicUrlBase: "公开访问前缀",
		s3PublicUrlBaseDesc:
			"笔记里的图片链接 = 这个前缀 + 对象路径。可以留空 —— 留空就用对象地址（服务地址 + 存储桶），那要求存储桶允许匿名读取；走 CDN 或自定义域名时必须填。",
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

		hookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{error}",
		hookLocalFallbackFailed: "本地文件也没能保存：{error}",
		hookNotConfigured: "未上传（{problem}）。文件已按 Obsidian 的原有方式保存，不会丢。— {where}",
		hookFixConnection: "请到「存储连接」里补全设置。",
		hookFixCredentials: "请到「存储连接」里选择访问密钥。",
		hookLostFiles: "⚠️ 有 {count} 个文件既没能上传、也没能保存到本地。",
		hookUnexpectedFailure: "图片上传出现未预期的错误：{error}",
		indexLoadFailed: "本地副本索引读取失败，离线副本将被重建：{error}",
		indexSkipped: "本地副本索引里有 {count} 条记录无法使用，已丢弃。",
		fallbackDownloadFailed: "补齐本地副本失败：{error}",
		fallbackNoCacheFolder: "没有设置缓存目录，取回的副本无处可放。",
		fallbackWriteFailed: "副本已取回，但写入 vault 失败：{error}",
		fallbackIndexPersistFailed: "副本已保存，但本地副本索引写入失败：{error}",

		cmdAuditCache: "查看缓存占用",
		cmdRepairIndex: "自检并修复本地副本索引",
		cmdCleanCache: "清理未使用的缓存文件",
		cmdUploadAttachments: "上传已存在的附件",

		maintainUsageReport:
			"缓存共 {count} 个文件、{totalMb} MB。其中可回收 {reclaimableMb} MB —— 孤儿 {orphans} 个、未引用 {unused} 个、索引指向的文件已不在 {missing} 条。上限：{limit}。",
		maintainRepaired: "索引已修复：清理失效记录 {healed} 条，跳过文件 {skipped} 个。",
		maintainNothingToClean: "没有需要清理的内容。已修复失效索引记录 {healed} 条。",
		maintainCleanTitle: "清理缓存文件",
		// 缓存清理只有一种方式：直接删除。所以文案不需要按模式分叉 ——
		// 这三条只需说清"删了、空间立刻释放、图会重新下载"。
		maintainCleanSummary: "将从缓存目录删除 {count} 个文件（{mb} MB），磁盘空间立刻释放。",
		maintainCleanMore: "……还有 {count} 个",
		// 这条必须写清楚"不能撤销" —— 它是用户按下确认前唯一的安全信息。
		maintainCleanSafety:
			"删除后无法撤销，磁盘空间会立刻释放。图片会在你下次查看时重新下载。仍被笔记引用的副本一律不动。",
		maintainCleanCta: "彻底删除",
		maintainCancelled: "已取消，没有改动任何内容。",
		maintainCleaned: "已清理 {removed} 个文件；修复索引记录 {healed} 条；跳过 {skipped} 个。",
		maintainPersistFailed: "修复后保存索引失败：{error}",
		maintainSkipOutsideCache: "不在缓存目录内",
		maintainSkipNotIndexed: "Obsidian 还看不到这个文件 —— 已跳过，而不是直接删除",
		maintainNotConfigured: "存储连接尚未配置，没有上传任何内容。",
		maintainBatchNothing: "没有需要上传的附件（图片都已经处理过了）。",
		maintainBatchTitle: "上传已存在的附件",
		maintainBatchSummary: "将上传 {count} 个文件，并把笔记里的链接改成指向你的存储。",
		// ⚠️ 别在文案里写 markdown（`**加粗**`）：确认弹窗是 `createDiv({ text })`、
		// 提示是宿主的 Notice，两者都**按纯文本**渲染 —— 星号会原样显示给用户。
		maintainBatchKeepsOriginals: "原文件会保留在原处 —— 不删任何东西，所以不会丢。",
		maintainBatchCta: "上传并改写链接",
		maintainBatchDone:
			"上传 {uploaded} 个、已存在 {reused} 个、失败 {failed} 个。在 {notes} 篇笔记里改写了 {links} 处链接。",

		// ── 站外图片 ──
		externalImageCache: "缓存站外图片",
		externalImageCacheDesc:
			"打开含站外图片的笔记时，会按站点询问一次：是否下载、上传到你的存储并改写链接。默认关闭。缓存副本始终保留在本地。",
		rememberedSites: "已记住的站点",
		rememberedSitesDesc: "你回答过的站点。选了「缓存」的站点会自动处理；选了「不再询问」的站点不再打扰。",
		rememberedSitesEmpty: "尚未记住任何站点。",
		rememberedSitesClear: "清除",
		rememberedSitesCleared: "已清除 {count} 个已记住的站点。",
		rememberedSiteAllow: "缓存",
		rememberedSiteDeny: "不再询问",
		externalAskMessage: "来自 {host} 的图片 —— 缓存到你的存储？",
		externalAskCache: "缓存并记住该站点",
		externalAskNever: "此站点不再询问",
		externalCached: "已缓存来自 {host} 的图片并改写链接。",
		externalCachedNoRewrite: "图片已上传，但没能改写本篇笔记里的链接：{error}",
		externalNoNote: "读不到这张图所在的笔记，因此没有下载、也没有改动任何内容。",
		externalFetchForbidden: "无法从 {host} 下载图片：该站点有防盗链保护。",
		externalFetchMissing: "图片已失效（{status}）。",
		externalNotImage: "该地址不是图片（{contentType}），未上传。",
		externalTooLarge: "图片超过 {mb} MB 上限，未上传。",
		externalUploadFailed: "图片已下载，但上传失败：{error}",

		// ── 缓存上限与自动轮换 ──
		cacheLimit: "缓存大小上限（MB）",
		cacheLimitDesc:
			"缓存目录超过这个大小后，后台会把最久没用过的副本删掉，磁盘空间立刻释放 —— 下次看到它们时会自动重新下载。填 0 表示不限制。",
		cacheLimitPlaceholder: "0 = 不限制",
		cacheLimitNone: "不限",
		cacheLimitValue: "{mb} MB",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"缓存超出上限：已删除 {count} 份最久没用过的副本（{mb} MB）。下次看到它们时会自动重新下载。",
		cacheEvictedPartial: "缓存超出上限：已删除 {count} 份（{mb} MB），仍超出上限 {overMb} MB。",
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
