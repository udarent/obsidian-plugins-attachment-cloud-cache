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
		// 按用户的使用顺序排列：先能连上，再谈上传，然后是离线与清理。
		sectionStorage: "Storage connection",
		sectionUpload: "Upload",
		sectionOffline: "Offline and local copies",
		sectionCleanup: "Cloud cleanup",

		// ── 存储连接 ──
		s3Endpoint: "Endpoint",
		s3EndpointDesc:
			"The address of your S3-compatible service, for example https://<account>.r2.cloudflarestorage.com. Fill in the fields below, press Test connection, then paste an image in a note to confirm the link points to your storage.",
		s3Bucket: "Bucket",
		s3BucketDesc: "Must match the bucket name exactly — it is case-sensitive.",
		s3Region: "Region",
		s3RegionDesc:
			"Use auto for Cloudflare R2; MinIO usually accepts us-east-1. A wrong value shows up as a signature mismatch.",
		s3AccessKey: "Access key ID",
		s3AccessKeyDesc:
			"The identification half of your key pair — MinIO calls it Access Key, AWS Access Key ID. It is not a secret.",
		s3SecretKey: "Secret access key",
		s3SecretKeyDesc:
			"The secret half of the pair; edit both here, side by side. Stored in your system keychain, never in the plugin's settings.",
		s3SecretKeyPlaceholder: "Stored in your keychain",
		s3SecretStoreFailed: "Could not save the secret to your keychain: {error}",
		s3PublicUrlBase: "Public link address (optional)",
		s3PublicUrlBaseDesc:
			"A link is this address plus the file path. Leave it empty to use your endpoint and bucket; links then open for other people only if the bucket lets anyone read it. Fill it in for a CDN or your own domain.",
		connectionStatus_checking: "Checking…",
		connectionStatus_public: "Public access — anyone with the link can open it.",
		connectionStatus_private: "Private access — links open only in this plugin, with your keys.",
		connectionStatus_unreachable:
			"Unreachable — it could not be reached with or without your keys. Check the address, the bucket and the keys.",
		testConnection: "Test connection",
		testConnectionDesc:
			"Uploads a tiny test file, reads it back, deletes it, and checks whether other people can open your links. Nothing is kept and no note is changed. The light below shows the result — press the button to refresh it.",
		s3Import: "Import from a credentials file",
		s3ImportDesc:
			"Fills the fields above from the JSON your provider gives you (MinIO's “Download credentials” produces one). The secret goes straight into your system keychain.",
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
		// ⚠️ 公开 / 私有**没有文案**：结论就在那盏灯上（`connectionStatus_*`），
		// 再写一句就是同一句话说两遍（用户 2026-10-18 报的冗余）。所以这里只列「判断不了 / 地址有问题」那几类。
		testPublic_missing:
			"Reached that address, but the object is not there — the public link address is probably wrong. Checked: {url}",
		testPublic_unreachable: "Could not reach that address at all — the public link address is probably wrong. Checked: {url}",
		testPublic_other: "Could not tell whether the link works — your storage answered in a way we do not recognise. Checked: {url}",
		testPublic_unstable:
			"That address answered inconsistently — it was readable one moment and refused the next. A proxy or load balancer in front of your storage is probably serving different policies; nothing in your notes changed. Checked: {url}",
		testPublic_webpage:
			"That address did not return your file — a proxy, a cache or a catch-all page may be answering, or the public link address points somewhere else. Checked: {url}",
		testPublic_noSample: "This time there was no object to check a link against, so whether it opens elsewhere could not be judged.",
		// 探针回路（写 → 读 → 删）：每一段都要自己说明自己，否则用户会看到一个陌生的对象名
		testProbe_tempLeftBehind:
			"The probe object ({key}) could not be deleted — please remove it from the bucket.",
		testFail_probeWrite:
			"Connected, but the storage refused to write — uploads will fail the same way. Check that these keys may write to the bucket.",
		testFail_probeRead:
			"The write went through, but reading it back failed — check that these keys may read the bucket; fetching local copies needs that.",
		testFail_probeMismatch:
			"Read back {read} bytes, but {written} were written — the storage or a proxy in between is altering the data.",

		// ── 链接可访问性：访问方式与两种模式的差别（1.7.0）── "Who can open the links in your notes",, "Automatic (detect)", "Public read (links work anywhere)", "Internal access only (links work here only)",
		// 判定理由（`auto` 档下必须说清"我们凭什么"） "Links can be opened by anyone: {reason}", "Links are for this plugin only: {reason}", "you chose public read.", "you chose internal access only.", "anonymous access to that URL succeeded.", "that URL refuses anonymous access, so the bucket is private.", "the URL answered but the object is gone, which does not prove the bucket is public.", "the probe did not complete, which does not prove the bucket is public.", "nothing has been probed yet.",

		// ── 上传 ──
		autoUpload: "Upload new attachments automatically",
		autoUploadDesc:
			"However a file enters your vault — pasted, dropped, from your phone's gallery or camera, shared into Obsidian, or copied in — it is uploaded automatically and the note links to your storage. Off, everything goes back to Obsidian.",
		attachAutoUploaded: "Uploaded {count} attachment(s) that had just been added to your vault.",
		// ⚠️ 与上一条**必须分开说**：这一条的动作是"链接换成已有对象的地址"，**没有上传**。
		// 合成一句"已上传 N 个"会让用户以为自己的流量/仓库又花了一份（他 2026-10-14 就是这么报的）。
		attachAutoReused:
			"Already in your storage: {count} attachment(s) — links updated, nothing re-uploaded.",
		attachAutoFailed: "{count} newly added attachment(s) could not be uploaded — the files are still in your vault.",

		// ── 离线副本 ──
		localCopy: "What happens to the local copy",
		localCopyDesc:
			"Keep the file in your vault after uploading, or delete it to save space. Keeping it is what makes offline viewing work. Without it, images, audio and video still show online, but PDFs cannot be shown.",
		localCopy_keep: "Keep it (works offline)",
		localCopy_trash: "Delete it (saves space, no offline)",
		fallbackDownload: "Download missing local copies automatically",
		fallbackDownloadDesc:
			"Fetches files from your storage that this device does not have yet, for example after syncing notes from another device. Turn it off to avoid the downloads — files from a private bucket are still fetched, because otherwise they could not be shown.",

		// ── 高级 ──
		forcePathStyle: "Compatibility mode",
		forcePathStyleDesc:
			"Addresses files as endpoint/bucket/key. Keep it on for Cloudflare R2, MinIO and most self-hosted services; turn it off only if your provider requires bucket subdomains.",

		// ── 出错 ──
		hookUploadFailedKeptLocal: "Upload failed, so the file was kept locally instead: {error}",
		hookUploadFailedMany: "{count} files were not uploaded and were kept locally instead: {error}",
		hookLocalFallbackFailed: "Could not save the file locally either: {error}",
		// ⭐ 失败时给**一句人话 + 下一步**，不把 S3 的原始响应体（XML / StringToSign）摊给用户。
		// 键名来自 `s3/errors.ts::hintKeyFor`；两表都必须有文案（`test-s3-errors` 有跨层断言）。
		s3HintSignature: "Signature mismatch. Check that Region and Compatibility mode match this provider.",
		s3HintAccessDenied: "The storage refused this operation. Check the key's permissions, and whether the bucket allows writes.",
		s3HintNoSuchBucket: "Bucket not found. Check the bucket name and region.",
		s3HintAuth: "Authentication failed. Check the access key and secret key.",
		s3HintNotFound: "Object not found. It may have been deleted, or the public URL prefix is wrong.",
		s3HintThrottled: "The storage is rate-limiting requests. Try again in a moment.",
		s3HintNetwork: "Cannot reach the storage. Check your network and the endpoint.",
		s3HintServer: "The storage service returned an error. Try again in a moment.",
		s3HintGeneric: "Request failed. Check the storage settings.",
		statusUploading: "Uploading {count} attachment(s)…",
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
		// ⚠️ 2026-10-22（D-77）：命令名去掉了限定词（原来是“no note links to”）。
		// 清单现在是**三类**：没人引用的云端对象 / 没有引用的本地文件 / 站外缓存副本
		// —— 都是「可以清理的附件」，名字只说那一类就是错的（D-73 同一条教训）。
		cloudCleanupDeviceBlindSpot:
			"Only this device's references can be seen. Other devices (or another vault sharing this storage) may still be using some of these files — deleting cannot be undone.",
		cloudCleanupPersistFailed: "Could not save the local-copy index: {error}",
		cloudCleanupUnreadableNote: "Could not read {path}, so the cleanup was cancelled.",
		// F18：清理本地占用（并入「不留副本」档，见设计 §4.4.3 与 §6.4 来路 ③）
		releaseSpaceName: "Free up local space",
		releaseSpaceDesc:
			"Deletes local copies of files your notes still use — permanently, not to the trash, so the space frees up at once. Cloud files and the links in your notes are untouched, and a copy comes back the next time a note shows it. With a limit set, it stops at the limit.",
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
			"Points the links in your notes back at the files in your vault. Nothing is deleted — cloud files and local files stay as they are. Use it when you stop using this plugin.",
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
		orphanTitle: "Clean up these attachments no note links to?",
		// ⚠️ 2026-10-22（D-74）：不再说"you uploaded" —— 清单里有从来没上传过的本地文件。
		orphanBody: "{count} attachment(s) are no longer linked from any note or canvas.",
		// ⭐ 行内小标签：两类候选混在一屏，靠它区分（过滤开关也叫这两个名字）
		orphanRowCloud: "cloud",
		orphanRowLocal: "local",
		// ⭐ 2026-10-22（D-77）：站外缓存下来的本地副本（删了下次显示重新下载）
		orphanRowCached: "cached",
		orphanFilterCloud: "Cloud objects",
		orphanFilterLocal: "Local files",
		orphanMore: "…and {count} more.",
		orphanLocalNote:
			"Deleting a local copy only frees space in your vault - linking it again downloads it back. Deleting from your storage cannot be undone.",
		// ⭐ 2026-10-22（D-76）：清单弹窗的标题（与另一条命令同一个规则：**就是命令名本身**（2026-10-23 起命令名不再带省略号，两侧字面相同））。
		// ⚠️ 自动那条询问仍然用 `orphanTitle`（它是**问句**：那是一次没人要求的打扰）。
		orphanListTitle: "Clean up attachments",
		// ⭐⭐ 2026-10-22（D-76）：清单顶部是**一句固定说明**（与「上传附件」同一个规则）：
		// 不含数量、不随内容变。数量在**两个删除档的按钮上**。
		// 原来这里是 3~4 段（带 count 的一句 + 条件出现的「从没上传过」+
		// `orphanLocalNote` + `cloudCleanupDeviceBlindSpot`），而上传那边只有一句 ⇒ 两屏看起来不是一个产品。
		orphanListBody:
			"Ticked attachments are handled however you choose below: deleting the local file only frees space in your vault - if the cloud copy is still there, linking it again downloads it back, while deleting from storage cannot be undone. A file tagged “local” that was never uploaded has no cloud copy to fall back on. A file tagged “cached” was downloaded from another site: removing it touches neither your storage nor your notes, it is simply downloaded again the next time it is shown. Only references this vault can see are counted, so objects uploaded from another device are not listed.",
		orphanKeep: "Keep them",
		// ⚠️ 改叫"files"而不是"copies"（D-74）：那些从来没上传过的是**唯一一份**，不是副本。
		// ⭐ D-76：带 `{count}` —— 两个删除档都要说清“这一下动几个”。
		orphanLocalOnly: "Delete local files only ({count})",
		orphanBoth: "Delete locally and from storage ({count})",
		orphanLocalDeleted: "Removed {removed} local file(s). Your storage was left untouched.",
		orphanDeletedBoth:
			"Removed {removed} local file(s). Storage: {deleted} deleted, {alreadyGone} already gone, {failed} failed.",
		orphanNotice:
			"{count} uploaded attachment(s) are no longer linked from any note or canvas. Open “{command}” and pick the “To clean up” filter to review them.",
		orphanDismissed:
			"Nothing was deleted. To ask again, open “{command}” and pick the “To clean up” filter.",
		// ⚠️ 2026-10-22（D-77）：原来写着「站外缓存不在这里处理」—— 现在它们的**本地副本**就在这里处理。
		orphanNoneToCheck:
			"No attachments to clean up — whatever is left is either still linked from a note or canvas, or was uploaded from another device (this one cannot see what links to those).",
		cloudDeleteFailed: "Could not delete the object: {error}",
		cmdManageAttachments: "Attachment manager",
		galleryTitle: "Attachment manager",
		galleryListHeading: "Attachments",
		galleryRefresh: "Refresh",
		galleryEmpty: "No attachments in this view.",
		galleryFilterAll: "All",
		galleryRuleLine: "To delete a cloud object that notes still point at, first switch it to a local reference: then nothing points at the cloud copy any more.",
		galleryActionLocalize: "Use local file ({count})",
		galleryLocalizeTitle: "Use local file instead",
		galleryLocalizeBody: "Rewrite {count} remote link(s) to point at the local file. Notes are edited.",
		galleryLocalizeKeepsCloud: "The cloud copy is not deleted here; local files are not touched.",
		galleryLocalizeCta: "Switch {count}",
		galleryFilterToClean: "To clean up",
		galleryActionDeleteCloud: "Delete from cloud ({count})",
		galleryCloudConfirmTitle: "Delete from cloud",
		galleryCloudConfirmBody: "Permanently delete {count} object(s) from your storage. This cannot be undone.",
		galleryCloudConfirmBlocked: "{count} selected item(s) are still referenced by notes and will be skipped.",
		galleryCloudConfirmLocalStays: "Local files are not touched; what is in your notes is not changed.",
		galleryCloudConfirmCta: "Delete {count}",
		galleryFilterNotUploaded: "Not uploaded",
		galleryFilterUploaded: "Uploaded",
		galleryFilterCloudOnly: "In cloud only",
		galleryFilterUnreferenced: "Not referenced",
		gallerySelectAll: "Select all",
		gallerySelectNone: "Select none",
		galleryClose: "Close",
		galleryCtaUpload: "Upload ({count})",
		galleryRunning: "{finished}/{total}",
		galleryFinished: "Finished {finished}/{total}",
		galleryDoneSummary: "Finished: {done} done, {skipped} skipped, {failed} failed",
		galleryDoneFailed: "Failed: {names}",
		galleryStatusDone: "Done",
		galleryStatusFailed: "Failed",
		galleryStatusSkipped: "Skipped",
		galleryShowMore: "Show {count} more",
		galleryOpen: "Open",
		galleryActionUpload: "Upload ({count})",
		galleryActionDeleteLocal: "Delete local ({count})",
		galleryActionRename: "Rename",
		galleryRenameTitle: "Rename / move",
		galleryRenameField: "New path",
		galleryRenameConfirm: "Rename",
		galleryStateUploaded: "Uploaded",
		galleryStateNotUploaded: "Not uploaded",
		galleryStateCloudOnly: "In cloud only",
		galleryStateUnverified: "Not uploaded (unverified)",
		galleryStateUnreferenced: "not referenced",
		galleryStateCached: "cached external",
		// ⭐ 命令**失败**时必须有人说话（2026-10-16 用户实测："点击命令没有反应"）。
		// 以前异步命令抛错只留一条控制台记录，界面上什么都不发生 —— 那是最坏的失败形态。
		// ⚠️ 不写命令名：用户刚点过它，而 `{error}` 才是他要看的东西（命令 id 进控制台日志）。
		cmdFailed: "The command could not run: {error}",


		selfHealRepaired:
			"Local-copy index repaired automatically: {count} record(s) pointed at files that are no longer there.",
		legacyKeyTemplateUpgraded:
			"The object-key template setting is gone: new uploads are always named “original-name-content-hash.ext”, so files stay findable by name in your storage (the name therefore also reaches your storage provider). Existing links keep working; content you uploaded under the old naming is stored once more if you paste it again.",
		legacyExternalDefaultMerged:
			"Setting change: “When a note links to a file on another site” is gone — the switch above it (“Upload files from other sites”) is now the only control. Your earlier choice was carried over: {state}.",
		legacyExternalKeptOn: "automatic handling stays on",
		legacyExternalKeptOff:
			"automatic handling stays off, because you had it set to do nothing automatically — you can still pick files one by one",
		maintainMoreItems: "…and {count} more",
		maintainCancelled: "Cancelled — nothing was changed.",
		// ── 清单类弹窗（缩略图 + 勾选 + 进度）：上传附件 / 清理没有笔记引用的云端附件共用 ──
		taskListEmpty: "Nothing to show here.",
		// ⭐ 一件能勾的都没有时主按钮退回成它（D-70：那种清单只剩"打开笔记去修"的行）
		taskListClose: "Close",
		taskListSelected: "{selected} of {total} selected",
		taskProgressRunning: "Working… {finished}/{total}",
		taskProgressFinished: "Finished: {done} done, {skipped} skipped, {failed} failed.",
		taskStatusDone: "done",
		taskStatusFailed: "failed",
		taskStatusSkipped: "skipped",
		taskShowMore: "Show {count} more row(s) — the rest are still included",
		fileCardOpen: "Open",
		// ⭐ 失效附件那一行的链接去的是**引用它的笔记**（D-70），文案得说清是"笔记"
		fileCardOpenNote: "Open note",
		fileCardOpenMissing: "That file is no longer in the vault: {path}",
		maintainPersistFailed: "Could not save the index after repairing it: {error}",
		maintainSkipUnknownCopy: "The index no longer points at this file — skipped",
		maintainSkipUnconfirmed: "Could not confirm the cloud still has it — skipped",
		maintainSkipNotInCloud: "Your storage no longer has this object — skipped, this copy is the only one left",
		maintainSkipNotIndexed: "Obsidian cannot see this file yet — skipped instead of deleting it directly",
		maintainNotConfigured: "The storage connection is not set up yet, so nothing was uploaded.",
		maintainBatchNothing: "No attachments to upload (everything is already handled).",
		// ⚠️ 2026-10-22（D-73）：标题**不再是"笔记引用的文件"** —— D-68 之后这条命令
		// 涵盖四类（被引用 / 没有引用 / 站外 / 本机），旧标题只说了第一类。
		// ⚠️ 与 `externalPickName`（设置页那一项）**恰好同字**，但两者用途不同
		//（一个是弹窗标题、一个是设置项名）—— 改一个不必改另一个，所以各自留着键。
		maintainBatchTitle: "Upload attachments",
		// ⭐ 清单上方的范围勾选框（2026-10-22）：勾上 = 只列当前这篇笔记里的候选。
		// ⚠️ 文案要说"只看"，而不是"上传当前笔记"—— 它**不改做什么**，只改看哪一份清单。
		maintainBatchOnlyCurrentNote: "Only the current note",
		// ⭐ 2026-10-22（D-71）：这一句现在**同时**承担"上传几个"与"文件不移动/不改名"那个承诺
		// （原来那是第二段 `maintainBatchOriginalsStay`）—— 用户要求把列表上方的文案收掉，
		// 而这两件事都是不能省的：前者是数量，后者是"跑完文件还在"的唯一交代。
		// ⭐⭐ 2026-10-22（D-72）：**固定说明，不随内容变**（用户：「还是有顶部会根据内容调整的
		// 文案,把文案简化成固定的说明文字」）。⚠️ 不许出现任何数字或主机名 —— 数量在**按钮**上
		// （`maintainBatchCta(count)`），站点在**每一行的副标题**里（`externalRowMeta`）。
		maintainBatchSummary:
			"Ticked files are uploaded to your storage and the links in your notes are rewritten to point there. Files stay in your attachments folder - nothing is moved or renamed. Off-site addresses in the list will be visited; a warning icon marks a file that is already gone - open the note next to it to fix that link.",
		maintainBatchUnreferencedHint: "no note links it",
		// ⭐ 行内小标签（D-71）：早就在这里传过了，勾了也**不会重传字节**，只改链接
		maintainBatchRepairHint: "link only",
		maintainBatchDuplicatesRemoved:
			"Deleted {count} duplicate copy(ies) the host had left behind on a name collision (same content as the copy that stays).",
		maintainBatchCanvasSkipped:
			"{count} reference(s) in canvases could not be rewritten (the file is not readable JSON), so they still point to their old location.",
		// ⚠️ 2026-10-22（D-76）：**数量就在这里** —— D-72 把顶部改成固定说明时说过“数量搬到按钮上”，
		// 但模板里没有 `{count}` ⇒ 那个数字一直被静默丢掉（套件的假 `t` 会把参数拼进去，
		// 所以单元测试一直绿）。验收里现在有一条**真译器**的断言钉着它。
		maintainBatchCta: "Upload and rewrite links ({count})",
		maintainBatchMissingHint: "file is gone",
		maintainBatchDone:
			"Uploaded {uploaded}, already there {reused}, failed {failed}. Rewrote {links} link(s) across {notes} note(s).",

		// ── Files from other sites ──
		externalImageCache: "Upload files from other sites",
		externalImageCacheDesc:
			"A file linked from another site is downloaded, uploaded to your storage and the link rewritten — just like pasting a local file. Off by default, so those files are left alone. Picking files by hand always works.",
		externalSiteMode: "Which sites to handle automatically",
		externalSiteModeDesc:
			"Only affects the automatic handling. “All sites” applies no filter; the other two use the list below to skip sites, or to handle only those.",
		externalSite_off: "All sites",
		externalSite_blocklist: "All except the ones listed",
		externalSite_allowlist: "Only the ones listed",
		externalSiteList: "Site list",
		externalSiteListDesc:
			"One domain per line. example.com also matches img.example.com; write example.com:8080 to match that host exactly. With “Only the ones listed”, an empty list means nothing is handled automatically.",
		externalSiteListPlaceholder: "example.com\ncdn.example.com",
		externalPickName: "Upload attachments",
		// ⚠️ 2026-10-22（D-73）：① 说"搬到你的存储"是**错的** —— 1.2.0（D-17）起
		// **文件不移动、不改名**，变的只有笔记里的链接；② 候选从 D-68 起含"没有任何笔记引用"的附件。
		externalPickDesc:
			"Upload the attachments in your vault that are not in your storage yet (including ones no note links to), plus the files your notes point at on other sites or on this computer. Tick each one in the list; the files themselves stay where they are.",
		externalPickButton: "Upload attachments…",
		externalPickAll: "Select all",
		externalPickNone: "Select none",
		externalPickCancel: "Cancel",
		externalCached: "Uploaded the file from {host} and rewrote the link.",
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
			"Caps the space local copies may take. The least recently used ones are deleted first and come back when you view them again. 0 means no limit.",
		cacheLimitPlaceholder: "0 = no limit",
		cacheLimitValue: "{mb} MB",
		// ⭐ 2026-10-22（D-79）：设置页那行「当前占用」—— 只读索引，界面写清「约」。
		localUsageName: "Space used",
		localUsageDesc:
			"An estimate from the index of how much your local copies take - it does not check every "
			+ "file on disk. To see what could be cleaned up, run Clean up attachments.",
		localUsageValue: "{count} local copy(ies), about {mb} MB.",
		localUsageEmpty: "No local copies yet.",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"Over the local copy limit: deleted {count} least recently used copies ({mb} MB). They will be downloaded again when you view them.",
		cacheEvictedPartial:
			"Over the local copy limit: deleted {count} copies ({mb} MB), still {overMb} MB over the limit.",

		// ── 无人引用的附件：怎么告诉你 ──
		orphanAsk: "When an attachment is no longer linked",
		orphanAskDesc:
			"What happens after an uploaded file loses its last link from any note or canvas. Cleaning up always asks for confirmation; this only decides whether and how you are told.",
		orphanAsk_always: "Ask me",
		orphanAsk_notice: "Just show a notice",
		orphanAsk_never: "Do nothing",
		cleanupCommandHint: "To clean up the ones that already exist, open “{command}” and pick the “To clean up” filter.",
		deleteLogName: "Deletion log",
		deleteLogDesc: "Every cloud deletion is written here. After a permanent delete this is the only record.",
		deleteLogButton: "Open",
		deleteLogTitle: "Cloud deletions",
		deleteLogEmpty: "No cloud deletions have been recorded yet.",
		deleteLogUnavailable: "The deletion log cannot be located in this environment.",
		debugLogging: "Debug logging",
		debugLoggingDesc: "Print each stage's counts and timings to the developer console (it has to show Verbose output). Nothing else changes, and nothing appears in the interface.",
	},
	zh: {
		sectionStorage: "存储连接",
		sectionUpload: "上传",
		sectionOffline: "离线与本地副本",
		sectionCleanup: "云端清理",

		s3Endpoint: "服务地址",
		s3EndpointDesc: "你的 S3 兼容服务地址，例如 https://<account>.r2.cloudflarestorage.com。填好下面几栏后点「测试连接」，再在笔记里粘一张图确认链接已指向你的存储。",
		s3Bucket: "存储桶",
		s3BucketDesc: "必须与桶名完全一致（区分大小写）。",
		s3Region: "区域",
		s3RegionDesc: "Cloudflare R2 填 auto；MinIO 常用 us-east-1。填错时表现为「签名不匹配」。",
		s3AccessKey: "访问密钥 ID",
		s3AccessKeyDesc: "密钥对里的「身份」部分 —— MinIO 叫 Access Key，AWS 叫 Access Key ID。它本身不是秘密。",
		s3SecretKey: "秘密访问密钥",
		s3SecretKeyDesc: "密钥对里的「秘密」部分；轮换时就在这里和上一项一起改。存在系统钥匙串里，不写进插件设置。",
		s3SecretKeyPlaceholder: "已存入系统钥匙串",
		s3SecretStoreFailed: "无法把该密钥写入系统钥匙串：{error}",
		s3PublicUrlBase: "公开链接地址（可选）",
		s3PublicUrlBaseDesc: "链接 = 这个地址 + 文件路径。留空就用服务地址和存储桶；这条链接要给别人打开，桶得允许任何人读取。用 CDN 或自己的域名时填这里。",
		connectionStatus_checking: "正在检测…",
		connectionStatus_public: "公开访问 —— 拿到链接的人都能打开。",
		connectionStatus_private: "私有访问 —— 链接只能在本插件里打开（需要有密钥）。",
		connectionStatus_unreachable: "无法访问 —— 不带密钥和带密钥都取不到。请检查服务地址、桶名与密钥。",
		testConnection: "测试连接",
		testConnectionDesc: "上传一个很小的测试文件、读回来、再删掉，同时检查别人能不能打开你的链接。什么都不留，也不改任何笔记。下面的灯就是结果，点按钮可重新检查。",
		s3Import: "从凭据文件导入",
		s3ImportDesc: "用服务商给你的 JSON 一次填好上面几栏（MinIO 的「下载凭据」就是这种）。秘密密钥直接进系统钥匙串。",
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
		// ⚠️ 公开 / 私有**没有文案**：结论就在那盏灯上（`connectionStatus_*`），
		// 再写一句就是同一句话说两遍（用户 2026-10-18 报的冗余）。所以这里只列「判断不了 / 地址有问题」那几类。
		testPublic_missing: "那个地址能连上，但文件不在 —— 公开链接地址多半写错了。检查的是：{url}",
		testPublic_unreachable: "连不上那个地址 —— 公开链接地址可能写错了。检查的是：{url}",
		testPublic_other: "无法判断链接是否可用 —— 存储回了一个我们没预料到的结果。检查的是：{url}",
		testPublic_unstable:
			"那个地址的响应不稳定 —— 同一轮里一次读得到、一次读不到。多半是存储前面的反向代理 / 负载均衡后面的策略不一致；你笔记里的链接本身没变。检查的是：{url}",
		testPublic_webpage: "那个地址回的不是你的文件 —— 可能被代理 / 缓存 / 兜底页接走了，或公开链接地址指到了别处。检查的是：{url}",
		testPublic_noSample: "这次没有可用的探测对象，因此判断不了链接在别处能不能打开。",
		// 探针回路（写 → 读 → 删）：每一段都要自己说明自己，否则用户会看到一个陌生的对象名
		testProbe_tempLeftBehind: "探测对象（{key}）没能删掉 —— 请到桶里手动删除。",
		testFail_probeWrite: "连接正常，但存储拒绝了写入 —— 上传也会这样失败。请检查这把密钥是否有写入权限。",
		testFail_probeRead: "写入成功了，但读不回来 —— 请检查这把密钥是否有读取权限（取回本地副本要用它）。",
		testFail_probeMismatch: "读回来 {read} 字节，写进去的是 {written} 字节 —— 存储或中间的代理改了数据。",

		// ── 链接可访问性：访问方式与两种模式的差别（1.7.0）── "笔记里的链接谁打得开",, "自动（探测后决定）", "公开读取（链接在任何地方都能打开）", "仅内部访问（链接只在装了本插件的地方能看）", "这些链接别人也能打开：{reason}", "这些链接只有本插件能取到：{reason}", "你选的是公开读取。", "你选的是仅内部访问。", "匿名访问那条地址成功了。", "那条地址拒绝匿名访问，说明桶是私有的。", "地址能连上但对象不在，这证明不了桶是公开的。", "探测没有完成，这证明不了桶是公开的。", "还没探测过。",

		autoUpload: "新附件自动上传",
		autoUploadDesc: "不管附件怎么进库 —— 粘贴、拖入、手机相册或相机、分享到 Obsidian、从别处拷进来 —— 都会自动上传，笔记里的链接换成云端地址。关闭后全部交回 Obsidian，文件只存在本地。",
		attachAutoUploaded: "已自动上传刚加入库的 {count} 个附件。",
		// ⚠️ 与上一条**必须分开说**：这一条的动作是"链接换成已有对象的地址"，**没有上传**。
		// 用户 2026-10-14 在 Android 上报的就是这个：重复插同一张图，提示却说"上传成功"。
		attachAutoReused: "刚加入库的 {count} 个附件此前已经上传过 —— 只更新了链接，没有重复上传。",
		attachAutoFailed: "刚加入库的 {count} 个附件上传失败 —— 文件仍然留在你的库里。",

		localCopy: "上传后如何处理本地副本",
		localCopyDesc: "上传后把文件留在库里，或者删掉它省空间。留着才能离线查看；删掉后图片、音频、视频仍能在线显示，但 PDF 显示不出来。",
		localCopy_keep: "保留（可离线查看）",
		localCopy_trash: "不保留（省空间，不能离线查看）",
		fallbackDownload: "自动下载缺失的本地副本",
		fallbackDownloadDesc: "这台设备上还没有的云端文件（例如从别的设备同步来的笔记里引用的）会自动取回。关掉可以省流量；桶不公开时仍会取回，否则图显示不出来。",

		forcePathStyle: "兼容模式",
		forcePathStyleDesc: "按「服务地址/桶/文件名」寻址。Cloudflare R2、MinIO 和多数自建服务都要开着；只有服务商要求用桶名做子域时才关掉。",

		hookUploadFailedKeptLocal: "上传失败，已改为保留本地文件：{error}",
		hookUploadFailedMany: "{count} 个文件上传失败，已改为保留本地文件：{error}",
		hookLocalFallbackFailed: "本地文件也没能保存：{error}",
		// ⭐ 失败时给**一句人话 + 下一步**，不把 S3 的原始响应体（XML / StringToSign）摊给用户。
		s3HintSignature: "签名不匹配。检查区域（Region）与兼容模式是否与服务商一致。",
		s3HintAccessDenied: "存储拒绝了这次操作。检查密钥权限，以及桶是否允许写入。",
		s3HintNoSuchBucket: "找不到这个桶。检查桶名与区域。",
		s3HintAuth: "认证失败。检查访问密钥与秘密密钥。",
		s3HintNotFound: "对象不存在。可能已被删除，或公开地址前缀写错了。",
		s3HintThrottled: "存储正在限流，稍后再试。",
		s3HintNetwork: "连不上存储。检查网络与服务地址。",
		s3HintServer: "存储服务端出错，稍后再试。",
		s3HintGeneric: "请求失败。检查存储设置。",
		statusUploading: "正在上传 {count} 个附件…",
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
		// ⚠️ 2026-10-22（D-77）：命令名去掉了限定词（原来是「没有笔记引用的」）。
		// 清单现在是**三类**：没人引用的云端对象 / 没有引用的本地文件 / 站外缓存副本
		// —— 都是「可以清理的附件」，名字只说那一类就是错的（D-73 同一条教训）。
		cloudCleanupDeviceBlindSpot:
			"只能看到本设备的引用情况。其他设备（或共用这个存储的另一个库）可能还在用其中一些文件 —— 删除后无法恢复。",
		cloudCleanupPersistFailed: "本地副本索引保存失败：{error}",
		cloudCleanupUnreadableNote: "读不到 {path}，因此取消了这次清理。",
		// F18：清理本地占用（并入「不留副本」档，见设计 §4.4.3 与 §6.4 来路 ③）
		releaseSpaceName: "释放本地空间",
		releaseSpaceDesc: "删掉笔记仍在用的附件的本地副本 —— 永久删除、不进回收站，空间立刻腾出。云端文件和笔记里的链接都不动，下次看图会自动补回。设了上限时只清到上限为止。",
		releaseSpaceButton: "删除本地副本…",
		releaseSpaceTitle: "永久删除这些本地副本？",
		releaseSpaceSummary: "{count} 个本地副本，约 {mb} MB：",
		releaseSpaceCannotUndo:
			"这些文件会被永久删除（不进回收站），无法撤销。下次笔记里显示它们时会自动重新下载。",
		releaseSpaceCloudUntouched:
			"云端对象与你的笔记都不会被改动；每一份都是在确认云端仍然有它之后才会删。",
		releaseSpaceCta: "永久删除",
		revertName: "把链接改回本地路径",
		revertDesc: "把笔记里的链接改回指向库里的文件。什么都不删 —— 云端文件和本地文件都原样留着。准备停用插件时用它。",
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
		orphanTitle: "要清理这些没有笔记引用的附件吗？",
		// ⚠️ 2026-10-22（D-74）：不再说"你上传过的" —— 清单里有从来没上传过的本地文件。
		orphanBody: "下列 {count} 个附件已经不再被任何笔记或画布引用了。",
		// ⭐ 行内小标签：两类候选混在一屏，靠它区分（过滤开关也叫这两个名字）
		orphanRowCloud: "云端",
		orphanRowLocal: "本地",
		// ⭐ 2026-10-22（D-77）：站外缓存下来的本地副本（删了下次显示重新下载）
		orphanRowCached: "站外缓存",
		orphanFilterCloud: "云端对象",
		orphanFilterLocal: "本地文件",
		orphanMore: "……还有 {count} 个。",
		orphanLocalNote:
			"只删本地副本只是腾出库里的空间 —— 以后笔记里再引用它，会自动重新下载；从存储里删掉就找不回来了。",
		// ⭐ 2026-10-22（D-76）：清单弹窗的标题（与另一条命令同一个规则：**就是命令名本身**（2026-10-23 起命令名不再带省略号，两侧字面相同））。
		// ⚠️ 自动那条询问仍然用 `orphanTitle`（它是**问句**：那是一次没人要求的打扰）。
		orphanListTitle: "清理附件",
		// ⭐⭐ 2026-10-22（D-76）：清单顶部是**一句固定说明**（与「上传附件」同一个规则）：
		// 不含数量、不随内容变。数量在**两个删除档的按钮上**。
		orphanListBody:
			"勾中的附件按下面选的方式处理：只删本地文件只是腾出库里的空间 —— 云端还在的话，以后笔记里再引用它会自动重新下载；从存储里删掉就找不回来了。标着「本地」、从来没上传过的那些没有云端可依。标着「站外缓存」的是从别的网站下载的副本：删掉不碰云端、也不改笔记，只是下次显示时要重新联网下载。这个清单只算本库看得见的引用，别的设备上传的对象不在这里。",
		orphanKeep: "保留",
		// ⚠️ 改叫"本地文件"而不是"本地副本"（D-74）：那些从来没上传过的是**唯一一份**，不是副本。
		// ⭐ D-76：带 `{count}` —— 两个删除档都要说清“这一下动几个”。
		orphanLocalOnly: "只删本地文件 ({count})",
		orphanBoth: "云端和本地一起删 ({count})",
		orphanLocalDeleted: "已删掉 {removed} 个本地文件；云端对象未动。",
		orphanDeletedBoth:
			"已删掉 {removed} 个本地文件；云端：删除 {deleted} 个、本来就不存在 {alreadyGone} 个、失败 {failed} 个。",
		orphanNotice: "有 {count} 个已上传的附件不再被任何笔记或画布引用。打开「{command}」，切到「待清理」筛选查看并处理。",
		orphanDismissed:
			"什么都没删。想再问一次：打开「{command}」，切到「待清理」筛选。",
		// ⚠️ 2026-10-22（D-77）：原来写着「站外缓存不在这里处理」—— 现在它们的**本地副本**就在这里处理。
		orphanNoneToCheck:
			"没有需要清理的附件 —— 剩下的要么还有笔记或画布在引用，要么是别的设备上传的（这台设备看不见谁在引用它们）。",
		cloudDeleteFailed: "删除对象失败：{error}",
		cmdManageAttachments: "附件管理",
		galleryTitle: "附件管理",
		galleryListHeading: "附件清单",
		galleryRefresh: "刷新",
		galleryEmpty: "这个筛选下没有附件。",
		galleryFilterAll: "全部",
		galleryRuleLine: "删云端之前要先让笔记不再指向它：勾上「改为本地引用」，那份对象才变成“没人引用”。",
		galleryActionLocalize: "改为本地引用 ({count})",
		galleryLocalizeTitle: "改为本地引用",
		galleryLocalizeBody: "把 {count} 处远端链接改回本地文件，会修改笔记。",
		galleryLocalizeKeepsCloud: "这一步不删云端对象，也不动本地文件。",
		galleryLocalizeCta: "改为本地引用 {count} 个",
		galleryFilterToClean: "待清理",
		galleryActionDeleteCloud: "删除云端 ({count})",
		galleryCloudConfirmTitle: "删除云端对象",
		galleryCloudConfirmBody: "将从你的存储里永久删除 {count} 个对象，无法恢复。",
		galleryCloudConfirmBlocked: "选中的里有 {count} 个仍被笔记引用，这次会跳过。",
		galleryCloudConfirmLocalStays: "本地文件不动；笔记里的内容也不改。",
		galleryCloudConfirmCta: "删除 {count} 个",
		galleryFilterNotUploaded: "未上传",
		galleryFilterUploaded: "已上传",
		galleryFilterCloudOnly: "云端有本地无",
		galleryFilterUnreferenced: "没人引用",
		gallerySelectAll: "全选",
		gallerySelectNone: "全不选",
		galleryClose: "关闭",
		galleryCtaUpload: "上传 ({count})",
		galleryRunning: "{finished}/{total}",
		galleryFinished: "已结束 {finished}/{total}",
		galleryDoneSummary: "已处理：完成 {done}, 跳过 {skipped}, 失败 {failed}",
		galleryDoneFailed: "失败：{names}",
		galleryStatusDone: "完成",
		galleryStatusFailed: "失败",
		galleryStatusSkipped: "跳过",
		galleryShowMore: "再显示 {count} 行",
		galleryOpen: "打开",
		galleryActionUpload: "上传 ({count})",
		galleryActionDeleteLocal: "删除本地 ({count})",
		galleryActionRename: "重命名",
		galleryRenameTitle: "重命名 / 移动",
		galleryRenameField: "新路径",
		galleryRenameConfirm: "改名",
		galleryStateUploaded: "已上传",
		galleryStateNotUploaded: "未上传",
		galleryStateCloudOnly: "云端有本地无",
		galleryStateUnverified: "未上传（未核）",
		galleryStateUnreferenced: "没人引用",
		galleryStateCached: "站外缓存",
		// ⭐ 命令**失败**时必须有人说话（2026-10-16 用户实测："点击命令没有反应"）。
		// 以前异步命令抛错只留一条控制台记录，界面上什么都不发生 —— 那是最坏的失败形态。
		// ⚠️ 不写命令名：用户刚点过它，而 `{error}` 才是他要看的东西（命令 id 进控制台日志）。
		cmdFailed: "命令执行失败：{error}",


		selfHealRepaired: "本地副本索引已自动修复：{count} 条记录指向的本地副本已经不在了。",
		legacyKeyTemplateUpgraded:
			"「对象 key 模板」设置已取消：之后上传的对象固定命名为「原文件名-内容哈希.扩展名」，存储里可以按名字找到文件（文件名因此也会出现在你的存储服务商那边）。已有链接不受影响；按旧命名传过的内容若再贴一次，会在云端多存一份。",
		legacyExternalDefaultMerged:
			"设置改版：「遇到站外文件链接时」那一档已并入上面的开关「站外文件也上传到云端」，你原来的选择已折算进去 —— {state}。",
		legacyExternalKeptOn: "自动处理保持开启",
		legacyExternalKeptOff:
			"自动处理保持关闭（你原本选的是「什么都不做」）；「上传附件」仍然随时可用",
		maintainMoreItems: "……还有 {count} 个",
		maintainCancelled: "已取消，没有改动任何内容。",
		// ── 清单类弹窗（缩略图 + 勾选 + 进度）：上传附件 / 清理没有笔记引用的云端附件共用 ──
		taskListEmpty: "这里没有可处理的条目。",
		// ⭐ 一件能勾的都没有时主按钮退回成它（D-70：那种清单只剩"打开笔记去修"的行）
		taskListClose: "关闭",
		taskListSelected: "已选 {selected} / {total}",
		taskProgressRunning: "正在处理…… {finished}/{total}",
		taskProgressFinished: "已结束：完成 {done} 个、跳过 {skipped} 个、失败 {failed} 个。",
		taskStatusDone: "完成",
		taskStatusFailed: "失败",
		taskStatusSkipped: "跳过",
		taskShowMore: "再显示 {count} 行（其余的行照样会被处理）",
		fileCardOpen: "打开",
		// ⭐ 失效附件那一行的链接去的是**引用它的笔记**（D-70），文案得说清是"笔记"
		fileCardOpenNote: "打开笔记",
		fileCardOpenMissing: "文件已不在库里：{path}",
		maintainPersistFailed: "修复后保存索引失败：{error}",
		maintainSkipUnknownCopy: "索引里已经不再指向这个文件 —— 跳过",
		maintainSkipUnconfirmed: "确认不了云端是否还有它 —— 跳过",
		maintainSkipNotInCloud: "你的存储里已经没有这个对象 —— 跳过，这份是仅剩的副本",
		maintainSkipNotIndexed: "Obsidian 还看不到这个文件 —— 已跳过，而不是直接删除",
		maintainNotConfigured: "存储连接尚未配置，没有上传任何内容。",
		maintainBatchNothing: "没有需要上传的附件（都已经处理过了）。",
		// ⚠️ 2026-10-22（D-73）：标题**不再是"笔记引用的文件"** —— D-68 之后这条命令
		// 涵盖四类（被引用 / 没有引用 / 站外 / 本机），旧标题只说了第一类。
		// ⚠️ 与 `externalPickName`（设置页那一项）**恰好同字**，但两者用途不同
		// （一个是弹窗标题、一个是设置项名）—— 改一个不必改另一个，所以各自留着键。
		maintainBatchTitle: "上传附件",
		// ⭐ 清单上方的范围勾选框（2026-10-22）：勾上 = 只列当前这篇笔记里的候选。
		// ⚠️ 文案要说"只看"，而不是"上传当前笔记"—— 它**不改做什么**，只改看哪一份清单。
		maintainBatchOnlyCurrentNote: "只看当前笔记",
		// ⭐ 2026-10-22（D-71）：这一句现在**同时**承担"上传几个"与"文件不移动/不改名"那个承诺
		// （原来那是第二段 `maintainBatchOriginalsStay`）—— 用户要求把列表上方的文案收掉，
		// 而这两件事都是不能省的：前者是数量，后者是"跑完文件还在"的唯一交代。
		// ⭐⭐ 2026-10-22（D-72）：**固定说明，不随内容变**（用户：「还是有顶部会根据内容调整的
		// 文案,把文案简化成固定的说明文字」）。⚠️ 不许出现任何数字或主机名 —— 数量在**按钮**上
		// （`maintainBatchCta(count)`），站点在**每一行的副标题**里（`externalRowMeta`）。
		maintainBatchSummary:
			"勾中的文件会传到你的存储，笔记里的链接会改成远端地址；文件留在附件目录，不移动也不改名。清单里的站外地址会被访问；标了警示图标的是已经不在了的文件，点行尾的「打开笔记」去修。",
		maintainBatchUnreferencedHint: "没有笔记引用",
		// ⭐ 行内小标签（D-71）：早就在这里传过了，勾了也**不会重传字节**，只改链接
		maintainBatchRepairHint: "只改链接",
		maintainBatchDuplicatesRemoved:
			"已删掉 {count} 份宿主撞名留下的重复副本（内容与留下的那份完全相同）。",
		maintainBatchCanvasSkipped:
			"画布里有 {count} 处引用没能改写（画布文件不是可读的 JSON），它们仍指向旧位置。",
		// ⚠️ 2026-10-22（D-76）：**数量就在这里** —— D-72 把顶部改成固定说明时说过“数量搬到按钮上”，
		// 但模板里没有 `{count}` ⇒ 那个数字一直被静默丢掉（套件的假 `t` 会把参数拼进去，
		// 所以单元测试一直绿）。验收里现在有一条**真译器**的断言钉着它。
		maintainBatchCta: "上传并改写链接 ({count})",
		maintainBatchMissingHint: "文件已不在",
		maintainBatchDone:
			"上传 {uploaded} 个、已存在 {reused} 个、失败 {failed} 个。在 {notes} 篇笔记里改写了 {links} 处链接。",

		// ── 站外文件 ──
		externalImageCache: "站外文件也上传到云端",
		externalImageCacheDesc: "笔记里出现站外文件时，会自动下载、上传到云端并改写链接 —— 和粘贴一张本地附件一样。默认关闭，关着时这类文件一步都不碰。手动选择始终可用。",
		externalSiteMode: "自动处理哪些站点",
		externalSiteModeDesc: "只影响上面的自动处理。「所有站点」不过滤；后两档用下面的名单跳过某些站点，或只处理名单里的站点。",
		externalSite_off: "所有站点",
		externalSite_blocklist: "除名单外的站点",
		externalSite_allowlist: "仅名单内的站点",
		externalSiteList: "站点名单",
		externalSiteListDesc: "一行一个域名。写 example.com 也会命中 img.example.com；写 example.com:8080 只匹配那个地址。选「仅名单内的站点」时，留空表示什么都不自动处理。",
		externalSiteListPlaceholder: "example.com\ncdn.example.com",
		externalPickName: "上传附件",
		// ⚠️ 2026-10-22（D-73）：① 说"搬到你的存储"是**错的** —— 1.2.0（D-17）起
		// **文件不移动、不改名**，变的只有笔记里的链接；② 候选从 D-68 起含"没有任何笔记引用"的附件。
		externalPickDesc:
			"把库里还没上传的附件（包括没有任何笔记引用的）以及笔记里指向站外或本机的文件传到你的存储。清单里可以逐项勾选，文件本身留在原处。",
		externalPickButton: "上传附件…",
		externalPickAll: "全选",
		externalPickNone: "全不选",
		externalPickCancel: "取消",
		externalCached: "已上传来自 {host} 的文件并改写链接。",
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
		cacheLimitDesc: "限制本地副本占用的空间。超出时先删最久没用过的，下次看到会重新下载。填 0 表示不限制。",
		cacheLimitPlaceholder: "0 = 不限制",
		cacheLimitValue: "{mb} MB",
		// ⭐ 2026-10-22（D-79）：设置页那行「当前占用」—— 只读索引，界面写清「约」。
		localUsageName: "占用空间",
		localUsageDesc:
			"这个数字来自索引，不逐个核对磁盘。想看哪些可以清，"
			+ "跑「清理附件」，那里逐行列着。",
		localUsageValue: "{count} 份本地副本，约 {mb} MB。",
		localUsageEmpty: "还没有本地副本。",
		// 缓存清理只有一种方式（直接删除），所以通知只有一条。
		cacheEvicted:
			"超出本地副本上限：已删除 {count} 份最久没用过的副本（{mb} MB）。下次看到它们时会自动重新下载。",
		cacheEvictedPartial: "超出本地副本上限：已删除 {count} 份（{mb} MB），仍超出上限 {overMb} MB。",

		// ── 无人引用的附件：怎么告诉你 ──
		orphanAsk: "附件不再被引用时",
		orphanAskDesc: "已上传的附件失去最后一条引用（笔记或画布）之后，插件怎么做。清理永远需要你确认；这一项只决定要不要通知你、怎么通知。",
		orphanAsk_always: "弹窗让我选",
		orphanAsk_notice: "只给一条通知",
		orphanAsk_never: "什么都不做",
		cleanupCommandHint: "要处理已有的孤儿，打开「{command}」，切到「待清理」筛选。",
		deleteLogName: "删除记录",
		deleteLogDesc: "每次删除云端对象都会记在这里。永久删除之后，这是唯一的记录。",
		deleteLogButton: "查看",
		deleteLogTitle: "云端删除记录",
		deleteLogEmpty: "还没有删除记录。",
		deleteLogUnavailable: "这个环境里找不到删除记录（插件目录未知）。",
		debugLogging: "排障日志",
		debugLoggingDesc: "在开发者控制台打印每个阶段的计数与耗时（需勾选 Verbose 级别）。不改变任何行为，也不会显示在界面上。",
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
