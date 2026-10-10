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
		s3Import: "Import from a credentials file",
		s3ImportDesc:
			"Read the JSON your storage provider gives you (MinIO's “Download credentials” produces one) and fill in the fields below. Only the service address, the access key and the addressing mode are written to the plugin's data; the secret key goes straight into your OS keychain, and no copy of the file is kept.",
		s3ImportButton: "Choose file…",
		s3ImportDone: "Imported from the credentials file",
		s3ImportIgnored: "Ignored, as this plugin does not use it: {fields}",
		s3ImportFailed: "Could not read that file: {reason}",
		s3ImportProblem_notJson: "it is not valid JSON.",
		s3ImportProblem_notObject: "its top level is not a JSON object.",
		s3ImportProblem_noCredentials: "it contains no recognisable credentials.",
		testing: "Testing…",
		testOk: "Connected, and the bucket is reachable.",
		testFail_notReady: "Not ready to test yet: {problem}",
		testFail_bucketMissing: "Reached the service, but the bucket was not found. Check the bucket name.",
		testFail_auth: "The service rejected the credentials. Check the keys and the bucket permissions.",
		testFail_network: "Could not reach the service. Check the address and your network.",
		testFail_throttled: "The service is rate-limiting requests. Try again in a moment.",
		testFail_server: "The service reported an internal error. Try again later.",
		testFail_other: "The test failed. Check the address, the bucket name and the credentials.",
		// ── 第二步：那个地址**别人**打得开吗（匿名探测）──
		testPublic_ok: "The public link works — anyone can open it: {url}",
		testPublic_forbidden:
			"Reached that address, but it refuses anonymous access — other people cannot open your links. Make the bucket publicly readable, or set a Public URL base (a CDN or custom domain).",
		testPublic_missing:
			"Reached that address, but the object is not there (404) — the URL base is probably wrong. Checked: {url}",
		testPublic_unreachable: "Could not reach that address at all — the URL base is probably wrong. Checked: {url}",
		testPublic_other: "Could not tell whether the link works (HTTP {status}). Checked: {url}",
		testPublic_noSample: "Nothing uploaded yet, so there is no link to check — upload a file first.",

		// ── 上传 ──
		autoUpload: "Upload new attachments automatically",
		autoUploadDesc:
			"Covers every way a file ends up in your vault: pasting, dropping, adding one from your phone's gallery or camera, sharing into Obsidian, or copying files in. Uploaded files are linked from your note as remote URLs. Turn it off and all of that goes back to Obsidian, leaving files local only.",
		attachAutoUploaded: "Uploaded {count} attachment(s) that had just been added to your vault.",
		attachAutoFailed: "{count} newly added attachment(s) could not be uploaded — the files are still in your vault.",

		// ── 离线副本 ──
		localCopy: "Where the local copy goes",
		localCopyDesc:
			"Where the local copy of an uploaded file is kept. Without a local copy, files cannot be shown offline.",
		localCopy_cache: "Move into the cache folder (offline works)",
		localCopy_keep: "Leave in the attachments folder (offline works)",
		localCopy_trash: "Do not keep a local copy (offline unavailable)",
		cacheFolder: "Cache folder",
		cacheFolderDesc:
			"Relative to the vault root. This folder is disposable: deleting it only costs one re-download.",
		fallbackDownload: "Download missing copies",
		fallbackDownloadDesc:
			"For files from this storage that have no local copy, such as ones synced from another device. Files from other sites are never downloaded.",

		// ── 高级 ──
		attachmentFolder: "Attachments folder override",
		attachmentFolderPlaceholder: "Follow Obsidian",
		attachmentFolderDesc:
			"Leave empty to follow Obsidian's own attachment setting; a value here overrides it.",
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
		hookUnexpectedFailure: "Upload failed unexpectedly: {error}",

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
		// ── 云端空间清理（F15）──
		cmdCleanupCloud: "Clean up unused objects in the cloud…",
		cloudCleanupTitle: "Clean up the cloud",
		cloudCleanupSummary:
			"{count} object(s), about {mb} MB, are not referenced by any note in this vault:",
		cloudCleanupCta: "Delete these objects",
		cloudCleanupDeviceBlindSpot:
			"Only this device's references can be seen. Other devices (or another vault sharing this storage) may still be using some of these files — deleting cannot be undone.",
		cloudCleanupCannotUndo: "The objects are deleted from your storage; local copies are kept.",
		cloudCleanupTruncatedWarning:
			"The listing stopped early (too many objects), so this list may be incomplete.",
		cloudCleanupNothing: "Nothing to clean up: every object in your storage is still referenced.",
		cloudCleanupTruncatedNothing:
			"Nothing to clean up in the part that was listed, and the listing stopped early — try again later.",
		cloudCleanupDone: "Deleted {deleted} object(s); {failed} failed. {unindexed} index record(s) removed.",
		cloudCleanupListFailed: "Could not list the objects in your storage: {error}",
		cloudCleanupPersistFailed: "Could not save the cache index: {error}",
		cloudCleanupUnreadableNote: "Could not read {path}, so the cleanup was cancelled.",
		cloudDeleteTitle: "Also delete the copy in your storage?",
		cloudDeleteBody: "{name} was uploaded to your storage. Delete that copy as well?",
		cloudDeleteWarning:
			"The object may be shared (the same content is stored once) and deleting it cannot be undone. Other devices would lose it until it is uploaded again.",
		cloudDeleteKeepLocal: 'Choosing "local only" just confirms the deletion you already made.',
		cloudDeleteStillReferenced: "Still linked from another note, so the cloud copy cannot be deleted.",
		cloudDeleteLocalOnly: "Local only (keep the cloud copy)",
		cloudDeleteBoth: "Delete in the cloud too",
		cloudDeleteCancel: "Cancel",
		cloudDeleteDone: "Deleted the object from your storage.",
		cloudDeleteFailed: "Could not delete the object: {error}",
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
			"Deleted files are gone — this cannot be undone, and the disk space is freed right away. They are downloaded again when you next view them. Copies still referenced by a note are never touched.",
		maintainCleanCta: "Delete permanently",
		maintainCancelled: "Cancelled — nothing was changed.",
		maintainCleaned: "Cleaned {removed} file(s); repaired {healed} index entries; {skipped} skipped.",
		maintainPersistFailed: "Could not save the index after repairing it: {error}",
		maintainSkipOutsideCache: "Not inside the cache folder",
		maintainSkipNotIndexed: "Obsidian cannot see this file yet — skipped instead of deleting it directly",
		maintainNotConfigured: "The storage connection is not set up yet, so nothing was uploaded.",
		maintainBatchNothing: "No attachments to upload (everything is already handled).",
		maintainBatchTitle: "Upload existing attachments",
		maintainBatchSummary: "Upload {count} file(s) and rewrite note links to point at your storage.",
		// ⚠️ 必须说清"跑完原文件就不在附件目录里了"（设置项承诺的是「移入缓存目录」），
		// 否则用户做完发现文件还在会以为没生效；也得说清"没被引用的文件不碰"。
		maintainBatchMovesOriginals:
			"Once uploaded, these files move into the cache folder and are renamed by content — nothing stays behind in the attachments folder. Files that no note refers to are left alone.",
		maintainBatchSkipsUnreferenced:
			"{count} file(s) in your vault are not linked from any note, so they are left alone.",
		maintainBatchCanvasSkipped:
			"{count} reference(s) in canvases could not be rewritten (the file is not readable JSON), so they still point to their old location.",
		maintainBatchCta: "Upload and rewrite links",
		maintainBatchExternal:
			"Also {count} file(s) hosted elsewhere, on {sites} site(s): {hosts}",
		maintainBatchDone:
			"Uploaded {uploaded}, already there {reused}, failed {failed}. Rewrote {links} link(s) across {notes} note(s).",

		// ── 站外图片 ──
		externalImageCache: "Cache files from other sites",
		externalImageCacheDesc:
			"Whether the plugin may handle files that live on other sites at all. Off by default: while it is off those files are left completely alone.",
		externalImageDefault: "When a note links to a file on another site",
		externalImageDefaultDesc:
			"What to do by default. \"Leave it alone\" never touches it; \"Cache straight away\" downloads it, uploads it to your storage and rewrites the link in the note. Either way you can pick individual files with the button below.",
		externalDefault_skip: "Leave it alone",
		externalDefault_cache: "Cache straight away",
		externalPickName: "Pick specific files",
		externalPickDesc:
			"Choose images from the current note or from the whole vault, and only those are cached. Picking one is the same as agreeing to it — the default above does not apply.",
		externalPickButton: "Choose files…",
		externalPickTitle: "Choose files to cache",
		externalPickScope: "Where to look",
		externalPickScopeNote: "Current note",
		externalPickScopeVault: "Whole vault",
		externalPickEmpty:
			"No images to cache here (they may already be in your own storage, or the feature or the storage connection is not set up).",
		externalPickAll: "Select all",
		externalPickNone: "Select none",
		externalPickCta: "Cache the {count} selected",
		externalPickCancel: "Cancel",
		externalPickDisabled: "Turn on \"Cache files from other sites\" first.",
		externalPickNothing: "No files were cached.",
		externalPickDone:
			"Cached {cached} file(s); {partial} were uploaded but their link could not be rewritten; {failed} failed.",
		cmdPickExternal: "Cache files from other sites…",
		externalCached: "Cached the file from {host} and rewrote the link.",
		externalCachedNoRewrite: "The file was uploaded, but the link in this note could not be rewritten: {error}",
		externalNoNote: "Could not read the note that links this file, so nothing was downloaded or changed.",
		externalFetchForbidden: "Could not download the file from {host}: the site blocks direct downloads (hotlink protection).",
		externalFetchMissing: "That link is no longer available ({status}).",
		externalNotAttachment: "That address returned a web page or plain text ({contentType}), not a file, so it was not uploaded.",
		externalTooLarge: "The file is larger than the {mb} MB limit, so it was not uploaded.",
		externalUploadFailed: "Downloaded the file but could not upload it: {error}",

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
		s3Import: "从凭据文件导入",
		s3ImportDesc:
			"读取存储服务商给你的那份 JSON（MinIO 控制台的「下载凭据」就是这种），自动填好下面几栏。只有服务地址、访问密钥和寻址方式会写进插件的数据；秘密访问密钥直接进系统钥匙串，插件不留副本。",
		s3ImportButton: "选择文件…",
		s3ImportDone: "已从凭据文件导入",
		s3ImportIgnored: "已忽略（本插件用不到）：{fields}",
		s3ImportFailed: "无法读取该文件：{reason}",
		s3ImportProblem_notJson: "它不是合法的 JSON。",
		s3ImportProblem_notObject: "它的顶层不是一个 JSON 对象。",
		s3ImportProblem_noCredentials: "里面没有能认出来的凭据字段。",
		testing: "测试中…",
		testOk: "连接正常，存储桶可访问。",
		testFail_notReady: "还无法测试：{problem}",
		testFail_bucketMissing: "能连上服务，但找不到这个存储桶 —— 请检查桶名。",
		testFail_auth: "服务拒绝了凭据 —— 请检查密钥与桶的权限。",
		testFail_network: "连不上服务 —— 请检查地址与网络。",
		testFail_throttled: "服务正在限流，请稍后再试。",
		testFail_server: "服务端出错，请稍后再试。",
		testFail_other: "测试失败 —— 请检查地址、桶名与凭据。",
		// ── 第二步：那个地址**别人**打得开吗（匿名探测）──
		testPublic_ok: "公开链接可用 —— 别人也能打开：{url}",
		testPublic_forbidden:
			"那个地址能连上，但拒绝匿名访问 —— 别人打不开你的链接。把存储桶设为公开读，或填一个公开访问前缀（CDN / 自定义域名）。",
		testPublic_missing: "那个地址能连上，但对象不在（404）—— 多半是前缀写错了。检查的是：{url}",
		testPublic_unreachable: "连不上那个地址 —— 前缀可能写错了。检查的是：{url}",
		testPublic_other: "无法判断链接是否可用（HTTP {status}）。检查的是：{url}",
		testPublic_noSample: "还没上传过任何东西，没有链接可检查 —— 先上传一个文件。",

		autoUpload: "新增附件自动上传",
		autoUploadDesc:
			"覆盖附件进入库的所有方式：粘贴、拖入、手机相册或相机、分享到 Obsidian、从别处拷进库。上传后笔记里的链接会换成远端地址。关闭后这些全部交回 Obsidian 处理，文件只存在本地。已经缓存的附件仍然离线可见。",
		attachAutoUploaded: "已自动上传刚加入库的 {count} 个附件。",
		attachAutoFailed: "刚加入库的 {count} 个附件上传失败 —— 文件仍然留在你的库里。",

		localCopy: "本地副本的处理",
		localCopyDesc: "上传后，本地副本放在哪里。不留副本时，断网就看不到附件。",
		localCopy_cache: "移入缓存目录（离线可用）",
		localCopy_keep: "留在附件目录（离线可用）",
		localCopy_trash: "不留本地副本（离线不可用）",
		cacheFolder: "缓存目录",
		cacheFolderDesc: "相对 vault 根目录。这个目录是可丢弃的：删掉只会导致重新下载一次。",
		fallbackDownload: "缺本地副本时自动下载",
		fallbackDownloadDesc:
			"属于本存储、却没有本地副本的附件（例如从另一台设备同步来的）会自动下载。站外文件永不下载。",

		attachmentFolder: "附件目录覆盖",
		attachmentFolderPlaceholder: "跟随 Obsidian",
		attachmentFolderDesc: "留空表示跟随 Obsidian 自己的附件设置；填写后将覆盖它。",
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
		hookUnexpectedFailure: "上传出现未预期的错误：{error}",
		indexLoadFailed: "本地副本索引读取失败，离线副本将被重建：{error}",
		indexSkipped: "本地副本索引里有 {count} 条记录无法使用，已丢弃。",
		fallbackDownloadFailed: "补齐本地副本失败：{error}",
		fallbackNoCacheFolder: "没有设置缓存目录，取回的副本无处可放。",
		fallbackWriteFailed: "副本已取回，但写入 vault 失败：{error}",
		fallbackIndexPersistFailed: "副本已保存，但本地副本索引写入失败：{error}",

		// ── 云端空间清理（F15）──
		cmdCleanupCloud: "清理云端未使用对象…",
		cloudCleanupTitle: "清理云端空间",
		cloudCleanupSummary: "有 {count} 个对象没有被本库任何笔记引用，约占 {mb} MB：",
		cloudCleanupCta: "删除这些对象",
		cloudCleanupDeviceBlindSpot:
			"只能看到**本设备**的引用情况。其他设备（或共用这个存储的另一个库）可能还在用其中一些文件 —— 删除后无法恢复。",
		cloudCleanupCannotUndo: "删除的是云端对象；本地副本会保留。",
		cloudCleanupTruncatedWarning: "列举提前结束了（对象太多），所以这份清单可能不全。",
		cloudCleanupNothing: "没有需要清理的：你存储里的对象都还被引用着。",
		cloudCleanupTruncatedNothing: "已列出的部分没有可清理的对象，而列举提前结束了 —— 可以稍后再试。",
		cloudCleanupDone: "已删除 {deleted} 个对象，失败 {failed} 个，摘掉 {unindexed} 条索引记录。",
		cloudCleanupListFailed: "无法列出你存储里的对象：{error}",
		cloudCleanupPersistFailed: "缓存索引保存失败：{error}",
		cloudCleanupUnreadableNote: "读不到 {path}，因此取消了这次清理。",
		cloudDeleteTitle: "要不要连云端那份一起删？",
		cloudDeleteBody: "{name} 已经上传到你的存储。要不要把云端那份也删掉？",
		cloudDeleteWarning:
			"这个对象可能被别处共用（相同内容只存一份），而且删除**无法撤销** —— 其他设备在重新上传之前会看不到它。",
		cloudDeleteKeepLocal: "选「仅删本地」就是确认你刚才那次删除，云端不动。",
		cloudDeleteStillReferenced: "它仍被别的笔记引用，所以不能删云端那一份。",
		cloudDeleteLocalOnly: "仅删本地（保留云端）",
		cloudDeleteBoth: "连同云端一起删",
		cloudDeleteCancel: "取消",
		cloudDeleteDone: "已从你的存储里删掉那个对象。",
		cloudDeleteFailed: "删除对象失败：{error}",
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
			"删除后无法撤销，磁盘空间会立刻释放。它们会在你下次查看时重新下载。仍被笔记引用的副本一律不动。",
		maintainCleanCta: "彻底删除",
		maintainCancelled: "已取消，没有改动任何内容。",
		maintainCleaned: "已清理 {removed} 个文件；修复索引记录 {healed} 条；跳过 {skipped} 个。",
		maintainPersistFailed: "修复后保存索引失败：{error}",
		maintainSkipOutsideCache: "不在缓存目录内",
		maintainSkipNotIndexed: "Obsidian 还看不到这个文件 —— 已跳过，而不是直接删除",
		maintainNotConfigured: "存储连接尚未配置，没有上传任何内容。",
		maintainBatchNothing: "没有需要上传的附件（都已经处理过了）。",
		maintainBatchTitle: "上传已存在的附件",
		maintainBatchSummary: "将上传 {count} 个文件，并把笔记里的链接改成指向你的存储。",
		// ⚠️ 别在文案里写 markdown（`**加粗**`）：确认弹窗是 `createDiv({ text })`、
		// 提示是宿主的 Notice，两者都**按纯文本**渲染 —— 星号会原样显示给用户。
		maintainBatchMovesOriginals:
			"上传成功后，这些文件会被移入缓存目录并按内容改名 —— 附件目录里不再留一份。没有任何笔记引用的文件不会被碰。",
		maintainBatchSkipsUnreferenced: "另有 {count} 个文件没有被任何笔记引用，不会被处理。",
		maintainBatchCanvasSkipped:
			"画布里有 {count} 处引用没能改写（画布文件不是可读的 JSON），它们仍指向旧位置。",
		maintainBatchCta: "上传并改写链接",
		maintainBatchExternal: "另有 {count} 个文件托管在站外，来自 {sites} 个站点：{hosts}",
		maintainBatchDone:
			"上传 {uploaded} 个、已存在 {reused} 个、失败 {failed} 个。在 {notes} 篇笔记里改写了 {links} 处链接。",

		// ── 站外图片 ──
		externalImageCache: "缓存站外文件",
		externalImageCacheDesc:
			"是否允许插件处理别处的文件。默认关闭；关着时这类文件一步都不会被碰。",
		externalImageDefault: "遇到站外文件链接时",
		externalImageDefaultDesc:
			"默认怎么做。「什么都不做」绝不碰它；「直接缓存」会下载、上传到你的存储、并改写笔记里的链接。两种情况都能用下面那颗按钮逐张挑。",
		externalDefault_skip: "什么都不做",
		externalDefault_cache: "直接缓存",
		externalPickName: "挑选要缓存的文件",
		externalPickDesc:
			"在「当前笔记」或「全库」里勾选图片，只处理你勾中的那些。勾选本身就是同意，与上面的默认设置无关。",
		externalPickButton: "选择文件…",
		externalPickTitle: "选择要缓存的文件",
		externalPickScope: "范围",
		externalPickScopeNote: "当前笔记",
		externalPickScopeVault: "全库",
		externalPickEmpty:
			"这个范围里没有可缓存的图片（可能已经在你自己的存储里，或者功能/存储连接还没配好）。",
		externalPickAll: "全选",
		externalPickNone: "全不选",
		externalPickCta: "缓存选中的 {count} 张",
		externalPickCancel: "取消",
		externalPickDisabled: "请先打开「缓存站外文件」。",
		externalPickNothing: "没有缓存任何文件。",
		externalPickDone: "已缓存 {cached} 张；{partial} 张已上传但没能改写链接；{failed} 张失败。",
		cmdPickExternal: "缓存站外文件（可挑选）…",
		externalCached: "已缓存来自 {host} 的文件并改写链接。",
		externalCachedNoRewrite: "文件已上传，但没能改写本篇笔记里的链接：{error}",
		externalNoNote: "读不到链接该文件的笔记，因此没有下载、也没有改动任何内容。",
		externalFetchForbidden: "无法从 {host} 下载文件：该站点有防盗链保护。",
		externalFetchMissing: "该链接已失效（{status}）。",
		externalNotAttachment: "该地址返回的是网页或纯文本（{contentType}），不是文件，未上传。",
		externalTooLarge: "文件超过 {mb} MB 上限，未上传。",
		externalUploadFailed: "文件已下载，但上传失败：{error}",

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
