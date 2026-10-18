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
		sectionOffline: "Offline and local copies",
		sectionCleanup: "Cloud cleanup",
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
		testConnectionDesc:
			"Writes one tiny probe object to your bucket, reads it back to compare, then deletes it — so uploading, fetching and deleting are all checked in one go. Nothing is kept.",
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
			"Reached that address, but it refuses anonymous access — other people cannot open your links. That is fine if the bucket is meant to stay private; if links should work elsewhere, make it publicly readable or set a Public URL base (a CDN or custom domain).",
		testPublic_missing:
			"Reached that address, but the object is not there — the URL base is probably wrong. Checked: {url}",
		testPublic_unreachable: "Could not reach that address at all — the URL base is probably wrong. Checked: {url}",
		testPublic_other: "Could not tell whether the link works — your storage answered in a way we do not recognise. Checked: {url}",
		testPublic_noSample: "This time there was no object to check a link against, so whether it opens elsewhere could not be judged.",
		// 探针回路（写 → 读 → 删）：每一段都要自己说明自己，否则用户会看到一个陌生的对象名
		testProbe_roundTrip: "Probe object ({key}): written, read back identical ({bytes} bytes), deleted.",
		testProbe_tempLeftBehind:
			"The probe object ({key}) could not be deleted — please remove it from the bucket.",
		testFail_probeWrite:
			"Connected, but the storage refused to write — uploads will fail the same way. Check that these keys may write to the bucket.",
		testFail_probeRead:
			"The write went through, but reading it back failed — check that these keys may read the bucket; fetching local copies needs that.",
		testFail_probeMismatch:
			"Read back {read} bytes, but {written} were written — the storage or a proxy in between is altering the data.",

		// ── 链接可访问性：访问方式与两种模式的差别（1.7.0）──
		linkAccessName: "Who can open the links in your notes",
		linkAccessDesc:
			"Your notes hold ordinary URLs, so whether other people can open them depends on your bucket's permissions, not on this plugin. Public read: the bucket allows anonymous access, so a link keeps working after you paste it into another app or send it to someone — this is what you want for sharing, and it means anyone holding the URL can view the file. Internal access only: the bucket stays private, nothing is exposed, and links pasted elsewhere will not open; images are shown here by either keeping a local copy (offline works) or, if you chose not to keep one, by a short-lived signed URL (nothing lands on disk, but offline shows nothing — that is plain image-host behaviour). Automatic detects which one your storage allows and picks the path accordingly; when it cannot tell (offline, timeout, or nothing uploaded yet) it uses internal access. Switching this does not rewrite a single link in your notes — existing links stay exactly the same, and nothing is moved or deleted in your bucket; only who can open them, and how this device gets the bytes, changes.",
		linkAccess_auto: "Automatic (detect)",
		linkAccess_public: "Public read (links work anywhere)",
		linkAccess_private: "Internal access only (links work here only)",
		// 判定理由（`auto` 档下必须说清"我们凭什么"）
		testAccess_public: "Links can be opened by anyone: {reason}",
		testAccess_private: "Links are for this plugin only: {reason}",
		testAccessReason_explicitPublic: "you chose public read.",
		testAccessReason_explicitPrivate: "you chose internal access only.",
		testAccessReason_probePublic: "anonymous access to that URL succeeded.",
		testAccessReason_probeForbidden: "that URL refuses anonymous access, so the bucket is private.",
		testAccessReason_probeMissing: "the URL answered but the object is gone, which does not prove the bucket is public.",
		testAccessReason_probeUnreachable: "the probe did not complete, which does not prove the bucket is public.",
		testAccessReason_probeUnknown: "nothing has been probed yet.",
		testAccess_timedOut: "The probe timed out, so it is treated as private for now. Reopen this page or test again when the network settles.",
		testAccess_unreachable: "The probe could not reach the address, so it is treated as private for now. If links should work elsewhere, check the endpoint and the Public URL prefix.",

		// ── 上传 ──
		autoUpload: "Upload new attachments automatically",
		autoUploadDesc:
			"Covers every way a file ends up in your vault: pasting, dropping, adding one from your phone's gallery or camera, sharing into Obsidian, or copying files in. Uploaded files are linked from your note as remote URLs. Turn it off and all of that goes back to Obsidian, leaving files local only.",
		attachAutoUploaded: "Uploaded {count} attachment(s) that had just been added to your vault.",
		// ⚠️ 与上一条**必须分开说**：这一条的动作是"链接换成已有对象的地址"，**没有上传**。
		// 合成一句"已上传 N 个"会让用户以为自己的流量/仓库又花了一份（他 2026-10-14 就是这么报的）。
		attachAutoReused:
			"Already in your storage: {count} attachment(s) — links updated, nothing re-uploaded.",
		attachAutoFailed: "{count} newly added attachment(s) could not be uploaded — the files are still in your vault.",

		// ── 离线副本 ──
		localCopy: "Where the local copy goes",
		localCopyDesc:
			"Where the local copy of an uploaded file is kept. The uploaded file itself is the copy — nothing is moved into a separate folder. Without a local copy, files cannot be shown offline. Choosing \"do not keep\" turns caching off: the plugin uploads and rewrites links, and never fetches a copy back — if your storage is not publicly readable, images are then shown through a short-lived signed URL instead (still nothing on disk).",
		localCopy_keep: "Keep the file where it is (offline works)",
		localCopy_trash: "Delete the local file after uploading (offline unavailable)",
		fallbackDownload: "Download missing copies",
		fallbackDownloadDesc:
			"For files from this storage that have no local copy, such as ones synced from another device. Only objects in your own storage are handled. Not used when no local copy is kept, since caching is off then. When your storage is not publicly readable, these downloads happen regardless — without them those images could not be shown at all.",

		// ── 高级 ──
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
		indexLoadFailed: "Local-copy index could not be read (copies are fetched again when needed): {error}",
		indexSkipped: "{count} entries in the local-copy index were unusable and have been dropped.",

		// ── 回退下载（补齐本地副本）──
		// 只在"用户能采取行动"的失败上出现：配置/权限类。离线失败刻意不提示，
		// 因为那正是用户此刻的状态，弹提示没有信息量。
		fallbackDownloadFailed: "Could not fetch a missing local copy: {error}",
		fallbackWriteFailed: "Fetched a copy but could not save it into the vault: {error}",
		fallbackIndexPersistFailed: "The copy was saved, but the local-copy index could not be written: {error}",

		// ── 上传（粘贴 / 拖拽 / 批量迁移）──
		// 三条都出现在"字节已经安全落盘、只是后续某一步没走完"的情形 ——
		// 共同点是**图不会丢**，所以措辞是"告知"，不是"报错"。
		ingestIndexPersistFailed: "The file was uploaded, but the local-copy index could not be saved: {error}",

		// ── 维护命令 ──
		// ── 云端空间清理（F15）──
		cmdCheckOrphans: "Check for unreferenced attachments in the cloud…",
		cloudCleanupDeviceBlindSpot:
			"Only this device's references can be seen. Other devices (or another vault sharing this storage) may still be using some of these files — deleting cannot be undone.",
		cloudCleanupPersistFailed: "Could not save the local-copy index: {error}",
		cloudCleanupUnreadableNote: "Could not read {path}, so the cleanup was cancelled.",
		// F18：清理本地占用（并入「不留副本」档，见设计 §20.10）
		releaseSpaceName: "Free up local space",
		releaseSpaceDesc:
			"Delete already-uploaded local copies — for good, not to the trash, so the space comes back at once; your storage and your notes are untouched, and a copy you delete is downloaded again when a note next shows it. With \"delete the local file\" this clears the copies a note still links to; with a local-copy limit it trims that same batch down to the limit (least recent first, and copies used in the last 10 minutes are left alone). Copies no note links to are never touched here — those may need removing from your storage as well, and that is a separate step.",
		releaseSpaceButton: "Delete local copies…",
		releaseSpaceTitle: "Delete these local copies for good?",
		releaseSpaceSummary: "{count} local copy(ies), about {mb} MB:",
		releaseSpaceCannotUndo:
			"These files are deleted permanently — they do not go to the trash, so this cannot be undone. They are downloaded again the next time a note shows them.",
		releaseSpaceCloudUntouched:
			"Nothing in your storage is deleted and your notes are not changed — and each copy is only deleted after confirming it is still there.",
		releaseSpaceCta: "Delete permanently",
		revertName: "Revert links to local paths",
		revertDesc:
			"Point note links back at the files in your vault instead of your storage. Nothing is deleted: the cloud objects and the local files stay exactly as they are. Use this when you stop using the plugin.",
		revertButton: "Revert links",
		revertTitle: "Revert links to local paths",
		revertSummary: "Rewrite {links} link(s) in {notes} note(s) back to the files in your vault.",
		revertKeepsEverything:
			"Nothing is deleted: every cloud object and every local file stays where it is. Only the links change.",
		revertMissing:
			"{count} uploaded file(s) no longer have a local copy, so their links are left pointing at your storage.",
		revertCanvasSkipped: "Canvas files are not touched: their file nodes already point inside the vault.",
		revertNothing: "Nothing to revert: no note link points at your storage.",
		revertAllMissing:
			"Nothing to revert: all {count} uploaded file(s) have no local copy left, and rewriting them would only create broken links.",
		revertCta: "Revert links",
		revertDone:
			"Reverted {links} link(s) in {notes} note(s). Cloud objects and local files were left untouched.",
		releaseSpaceDone: "Deleted {deleted} local copy(ies), freeing about {mb} MB. Skipped {skipped}.",
		releaseSpaceNothingDeleted:
			"Nothing was deleted: {skipped} copy(ies) could not be confirmed in your storage just now. A local copy is only deleted when the object is still there — it may be the last one. Local copies look fine; if the objects really are gone, your index and your storage have drifted apart.",
		releaseSpaceNothing:
			"Nothing to clean up: this only covers copies that a note still links to through your storage (attachments you never uploaded are left alone).",
		releaseSpaceNothingMissing:
			"Nothing to clean up. {count} index record(s) point at files that are no longer there — \"Check and repair the local-copy index\" clears those.",
		// ── 上限档（目标 = 清到上限以内）：说什么都要带上目标与**结果** ──
		// ⚠️ 话术里一律说"这批"（= 笔记里仍引用着的那批）：本流程**不碰**没人引用的副本
		//（那一类要连云端一起决定，见 `releaseSpaceUnlinkedLeft`），所以不能声称"总占用已降到上限以内"。
		releaseSpaceSummaryToLimit:
			"{count} local copy(ies), about {mb} MB — trimming this batch to your {limit} limit leaves about {remainMb} MB:",
		releaseSpaceDoneToLimit:
			"Deleted {deleted} local copy(ies), freeing about {mb} MB. This batch is now about {remainMb} MB ({limit} limit). Skipped {skipped}.",
		releaseSpaceStillOver:
			"About {overMb} MB of this batch was left alone: those copies were used in the last 10 minutes (or could not be confirmed in your storage). The background will keep trimming.",
		releaseSpaceNothingUnderLimit:
			"This batch of local copies is already within your {limit} limit — nothing to clean up.",
		releaseSpaceUnlinkedLeft:
			"Also about {mb} MB of local copies are linked from no note — those are not part of this cleanup: they may need removing from your storage as well, so run “{command}” for them.",
		orphanTitle: "Clean up these unused attachments?",
		orphanBody:
			"{count} attachment(s) you uploaded are no longer linked from any note or canvas.",
		orphanMore: "…and {count} more.",
		orphanLocalNote:
			"Deleting the local copies only frees space in your vault - linking one again downloads it back. Deleting from your storage cannot be undone.",
		orphanKeep: "Keep them",
		orphanLocalOnly: "Delete local copies",
		orphanBoth: "Delete locally and from storage",
		orphanLocalDeleted: "Removed {removed} local copy(ies). Your storage was left untouched.",
		orphanDeletedBoth:
			"Removed {removed} local copy(ies). Storage: {deleted} deleted, {alreadyGone} already gone, {failed} failed.",
		orphanNotice:
			"{count} uploaded attachment(s) are no longer linked from any note or canvas. Run “{command}” to review and clean up.",
		orphanDismissed:
			"Nothing was deleted. To ask again, run “{command}”.",
		orphanNoneToCheck:
			"No unreferenced attachments found — everything we uploaded is either still linked from a note or canvas, or came in from another site (those are never handled here).",
		cloudDeleteFailed: "Could not delete the object: {error}",
		cmdAuditCache: "Show local copy usage",
		// ⭐ 与设置页那颗「Delete local copies…」是**同一条链**（`releaseLocalSpace`），
		// 命令面板侧多一个限定词：这里说的是**清理哪些**（没有任何笔记引用的那些）。
		cmdUploadAttachments: "Upload attachments",
		// ⭐ 命令**失败**时必须有人说话（2026-10-16 用户实测："点击命令没有反应"）。
		// 以前异步命令抛错只留一条控制台记录，界面上什么都不发生 —— 那是最坏的失败形态。
		// ⚠️ 不写命令名：用户刚点过它，而 `{error}` 才是他要看的东西（命令 id 进控制台日志）。
		cmdFailed: "The command could not run: {error}",

		maintainUsageReport:
			"Local copies: {totalMb} MB in {count} files. Not linked from any note: {unused} ({reclaimableMb} MB — an estimate: nothing is removed before your storage is confirmed to still have it). {missing} index entr(ies) point at files that are gone. Limit: {limit}.",
		// ⚠️ 只在真有失效记录时单独弹这一句（见 `auditCache` 命令的接线）：
		// 那行数字本身不带处置办法，用户 2026-10-14 在 Android 上把它读成了"索引坏了"。
		maintainUsageMissingHint:
			"Those {count} stale record(s) are harmless — the background check drops them on its own.",
		selfHealRepaired:
			"Local-copy index repaired automatically: {count} record(s) pointed at files that are no longer there.",
		legacyKeyTemplateUpgraded:
			"The object-key template setting is gone: new uploads are always named “original-name-content-hash.ext”, so files stay findable by name in your storage (the name therefore also reaches your storage provider). Existing links keep working; content you uploaded under the old naming is stored once more if you paste it again.",
		legacyExternalDefaultMerged:
			"Setting change: “When a note links to a file on another site” is gone — the switch above it (“Handle files from other sites like ordinary files”) is now the only control. Your earlier choice was carried over: {state}.",
		legacyExternalKeptOn: "automatic handling stays on",
		legacyExternalKeptOff:
			"automatic handling stays off, because you had it set to do nothing automatically — you can still pick files one by one",
		maintainMoreItems: "…and {count} more",
		maintainCancelled: "Cancelled — nothing was changed.",
		// ── 清单类弹窗（缩略图 + 勾选 + 进度）：上传附件 / 检查未被引用的云端附件 / 挑选要缓存的文件共用 ──
		taskListEmpty: "Nothing to show here.",
		taskProgressRunning: "Working… {finished}/{total}",
		taskProgressFinished: "Finished: {done} done, {skipped} skipped, {failed} failed.",
		taskStatusDone: "done",
		taskStatusFailed: "failed",
		taskStatusSkipped: "skipped",
		taskShowMore: "Show {count} more row(s) — the rest are still included",
		maintainPersistFailed: "Could not save the index after repairing it: {error}",
		maintainSkipUnknownCopy: "The index no longer points at this file — skipped",
		maintainSkipUnconfirmed: "Could not confirm the cloud still has it — skipped",
		maintainSkipNotInCloud: "Your storage no longer has this object — skipped, this copy is the only one left",
		maintainSkipNotIndexed: "Obsidian cannot see this file yet — skipped instead of deleting it directly",
		maintainNotConfigured: "The storage connection is not set up yet, so nothing was uploaded.",
		maintainBatchNothing: "No attachments to upload (everything is already handled).",
		maintainBatchTitle: "Upload attachments",
		maintainBatchSummary:
			"Upload {count} file(s) — anything already in your storage is reused — and rewrite note links to point at your storage.",
		// ⚠️ 1.2.0（D-17）起，"上传后把原文件搬走"这件事**不存在了** —— 那份文件留在原地、
		// 就地作为本地副本（没有缓存目录可搬）。所以必须照实说"不移动、不改名"：
		// 从前这里承诺的正是"附件目录里不再留一份"，照抄下来会让用户以为命令没生效。
		// 同时说清"没被引用的文件不碰"。
		maintainBatchOriginalsStay:
			"Nothing is moved or renamed: the file stays in your attachments folder and remains the local copy — only the links in your notes are rewritten. Files that no note refers to are left alone.",
		maintainBatchSkipsUnreferenced:
			"{count} file(s) in your vault are not linked from any note, so they are left alone.",
		maintainBatchDuplicates:
			"{count} of them look like the copy the host leaves behind when a name collides (photo 1.png next to photo.png). Once its link is rewritten that copy is deleted — its bytes are identical to the one that stays.",
		maintainBatchDuplicatesRemoved:
			"Deleted {count} duplicate copy(ies) the host had left behind on a name collision (same content as the copy that stays).",
		maintainBatchCanvasSkipped:
			"{count} reference(s) in canvases could not be rewritten (the file is not readable JSON), so they still point to their old location.",
		maintainBatchCta: "Upload and rewrite links",
		maintainBatchExternal:
			"Also {count} file(s) hosted elsewhere, on {sites} site(s): {hosts}",
		// ⚠️ 本机文件那条**必须带路径**：不加目录白名单（用户 2026-10-15 定）之后，
		// "看得见要读哪条路径"是那次授权唯一能成立的前提。⚠️ `{count}` 是**全部**条数，
		// 列表最多三条（多的省略）—— 数字准确、清单诚实。
		// ⚠️ 这一行是**纯文本**（Confirm 的正文，不渲染 Markdown）⇒ 不许写 `**强调**`
		//（2026-10-16 用户实测看到的就是一对露出来的星号）。
		maintainBatchLocalFiles: "Also {count} local file(s) on this computer (outside the vault): {paths}",
		// ⭐ 已经**不在本机**的那些（列清单前问过一次 `stat`）：它们不进清单（点了一定失败），
		// 但必须说出来 —— 在笔记里它们正是**坏链**，用户找不到会以为漏了。
		maintainBatchLocalFilesMissing:
			"There are {count} local file(s) that are no longer on this computer (nothing to upload): {paths}",
		maintainBatchDone:
			"Uploaded {uploaded}, already there {reused}, failed {failed}. Rewrote {links} link(s) across {notes} note(s).",

		// ── Files from other sites ──
		externalImageCache: "Handle files from other sites like ordinary files",
		externalImageCacheDesc:
			"On: a note that links to a file on another site gets it downloaded, uploaded to your storage and the link rewritten — exactly like pasting a local file. Off by default; while it is off those files are left completely alone. Picking individual files is always available, with or without this switch.",
		externalSiteMode: "Which sites to handle",
		externalSiteModeDesc:
			"Only affects the automatic handling above. \"All sites\" applies no filter; the other two use the list below — to skip those sites, or to handle only those. This filter never restricts picking individual files.",
		externalSite_off: "All sites",
		externalSite_blocklist: "All except the ones listed",
		externalSite_allowlist: "Only the ones listed",
		externalSiteList: "Site list",
		externalSiteListDesc:
			"One domain per line. example.com also matches img.example.com; write example.com:8080 to match that exact host. Under \"Only the ones listed\", an empty list means nothing is handled automatically.",
		externalSiteListPlaceholder: "example.com\ncdn.example.com",
		externalPickName: "Pick specific files",
		externalPickDesc:
			"Choose files from the current note or from the whole vault, and only those are cached. Picking one is the same as agreeing to it — it works whether or not the switch above is on.",
		externalPickButton: "Choose files…",
		externalPickTitle: "Choose files to cache",
		externalPickScope: "Where to look",
		externalPickScopeNote: "Current note",
		externalPickScopeVault: "Whole vault",
		externalPickEmpty:
			"No files to cache here (they may already be in your own storage, or the storage connection is not set up).",
		externalPickAll: "Select all",
		externalPickNone: "Select none",
		externalPickCta: "Cache the {count} selected",
		externalPickCancel: "Cancel",
		externalPickNothing: "No files were cached.",
		externalPickDone:
			"Cached {cached} file(s); {partial} were uploaded but their link could not be rewritten; {failed} failed.",
		cmdPickExternal: "Cache external files…",
		externalCached: "Cached the file from {host} and rewrote the link.",
		// ── 本机文件（file:///D:/…）：与站外同一套链，只有"字节从哪来"不同 ──
		localCached: "Uploaded the local file {name} and rewrote the link.",
		localFileMissing: "That file is no longer on this computer, so nothing was changed: {path}",
		localFileUnreadable: "Could not read that file on this computer, so nothing was changed: {path} ({error})",
		externalCachedNoRewrite: "The file was uploaded, but the link in this note could not be rewritten: {error}",
		externalNoNote: "Could not read the note that links this file, so nothing was downloaded or changed.",
		externalFetchForbidden: "Could not download the file from {host}: the site blocks direct downloads (hotlink protection).",
		externalFetchMissing: "That link is no longer available ({status}).",
		externalNotAttachment: "That address returned a web page or plain text ({contentType}), not a file, so it was not uploaded.",
		externalTooLarge: "The file is larger than the {mb} MB limit, so it was not uploaded.",
		externalUploadFailed: "Downloaded the file but could not upload it: {error}",

		// ── 缓存上限与自动轮换 ──
		cacheLimit: "Local copy limit (MB)",
		cacheLimitDesc:
			"Once your local copies grow past this, the least recently used ones are deleted in the background and the disk space is freed right away — they are downloaded again the next time you view them. A copy is only ever deleted after confirming it still exists in your storage. Only copies the index knows about are counted: attachments you never uploaded are left alone. 0 means no limit.",
		cacheLimitPlaceholder: "0 = no limit",
		cacheLimitNone: "unlimited",
		cacheLimitValue: "{mb} MB",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"Over the local copy limit: deleted {count} least recently used copies ({mb} MB). They will be downloaded again when you view them.",
		cacheEvictedPartial:
			"Over the local copy limit: deleted {count} copies ({mb} MB), still {overMb} MB over the limit.",

		// ── 无人引用的附件：怎么告诉你 ──
		orphanAsk: "When an attachment is no longer linked",
		orphanAskDesc:
			"Once an uploaded file loses its last link from any note or canvas, this is what the plugin does. Cleaning up always needs your explicit confirmation — this only decides whether you are told about it, and how.",
		orphanAsk_always: "Ask me (keep / drop the local copy / drop both)",
		orphanAsk_notice: "Just show a notice",
		orphanAsk_never: "Do nothing",
	},
	zh: {
		sectionStorage: "存储连接",
		sectionUpload: "上传",
		sectionOffline: "离线与本地副本",
		sectionCleanup: "云端清理",
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
		testConnectionDesc:
			"会往桶里写一个很小的探测对象、读回来核对，再删掉 —— 上传、取回、删除一次测全，什么都不留。",
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
			"那个地址能连上，但拒绝匿名访问 —— 别人打不开你的链接。桶本来就不打算对外，这样是对的；若希望链接在别处也能打开，把存储桶设为公开读，或填一个公开访问前缀（CDN / 自定义域名）。",
		testPublic_missing: "那个地址能连上，但对象不在 —— 多半是前缀写错了。检查的是：{url}",
		testPublic_unreachable: "连不上那个地址 —— 前缀可能写错了。检查的是：{url}",
		testPublic_other: "无法判断链接是否可用 —— 存储回了一个我们没预料到的结果。检查的是：{url}",
		testPublic_noSample: "这次没有可用的探测对象，因此判断不了链接在别处能不能打开。",
		// 探针回路（写 → 读 → 删）：每一段都要自己说明自己，否则用户会看到一个陌生的对象名
		testProbe_roundTrip: "探测对象（{key}）：写入 → 读回一致（{bytes} 字节）→ 已删除。",
		testProbe_tempLeftBehind: "探测对象（{key}）没能删掉 —— 请到桶里手动删除。",
		testFail_probeWrite: "连接正常，但存储拒绝了写入 —— 上传也会这样失败。请检查这把密钥是否有写入权限。",
		testFail_probeRead: "写入成功了，但读不回来 —— 请检查这把密钥是否有读取权限（取回本地副本要用它）。",
		testFail_probeMismatch: "读回来 {read} 字节，写进去的是 {written} 字节 —— 存储或中间的代理改了数据。",

		// ── 链接可访问性：访问方式与两种模式的差别（1.7.0）──
		linkAccessName: "笔记里的链接谁打得开",
		linkAccessDesc:
			"笔记里存的是普通地址，所以别人能不能打开，取决于你存储桶的权限，而不是这个插件。公开读取：桶允许匿名访问，链接粘到别的应用里、发给别人之后照样打得开 —— 需要对外分享就选它；代价是任何拿到地址的人都能看。仅内部访问：桶保持私有、什么都不对外暴露，粘到别处的链接会打不开；本机怎么显示图，取决于「本地副本」那一项 —— 保留副本就用副本显示（离线也能看），不留副本就改用一条短时签名地址（像图床一样：磁盘上不落文件，但离线看不到）。自动：先探测你的存储允许哪一种，再据此选路；探测不出来时（离线、超时、或还没上传过东西）按内部访问处理。切换这一项不会改写笔记里的任何一条链接 —— 已有链接一字不变，桶里的对象也不会被搬迁或删除；变的只是「谁能打开」与「本机怎么取到字节」。",
		linkAccess_auto: "自动（探测后决定）",
		linkAccess_public: "公开读取（链接在任何地方都能打开）",
		linkAccess_private: "仅内部访问（链接只在装了本插件的地方能看）",
		testAccess_public: "这些链接别人也能打开：{reason}",
		testAccess_private: "这些链接只有本插件能取到：{reason}",
		testAccessReason_explicitPublic: "你选的是公开读取。",
		testAccessReason_explicitPrivate: "你选的是仅内部访问。",
		testAccessReason_probePublic: "匿名访问那条地址成功了。",
		testAccessReason_probeForbidden: "那条地址拒绝匿名访问，说明桶是私有的。",
		testAccessReason_probeMissing: "地址能连上但对象不在，这证明不了桶是公开的。",
		testAccessReason_probeUnreachable: "探测没有完成，这证明不了桶是公开的。",
		testAccessReason_probeUnknown: "还没探测过。",
		testAccess_timedOut: "探测超时了，暂时按私有处理。网络恢复正常后重新打开本页或再点一次测试。",
		testAccess_unreachable: "探测没能连上那个地址，暂时按私有处理。如果希望链接在别处也能打开，请检查服务地址与公开访问前缀。",

		autoUpload: "新增附件自动上传",
		autoUploadDesc:
			"覆盖附件进入库的所有方式：粘贴、拖入、手机相册或相机、分享到 Obsidian、从别处拷进库。上传后笔记里的链接会换成远端地址。关闭后这些全部交回 Obsidian 处理，文件只存在本地。已经缓存的附件仍然离线可见。",
		attachAutoUploaded: "已自动上传刚加入库的 {count} 个附件。",
		// ⚠️ 与上一条**必须分开说**：这一条的动作是"链接换成已有对象的地址"，**没有上传**。
		// 用户 2026-10-14 在 Android 上报的就是这个：重复插同一张图，提示却说"上传成功"。
		attachAutoReused: "刚加入库的 {count} 个附件此前已经上传过 —— 只更新了链接，没有重复上传。",
		attachAutoFailed: "刚加入库的 {count} 个附件上传失败 —— 文件仍然留在你的库里。",

		localCopy: "本地副本的处理",
		localCopyDesc:
			"上传后，本地副本放在哪里。上传的那份文件**本身就是**本地副本（不会搬去别的目录）。选「不留」等于关闭缓存：插件只负责上传与改写链接，不会把副本补回来 —— 若存储不可公开读取，图片会改用一条短时签名地址显示（磁盘上同样不落文件）。",
		localCopy_keep: "留在附件目录（离线可用）",
		localCopy_trash: "不留本地副本（等于关闭缓存，离线不可用）",
		fallbackDownload: "缺本地副本时自动下载",
		fallbackDownloadDesc:
			"属于本存储、却没有本地副本的附件（例如从另一台设备同步来的）会自动下载。只处理你自己存储里的对象。选「不留副本」时不生效（那一档已关闭缓存）。存储不可公开读取时这一项不生效 —— 那时不取回就完全显示不出图。",

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
		indexLoadFailed: "本地副本索引读取失败（副本会在下次需要时自动取回）：{error}",
		indexSkipped: "本地副本索引里有 {count} 条记录无法使用，已丢弃。",
		fallbackDownloadFailed: "补齐本地副本失败：{error}",
		fallbackWriteFailed: "副本已取回，但写入 vault 失败：{error}",
		fallbackIndexPersistFailed: "副本已保存，但本地副本索引写入失败：{error}",

		// ── 上传（粘贴 / 拖拽 / 批量迁移）──
		ingestIndexPersistFailed: "文件已上传，但本地副本索引保存失败：{error}",

		// ── 云端空间清理（F15）──
		cmdCheckOrphans: "检查未被引用的云端附件…",
		cloudCleanupDeviceBlindSpot:
			"只能看到本设备的引用情况。其他设备（或共用这个存储的另一个库）可能还在用其中一些文件 —— 删除后无法恢复。",
		cloudCleanupPersistFailed: "本地副本索引保存失败：{error}",
		cloudCleanupUnreadableNote: "读不到 {path}，因此取消了这次清理。",
		// F18：清理本地占用（并入「不留副本」档，见设计 §20.10）
		releaseSpaceName: "释放本地空间",
		releaseSpaceDesc:
			"清掉已上传附件的本地副本 —— 永久删除、不进回收站，所以空间立刻释放；云端对象与笔记里的链接都不动，删掉的那份下次看图时会自动重新下载。选「不留本地副本」时：清掉笔记里仍引用着云端地址的那批；设了「本地副本上限」时：把同一批清到上限以内（最久没用过的先走，10 分钟内用过的这轮不动）。没有任何笔记引用的副本一概不碰 —— 那类可能还要连云端对象一起删，是另一步。",
		releaseSpaceButton: "清理本地副本…",
		releaseSpaceTitle: "永久删除这些本地副本？",
		releaseSpaceSummary: "{count} 个本地副本，约 {mb} MB：",
		releaseSpaceCannotUndo:
			"这些文件会被永久删除（不进回收站），无法撤销。下次笔记里显示它们时会自动重新下载。",
		releaseSpaceCloudUntouched:
			"云端对象与你的笔记都不会被改动；每一份都是在确认云端仍然有它之后才会删。",
		releaseSpaceCta: "永久删除",
		revertName: "把链接改回本地路径",
		revertDesc:
			"把笔记里的链接改回指向库里那份附件（不再指向你的存储）。什么都不删：云端对象与本地文件都原样留着。准备停用这个插件时用它。",
		revertButton: "改回本地路径",
		revertTitle: "把链接改回本地路径",
		revertSummary: "把 {notes} 篇笔记里的 {links} 处链接改回指向库里的文件。",
		revertKeepsEverything: "什么都不删：云端对象与本地文件都留在原处，只有链接会变。",
		revertMissing: "有 {count} 份已上传的文件本地副本已经不在了，它们对应的链接会继续指向你的存储。",
		revertCanvasSkipped: "画布不会被动：它的 file 节点本来就指向库内文件。",
		revertNothing: "没有可改的：没有任何笔记链接指向你的存储。",
		revertAllMissing: "没有可改的：{count} 份已上传文件都没有本地副本了，改回去只会得到坏链。",
		revertCta: "改回本地路径",
		revertDone: "已把 {notes} 篇笔记里的 {links} 处链接改回本地路径；云端对象与本地文件都没动。",
		releaseSpaceDone: "已永久删除 {deleted} 个本地副本，释放约 {mb} MB；跳过 {skipped} 个。",
		releaseSpaceNothingDeleted:
			"一个都没删：有 {skipped} 份副本刚才没能确认云端仍然有它。只有在云端确实还在时才会删本地副本 —— 它可能是最后一份。图不受影响；如果云端确实已经没有了，说明索引与你的存储对不上了。",
		releaseSpaceNothing:
			"没有可清理的本地副本 —— 只清理笔记里仍引用着你存储地址的那些（你自己未上传的附件一概不碰）。",
		releaseSpaceNothingMissing:
			"没有可清理的副本。有 {count} 条索引记录指向的文件已经不在，那些记录由「自检并修复本地副本索引」处理。",
		// ── 上限档（目标 = 清到上限以内）：说什么都要带上目标与**结果** ──
		// ⚠️ 话术里一律说"这批"（= 笔记里仍引用着的那批）：本流程**不碰**没人引用的副本
		//（那一类要连云端一起决定，见 `releaseSpaceUnlinkedLeft`），所以不能声称"总占用已降到上限以内"。
		releaseSpaceSummaryToLimit:
			"将删除 {count} 个本地副本，约 {mb} MB —— 把这批清到你设的 {limit} 上限以内后，约剩 {remainMb} MB：",
		releaseSpaceDoneToLimit:
			"已删除 {deleted} 个本地副本，释放约 {mb} MB；这批本地副本现在约 {remainMb} MB（上限 {limit}）。跳过 {skipped} 个。",
		releaseSpaceStillOver:
			"这批里还有约 {overMb} MB 没清掉：那些副本 10 分钟内刚用过（或云端没能确认上）。后台还会按上限继续处理。",
		releaseSpaceNothingUnderLimit:
			"这批本地副本已经在你设的 {limit} 上限以内，没什么可清理的。",
		releaseSpaceUnlinkedLeft:
			"另有约 {mb} MB 是「没有任何笔记引用」的本地副本 —— 那不属于这次清理：它们可能需要连云端对象一起处理，请用「{command}」。",
		orphanTitle: "要清掉这些没人用的附件吗？",
		orphanBody: "你上传过的 {count} 个附件已经不再被任何笔记或画布引用了。",
		orphanMore: "……还有 {count} 个。",
		orphanLocalNote:
			"只删本地副本只是腾出库里的空间 —— 以后笔记里再引用它，会自动重新下载；从存储里删掉就找不回来了。",
		orphanKeep: "保留",
		orphanLocalOnly: "只删本地副本",
		orphanBoth: "云端和本地一起删",
		orphanLocalDeleted: "已删掉 {removed} 个本地副本；云端对象未动。",
		orphanDeletedBoth:
			"已删掉 {removed} 个本地副本；云端：删除 {deleted} 个、本来就不存在 {alreadyGone} 个、失败 {failed} 个。",
		orphanNotice:
			"有 {count} 个已上传的附件不再被任何笔记或画布引用。运行「{command}」可以查看并清理。",
		orphanDismissed:
			"什么都没删。想再问一次：运行「{command}」。",
		orphanNoneToCheck:
			"没有需要处理的 —— 已上传的附件要么还有笔记或画布在引用它，要么是站外缓存来的（那一类不在这里处理）。",
		cloudDeleteFailed: "删除对象失败：{error}",
		cmdAuditCache: "查看本地副本占用",
		// ⭐ 与设置页那颗「清理本地副本…」是**同一条链**（`releaseLocalSpace`），
		// 命令面板侧多一个限定词：这里说的是**清理哪些**（没有任何笔记引用的那些）。
		cmdUploadAttachments: "上传附件",
		// ⭐ 命令**失败**时必须有人说话（2026-10-16 用户实测："点击命令没有反应"）。
		// 以前异步命令抛错只留一条控制台记录，界面上什么都不发生 —— 那是最坏的失败形态。
		// ⚠️ 不写命令名：用户刚点过它，而 `{error}` 才是他要看的东西（命令 id 进控制台日志）。
		cmdFailed: "命令执行失败：{error}",

		maintainUsageReport:
			"本地副本共 {count} 个文件、{totalMb} MB。其中没有任何笔记引用的 {unused} 个（{reclaimableMb} MB —— 这是估算：真正删除前会先确认你的存储里仍然有它）。索引指向的文件已不在 {missing} 条。上限：{limit}。",
		// ⚠️ 同上：只在真有失效记录时弹（那行数字不带处置办法，会被读成"索引坏了"）。
		maintainUsageMissingHint:
			"那 {count} 条失效记录无害 —— 后台自检会自己摘掉。",
		selfHealRepaired: "本地副本索引已自动修复：{count} 条记录指向的本地副本已经不在了。",
		legacyKeyTemplateUpgraded:
			"「对象 key 模板」设置已取消：之后上传的对象固定命名为「原文件名-内容哈希.扩展名」，存储里可以按名字找到文件（文件名因此也会出现在你的存储服务商那边）。已有链接不受影响；按旧命名传过的内容若再贴一次，会在云端多存一份。",
		legacyExternalDefaultMerged:
			"设置改版：「遇到站外文件链接时」那一档已并入上面的开关「站外文件按普通附件处理」，你原来的选择已折算进去 —— {state}。",
		legacyExternalKeptOn: "自动处理保持开启",
		legacyExternalKeptOff:
			"自动处理保持关闭（你原本选的是「什么都不做」）；「挑选要缓存的文件」仍然随时可用",
		maintainMoreItems: "……还有 {count} 个",
		maintainCancelled: "已取消，没有改动任何内容。",
		// ── 清单类弹窗（缩略图 + 勾选 + 进度）：上传附件 / 检查未被引用的云端附件 / 挑选要缓存的文件共用 ──
		taskListEmpty: "这里没有可处理的条目。",
		taskProgressRunning: "正在处理…… {finished}/{total}",
		taskProgressFinished: "已结束：完成 {done} 个、跳过 {skipped} 个、失败 {failed} 个。",
		taskStatusDone: "完成",
		taskStatusFailed: "失败",
		taskStatusSkipped: "跳过",
		taskShowMore: "再显示 {count} 行（其余的行照样会被处理）",
		maintainPersistFailed: "修复后保存索引失败：{error}",
		maintainSkipUnknownCopy: "索引里已经不再指向这个文件 —— 跳过",
		maintainSkipUnconfirmed: "确认不了云端是否还有它 —— 跳过",
		maintainSkipNotInCloud: "你的存储里已经没有这个对象 —— 跳过，这份是仅剩的副本",
		maintainSkipNotIndexed: "Obsidian 还看不到这个文件 —— 已跳过，而不是直接删除",
		maintainNotConfigured: "存储连接尚未配置，没有上传任何内容。",
		maintainBatchNothing: "没有需要上传的附件（都已经处理过了）。",
		maintainBatchTitle: "上传附件",
		maintainBatchSummary:
			"将上传 {count} 个文件（已经传过的会直接复用），并把笔记里的链接改成指向你的存储。",
		// ⚠️ 别在文案里写 markdown（`**加粗**`）：确认弹窗是 `createDiv({ text })`、
		// 提示是宿主的 Notice，两者都**按纯文本**渲染 —— 星号会原样显示给用户。
		// ⚠️ 1.2.0（D-17）：上传后文件**留在附件目录里**（它就是本地副本，没有缓存目录可搬）——
		// 照实说"不移动、不改名"，否则用户会以为命令没生效（从前这里承诺的正是"搬走"）。
		maintainBatchOriginalsStay:
			"不会移动或改名：文件留在附件目录里，就地作为本地副本 —— 只有笔记里的链接会被改写。没有任何笔记引用的文件不会被碰。",
		maintainBatchSkipsUnreferenced: "另有 {count} 个文件没有被任何笔记引用，不会被处理。",
		maintainBatchDuplicates:
			"其中 {count} 个看起来是宿主撞名时另落下的副本（照片.png 旁边的 照片 1.png）：链接改写成功后那份会被删掉 —— 它与留下来的那份内容完全一样。",
		maintainBatchDuplicatesRemoved:
			"已删掉 {count} 份宿主撞名留下的重复副本（内容与留下的那份完全相同）。",
		maintainBatchCanvasSkipped:
			"画布里有 {count} 处引用没能改写（画布文件不是可读的 JSON），它们仍指向旧位置。",
		maintainBatchCta: "上传并改写链接",
		maintainBatchExternal: "另有 {count} 个文件托管在站外，来自 {sites} 个站点：{hosts}",
		// ⚠️ 本机文件那条**必须带路径**：不加目录白名单（用户 2026-10-15 定）之后，
		// "看得见要读哪条路径"是那次授权唯一能成立的前提。⚠️ `{count}` 是**全部**条数，
		// 列表最多三条（多的省略）—— 数字准确、清单诚实。
		// ⚠️ 这一行是**纯文本**（弹窗正文，不渲染 Markdown）⇒ 不许写 `**强调**`
		//（2026-10-16 用户实测看到的就是一对露出来的星号）。
		maintainBatchLocalFiles: "另有 {count} 个是本机文件（在你电脑上、不在库里）：{paths}",
		// ⭐ 已经**不在本机**的那些（列清单前问过一次 `stat`）：它们不进清单（点了一定失败），
		// 但必须说出来 —— 在笔记里它们正是**坏链**，用户找不到会以为漏了。
		maintainBatchLocalFilesMissing:
			"有 {count} 个本机文件在这台电脑上已经找不到了，没有可上传的内容：{paths}",
		maintainBatchDone:
			"上传 {uploaded} 个、已存在 {reused} 个、失败 {failed} 个。在 {notes} 篇笔记里改写了 {links} 处链接。",

		// ── 站外文件 ──
		externalImageCache: "站外文件按普通附件处理",
		externalImageCacheDesc:
			"打开后，笔记里指向别处的文件会被下载、上传到你的存储，并改写笔记里的链接 —— 与粘贴一张本地附件完全一样。默认关闭；关着时这类文件一步都不会被碰。「挑选要缓存的文件」始终可用，不受这个开关限制。",
		externalSiteMode: "处理哪些站点",
		externalSiteModeDesc:
			"只影响上面的自动处理。「所有站点」不做过滤；后两档由下面的名单决定 —— 跳过名单里的站点，或只处理名单里的站点。这份名单不会限制手动挑选。",
		externalSite_off: "所有站点",
		externalSite_blocklist: "除名单外的站点",
		externalSite_allowlist: "仅名单内的站点",
		externalSiteList: "站点名单",
		externalSiteListDesc:
			"一行一个域名。写 example.com 也会命中 img.example.com；写 example.com:8080 则只匹配含那个端口的地址。选「仅名单内的站点」时，留空表示什么都不自动处理。",
		externalSiteListPlaceholder: "example.com\ncdn.example.com",
		externalPickName: "挑选要缓存的文件",
		externalPickDesc:
			"在「当前笔记」或「全库」里勾选文件，只处理你勾中的那些。勾选本身就是同意，与上面的开关无关。",
		externalPickButton: "选择文件…",
		externalPickTitle: "选择要缓存的文件",
		externalPickScope: "范围",
		externalPickScopeNote: "当前笔记",
		externalPickScopeVault: "全库",
		externalPickEmpty:
			"这个范围里没有可缓存的文件（可能已经在你自己的存储里，或者存储连接还没配好）。",
		externalPickAll: "全选",
		externalPickNone: "全不选",
		externalPickCta: "缓存选中的 {count} 个",
		externalPickCancel: "取消",
		externalPickNothing: "没有缓存任何文件。",
		externalPickDone: "已缓存 {cached} 张；{partial} 张已上传但没能改写链接；{failed} 张失败。",
		cmdPickExternal: "缓存外部文件（可挑选）…",
		externalCached: "已缓存来自 {host} 的文件并改写链接。",
		// ── 本机文件（file:///D:/…）：与站外同一套链，只有"字节从哪来"不同 ──
		localCached: "已把本机文件 {name} 上传上去并改写链接。",
		localFileMissing: "那个文件在这台电脑上已经不在了，没有改动任何内容：{path}",
		localFileUnreadable: "读不了这台电脑上的那个文件，没有改动任何内容：{path}（{error}）",
		externalCachedNoRewrite: "文件已上传，但没能改写本篇笔记里的链接：{error}",
		externalNoNote: "读不到链接该文件的笔记，因此没有下载、也没有改动任何内容。",
		externalFetchForbidden: "无法从 {host} 下载文件：该站点有防盗链保护。",
		externalFetchMissing: "该链接已失效（{status}）。",
		externalNotAttachment: "该地址返回的是网页或纯文本（{contentType}），不是文件，未上传。",
		externalTooLarge: "文件超过 {mb} MB 上限，未上传。",
		externalUploadFailed: "文件已下载，但上传失败：{error}",

		// ── 缓存上限与自动轮换 ──
		cacheLimit: "本地副本上限（MB）",
		cacheLimitDesc:
			"本地副本总量超过这个大小后，后台会把最久没用过的副本删掉，磁盘空间立刻释放 —— 下次看到它们时会自动重新下载。只有在确认你的存储里仍然有这个对象之后才会删。只统计**索引里记过的**副本：没有经手过的附件不计入。填 0 表示不限制。",
		cacheLimitPlaceholder: "0 = 不限制",
		cacheLimitNone: "不限",
		cacheLimitValue: "{mb} MB",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"超出本地副本上限：已删除 {count} 份最久没用过的副本（{mb} MB）。下次看到它们时会自动重新下载。",
		cacheEvictedPartial: "超出本地副本上限：已删除 {count} 份（{mb} MB），仍超出上限 {overMb} MB。",

		// ── 无人引用的附件：怎么告诉你 ──
		orphanAsk: "附件没人引用时",
		orphanAskDesc:
			"某个已上传的附件失去了笔记或画布里的最后一条引用之后，插件怎么做。清理永远需要你明确确认 —— 这一项只决定要不要告诉你、以及用哪种方式告诉你。",
		orphanAsk_always: "弹窗问我（保留 / 只删本地副本 / 一起删）",
		orphanAsk_notice: "只给一条通知",
		orphanAsk_never: "什么都不做",
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
