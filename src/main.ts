/**
 * 插件入口。
 *
 * ## 接线清单（改这里之前先读这一段）
 *
 * `onload` 里注册的东西就是**用户实际能用到**的全部能力。没在这里注册的模块，
 * 哪怕测试全绿、代码再周全，运行时也**一行都不会执行** —— 这是本项目踩过的坑：
 * 曾经有 8 个模块（上传编排、缓存索引、粘贴判定……）全都有测试，
 * 而入口只注册了设置页，于是装进 vault 的插件除了设置界面什么都不做。
 *
 * 因此 `main.ts` 有一条专门的验收测试（`scripts/test-load-acceptance.mjs`）：
 * 它加载**真实构建产物**、跑 `onload()`、断言钩子真的被注册了。
 * 判据很直接：**把下面任何一行注册代码删掉，那条测试必须变红。**
 *
 * ## 关于那个 ribbon 图标
 *
 * 这里**故意没有** ribbon 图标。曾经有一个，但它只能弹一句"设置界面即将提供" ——
 * 而设置界面现在已经存在，用程序打开设置页的 API 却**不在公开类型里**
 * （`app.setting` / `openTabById` 都没出现在钉住的 `obsidian.d.ts` 中）。
 * 能用的写法是 `(this.app as any).setting...`，但那绕过类型系统、依赖未公开接口 ——
 * 与本项目"只用两端都有、且公开的 API"的纪律冲突（那条纪律由 lint 强制）。
 *
 * 用户找设置的正常路径是「设置 → 第三方插件 → 本插件的齿轮」；
 * 而"没配置就用"时粘贴会给出明确报错并指向设置页 —— 那条路径比一个图标更有用。
 */

import { Component, MarkdownRenderer, Notice, Plugin, TFile, TFolder, getLanguage } from "obsidian";

import { SETTINGS_DEFAULTS, hasLegacyExternalImageDefault, hasLegacyObjectKeyTemplate, legacyAutoCacheEnabled, mergePluginSettings } from "./settings";
import type { LocalCopyAction, PluginSettings } from "./types";
import { detectLocale, translate } from "./i18n";
import { SettingsTab } from "./ui/settings-tab";
import { CacheIndex } from "./cache/index";
import { createIndexStore, makeSerializer } from "./host/runtime";
import type { HostContext } from "./host/runtime";
import { createEditorHandlers } from "./host/editor-bridge";
import { inspectLocalCopies, readCopies, runBatchUpload, runEviction, runReleaseSpace, scanReferences } from "./maintenance/run";
import { formatMegabytes } from "./maintenance/eviction";
import { planReleaseSpace } from "./maintenance/release-space";
import type { ReleaseSpaceSelection } from "./maintenance/release-space";
import { canvasTextTargets, keysInText } from "./maintenance/references";
import { describeError } from "./error-text";
import type { MaintenanceDeps } from "./maintenance/run";
import { createCacheRotator } from "./maintenance/rotation";
import type { CacheRotator } from "./maintenance/rotation";
import {
	selectExternalUploadCandidates,
	selectUploadCandidates,
} from "./maintenance/batch";
import { listAllObjects, runCloudCleanup, selectCleanupCandidates } from "./maintenance/cloud-cleanup";
import type { CloudCleanupResult } from "./maintenance/cloud-cleanup";
import { externalKeysOf, referencedKeysFromUrls } from "./maintenance/cloud-cleanup";
import { sha256Hex } from "./s3/hash";
import { createAttachWatcher, createSelfWriteLedger } from "./maintenance/attach-watch";
import type { AttachWatcher } from "./maintenance/attach-watch";
import { askOrphanCloudDelete } from "./ui/cloud-delete-modal";
import { createOrphanWatcher, planOrphanLocalRemoval, selectOrphanAsks } from "./maintenance/orphan-watch";
import type { NoteKind, OrphanLocalTarget, OrphanWatcher } from "./maintenance/orphan-watch";
import { removeOrphanCopies } from "./maintenance/orphan-removal";
import { deleteLogTargetPath, recordDeletions } from "./maintenance/delete-log";
import type { DeletedObjectRecord } from "./maintenance/delete-log";
import { CONFIRM_IMMEDIATELY, createAbsenceConfirmer, runSelfHeal } from "./maintenance/self-heal";
import type { SelfHealResult } from "./maintenance/self-heal";

import type { ExternalCandidate } from "./maintenance/batch";
import { ingestAttachment } from "./core/ingest";
import { confirmWithModal } from "./ui/confirm-modal";
import type { ConfirmOptions } from "./ui/confirm-modal";
import { planFileCards } from "./ui/file-cards";
import { displayNameForKey } from "./object-key";
import type { FileCard, FileCardInput } from "./ui/file-cards";
import { keyFromUrl } from "./render/render-target";
import { createS3Client } from "./s3/client";
import type { S3Client } from "./s3/client";
import { connectionReadiness, parseCredentialFile } from "./s3/credentials";
import type { CredentialFileProblem } from "./s3/credentials";
import { ensureSecretSlot, randomSlotPart } from "./ui/settings-logic";
import { createLocalCopyEnsurer } from "./core/download";
import {
	keyOfUrl,
	readActiveNoteText,
	readAllNoteTexts,
	referencedVaultPaths,
	remoteUrlForKey,
	resourceUrlFor,
	vaultPathExists,
} from "./plugin/notes-query";
import type { LocalCopyOutcome } from "./core/download";
import { installImageSrcPatch, processImages } from "./render/render-hook";
import { createEmbedRebuildQueue, processEmbeds } from "./render/embed-rebuild";
import type { EmbedRebuildDeps, EmbedRebuildQueue } from "./render/embed-rebuild";
import { notePathForElement } from "./render/external-live";
import type { ImageElementLike, RenderHookDeps } from "./render/render-hook";
import { createExternalHook } from "./render/external-hook";
import type { ExternalHook } from "./render/external-hook";
import { createExternalLiveQueue } from "./render/external-live";
import type { ExternalLiveQueue, OpenViewLike } from "./render/external-live";
import { createExternalCacher } from "./core/external-cache";
import { pickExternalImagesWithModal } from "./ui/external-picker-modal";
import type { ExternalCandidateLoader } from "./ui/external-picker-modal";
import type { ExternalPickItem, ExternalPickScope } from "./ui/external-picker-logic";

/**
 * 启动后延迟多久做第一次缓存上限检查。
 *
 * 延迟是刻意的：超限时那一轮要列缓存目录、还要扫全库笔记（判断哪些副本还被人引用），
 * 直接放在 `onload` 里会让"打开 Obsidian"变慢。3 秒足够让界面先出来。
 */
const ROTATION_STARTUP_DELAY_MS = 3 * 1000;

/**
 * 周期性兜底检查的间隔。
 *
 * ⚠️ 间隔短不会造成持续 I/O：每一轮先走**便宜的门槛**（索引里的字节求和，
 * 纯内存），没超就立刻返回。真正昂贵的部分（列目录、扫笔记）只在超限时才发生，
 * 而且还有一层分钟级节流。
 */
const ROTATION_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 索引自愈的启动延迟。
 *
 * ⚠️ 比轮换那一次（3 秒）**更晚**：自愈不是"必须马上做"的事，而启动后那几百毫秒里
 * 还有索引加载、渲染钩子挂载、引用快照建立等等要做完 —— 排它们后面，
 * 免得抢同一段启动窗口。
 */
const SELF_HEAL_STARTUP_DELAY_MS = 8 * 1000;

/**
 * 索引自愈的周期兜底间隔。
 *
 * ⚠️ 这一条是"**两轮确认**"能成立的前提（见 `createAbsenceConfirmer`）：
 * 启动那轮只标记"这次不在"，要等到**下一轮**仍不在才摘。
 * 间隔取 10 分钟与轮换同频 —— 一轮本身几乎零成本（常态下只是查宿主的内存索引），
 * 而会话短于一个间隔时最多"晚一轮修"，不再有任何正确性代价。
 */
const SELF_HEAL_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** 引用重算的防抖窗口。编辑途中宿主的自动保存会反复触发 `modify`。 */
const ORPHAN_CHECK_DEBOUNCE_MS = 1500;

/**
 * 询问的防抖窗口。
 *
 * 它比上面那个**更长**：一次编辑可能连着让好几个对象变成孤儿（删掉一段带三张图的文字），
 * 而"一次整理"里用户可能连着删好几次 —— 攒在一起只问一次，比连着弹三次礼貌得多。
 */
const ORPHAN_ASK_DEBOUNCE_MS = 4000;

/**
 * 询问框里最多列出几个对象（再多就只报数量）。
 *
 * ⚠️ 上限影响的是**展示**，不是判定：判定永远跑完整份清单。
 * 每一行现在都带一张缩略图，所以这个数也是"最多同时加载几张图"。
 */
const ORPHAN_LIST_MAX = 8;

/** 同上，给「清理云端未使用对象」那条命令的确认框用（对象可能很多，列少一点）。 */
const CLOUD_CLEANUP_LIST_MAX = 10;

/** 同上，给「清理本地占用」（F18）的确认框用。 */
const RELEASE_SPACE_LIST_MAX = 10;

/**
 * 这篇文件是不是"引用的来源"（只监视笔记与画布）。
 *
 * ⚠️ 只认扩展名，不读内容：`modify` 事件很频繁，这里必须便宜。
 * 认错方向的代价只是"多读一次文件"，而漏认的代价是"孤儿问不出来" ⇒ 宁可多认。
 */
function noteKindOf(file: unknown): NoteKind | null {
	if (!(file instanceof TFile)) return null;
	if (file.extension === "md") return "md";
	if (file.extension === "canvas") return "canvas";
	return null;
}

/**
 * 导入一份凭据文件的结果。
 *
 * ⚠️ **不含秘密值**，只含"改了哪几项" —— 于是它可以被日志、通知、真机探针随便打印，
 * 而不会把密钥漏到任何地方去。
 */
export type ImportCredentialsOutcome =
	| {
			ok: true;
			/** 这次**真的改了**的设置项，值是**文案键**（界面负责翻译）。 */
			applied: string[];
			/** 文件里有、但本插件用不上的键（如 MinIO 的 `api`）。 */
			ignored: string[];
	  }
	| {
			ok: false;
			/**
			 * `secretStoreFailed` 是**这一步**特有的失败：文件本身没问题，
			 * 只是钥匙串写不进去（宿主实现差异、被锁）。它与"这份文件认不出来"
			 * 是两件该给不同提示的事 —— 前者的修法不是"换一份文件"。
			 */
			problem: CredentialFileProblem | "secretStoreFailed";
			/** 仅 `secretStoreFailed` 时有值：宿主给的原始错误（可能很长，界面自己截）。 */
			detail?: string;
	  };

export default class AttachmentCloudCachePlugin extends Plugin {
	settings: PluginSettings = { ...SETTINGS_DEFAULTS };
	locale = "en";

	/**
	 * 这份 `data.json` 里带着**已被取消的 key 模板**（1.2.0），且我们已经清理过它。
	 *
	 * 只在 `loadSettings` 里置位，等文案语种与界面都就绪之后再告诉用户 ——
	 * 提示要等他看得懂、而不是在插件还在启动时闪一下。
	 */
	private legacyKeyTemplateUpgraded = false;

	/**
	 * 这次启动有没有把旧的两档「遇到站外文件链接时」折进那个开关（1.2.0）。
	 *
	 * 存折算**结果**（自动处理到底开没开）而不是一个布尔：提示文案要说清"你原来的
	 * 选择被保留成了哪个状态"，否则开关显示为关的用户会以为插件擅自把他的功能关了。
	 */
	private legacyExternalModeMerged: { auto: boolean } | null = null;

	/**
	 * 上一拍「本地副本」是哪一档 —— 只为了认出**用户刚切到「不留副本」**那一刻。
	 *
	 * ⚠️ F18（2026-10-12，D-19）的询问挂在"切换"这个**动作**上，不是挂在"当前值是 trash"上：
	 * 后者每次保存设置都会问一遍（用户改任何一个字段都被问），那是骚扰。
	 * 只在 `loadSettings` 里初始化，于是"启动时就已经是这一档"的老用户**不会**被问
	 * —— 他想清就自己去设置页点那个按钮。
	 */
	private lastLocalCopyAction?: LocalCopyAction;

	/** 索引的读写（含串行化落盘）。`onload` 里初始化。 */
	private indexStore: ReturnType<typeof createIndexStore> | null = null;

	/**
	 * 补齐器（回退下载）。**必须是稳定的一份**：它的并发去重表挂在闭包里，
	 * 每次新建就等于没有去重 —— 一屏里同一张图会被下载 N 次。
	 *
	 * `sourcePath` = 触发这次渲染的笔记；用来推"附件落在哪个目录"
	 * （宿主的 `attachmentFolderPath` 取 `./` 时 = 与那篇笔记同目录）。
	 */
	private ensureLocalCopy: (
		key: string,
		remoteUrl: string,
		sourcePath?: string | null
	) => Promise<LocalCopyOutcome> = async () => ({
		status: "failed",
		key: "",
		localPath: "",
	});

	/**
	 * 落盘队列。索引自己的写入已经在 `createIndexStore` 里串行化了，
	 * 这一条是给其它将来要写盘的模块复用的 —— 两条队列分开会让
	 * "不同数据的写入互相插队"重新变成可能，而症状同样是难查的。
	 */
	private readonly serialize = makeSerializer();

	/**
	 * 后台自愈的"两轮确认"状态（见 `createAbsenceConfirmer`）。
	 *
	 * ⚠️ 必须是**稳定的一份**：它靠跨轮累积来判断"上一轮也不在"，每次现造就等于没有确认。
	 * 状态在进程内 —— 重启即重置，代价只是"再确认一轮"（安全方向）。
	 */
	private readonly absenceConfirmer = createAbsenceConfirmer();

	/** 站外缓存的编排。**必须是稳定的一份** —— 去重表挂在它的闭包里。 */
	private externalHook: ExternalHook | null = null;

	/**
	 * 实时预览下的站外图：`src` 拦截上报候选 → 攒批 → 延后解析归属 → 交给上面那份编排。
	 *
	 * ⚠️ 必须是**稳定的一份**：待处理的那批挂在上面的闭包里。
	 * 而且不能省 —— 后处理器**在实时预览下不跑**（真机实测 0 次），
	 * 少了这条，编辑态里「缓存站外图片」就完全没有反应。
	 */
	private externalLive: ExternalLiveQueue | null = null;

	/** 缓存上限的自动轮换。同上：节流与并发标志挂在它的闭包里。 */
	private rotation: CacheRotator | null = null;

	/**
	 * 「库里新增的附件」那条入口（第三条）。
	 *
	 * ⚠️ 必须是**稳定的一份**：攒批与重试时刻表挂在它的闭包里，每次新建等于
	 * 把"还没等到引用的那几个文件"丢掉。
	 */
	private attachWatch: AttachWatcher | null = null;

	/**
	 * 「某个已上传对象失去最后一个引用」（= 出现孤儿）那条入口。
	 *
	 * ⚠️ 必须是**稳定的一份**：每篇笔记的引用快照与全局引用计数挂在它的闭包里 ——
	 * 每次新建就等于把"哪篇笔记引用过什么"全忘掉，于是**谁都不会再变成孤儿**。
	 */
	private orphanWatch: OrphanWatcher | null = null;

	/** 本会话里已经问过的孤儿 key（冷却：问过就不再打扰）。 */
	private orphanAsked = new Set<string>();

	/** 待询问的孤儿（一次编辑可能删掉好几条引用 ⇒ 攒成一批只问一次）。 */
	private orphanPending = new Set<string>();

	/**
	 * 引用重算的防抖（编辑途中，宿主的自动保存会反复触发 `modify`）。
	 *
	 * ⚠️ 类型是 `number` 而不是 `ReturnType<typeof setTimeout>`：这里排的定时器一律走
	 * `window.setTimeout`（弹出窗口里裸 `setTimeout` 不是同一个），而浏览器侧的返回值是数字。
	 */
	private orphanCheckTimer: number | null = null;

	/** 询问的防抖（把同一小段时间里出现的孤儿攒到一起）。理由同上。 */
	private orphanAskTimer: number | null = null;

	/**
	 * 我们自己刚落盘的中转文件（`stageLocally` 上报，见 `SelfWriteLedger`）。
	 *
	 * 存在的理由：粘贴那条路的"先落盘再上传"与自动接管共用 `vault.on("create")`。
	 * 台账的作用是让后者认出"这是自己刚写的"，别去重复接管。
	 */
	private readonly stagedPaths = createSelfWriteLedger();

	/**
	 * 「选择要缓存的外链图片」那个弹窗的接缝。
	 *
	 * ⚠️ 默认是**真弹窗**；入口验收测试会覆写它（真弹窗在测试里点不了）。
	 * 这条接缝是这条链路唯一能被端到端驱动的地方 —— 没有它，
	 * "用户勾了几张之后到底发生了什么"就只能靠单元套件间接推断。
	 */
	pickExternalImages: (
		load: ExternalCandidateLoader
	) => Promise<ExternalPickItem[] | null> = (load) =>
		pickExternalImagesWithModal(this.app, load, {
			title: this.t("externalPickTitle"),
			scopeName: this.t("externalPickScope"),
			scopeNote: this.t("externalPickScopeNote"),
			scopeVault: this.t("externalPickScopeVault"),
			empty: this.t("externalPickEmpty"),
			selectAll: this.t("externalPickAll"),
			selectNone: this.t("externalPickNone"),
			cta: this.t("externalPickCta"),
			cancel: this.t("externalPickCancel"),
		});

	async onload(): Promise<void> {
		await this.loadSettings();
		// ⚠️ 语种要在**注册设置页之前**定下来 —— 设置页在 `display()` 里取文案，
		// 若此时 locale 还是初始的 "en"，中文用户第一次打开会看到英文界面。
		this.locale = detectLocale(getLanguage());

		this.addSettingTab(new SettingsTab(this.app, this));

		await this.loadCacheIndex();

		// 粘贴与拖拽注册在这两个事件上（`@since 1.1.0`），而不是 document 上的 DOM 事件：
		// 宿主会把 `Editor` 直接递过来，不必自己判断"哪个编辑器有焦点"，
		// 也不用猜移动端的事件路径是否一致。
		// `registerEvent` 让宿主在卸载时自动注销 —— 手动 `offref` 迟早会漏掉一条。
		const handlers = createEditorHandlers({
			host: this.hostContext(),
			onError: (error) => {
				// 这里只留技术细节（原始 message 可能很长，不适合弹窗）；
				// 用户可见的交代由 handler 内部的 notify 负责。
				console.error("[attachment-cloud-cache] 上传流程出现未预期的错误", error);
			},
		});
		this.registerEvent(this.app.workspace.on("editor-paste", handlers.onPaste));
		this.registerEvent(this.app.workspace.on("editor-drop", handlers.onDrop));

		// ── 第三条入口：**库里新增的文件** ──
		//
		// 上面两条是"用户在编辑器里主动放东西"。而手机上把图片加进笔记走的是**另一条路**：
		// 底部工具栏的回形针执行宿主自己的 `editor:attach-file`，它的实现（1.14 字节码实测）是
		// `app.saveAttachment`（内部 `vault.createBinary`）+ `generateMarkdownLink` + `replaceSelection`
		// —— 文件**先落进库里**、链接**随后**才写进笔记，全程**没有粘贴/拖拽事件**。
		// 于是用户报的"手机上添加图片附件不会自动上传"不是回归，而是 R2 从来没覆盖过的入口。
		//
		// 为什么用 `vault.on("create")` 而不是去猜"哪个平台、哪个按钮"：上面那三个宿主 API
		// 是**全平台同一份实现**，所以"库内出现了一个新文件"是与平台无关的观察点，
		// 顺带把分享菜单、桌面把文件拷进库这些入口一起覆盖了（附录 A：不做平台分支）。
		//
		// ⚠️ 接管有硬前提：**文件必须已经被某篇笔记引用**（引用会被同一趟改写成远端地址）。
		// 而宿主的链接是文件落盘**之后**才插进笔记的，所以这里不能立刻动手 ——
		// 退避重试与攒批都在 `attach-watch` 里。
		//
		// ⭐ 1.2.0（D-17）：判"这个新文件是不是我们自己的副本"不再靠**缓存目录**
		// （那层目录取消了），改由三重簿记：自写台账 → 索引路径 → 内容哈希在台账里。
		this.attachWatch = createAttachWatcher({
			autoUpload: () => this.settings.autoUpload,
			isSelfWrite: (path) => this.stagedPaths.has(path),
			// ③ 内容哈希 ∈ 上传台账 —— 同步到达的副本靠它一眼认出（不必等满退避窗口）
			isKnownCloudCopy: (path) => this.isKnownCloudCopy(path),
			index: () => this.currentIndex(),
			settings: () => this.settings,
			// 每次现查（文件可能已经被别的流程搬走/删掉）—— 与 `TFile` 的形状解耦
			lookup: (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				return { path: file.path, extension: file.extension, stat: { size: file.stat?.size ?? 0 } };
			},
			referencedPaths: () => referencedVaultPaths(this.app),
			adopt: async (paths) => {
				// 存储没就绪时**什么都不做**，只把"去哪配"说清楚 —— 与粘贴那条路的口径一致：
				// 不拦用户、不假装成功，也绝不留下半个动作（文件原地不动、笔记一个字不改）。
				const readiness = connectionReadiness(this.app.secretStorage, this.settings);
				if (!readiness.ready) {
					new Notice(
						this.t("hookNotConfigured", {
							problem: readiness.problem,
							where: this.t(readiness.fixIn === "credentials" ? "hookFixCredentials" : "hookFixConnection"),
						})
					);
					return { uploaded: 0, reused: 0, failed: 0, linksRewritten: 0 };
				}
				// 复用批量那一趟（`referencedPaths` 只放这一个文件 ⇒ 候选也只有它）：
				// 于是"上传 → 搬入缓存 → 改写引用（含画布）"只有一份实现。
				return runBatchUpload(this.maintenanceDeps(), { referencedPaths: new Set(paths) });
			},
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			log: (message) => console.debug(`[attachment-cloud-cache] ${message}`),
		});
		this.registerEvent(this.app.vault.on("create", (file) => this.attachWatch?.onCreated(file)));

		this.ensureLocalCopy = createLocalCopyEnsurer({
			app: this.app,
			settings: () => this.settings,
			// ⚠️ 回退下载写下的文件同样会触发 `create`：写**之前**登记同一本自写台账，
			// 否则自动接管那条链会把它当成"用户新加的附件"再上传一遍。
			onStaged: (path) => this.stagedPaths.note(path),
			// 每次现造：用户可能刚在设置页改完/选好密钥，抓快照会让"改了不生效"
			// 以最难查的形式出现。拿不到客户端时返回 null（未配置 → 静默不下载）。
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		});

		// ── 站外图：按设置里的默认行为处理（默认什么都不做），也可以由用户在
		//    「选择要缓存的外链图片」里逐张勾选 ──
		//
		// ⚠️ 这里是全库**唯一**会下载"别人的图"、也是唯一会**改写用户笔记**的链路。
		// 它的前置条件是"用户的显式动作"（把默认值改成「直接缓存」，或者在弹窗里勾中），
		// 执行层还会再复核一次（功能可能在两者之间被关掉）。
		const cacheExternalImage = createExternalCacher({
			app: this.app,
			settings: () => this.settings,
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		});

		// ⚠️ 稳定单例：那张"正在下载/上传的 URL"表挂在它的闭包里。
		// 每次渲染新建一份 = 没有去重 = 同一张图会被反复下载上传
		//（渲染会因滚动、切视图而反复发生）。
		this.externalHook = createExternalHook({
			settings: () => this.settings,
			// 同步算：判定层是同步的，而一次渲染里只算一次
			configured: () => connectionReadiness(this.app.secretStorage, this.settings).ready,
			cache: (url, notePath) => cacheExternalImage(url, notePath),
			onError: (error) => console.error("[attachment-cloud-cache] 站外图片处理出错", error),
		});

		// ⚠️ 后处理器**在实时预览（编辑态）下根本不跑**（真机实测：同一篇笔记
		// 阅读视图触发 5 次、编辑态 0 次），而编辑态是用户待得最久的地方 ——
		// 少了这条，站外图在编辑态里完全没有反应。
		//
		// 候选从 `src` 拦截里来（那条路能收到编辑器造的每一张图），
		// 而"这张图属于哪篇笔记"必须**等元素进了 DOM** 之后才问得出来（也是实测的）。
		this.externalLive = createExternalLiveQueue({
			openViews: () => this.openNoteViews(),
			handle: (element, notePath) => {
				// 复用同一个编排（含那张去重表）：容器只有这一个元素。
				// 于是"这个 URL 正在处理"在两条路径之间是**共享**的 ——
				// 同一个地址不会因为在编辑态和阅读态各渲染一次而被下载两遍。
				this.externalHook?.process({ querySelectorAll: () => [element] }, { sourcePath: notePath });
			},
			onError: (error) => console.error("[attachment-cloud-cache] 站外图片（实时预览）处理出错", error),
		});
		this.register(() => this.externalLive?.dispose());

		// ── 缓存上限：后台自动轮换（超限时淘汰最久没用过的副本） ──
		//
		// 默认**不限制**（`cacheLimitMb: 0`），此时这一整条链路连一次 I/O 都不会做。
		this.rotation = createCacheRotator({
			settings: () => this.settings,
			index: () => this.currentIndex(),
			// ⭐ 1.2.0：候选与统计**一律来自索引**（缓存目录已经不在了）。
			// 存在性用宿主的文件索引回答 —— 它可能滞后，而滞后只会让这一轮少淘汰几个。
			isPresent: (path) => Boolean(this.app.vault.getAbstractFileByPath(path)),
			// 扫引用这条仍然复用维护功能那一份实现（只此一处）
			scanReferencedKeys: async () => (await scanReferences(this.app, (url) => keyOfUrl(this.settings, url))).keys,
			evict: (plan) => runEviction(this.maintenanceDeps(), plan),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			onError: (error) => console.error("[attachment-cloud-cache] 缓存轮换出错", error),
		});

		// 触发 ①：启动后延迟一次。**延迟**是刻意的 —— 超限时这一轮要列目录、
		// 扫全库笔记，不能挡在插件加载路径上。
		const startupTimer = window.setTimeout(() => {
			void this.rotation?.maybeRotate("startup");
		}, ROTATION_STARTUP_DELAY_MS);
		this.register(() => window.clearTimeout(startupTimer));

		// 触发 ②：周期性兜底。这一轮先走**便宜的门槛**（内存里求和），
		// 没超就直接返回 —— 所以间隔短也不会造成持续 I/O。
		const intervalTimer = window.setInterval(() => {
			void this.rotation?.maybeRotate("interval");
		}, ROTATION_CHECK_INTERVAL_MS);
		this.register(() => window.clearInterval(intervalTimer));

		// 触发 ③（2026-10-11 新增、2026-10-12 扩成两条线）：**索引自愈**。
		//
		// 为什么要有它：索引是**派生数据**，它指向的副本随时可能消失（同步漏了一个文件、
		// `keep` 档下用户自己整理了附件目录、外部工具先删后写）。留着一条指向不存在文件的
		// 记录会让**占用统计偏高**，并让下次看到那张图时白下载一次。
		// 而"让用户手动跑一条命令来修插件自己的账本"，是把内部维护成本转嫁给用户。
		//
		// ⚠️ 它**只改索引，绝不碰任何文件**（见 `maintenance/self-heal.ts` 的纪律）。
		// ⚠️ 正确性**不**依赖它，别再把"必须在某时刻前修完"当成前提：
		//    渲染遇到缺失副本会自己去取回并回写记录；而"统计偏高会导致多删"已由淘汰侧
		//    只按**存在的**副本来求和兜住（`eviction.ts`）。
		const selfHealTimer = window.setTimeout(() => {
			void this.runIndexSelfHeal();
		}, SELF_HEAL_STARTUP_DELAY_MS);
		this.register(() => window.clearTimeout(selfHealTimer));

		// 触发 ④：**周期性**兜底。这一条也是"两轮确认"能成立的前提 ——
		// 启动那轮只标记"这次不在"，要等到下一轮仍不在才摘（见 `createAbsenceConfirmer`）。
		// 一轮几乎零成本（常态下只是查宿主的内存索引），所以间隔短不心疼。
		const selfHealIntervalTimer = window.setInterval(() => {
			void this.runIndexSelfHeal();
		}, SELF_HEAL_CHECK_INTERVAL_MS);
		this.register(() => window.clearInterval(selfHealIntervalTimer));

		// 重建节点时用的子 Component：挂进插件生命周期，卸载时一并清掉。
		this.addChild(this.embedComponent);

		// ── 渲染：把属于本存储的图换成本地副本（离线可用的落点）──
		//
		// 两条路径缺一不可：阅读视图（后处理器）与实时预览（setter 拦截）。
		// 只做前者，用户在离线时编辑笔记会看到满屏破图；只做后者，导出与阅读模式不受益。
		//
		// 站外图的判定与缓存也挂在这条路径上（第二个参数 `ctx.sourcePath` 是
		// "该改哪篇笔记"的唯一权威来源 —— 没有它就没法改写，链路也就没有意义）。
		this.registerMarkdownPostProcessor((element, ctx) => {
			// ⚠️ 这里**同步**完成，不 await —— 一旦 await，元素可能已连上 DOM
			// 并开始加载远端图片，"零请求"就不成立了。理由见 render-hook 的头注释。
			processImages(element, this.renderDeps(ctx.sourcePath));
			// 非图片的可预览附件（音频/视频/PDF）：宿主把它们渲染成了 `<img>`，
			// 改 `src` 救不了，只能重建节点（见 render/embed-rebuild.ts）。
			processEmbeds(element, this.embedDeps(ctx.sourcePath), ctx.sourcePath, this.embedQueue());
			// 站外图：判定是同步的，真正的下载/上传是 fire-and-forget。
			this.externalHook?.process(element, ctx);
		});

		const uninstallSrcPatch = installImageSrcPatch(
			{
				...this.renderDeps(),
				// 站外候选只从**这条路**上报：阅读视图那边的外站图由上面的后处理器
				// 整批交给编排（那里天然带着 `ctx.sourcePath`，不需要延后解析归属）。
				onExternalSrc: (element) => this.externalLive?.see(element),
				// 实时预览：非图片 ⇒ 不写 `src`，把元素交给重建队列
				onNonImageEmbed: (element, localPath) => this.embedQueue().see(element, localPath, null),
			},
			{
				view: typeof window === "undefined" ? null : window,
				log: (error) => console.error("[attachment-cloud-cache] 改写图片地址时出错", error),
			}
		);
		// 卸载时把原 setter 放回去 —— 插件卸载后还在改全局 prototype 是最典型的
		// "卸载不干净"，而且症状出现在**别的插件**身上，极难归因。
		this.register(() => uninstallSrcPatch());

		// ── 云端空间清理（F15 / 需求 R17）──
		//
		// ⭐ 入口：**某个已上传对象失去最后一个引用**（= 出现孤儿）时，问一次要不要连云端一起清。
		//
		// 为什么不是"用户删掉那个文件时问"（上一版的落地方式）：用户在 Obsidian 里表达
		// "我不要这张图了"几乎总是**删掉笔记里的引用**（或删掉整篇笔记）—— 两者都不删文件；
		// 而默认档（移入缓存目录）下那个附件文件根本不在附件目录里（上传时就被搬走了）
		// ⇒ 挂在"删文件"上的询问，默认配置下**一次都不会出现**（详细设计 §13.1）。
		this.orphanWatch = createOrphanWatcher({
			listNotes: () => {
				const notes: Array<{ path: string; kind: NoteKind }> = [];
				for (const file of this.app.vault.getFiles()) {
					const kind = noteKindOf(file);
					if (kind) notes.push({ path: file.path, kind });
				}
				return notes;
			},
			readText: async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file || !(file instanceof TFile)) throw new Error(`不是文件：${path}`);
				return await this.app.vault.cachedRead(file);
			},
			extractKeys: (kind, text) => this.extractStoredKeys(kind, text),
			onError: (error) => {
				// 读不到某一篇只是"这一篇这一趟没算进来"，下一轮事件会重新算它
				console.error("[attachment-cloud-cache] 建立引用快照时读文件失败", error);
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const kind = noteKindOf(file);
				if (kind) this.scheduleOrphanCheck(file.path, kind);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				// ⭐ 新建的笔记/画布也要**立刻登记**进快照。
				//
				// ⚠️ 这一条是真机探针查出来的：原先只监听 `modify` 时，一篇**新建**的笔记
				// （例如用户刚写好、里面贴了引用）在快照里还不存在 —— 于是它**第一次内容变化**
				// 被当成"第一次见到这篇"（只登记、不判定），那一刻的引用消失被**丢掉**。
				// 症状是"新建笔记里删掉一张图的引用，不问"（老笔记正常）。
				// 登记本身不会产出孤儿（`apply` 对没有旧快照的路径返回空），所以这一条是安全的。
				const kind = noteKindOf(file);
				if (kind) this.scheduleOrphanCheck(file.path, kind);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				// 删整篇笔记也会让它引用过的图失去引用（缓存副本之类的路径从来不在快照里）
				this.handleNoteRemoved(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// 快照跟着搬：改名不是"引用消失"，计数不变
				this.orphanWatch?.noteRenamed(oldPath, file.path);
				// ⭐ 索引也跟着搬（附件被移动 / 改名）。
				//
				// 不做会怎样：那份副本还在磁盘上，但索引指着旧路径 ⇒ 下次渲染判定"本地没有副本"
				// ⇒ 按**附件目录里的原名**重新下载一份 ⇒ 用户库里多出一份重复文件。
				// ⚠️ 宿主的 `rename` 给了 `旧 → 新`，所以这不是猜（与 `resolvedLinks` 那次不同）。
				// ⚠️ **静默**：这不算"修好了什么"，只是把账本搬到新地址 —— 不打扰用户。
				// ⚠️ 目录改名时子文件路径也要跟着搬（`includeDescendants`）。
				const moved = this.currentIndex().moveCachePath(oldPath, file.path, {
					includeDescendants: file instanceof TFolder,
				});
				if (moved > 0) {
					void this.hostContext()
						.persistIndex()
						.catch((error) => {
							// 落盘失败不阻塞：索引在内存里已经对了，下次任意一次保存会把它写下去。
							console.error("[attachment-cloud-cache] 索引跟随改名落盘失败", error);
						});
				}
			})
		);
		// 快照在布局就绪后建立（那时文件已可读），且**不阻塞启动**
		this.app.workspace.onLayoutReady(() => {
			void this.warmUpOrphanWatch();

			// ⭐ 一次性兼容升级的**告知**（1.2.0）：`loadSettings` 已经把遗留的 key 模板
			// 从 `data.json` 里清掉了，但用户得知道"之后上传的对象命名变了"。
			// 放在这里而不是 `onload` 里：那时语种与界面都就绪，提示不会被启动过程吞掉。
			if (this.legacyKeyTemplateUpgraded) {
				this.legacyKeyTemplateUpgraded = false;
				new Notice(this.t("legacyKeyTemplateUpgraded"));
			}

			// ⭐ 同上（1.2.0）：告诉用户"那一档去哪了" —— 尤其是原来选「什么都不做」的人，
			// 他会看到那个开关现在是**关**的；不说一声就像插件擅自关掉了他的功能。
			if (this.legacyExternalModeMerged) {
				const { auto } = this.legacyExternalModeMerged;
				this.legacyExternalModeMerged = null;
				new Notice(
					this.t("legacyExternalDefaultMerged", {
						state: this.t(auto ? "legacyExternalKeptOn" : "legacyExternalKeptOff"),
					})
				);
			}
		});

		this.registerMaintenanceCommands();
	}

	/**
	 * 注册维护命令（P1 #8/#9/#10）。
	 *
	 * ⚠️ 破坏性命令（清理缓存）**必须先出确认框**，而且要写清"删几个、占多少空间"。
	 * 一条"确定要清理吗"等于让用户闭着眼睛按确认。
	 */
	private registerMaintenanceCommands(): void {
		this.addCommand({
			id: "audit-cache",
			name: this.t("cmdAuditCache"),
			callback: () => void this.reportCacheUsage(),
		});

		this.addCommand({
			id: "cleanup-cloud",
			name: this.t("cmdCleanupCloud"),
			callback: () => void this.cleanupCloudObjects(),
		});

		this.addCommand({
			id: "repair-index",
			name: this.t("cmdRepairIndex"),
			callback: () => void this.repairIndex(),
		});

		this.addCommand({
			id: "upload-attachments",
			name: this.t("cmdUploadAttachments"),
			callback: () => void this.uploadExistingAttachments(),
		});

		// ⭐ 逐张挑选要缓存的外链图。
		//
		// 与上面那条命令的分工：那条是"把还没搬的全搬"，这条是"我只要这几张"。
		// 两者与设置里的默认行为**都不冲突** —— 显式动作用的是"能不能搬"那个判据，
		// 不受"默认动不动手"影响（否则默认设成「什么都不做」之后这两个入口都会空转）。
		this.addCommand({
			id: "pick-external-images",
			name: this.t("cmdPickExternal"),
			callback: () => void this.cachePickedExternalImages(),
		});
	}

	/**
	 * **云端清理入口**：某个已上传对象**失去最后一个引用**（= 出现孤儿）时问用户一次。
	 *
	 * ## 为什么不是"用户删掉那个文件时问"（上一版的落地方式）
	 *
	 * 那个动作选错了：用户在 Obsidian 里表达"我不要这张图了"几乎总是**删掉笔记里的引用**
	 *（或删掉整篇笔记）—— 两者都**不删文件**；而默认档（移入缓存目录）下那个附件文件
	 * 根本不在附件目录里（上传时就被搬进缓存目录了）。⇒ 挂在"删文件"上的询问，
	 * 默认配置下**一次都不会出现**（详细设计 §13.1）。
	 *
	 * ## 判定链
	 *
	 * 1. `orphan-watch` 维护"每篇笔记引用了哪些对象"的快照，某个 key 的引用数归零 ⇒ 候选；
	 * 2. 筛掉**不是我们上传的**（索引里没有记录 —— 对别人的对象我们没有任何处置权）；
	 * 3. 筛掉**本会话已经问过的**（冷却：用户做过选择就不再追着问）；
	 * 4. 攒批后**只弹一次**（一次编辑可能删掉好几条引用）。
	 *
	 * ## ⚠️ 两条必须如实告知（需求 R17 的纪律）
	 *
	 * - **云端删除不可恢复**；
	 * - **多设备盲区**：只看得到本设备的引用，别的设备/别的 vault 可能仍在用同一个对象。
	 *
	 * 而且默认是**保留**（主按钮），删除是破坏性样式 —— 这个弹窗会自动出现，
	 * 顺手按回车的代价在两个方向上并不对等。
	 */
	private scheduleOrphanCheck(path: string, kind: NoteKind): void {
		// ⚠️ 一律用 `window.setTimeout`（弹出窗口里裸 `setTimeout` 不是同一个定时器 ——
		// 与 `core/external-cache.ts`、`host/runtime.ts` 同一条理由，别处漏写会被 lint 报出来）。
		if (this.orphanCheckTimer) window.clearTimeout(this.orphanCheckTimer);
		this.orphanCheckTimer = window.setTimeout(() => {
			this.orphanCheckTimer = null;
			void this.checkOrphans(path, kind);
		}, ORPHAN_CHECK_DEBOUNCE_MS);
	}

	/** 重算**这一篇**的引用，看有没有对象因此变成孤儿（只扫一篇，不是全库）。 */
	private async checkOrphans(path: string, kind: NoteKind): Promise<void> {
		const watcher = this.orphanWatch;
		if (!watcher) return;

		const file = this.app.vault.getAbstractFileByPath(path);
		// 文件可能刚被删/改名 ⇒ 那不是"内容变了"（删除与改名各有自己的事件）
		if (!file || !(file instanceof TFile)) return;

		let text: string;
		try {
			// 用 `read`（真实读取）而不是 `cachedRead`：后者读宿主的文本缓存，
			// 而"缓存有没有跟上刚才那次修改"是**额外的一个时序假设**。
			// ⚠️ 如实记：真机上**没有**观察到它滞后（探针的诊断显示快照被正确更新）——
			// 所以这不是"修了一个 bug"，而是把假设去掉：这条链已经在防抖之后，
			// 每篇改动读一次磁盘的代价可以接受，而判错的代价是"该弹的框不弹"。
			text = await this.app.vault.read(file);
		} catch (error) {
			// 读不到就跳过这一轮（下一条事件会重算）。
			// ⚠️ **绝不能**因此当成"它没有引用了" —— 那会把仍在用的对象判成孤儿。
			console.error("[attachment-cloud-cache] 读笔记以统计引用失败", error);
			return;
		}
		this.collectOrphans(watcher.noteChanged(path, kind, text));
	}

	/** 文件被删（含删整篇笔记）：它引用过的对象都少了一个引用。 */
	private handleNoteRemoved(path: string): void {
		this.collectOrphans(this.orphanWatch?.noteRemoved(path) ?? []);
	}

	/**
	 * 引用快照的冷启动。放在布局就绪之后，**不阻塞启动**。
	 *
	 * ⚠️ 这一趟的语义是"第一次看到它们"，不是"引用变少了" —— 所以它**不会**弹任何询问
	 *（`orphan-watch` 的 `apply` 对没有旧快照的路径只登记、不判定）。
	 */
	private async warmUpOrphanWatch(): Promise<void> {
		try {
			await this.orphanWatch?.warmUp();
		} catch (error) {
			// 快照建不起来只是"这一趟不工作"，不该影响插件其余部分；
			// 之后任何一条编辑事件都会从那一篇开始重新建立。
			console.error("[attachment-cloud-cache] 建立引用快照失败", error);
		}
	}

	/** 攒批：一次编辑/一次删笔记可能让好几个对象同时成为孤儿 ⇒ 只问一次。 */
	private collectOrphans(keys: readonly string[]): void {
		if (keys.length === 0) return;
		for (const key of keys) this.orphanPending.add(key);
		if (this.orphanAskTimer) window.clearTimeout(this.orphanAskTimer);
		this.orphanAskTimer = window.setTimeout(() => {
			this.orphanAskTimer = null;
			void this.askAboutOrphans();
		}, ORPHAN_ASK_DEBOUNCE_MS);
	}

	/**
	 * 把攒下的孤儿筛一遍、问用户一次。
	 *
	 * ## ⭐ 一个孤儿占**两份**资源，所以询问是三档而不是"删 / 不删"
	 *
	 * 云端对象（删了**找不回来**）+ 本地副本（删掉只是"以后重新下载一次"）。
	 * 用户答"只删本地"时**一次网络写都不做** —— 这条路径存在的意义就是
	 * "让库小一点，但别动我的源文件"。
	 */
	private async askAboutOrphans(): Promise<void> {
		const pending = [...this.orphanPending];
		this.orphanPending.clear();
		if (pending.length === 0) return;

		// ⭐ 用户可以直接说"别主动告诉我"。这一档在**筛选之前**就返回：
		// 连扫一遍都省了，而且**没有任何信息丢失** —— 「清理云端未使用对象…」
		// 那条命令随时都能列出候选（它算的是"本库看不见引用的对象"，与这里无关）。
		const mode = this.settings.orphanAsk;
		if (mode === "never") return;

		const index = this.currentIndex();
		const selection = selectOrphanAsks(pending, {
			// ⭐ 判"是不是我们的"必须查**上传台账**，不能查"索引里有没有条目"：
			// 条目只管"本地副本在哪"，而「不留副本」那一档没有副本、按纪律不写条目
			// ⇒ 问条目会在那一档对**所有**对象答"不是我们的"，这个询问于是永不出现
			// （N11，与 P8 同一形状）。台账不看副本，三档都答得对。
			isOurs: (key) => index.wasUploaded(key),
			hasAsked: (key) => this.orphanAsked.has(key),
		});
		if (selection.asks.length === 0) return;

		// ⭐ 问过就记住，**无论用户怎么回答** —— 这是"不打扰"的底线
		//（他可能还在整理笔记，同一条引用被删掉的原因有很多种）
		for (const key of selection.asks) this.orphanAsked.add(key);

		// ⭐ `notice` 档：不弹窗，只给一条**不阻塞**的通知（并指路到命令）。
		// 它同样吃冷却 —— 通知反复冒出来，与弹窗一样烦人。
		if (mode === "notice") {
			new Notice(
				this.t("orphanNotice", {
					count: selection.asks.length,
					command: this.t("cmdCleanupCloud"),
				})
			);
			return;
		}

		// 存储没配好就**不问了**：这个弹窗的三个选项里有两个以"云端"为前提，
		// 而只有一个能成立时，问法本身是误导（"只删本地副本"那一档由 R17 的询问
		// 与 `cleanup-cloud` 承担，跟这里的三选一不是一件事）。
		const client = this.buildClient();
		if (!client) return;

		// ⭐ 清单给的是**图 + 名字**，不是一串 key：老 key 是 `<sha256>.<扩展名>`，
		// 用户看它认不出是哪张图，而这是不可恢复动作前**唯一能核对**的东西。
		// ⚠️ 名字的三个来源按序兜底：条目 sourceName → 从 key 反推（key 自带名字：`<名字>-<哈希>.<扩展名>`）
		// → 退化成 key 本身；图仍然是可核对的（有副本用副本，没有就用存储里的地址）。
		const cards = this.fileCards(
			selection.asks.map((key) => {
				const entry = index.get(key);
				// 「不留副本」档没有条目 ⇒ 从 key 反推（key 自带名字）
				return { id: key, name: entry?.sourceName || displayNameForKey(key), localPath: entry?.cachePath, remoteKey: key };
			}),
			ORPHAN_LIST_MAX
		);

		const choice = await askOrphanCloudDelete(this.app, {
			title: this.t("orphanTitle"),
			lines: [
				this.t("orphanBody", { count: selection.asks.length }),
				...(selection.asks.length > ORPHAN_LIST_MAX
					? [this.t("orphanMore", { count: selection.asks.length - ORPHAN_LIST_MAX })]
					: []),
				// ⚠️ 显著位置，两句缺一不可：
				// ① 各档的**可恢复性**（本地能回来、云端不能）—— 这是三个按钮的差别所在；
				// ② 多设备盲区（只能看到本设备的引用）。
				this.t("orphanLocalNote"),
				this.t("cloudCleanupDeviceBlindSpot"),
			],
			cards,
			keepCta: this.t("orphanKeep"),
			localCta: this.t("orphanLocalOnly"),
			bothCta: this.t("orphanBoth"),
		});
		if (choice === "keep") return;

		// ⚠️ 清单按**索引当时的记录**算（`planOrphanLocalRemoval` 是纯函数）。
		// 1.2.0（D-17）起删法只有一种（走回收站）：从前那条"在缓存目录里 ⇒ 直接删"的分支
		// 随缓存目录一起没了，而那份文件现在**同时可能就是用户的附件原件**。
		const localTargets = planOrphanLocalRemoval(selection.asks, {
			cachePathOf: (key) => this.currentIndex().get(key)?.cachePath,
		});

		// 先删云端（不可恢复的那一半先做：失败时下面那句提示会如实说明"云端对象未动"）
		let cloud: CloudCleanupResult | null = null;
		const logRecords: DeletedObjectRecord[] = [];
		if (choice === "both") {
			try {
				cloud = await runCloudCleanup(
					{
						client,
						index: () => this.currentIndex(),
						persistIndex: () => this.hostContext().persistIndex(),
						notify: (message) => new Notice(message),
						t: (key, params) => this.t(key, params),
						onRemoved: (record) => logRecords.push({ ...record, scope: "orphan" }),
					},
					selection.asks
				);
			} catch (error) {
				new Notice(this.t("cloudDeleteFailed", { error: describeError(error) }));
			}
		}
		// 留痕：这条询问是**自动出现**的，而删除不可恢复 ⇒ 至少要让"删过什么"事后可查
		await this.writeDeleteLog(logRecords);

		const removed = await this.removeOrphanCopies(localTargets);

		new Notice(
			cloud
				? this.t("orphanDeletedBoth", {
						removed,
						deleted: cloud.deleted,
						alreadyGone: cloud.alreadyGone,
						failed: cloud.failed,
					})
				: this.t("orphanLocalDeleted", { removed })
		);
	}

	/**
	 * 删掉孤儿对象在本地的副本（用户答"连本地一起清"之后）。
	 *
	 * ⚠️ 判定与执行都不在这里：分类由 `planOrphanLocalRemoval`（纯函数，套件与变异锚点都在）
	 * 给出，删除顺序与两类文件的分工在 `maintenance/orphan-removal.ts`。
	 * 这一层只负责把两条依赖接上去 —— 本项目的教训是"接线层里的几行"最容易
	 * 悄悄长出没人验的分支（弹窗那层就出过一次）。
	 */
	private removeOrphanCopies(targets: readonly OrphanLocalTarget[]): Promise<number> {
		return removeOrphanCopies(targets, {
			app: this.app,
			forget: (key) => this.currentIndex().remove(key),
			persist: () => this.hostContext().persistIndex(),
			onPersistError: (error) => {
				// 与批量清理同一条纪律：索引存不下去必须说出来，不能静默
				new Notice(this.t("cloudCleanupPersistFailed", { error: describeError(error) }));
			},
			onDeleteError: (error, path) => {
				console.error(`[attachment-cloud-cache] 删除孤儿的本地副本失败（${path}）`, error);
			},
		});
	}

	/**
	 * 删除留痕：把这一批**云端删除**追加写到插件目录下的日志里。
	 *
	 * ## 为什么要留痕
	 *
	 * 删云端对象是**不可恢复**的，而这条询问自 2026-10-11 起是**自动出现**的。
	 * 「自动触发」+「不可恢复」+「不留痕迹」三件事叠在一起，是本产品风险最集中的一处 ——
	 * 至少要让"删了什么、什么时候删的、走哪条入口"事后查得到。
	 *
	 * ## 两条刻意的选择
	 *
	 * ① **写在插件目录，不写本地副本所在处**：本地副本（附件目录里那份、或用户选的
	 *   缓存目录）是承诺过"可以整体删除"的 —— 留痕写在那里，用户清理一次副本
	 *   就把证据一起抹掉了，等于白留。
	 * ② **写失败绝不抛错**：见 `maintenance/delete-log.ts`。为一个附属功能
	 *   炸断一条不可恢复的主流程，代价完全不成比例。
	 *
	 * ⚠️ 它**不是回收站**：日志里的对象恢复不了。真正的宽限期是另一件事（尚未做）。
	 */
	private async writeDeleteLog(records: readonly DeletedObjectRecord[]): Promise<void> {
		if (records.length === 0) return;
		// ⚠️ 插件目录未知 ⇒ **不写**（见 `deleteLogTargetPath`：兜底名会落到 vault 根）。
		// 这只在开发/探针环境发生，删除本身照常已经完成，所以只留一行开发者可见的说明。
		const path = deleteLogTargetPath(this.manifest.dir);
		if (!path) {
			console.warn("[attachment-cloud-cache] 插件目录未知，跳过写删除日志", records.length);
			return;
		}
		const adapter = this.app.vault.adapter;
		await recordDeletions(
			{
				append: async (text) => {
					// ⚠️ 不依赖 `append` 的"文件不存在就创建"这条约定：先看一眼，
					// 没有就 `write`。多一次 `exists` 换掉一个宿主行为假设，划算 ——
					// 假设不成立时这条链会**静默**什么都不写。
					if (await adapter.exists(path)) await adapter.append(path, text);
					else await adapter.write(path, text);
				},
				onError: (error) => {
					// 只说给开发者看（控制台）：用户此刻刚看到"已删除 N 个"，
					// 再弹一条"日志写不进去"只会让人以为删除失败了。
					console.error("[attachment-cloud-cache] 写删除日志失败", error);
				},
			},
			records
		);
	}

	/**
	 * 从一篇正文里取出"属于本存储的对象 key"（孤儿监视的取数口）。
	 *
	 * 复用 `keysInText`（与入口 B 的引用扫描、与渲染判定共用同一个 `keyFromUrl`）
	 * ⇒ "哪些对象算被引用"与"渲染时认不认这条 URL"永远是同一套规则。
	 *
	 * 画布的引用藏在 JSON 字符串里：先按画布规则把文本目标取出来，再走同一套 URL 识别
	 *（`canvasTextTargets` 已处理"转义解不开就跳过那一条"的纪律）。
	 */
	private extractStoredKeys(kind: NoteKind, text: string): Set<string> {
		const keyOf = (url: string): string | null => keyFromUrl(url, this.settings.s3);
		if (kind !== "canvas") return keysInText(text, keyOf);

		const keys = new Set<string>();
		for (const raw of canvasTextTargets(text)) {
			for (const key of keysInText(raw, keyOf)) keys.add(key);
		}
		return keys;
	}

	/**
	 * **入口 B**：「清理云端未使用对象…」。
	 *
	 * 候选公式（见 `cloud-cleanup.ts`）：桶内对象 − 本库引用着的 key − 站外缓存的 key。
	 * 用户看到的是**清单 + 总体积 + 共享风险**，确认之后才真的删。
	 *
	 * ⚠️ 列举有页数上限；中途停下时**如实说**"清单可能不全"
	 * （假装完整会让用户以为"剩下那些都还有人用"）。
	 */
	private async cleanupCloudObjects(): Promise<void> {
		const client = this.buildClient();
		if (!client) {
			new Notice(this.t("maintainNotConfigured"));
			return;
		}

		let listed;
		try {
			listed = await listAllObjects(client);
		} catch (error) {
			new Notice(this.t("cloudCleanupListFailed", { error: describeError(error) }));
			return;
		}

		const referenced = await this.cloudReferencedKeys();
		const selection = selectCleanupCandidates({
			objects: listed.objects,
			referencedKeys: referenced,
			externalKeys: externalKeysOf(this.currentIndex()),
		});

		if (selection.candidates.length === 0) {
			new Notice(
				listed.truncated
					? this.t("cloudCleanupTruncatedNothing")
					: this.t("cloudCleanupNothing")
			);
			return;
		}

		const index = this.currentIndex();
		const cards = this.fileCards(
			selection.candidates.map((object) => {
				const entry = index.get(object.key);
				return { id: object.key, name: entry?.sourceName || displayNameForKey(object.key), localPath: entry?.cachePath, remoteKey: object.key };
			}),
			CLOUD_CLEANUP_LIST_MAX
		);

		const lines = [
			this.t("cloudCleanupSummary", {
				count: selection.candidates.length,
				mb: Math.max(1, Math.round(selection.bytes / (1024 * 1024))),
			}),
			...(selection.candidates.length > CLOUD_CLEANUP_LIST_MAX
				? [
						this.t("maintainMoreItems", {
							count: selection.candidates.length - CLOUD_CLEANUP_LIST_MAX,
						}),
					]
				: []),
			// ⚠️ 显著位置：这两句是"多设备盲区"与"不可恢复"的如实告知
			this.t("cloudCleanupDeviceBlindSpot"),
			this.t("cloudCleanupCannotUndo"),
			...(listed.truncated ? [this.t("cloudCleanupTruncatedWarning")] : []),
		];

		const confirmed = await this.confirmMaintenance({
			title: this.t("cloudCleanupTitle"),
			lines,
			cards,
			cta: this.t("cloudCleanupCta"),
			destructive: true,
		});
		if (!confirmed) {
			new Notice(this.t("maintainCancelled"));
			return;
		}

		const records: DeletedObjectRecord[] = [];
		const result = await runCloudCleanup(
			{
				client,
				index: () => this.currentIndex(),
				persistIndex: () => this.hostContext().persistIndex(),
				notify: (message) => new Notice(message),
				// ⚠️ 必须用箭头函数包一层：直接写 `t: this.t` 会把方法从实例上"摘下来"，
				// 调用时 `this` 就不再是插件实例（lint 的 unbound-method 正是在拦这个）。
				t: (key, params) => this.t(key, params),
				onRemoved: (record) => records.push({ ...record, scope: "command" }),
			},
			selection.candidates.map((object) => object.key)
		);
		await this.writeDeleteLog(records);

		new Notice(
			this.t("cloudCleanupDone", {
				deleted: result.deleted,
				alreadyGone: result.alreadyGone,
				failed: result.failed,
				unindexed: result.unindexed,
			})
		);
	}

	/**
	 * 笔记与画布里**属于本存储**的对象 key 集合（云端清理的"仍被引用"判据）。
	 *
	 * 两处来源都扫：Markdown 笔记的正文，加上**画布的原始文本**（画布里的链接
	 * 也是文本内容，宿主的索引不保证覆盖 —— 与 `referencedVaultPaths` 同一条理由）。
	 * 换算用的是注入的 `keyFromUrl`，也就是**渲染判定用的同一个**回算函数：
	 * 于是"哪些对象算被引用"与"渲染时认不认这个 URL"永远一致。
	 */
	private async cloudReferencedKeys(): Promise<Set<string>> {
		const urls: string[] = [];
		const collect = (text: string): void => {
			for (const key of keysInText(text, (url) => keyFromUrl(url, this.settings.s3))) {
				urls.push(key);
			}
		};

		for (const note of this.app.vault.getMarkdownFiles()) {
			try {
				collect(await this.app.vault.read(note));
			} catch {
				// 读不到就当它没有引用 —— 但这一侧是**危险**的方向，
				// 所以下面补一层：拿不到正文时**整体放弃**这次清理（见 return 前的判断）。
				throw new Error(this.t("cloudCleanupUnreadableNote", { path: note.path }));
			}
		}
		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== "canvas") continue;
			try {
				collect(await this.app.vault.read(file));
			} catch {
				throw new Error(this.t("cloudCleanupUnreadableNote", { path: file.path }));
			}
		}

		// ⚠️ 这里收到的其实是 key（`keysInText` 已经把 URL 换算过了），
		// 所以只是去重成一个集合 —— 再换算一次是多余的，也会引入第二套规则。
		return referencedKeysFromUrls(urls, (value) => value);
	}

	private maintenanceDeps(): MaintenanceDeps {
		return {
			app: this.app,
			settings: () => this.settings,
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			ingest: async (request) => {
				const client = this.buildClient();
				if (!client) throw new Error(this.t("maintainNotConfigured"));
				return ingestAttachment(
					{
						app: this.app,
						settings: this.settings,
						client,
						index: this.currentIndex(),
						persistIndex: () => this.hostContext().persistIndex(),
						notify: (message) => new Notice(message),
						// ⚠️ 文案由这一层给：核心层只决定"说哪一句"（见 `IngestDeps.t`）
						t: (key, params) => this.t(key, params),
					},
					request
				);
			},
			// ⚠️ 复用「缓存站外图片」那条链，而不是另写一套下载+上传：
			// 于是同意复核、失败分类、"URL 在笔记里总是字面出现"那几条纪律只有一份实现。
			cacheExternal: (url, notePath) => this.cacheExternalImage(url, notePath),
			// ⭐ 淘汰本地副本前的**云端复核**（HEAD）：确认对象此刻真的还在。
			// 删文件前的安全线 —— 答不上来（离线、出错）一律当作"没有"，于是不删。
			confirmRemote: (key) => this.isObjectInCloud(key),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		};
	}

	/**
	 * 站外图的"下载 → 上传 → 改写链接"（批量上传复用同一条链）。
	 *
	/**
	 * ⚠️ `report` 默认 **false**：那条链默认每张图弹一条通知 —— 按需缓存时是对的
	 * （用户正看着那张图），批量命令里就是刷屏（50 张图 = 50 条）。
	 *
	 * 而**用户亲手勾的那几张**要用 `report: true`：他刚做完选择，
	 * "成了没有、为什么没成"正是他在等的东西。执行层自己会过滤掉不值得打扰的
	 * 几种结局（超时 / 断网 / 未配置），所以这里不会变成刷屏。
	 */
	private cacheExternalImage(url: string, notePath: string | undefined, report = false) {
		return createExternalCacher({
			app: this.app,
			settings: () => this.settings,
			// 每次现造：用户可能刚在设置页改完密钥（与 `ensureLocalCopy` 同一条纪律）
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			...(report
				? { notify: (message: string) => new Notice(message), t: (key: string, params?: Record<string, unknown>) => this.t(key, params) }
				: {}),
		})(url, notePath);
	}



	/**
	 * 把清单里的项算成"怎么展示"（缩略图 + 名字 + 类型标记）。
	 *
	 * 三处确认框共用：孤儿询问、清理云端未使用对象、批量上传
	 * （1.2.0 起 `clean-cache` 退役 —— 它原来那份清单也走这里）。
	 * 判定本身在 `ui/file-cards.ts`（纯函数，可穷举），这里只负责接上宿主的两件事
	 * —— 本地文件地址与远端地址。
	 */
	private fileCards(items: readonly FileCardInput[], limit: number): FileCard[] {
		return planFileCards(items.slice(0, Math.max(0, limit)), {
			resourceUrl: (path) => resourceUrlFor(this.app, path),
			remoteUrl: (key) => remoteUrlForKey(this.settings, key),
		});
	}

	/**
	 * 看一遍本地副本占用（只读，不动任何文件）。
	 *
	 * ⚠️ 1.2.0（D-17）起口径是**索引 + 存在性**：只统计"索引里记过的副本此刻还在不在"。
	 * 从前那些"孤儿文件"（磁盘有、索引无）**不再可能出现** ——
	 * 索引外的文件可能是用户自己的附件，扫出来也绝不能动（见 `audit.ts` 文件头）。
	 */
	private async reportCacheUsage(): Promise<void> {
		const deps = this.maintenanceDeps();
		const { audit } = await inspectLocalCopies(deps, (url) => keyOfUrl(this.settings, url));
		const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

		// 上限：0 = 不限制。用一句人话表示，而不是把 0 直接摆给用户看
		// （"上限：0 MB" 会被读成"上限是零"，那是相反的意思）。
		const limit = this.settings.cacheLimitMb > 0
			? this.t("cacheLimitValue", { mb: this.settings.cacheLimitMb })
			: this.t("cacheLimitNone");

		new Notice(
			this.t("maintainUsageReport", {
				totalMb: mb(audit.bytes.total),
				count: audit.healthy.length + audit.unused.length,
				reclaimableMb: mb(audit.bytes.reclaimable),
				unused: audit.unused.length,
				missing: audit.missingCopies.length,
				limit,
			})
		);
	}

	/**
	 * 算一遍"哪些本地副本可以清掉"（F18 的**唯一**计算入口）。
	 *
	 * 候选的四条判据在 `planReleaseSpace`（纯函数，套件穷举）；这里只负责把
	 * "索引 + 磁盘 + 笔记正文"三样东西凑齐：
	 *
	 * 1. **索引条目** —— 候选的来源（索引外的文件一概不碰，那可能是用户自己的附件）；
	 * 2. **磁盘上的样子** —— 一次 `stat` 一条索引路径（**不扫目录**，理由同 `readCopies`）；
	 * 3. ⭐ **"仍被引用"的对象 key** —— 复用云端清理那份 `cloudReferencedKeys()`：
	 *    同一套 URL→key 换算，于是"哪些对象算带远端链接"与渲染、与云端清理**永远一致**。
	 *    ⚠️ 它在**读不到某篇笔记时会抛错 ⇒ 整体放弃**（调用方要如实告知、什么都不清）——
	 *    那正是我们要的方向：不知道有没有人引用，就不该删文件。
	 */
	private async localSpaceSelection(): Promise<ReleaseSpaceSelection> {
		const index = this.currentIndex();
		const entries = index.toArray();
		const copies = await readCopies(
			this.app,
			entries.map((entry) => entry.cachePath)
		);
		const referencedKeys = await this.cloudReferencedKeys();

		return planReleaseSpace({
			entries,
			uploaded: new Set(index.uploadedKeys()),
			present: (path) => copies.has(path),
			referencedKeys,
		});
	}

	/**
	 * 设置页那个按钮的入口（F18 的**手动**入口）。
	 *
	 * ⚠️ 与"切档时的那次询问"共用同一个流程（`releaseLocalSpace`），
	 * 差别只在"没有可清项时要不要出声"：手动入口必须说一声（他是特地来的）。
	 */
	async freeUpLocalSpace(): Promise<void> {
		await this.releaseLocalSpace("notice");
	}

	/**
	 * 「清理本地占用」（F18，设计 §20.10）：把**已上传且仍带远端链接**的本地副本
	 * **永久删除**，把磁盘空间立刻还回来。
	 *
	 * ## 两个入口共用这一个流程
	 *
	 * 1. **用户主动**（设置页「不留副本」档下的按钮）⇒ `whenEmpty: "notice"`
	 *    —— 他是特地来清东西的，没有可清项必须说一声；
	 * 2. **切档时的那次询问** ⇒ `whenEmpty: "silent"`
	 *    —— 没东西可清就别打扰他（他刚做的事是"改设置"，不是"清理"）。
	 *
	 * ## ⚠️ 为什么是"直接删"而不是回收站
	 *
	 * 这一档的新上传那段走回收站（`planLocalCopy`），这里走 `Vault.delete` ——
	 * 两段删法**故意不同**：判据是"**要不要立刻释放空间**"（设计 §20.16 #7）。
	 * 用户按下这个按钮的**全部目的**就是腾空间，而回收站（系统回收站与 `.trash`
	 * 都在同一块盘上）**不释放** —— 走回收站等于让他跑完发现"空间没变"。
	 * 代价是**不可撤销**，所以确认框必须写明白（`releaseSpaceCannotUndo`），
	 * 而且执行层会**逐个 HEAD 复核"云端现在确实还有它"**，确认不上就不删。
	 */
	private async releaseLocalSpace(whenEmpty: "notice" | "silent"): Promise<void> {
		let selection: ReleaseSpaceSelection;
		try {
			selection = await this.localSpaceSelection();
		} catch (error) {
			// 扫引用失败（有笔记读不到）⇒ 什么都不清，并把原因说清楚。
			// ⚠️ 不能"跳过那篇笔记继续"：漏掉的那篇可能正是引用着这些图的笔记，
			// 于是候选会凭空变大 —— 这是这个功能唯一能"因为读不到而多删"的方向。
			new Notice(describeError(error));
			return;
		}

		if (selection.candidates.length === 0) {
			if (whenEmpty === "silent") return;
			new Notice(
				selection.missing > 0
					? this.t("releaseSpaceNothingMissing", { count: selection.missing })
					: this.t("releaseSpaceNothing")
			);
			return;
		}

		const index = this.currentIndex();
		const cards = this.fileCards(
			selection.candidates.map((candidate) => {
				const entry = index.get(candidate.key);
				return {
					id: candidate.key,
					name: entry?.sourceName || displayNameForKey(candidate.key),
					localPath: candidate.cachePath,
					remoteKey: candidate.key,
				};
			}),
			RELEASE_SPACE_LIST_MAX
		);

		const lines = [
			this.t("releaseSpaceSummary", {
				count: selection.candidates.length,
				mb: formatMegabytes(selection.bytes),
			}),
			...(selection.candidates.length > RELEASE_SPACE_LIST_MAX
				? [
						this.t("maintainMoreItems", {
							count: selection.candidates.length - RELEASE_SPACE_LIST_MAX,
						}),
					]
				: []),
			// ⚠️ 这两句是按下按钮前**唯一**读到的安全信息，必须如实：
			// 一句说"不可撤销"，一句说"云端与笔记都不动"（否则用户会怕把图删死）。
			this.t("releaseSpaceCannotUndo"),
			this.t("releaseSpaceCloudUntouched"),
		];

		const confirmed = await this.confirmMaintenance({
			title: this.t("releaseSpaceTitle"),
			lines,
			cards,
			cta: this.t("releaseSpaceCta"),
			destructive: true,
		});
		if (!confirmed) {
			new Notice(this.t("maintainCancelled"));
			return;
		}

		const result = await runReleaseSpace(this.maintenanceDeps(), selection);
		new Notice(
			this.t("releaseSpaceDone", {
				deleted: result.evicted,
				mb: formatMegabytes(result.freed),
				skipped: result.skipped.length,
			})
		);
		// ⚠️ "一个都没删"必须解释清楚 —— 否则用户刚按下"永久删除"、看到"跳过 N 个"，
		// 完全不知道发生了什么（他会以为功能坏了）。
		// 真实原因只有一个：候选是**纯判定**（不联网），而删除前要逐个 HEAD 复核
		// "云端现在确实还有它"（那可能是最后一份）⇒ 确认不上的那些会被跳过。
		if (result.evicted === 0 && result.skipped.length > 0) {
			new Notice(this.t("releaseSpaceNothingDeleted", { skipped: result.skipped.length }));
		}
	}

	/**
	 * 「自检并修复本地副本索引」命令。
	 *
	 * ⚠️ 它调的是**与后台自愈同一份实现**（`maintenance/self-heal.ts`）。
	 * 早先这里走的是"列出缓存目录 + **扫全库笔记** → 分类 → 只摘失效记录" ——
	 * 而自愈根本不需要扫笔记（那只影响"未引用 vs 健康"的区分），
	 * 于是这条命令白付了一次全库读；更糟的是它按"文件是否在缓存目录的列表里"判存在，
	 * 于是**`keep` 档（副本留在附件目录）的失效记录永远修不到**。
	 *
	 * 现在的判据是"逐条路径问一下在不在"：既便宜（宿主索引是内存查表），
	 * 也不再有"只管缓存目录"这个盲区。
	 */
	private async repairIndex(): Promise<void> {
		const result = await this.runIndexSelfHeal({ silent: true, immediate: true });
		new Notice(
			result.healed > 0
				? this.t("repairIndexFound", { count: result.healed })
				: this.t("repairIndexNothing")
		);
	}

	/**
	 * 跑一轮索引自愈。
	 *
	 * @param options.silent `true` = 给命令用（结果由调用方回话，这一层不出声）；
	 *   `false`（默认）= 后台用，只在真的修了东西时通知（0 条不打扰）。
	 * @param options.immediate `true` = **单轮即摘**（只给命令用）。后台那条线走**两轮确认**：
	 *   第一次判"不在"只标记，下一轮仍不在才摘 —— 否则换设备/同步进行中会把
	 *   "还在路上"的记录一起摘掉（新设备上那可能是整份索引）。
	 */
	private runIndexSelfHeal(options: { silent?: boolean; immediate?: boolean } = {}): Promise<SelfHealResult> {
		const silent = options.silent ?? false;
		return runSelfHeal({
			entries: () => this.currentIndex().toArray(),
			exists: (path) => vaultPathExists(this.app, path),
			forget: (key) => this.currentIndex().remove(key),
			persist: () => this.hostContext().persistIndex(),
			// ⚠️ 命令走 `CONFIRM_IMMEDIATELY`：显式动作、用户正等着结果，让他按两次才是坏体验。
			// 后台那份确认器的状态在**进程内**（见 `createAbsenceConfirmer` 的取舍）。
			confirmAbsent: options.immediate ? CONFIRM_IMMEDIATELY : this.absenceConfirmer,
			// ⚠️ `silent` 时把通知吞掉（命令自己会回话），而不是在这里分叉两套逻辑 ——
			// 分叉过一次的路径，下一次改行为只会改到其中一边。
			notify: (message) => {
				if (!silent) new Notice(message);
			},
			t: (key, params) => this.t(key, params),
			yieldNow: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
			onError: (error) => console.error("[attachment-cloud-cache] 索引自愈出错", error),
		});
	}


	/**
	 * 上传附件目录里已有的图片（P1 #8）。
	 *
	 * 上传前先确认：这条命令会**改用户的笔记**（把本地链接换成远端链接）。
	 */
	private async uploadExistingAttachments(): Promise<void> {
		const deps = this.maintenanceDeps();
		if (!this.buildClient()) {
			new Notice(this.t("maintainNotConfigured"));
			return;
		}

		const files = this.app.vault
			.getFiles()
			.filter((file) => typeof file?.path === "string");
		// ⭐ 引用集合**算一次、用两次**（确认框的清单 + 真正执行的那趟）——
		// 两份不一致的话，用户会按清单授权、却按另一份执行。
		const referencedPaths = await referencedVaultPaths(this.app);
		const selection = selectUploadCandidates(files, {
			settings: this.settings,
			index: this.currentIndex(),
			referencedPaths,
		});

		// ⭐ 笔记里的**外链文件**也算候选：这条命令补的是"把还没进你自己存储的搬进去"，
		// 而指向别处的同样没进存储 —— 只是它们在别人的服务器上。
		// 判定用的是**同一个纯函数**（`decideExternalCache`），所以"自己的存储 /
		// 回环地址 / 存储未就绪"全都自动一致，不另立一套标准。
		// ⚠️ 它走 `purpose: "manual"`：**点这个确认框本身就是显式动作**，
		// 于是功能开关与站点名单都不约束它（关掉开关也照样能跑这条命令）。
		const external = selectExternalUploadCandidates(await readAllNoteTexts(this.app), {
			settings: this.settings,
			configured: connectionReadiness(this.app.secretStorage, this.settings).ready,
		});

		if (selection.paths.length === 0 && external.candidates.length === 0) {
			new Notice(this.t("maintainBatchNothing"));
			return;
		}

		const lines = [
			this.t("maintainBatchSummary", { count: selection.paths.length }),
			...selection.paths.slice(0, 10),
			...(selection.paths.length > 10
				? [this.t("maintainMoreItems", { count: selection.paths.length - 10 })]
				: []),
			// ⚠️ 1.2.0（D-17）后这条必须照实说"什么都不搬"：文件留在原处就地当本地副本，
			// 变的只有笔记里的链接。不写清楚，用户跑完发现文件还在会以为没生效
			//（旧文案承诺的正是"会被搬进缓存目录"）。
			this.t("maintainBatchOriginalsStay"),
		];

		// ⚠️ 也要说清"哪些**不会**被处理" —— 用户跑这条命令的预期往往是"把没搬的全搬"，
		// 而它只动被笔记引用着的那些（没引用的搬走只会让人以为丢东西）。
		// 不说的话他会以为漏了，然后反复重跑。
		if (selection.unreferenced > 0) {
			lines.push(this.t("maintainBatchSkipsUnreferenced", { count: selection.unreferenced }));
		}

		if (external.candidates.length > 0) {
			// ⚠️ 必须把**站点**列出来：这个确认框就是那份授权（点它就是显式同意）。
			// 只说"还有 3 张站外图"等于让用户盲签一份许可。
			lines.push(
				this.t("maintainBatchExternal", {
					count: external.candidates.length,
					sites: external.sites.length,
					hosts: external.sites.map((site) => site.host).join(", "),
				})
			);
		}

		const confirmed = await this.confirmMaintenance({
			title: this.t("maintainBatchTitle"),
			lines,
			cta: this.t("maintainBatchCta"),
		});
		if (!confirmed) {
			new Notice(this.t("maintainCancelled"));
			return;
		}

		const result = await runBatchUpload(deps, { external, referencedPaths });
		new Notice(
			this.t("maintainBatchDone", {
				uploaded: result.uploaded,
				reused: result.reused,
				failed: result.failed,
				notes: result.notesChanged,
				links: result.linksRewritten,
			})
		);
		// ⚠️ 画布里"没敢动"的值要**单独说出来**：它不属于失败，但用户必须知道
		// 某一处引用可能还指着旧位置（否则他会以为全改好了）。
		if (result.canvasSkipped > 0) {
			new Notice(this.t("maintainBatchCanvasSkipped", { count: result.canvasSkipped }));
		}
	}

	/**
	 * 「选择要缓存的外链图片」：弹窗让用户勾，然后只搬他勾中的那些。
	 *
	 * ## 勾选**就是**授权
	 *
	 * 与那条批量命令一样，这里也不碰"默认行为"那一档：用户明确挑出来的东西，
	 * 就是他此刻的意图（判定层只负责回答"这些地址**能不能**搬"）。
	 *
	 * ## 为什么逐张 `await` 而不是并发
	 *
	 * 用户勾的是个位数到几十张，而每一次都是一轮"下载 + 上传"。
	 * 串行既不给对方站点压力，也让"正在处理第几张"这件事在失败时更好归因。
	 *
	 * ## 为什么最后还要给一句汇总
	 *
	 * 逐张的通知只说"这一张怎么样了"，而用户真正想知道的是
	 * "我勾的那几张三张里成了几张"。两句都给：单张的细节 + 一句总账。
	 */
	async cachePickedExternalImages(): Promise<void> {
		// ⚠️ 1.2.0 起这里**不再检查** `externalImageCache`：那个开关只管**自动**那一路，
		// 而这里是用户**显式**挑出来的（勾选本身就是同意）。
		// 唯一的真前提是"存储配好了" —— 没配好连候选都挑不出来，早退比弹个空清单清楚。
		if (!this.buildClient()) {
			new Notice(this.t("maintainNotConfigured"));
			return;
		}

		const picked = await this.pickExternalImages((scope) => this.externalCandidates(scope));
		// `null` = 取消（含直接关掉弹窗）；空数组 = 看了但一张都没勾。两者都不做事。
		if (!picked || picked.length === 0) {
			new Notice(this.t("externalPickNothing"));
			return;
		}

		let cached = 0;
		let partial = 0;
		let failed = 0;
		for (const item of picked) {
			const outcome = await this.cacheExternalImage(item.url, item.notePath, true);
			if (outcome.status === "cached") cached += 1;
			else if (outcome.status === "cached-no-rewrite") partial += 1;
			else failed += 1;
		}

		new Notice(this.t("externalPickDone", { cached, partial, failed }));
	}

	/**
	 * 某个范围下的外链候选。
	 *
	 * ⭐ 两个范围走**同一个**候选挑选（当前笔记只是"一篇笔记的清单"）——
	 * 于是"功能关掉 / 自己的存储 / 回环地址 / 存储未就绪"这些过滤只有一份实现，
	 * 界面看到的清单与命令要处理的东西永远一致。
	 */
	private async externalCandidates(scope: ExternalPickScope): Promise<ExternalCandidate[]> {
		const notes = scope === "note" ? await readActiveNoteText(this.app) : await readAllNoteTexts(this.app);
		const selection = selectExternalUploadCandidates(notes, {
			settings: this.settings,
			configured: connectionReadiness(this.app.secretStorage, this.settings).ready,
		});
		return selection.candidates;
	}



	/**
	 * **被引用着**的文件路径集合（宿主的链接索引 + 我们自己扫的画布文本）。
	 *
	 * 这条命令跑完会把原文件移进缓存目录，所以"搬谁"必须由**引用**决定：
	 * 引用会被同一条命令改写成远端地址，而没有任何引用的文件我们一概不碰。
	 *
	 * ⚠️ 两条来源**都要看**（需求 R16：画布与笔记同等算数）：
	 * - 宿主的链接索引（`resolvedLinks`）—— 覆盖笔记里的所有写法；
	 * - **画布文本节点**里自己扫出来的目标 —— 那部分是文本内容，宿主是否索引没有保证
	 *   （取证点 E-1c），少了它"只被画布文本引用的附件"会永远不被处理。
	 *   多出来的候选由后续判据兜底，**少掉的那些才是真缺陷**。
	 */
	/**
	 * 这个文件的**内容**是不是我们早就传过的（同步到达的副本判定，见 `attach-watch` ③）。
	 *
	 * 实现只有两步：读字节 → 算 sha256 → 问上传台账（`wasContentUploaded` 会按
	 * `hashFromKey` 把 key 里的哈希段取出来比较 —— 1.2.0 起 key 里还有名字，
	 * 直接拿文件哈希去比 key 会**永远不相等**）。
	 *
	 * ⚠️ 任何一步出错都返回 `false`（= 不知道）。方向是刻意的：这一条只用来"提前
	 * 认出自家副本"，答不上来时退回原来的行为（等引用），既不误判也不会卡住流程。
	 */
	private async isKnownCloudCopy(path: string): Promise<boolean> {
		try {
			const buffer = await this.app.vault.adapter.readBinary(path);
			const hash = await sha256Hex(new Uint8Array(buffer));
			return this.currentIndex().wasContentUploaded(hash);
		} catch {
			return false;
		}
	}

	/**
	 * 云端**现在**还有这个对象吗（淘汰本地副本前的复核）。
	 *
	 * 为什么不能只查台账：台账记的是"我们传过它"，而别的设备可能已经把云端对象清掉了 ——
	 * 那种情况下本机这份副本是**最后一份**，删它就是丢数据。
	 * 缓存目录时代不需要这一问（那条目录里的东西必然是刚传上去的）。
	 *
	 * ⚠️ 任何异常（离线、鉴权、404 之外的服务端错）一律返回 `false` ⇒ 不淘汰。
	 * 方向是刻意的：这一条的存在意义就是"没有确认就不动手"。
	 */
	private async isObjectInCloud(key: string): Promise<boolean> {
		const client = this.buildClient();
		if (!client) return false;
		try {
			const head = await client.headObject(key);
			return head !== null;
		} catch (error) {
			console.debug(`[attachment-cloud-cache] 云端复核失败（本轮不淘汰 ${key}）`, error);
			return false;
		}
	}


	/** 抽成方法是为了让测试能替换掉它（真弹窗点不了）。 */
	private confirmMaintenance(options: ConfirmOptions): Promise<boolean> {
		return confirmWithModal(this.app, options);
	}

	onunload(): void {
		// 事件与 prototype 补丁都由 `registerEvent` / `register` 自动撤销，无需手写。
		// 这里只清掉自有引用，避免插件实例被延长引用（热重载时尤其明显）。
		// ⚠️ 自动接管那条链自己排了定时器，**必须显式取消**：`registerEvent` 管不到它，
		// 留着的话插件卸载后还会去改用户的笔记（热重载时表现为"改了两次"）。
		this.attachWatch?.dispose();
		this.attachWatch = null;
		// ⚠️ 孤儿监视排了两个定时器（重算与询问），同样**必须显式取消**：
		// 留着的话插件卸载后还会弹一次"要不要删云端"—— 而那时插件已经卸载了。
		if (this.orphanCheckTimer) window.clearTimeout(this.orphanCheckTimer);
		if (this.orphanAskTimer) window.clearTimeout(this.orphanAskTimer);
		this.orphanCheckTimer = null;
		this.orphanAskTimer = null;
		this.orphanWatch = null;
		this.orphanPending.clear();
		this.indexStore = null;
		this.externalHook = null;
		this.externalLive = null;
		this.rotation = null;
	}

	/**
	 * 让当前打开着的笔记重新走一遍站外图判定。
	 *
	 * 用途：用户刚在设置里把「遇到外链图片时」改成别的取值（见 `saveSettings`）。
	 * 那条判定是**渲染时**做的，而改设置不会让已经渲染出来的图重跑 ——
	 * 少了这一步，"改成直接缓存"之后用户什么都看不到，要等下次重开笔记才生效
	 * （这类"改了设置没反应"是本项目一直在防的一类症状）。
	 *
	 * 复用 `externalLive` 那条路（它自带攒批、以及"等元素进 DOM 之后再解析归属"），
	 * 而不是另写一套扫描：于是"哪张图属于哪篇笔记"、去重表、错误隔离都只有一份实现。
	 *
	 * 属于本存储的图会被判定层直接忽略（`app://` 不是 http(s)），所以多走一遍是安全的 ——
	 * 真正会被处理的只有站外图。
	 */
	private reprocessOpenNotes(): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as unknown as {
				containerEl?: { querySelectorAll?: (selector: string) => ArrayLike<ImageElementLike> } | null;
			};
			const images = view?.containerEl?.querySelectorAll?.("img");
			if (!images) return;
			for (let i = 0; i < images.length; i += 1) {
				const image = images[i];
				if (image) this.externalLive?.see(image);
			}
		});
	}

	/** 当前索引（`load` 之后对象会换，所以要现取）。 */
	private currentIndex(): CacheIndex {
		return this.indexStore?.index ?? new CacheIndex();
	}

	/**
	 * 索引里任意一条对象的 key —— 供设置页验证「笔记里那条公开链接，**别人**打得开吗」。
	 *
	 * 没有则返回 `null`（还没上传过任何东西）。设置页据此**如实说"无从验证"**，
	 * 而不是拿一个假的通过糊弄过去。
	 */
	sampleObjectKey(): string | null {
		return this.currentIndex().keys()[0] ?? null;
	}

	/**
	 * 从一份**凭据文件**导入连接参数（MinIO 控制台「下载凭据」给的那个 json）。
	 *
	 * ## 为什么放在插件上、而不是写在设置页里
	 *
	 * 界面只负责"取到文本"，写设置与写钥匙串都在这里 —— 于是**真机探针能直接调它**，
	 * 不必去点界面（点界面测的是"按钮接对了没有"，而这里测的是"导入到底做了什么"）。
	 * `cachePickedExternalImages` 是同一个理由下的先例。
	 *
	 * ## ⚠️ 顺序：先写钥匙串，再写设置
	 *
	 * 反过来的话，钥匙串写入失败就会留下「**ID 换了、秘密还是旧的**」这种组合 ——
	 * 它能签出一个格式完全正确、但服务端必然拒绝的请求，而用户看到的是
	 * "凭据被拒"，会去怀疑自己抄错了密钥。所以任何一步失败都**整批不做**。
	 *
	 * ## 秘密的去向只有一处
	 *
	 * `parseCredentialFile` 把外来的 json 拆成「要写设置的字段」与「秘密」两半，
	 * 这里也照着这个边界落：`patch` 里的字段进 `settings`，秘密只进钥匙串。
	 * 秘密**永远不进** `data.json`（那个文件会随 vault 同步、备份、分享出去）。
	 *
	 * @returns 结果里**不含秘密值**，只含"改了哪几项"，供界面如实报告。
	 */
	async importCredentialsFile(text: string): Promise<ImportCredentialsOutcome> {
		const parsed = parseCredentialFile(text);
		if (!parsed.ok) return { ok: false, problem: parsed.problem };

		const s3 = this.settings.s3;
		const patch = parsed.patch;

		// ① 秘密先进钥匙串（失败则什么都不改 —— 见上面那段）
		let secretStored = false;
		if (parsed.secret !== null) {
			const slot = ensureSecretSlot(s3.secretAccessKeyRef, randomSlotPart());
			try {
				this.app.secretStorage.setSecret(slot, parsed.secret);
			} catch (error) {
				return {
					ok: false,
					problem: "secretStoreFailed",
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			// ⚠️ 槽位名沿用已有的（`ensureSecretSlot` 从不改名）—— 改名会把已存的秘密孤儿化
			s3.secretAccessKeyRef = slot;
			secretStored = true;
		}

		// ② 其余字段进设置。**只有文件里真的有的那一项**才动：
		// 一份只有秘密的文件不该顺手把服务地址清空。
		if (patch.endpoint !== undefined) s3.endpoint = patch.endpoint;
		if (patch.accessKeyId !== undefined) s3.accessKeyId = patch.accessKeyId;
		if (patch.forcePathStyle !== undefined) s3.forcePathStyle = patch.forcePathStyle;

		await this.saveSettings();

		// 报告的次序与设置页上那几栏的次序一致（服务地址 → 访问密钥 → 秘密 → 寻址），
		// 于是用户能把通知里的清单直接对着界面核。
		const applied: string[] = [];
		if (patch.endpoint !== undefined) applied.push("s3Endpoint");
		if (patch.accessKeyId !== undefined) applied.push("s3AccessKey");
		if (secretStored) applied.push("s3SecretKey");
		if (patch.forcePathStyle !== undefined) applied.push("forcePathStyle");

		return { ok: true, applied, ignored: parsed.ignored };
	}

	/**
	 * 按**当前**设置与钥匙串造一个客户端；还没配齐时返回 `null`。
	 *
	 * 复用 `connectionReadiness`（设置页的"测试连接"用的是同一个判定）⇒
	 * 界面上说"能连"和实际上传/下载用的是同一套判据，不会出现
	 * "测试连接成功但粘贴报未配置"这种自相矛盾的表现。
	 */
	private buildClient(): S3Client | null {
		const readiness = connectionReadiness(this.app.secretStorage, this.settings);
		return readiness.ready ? createS3Client(readiness.config) : null;
	}


	/** 交给渲染钩子的依赖。 */
	/**
	 * 打开着的、可能承载笔记内容的视图（容器根节点 + 笔记路径）。
	 *
	 * ⚠️ 只用来回答"**这个元素**在哪篇笔记里"，**不是**为了拿"当前笔记"：
	 * 分屏时正在渲染的可能正是没有焦点的那一篇，按活动笔记去猜会改写**另一篇**
	 * —— 而这条链路的产出就是改写笔记，写错文件等于损坏用户数据。
	 *
	 * 返回数组而不是边查边处理：一次 flush 里所有候补共用同一份视图列表
	 * （一屏几十张图时这是几十倍的差别）。
	 */
	private openNoteViews(): OpenViewLike[] {
		const views: OpenViewLike[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as unknown as {
				file?: { path?: unknown };
				containerEl?: { contains?: (node: unknown) => unknown } | null;
			};
			const path = view?.file?.path;
			// 只收"确实承载着一篇笔记"的视图：设置页、图谱、别的插件面板都没有 `file.path`
			if (typeof path === "string" && path) views.push({ root: view.containerEl, path });
		});
		return views;
	}

	/**
	 * 非图片可预览附件（音频/视频/PDF）的**节点重建**队列。
	 *
	 * **懒建**：它要用宿主 API（`generateMarkdownLink` + `MarkdownRenderer`），
	 * 而那些只有在插件实例就绪之后才拿得到；懒建顺带也保证"从没用过"的会话
	 * 不建任何东西。卸载时 `dispose()`（丢掉攒下的候补，不再排调度）。
	 */
	private embedQueueField: EmbedRebuildQueue | null = null;

	/**
	 * 渲染重建节点时用的**子 Component**（见 `renderEmbed` 里的说明）。
	 *
	 * 与插件实例分开是为了让生命周期可控：它随插件注册（`addChild`），
	 * 卸载时会被一起清掉；而"把插件实例当 Component 用"会让宿主以为
	 * 那些子组件要活到整个插件结束。
	 */
	private embedComponent = new Component();

	private embedQueue(): EmbedRebuildQueue {
		if (!this.embedQueueField) {
			this.embedQueueField = createEmbedRebuildQueue(this.embedDeps());
			this.register(() => {
				this.embedQueueField?.dispose();
				this.embedQueueField = null;
			});
		}
		return this.embedQueueField;
	}

	/**
	 * 重建那一层要的宿主能力。
	 *
	 * ⚠️ `renderEmbed` 是这里面唯一的"宿主魔法"：先用**宿主的**生成器产出库内链接
	 * （尊重用户的「新链接格式」设置），再交给**宿主的**渲染器变成节点 ——
	 * 于是"该长什么样"完全由宿主决定，我们不猜任何 DOM 结构。
	 * 造不出来（文件不在、渲染器抛错）时返回 `null`：调用方**保留原元素**，
	 * 绝不产出一个坏节点。
	 */
	private embedDeps(sourcePath: string | null = null): EmbedRebuildDeps {
		return {
			settings: () => this.settings,
			index: () => this.currentIndex(),
			resourceUrlFor: (path) => resourceUrlFor(this.app, path),
			ensureLocalCopy: async (key, remoteUrl) => {
				// ⭐ `sourcePath` 在这里闭包捕获：回退下载的落点要靠它推"附件目录"
				// （宿主的 `attachmentFolderPath` 取 `./` 时 = 与这篇笔记同目录）。
				const outcome = await this.ensureLocalCopy(key, remoteUrl, sourcePath);
				return outcome.localPath || null;
			},
			notePathFor: (element) => {
				// 实时预览那条路：**等元素进 DOM 之后**反查归属（与站外图同一份实现）。
				// 拿不准就返回 null —— 那会让重建发生在"没有归属"的上下文里，
				// 对库内嵌入来说是安全的（`![[path]]` 不需要 sourcePath 也能解析）。
				const views = this.app.workspace.getLeavesOfType("markdown").map((leaf) => {
					const view = leaf.view as unknown as {
						containerEl?: { contains?: (node: unknown) => unknown } | null;
						file?: { path?: string } | null;
					};
					return {
						root: view.containerEl ?? null,
						path: view.file?.path ?? "",
					};
				});
				return notePathForElement(views, element);
			},
			renderEmbed: async (localPath, sourcePath) => {
				const file = this.app.vault.getAbstractFileByPath(localPath);
				if (!(file instanceof TFile)) return null;
				const link = this.app.fileManager.generateMarkdownLink(file, sourcePath ?? "");
				const container = createDiv();
				try {
					// ⚠️ 传的是**我们自己的**子 Component（不是插件实例本身）：
					// 渲染出来的子组件会挂在它下面，而我们可以在卸载时统一关掉。
					// 直接传插件实例会让那些子组件的生命周期与整个插件一样长（lint 也拦这个）。
					await MarkdownRenderer.render(this.app, `!${link}`, container, sourcePath ?? "", this.embedComponent);
				} catch (error) {
					console.error("[attachment-cloud-cache] 重建附件节点失败", error);
					return null;
				}
				return container.firstElementChild;
			},
			onError: (error) => console.error("[attachment-cloud-cache] 重建附件节点时出错", error),
		};
	}

	private renderDeps(sourcePath: string | null = null): RenderHookDeps {
		return {
			settings: () => this.settings,
			index: () => this.currentIndex(),
			resourceUrlFor: (path) => resourceUrlFor(this.app, path),
			// 渲染钩子只关心"补上了没有、在哪"，所以在这里把结果收敛成路径 ——
			// 让渲染层不必知道下载层那套状态机（downloaded/reused/refused…）。
			ensureLocalCopy: async (key, remoteUrl) => {
				// ⭐ `sourcePath` 在这里闭包捕获：回退下载的落点要靠它推"附件目录"
				// （宿主的 `attachmentFolderPath` 取 `./` 时 = 与这篇笔记同目录）。
				const outcome = await this.ensureLocalCopy(key, remoteUrl, sourcePath);
				return outcome.localPath || null;
			},
			onLocalCopyMissing: (key) => void this.forgetLocalCopy(key),
			// 记下"这张图刚被看到" —— 缓存上限轮换靠它区分"常看"与"早就没人看"。
			// ⚠️ 只改内存（落盘在 `IndexStore.touch` 里防抖）：这条路径是渲染热路径。
			onLocalCopyUsed: (key) => void this.indexStore?.touch(key),
			notify: (message) => new Notice(message),
		};
	}

	/**
	 * 索引指向的本地副本其实不存在 → 把这条记录摘掉并落盘。
	 *
	 * 这是**自愈**而不是清理：只改索引，不动任何文件。发生的时机是渲染时
	 * `<img>` 加载失败（用户删了缓存目录 —— 那随时可做，是承诺过的）。
	 * 不摘掉的话，这个 key 会**永远**被判为"本地已有"，于是永远不去下载。
	 */
	private async forgetLocalCopy(key: string): Promise<void> {
		const store = this.indexStore;
		if (!store) return;
		try {
			if (store.index.remove(key)) await this.serialize(() => store.save());
		} catch (error) {
			console.error("[attachment-cloud-cache] 摘除失效索引记录失败", error);
		}
	}

	/** 供各模块统一的文案查询入口。 */
	t(key: string, params?: Record<string, unknown>): string {
		return translate(this.locale, key, params ?? {});
	}

	async loadSettings(): Promise<void> {
		// ⚠️ 走 mergePluginSettings 而不是直接赋值：data.json 可能是手改的、
		// 旧版本的、或被别的工具写坏的，必须逐字段校验后再用。
		// ⚠️ 标 `unknown`：`loadData()` 的返回是 `any`，而这里正是"数据可能被手改/写坏"
		// 的入口 —— 让它显式地不信任，而不是靠 `any` 悄悄流过去。
		const stored: unknown = await this.loadData();
		this.settings = mergePluginSettings(SETTINGS_DEFAULTS, stored);
		// 记下"这次启动时它是哪一档"：F18 的询问只认**切换**这个动作
		this.lastLocalCopyAction = this.settings.localCopy;

		// ⭐ 一次性兼容升级（1.2.0）：老 `data.json` 里的 `objectKeyTemplate` 已被取消。
		//
		// 合并结果里本来就不会带上它（字段表只写自己列出的键），所以这一步**不是**在为
		// "设置生效"做迁移 —— 它做两件别的事：把遗留值从文件里清掉，并让用户**知道**
		// 他的 key 形状从此固定成「原名-哈希.扩展名」了。
		//
		// ⚠️ 幂等：清掉之后再进来就查不到了 ⇒ 只会写这一次（`hasLegacy...` 问的就是
		// "文件里还有没有那个键"）。写失败也不影响本次运行 —— 设置已经是对的，
		// 只是文件要到下次保存才干净，所以这里**不提示失败**（那会变成每次启动都弹一条噪音）。
		let needsRewrite = false;
		if (hasLegacyObjectKeyTemplate(stored)) {
			this.legacyKeyTemplateUpgraded = true;
			needsRewrite = true;
		}

		// ⭐ 另一次一次性兼容升级（1.2.0）：旧的两档「遇到站外文件链接时」已并进
		// 「站外文件按普通附件处理」这一个开关（折算规则见 `legacyAutoCacheEnabled`）。
		// ⚠️ 这一次**会改设置值**（不只是清遗留键）：旧语义是两个控件，新语义是一个，
		// 折算必须显式 —— 否则"开着功能但什么都不做"的用户会被静默改成自动搬。
		if (hasLegacyExternalImageDefault(stored)) {
			this.settings.externalImageCache = legacyAutoCacheEnabled(stored);
			this.legacyExternalModeMerged = { auto: this.settings.externalImageCache };
			needsRewrite = true;
		}

		if (needsRewrite) {
			try {
				await this.saveData(this.settings);
			} catch (error) {
				console.error("[attachment-cloud-cache] 清理遗留设置失败（不影响本次运行）", error);
			}
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 触发 ③：用户可能刚把上限调小（甚至从"不限制"改成有值），
		// 那时他期待的是"立刻生效"，而不是等下一个周期。
		// ⚠️ 这条路径每次改设置都会被调到（包括每敲一个字符），
		// 所以轮换器自带**节流**，而门槛检查只花一次内存求和 —— 不会变成打字卡顿。
		void this.rotation?.maybeRotate("settings");

		// 站外图那条链路的判定是**渲染时**做的，改设置不会让它重跑 ——
		// 少了这一步，把「遇到外链图片时」改成「直接缓存」之后**什么都看不到**，
		// 要等下次重开笔记才生效（"改了设置没反应"是本项目一直在防的一类症状）。
		// 只在功能开着时做：关着时判定第一步就忽略，扫一遍纯属白费。
		if (this.settings.externalImageCache) this.reprocessOpenNotes();

		// 触发 ④（F18 / D-19）：用户刚把「本地副本」切成**不留副本** ——
		// 这一档的含义是"本地不留副本"，可库里**已经上传过的**那些副本还占着空间。
		// 所以切过来的**那一刻**问一次"要不要把已有的也清掉"（清单 + 可释放字节）。
		// ⚠️ 只在**切换**时问（见 `lastLocalCopyAction` 的说明）；
		// ⚠️ 更**不自动删** —— 那是不可逆的批量动作，必须用户点头（里面的确认框）。
		const previousLocalCopy = this.lastLocalCopyAction;
		this.lastLocalCopyAction = this.settings.localCopy;
		if (
			previousLocalCopy !== undefined &&
			previousLocalCopy !== this.settings.localCopy &&
			this.settings.localCopy === "trash"
		) {
			void this.releaseLocalSpace("silent").catch((error) => {
				console.error("[attachment-cloud-cache] 存量清理的询问失败（不影响本次设置保存）", error);
			});
		}
	}

	/**
	 * 读缓存索引。
	 *
	 * ⚠️ **读失败绝不能挡住插件启动**：索引是可重建的派生数据，
	 * 而它读失败的时机恰好是插件加载。在这里抛错等于"一个索引文件损坏
	 * 就让用户连设置页都进不去"。所以失败只提示、然后以空索引继续跑
	 * （`loadCacheIndex` 自己也不抛；这里再兜一层，因为适配器与宿主 API
	 * 在异常场景下的行为不归我们保证）。
	 */
	private async loadCacheIndex(): Promise<void> {
		this.indexStore = createIndexStore(this.app, this.manifest.dir, this.manifest.id, () => new CacheIndex());

		try {
			const { error, skipped, existed } = await this.indexStore.load();
			if (error) {
				new Notice(this.t("indexLoadFailed", { error }));
			} else if (skipped > 0) {
				// 坏条目被丢弃是容错，但用户有权知道"有些图的本地副本不被认识了"。
				new Notice(this.t("indexSkipped", { count: skipped }));
			} else if (!existed) {
				// 首次运行：不提示。刚装上的插件弹"索引不存在"只会让人以为出错了。
			}
		} catch (error) {
			this.indexStore = null;
			new Notice(this.t("indexLoadFailed", { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/**
	 * 交给接线层的宿主上下文。
	 *
	 * `settings` / `index` 都是**取值函数**而不是快照：设置页改完立即生效，
	 * 索引在 `load()` 后会换对象 —— 抓快照会让"改了不生效"这类问题
	 * 以最难排查的形式出现（界面上一切正常，只有行为不对）。
	 */
	private hostContext(): HostContext {
		const store = this.indexStore;
		return {
			app: this.app,
			settings: () => this.settings,
			index: () => store?.index ?? new CacheIndex(),
			persistIndex: async () => {
				if (store) await this.serialize(() => store.save());
				// 触发 ④：`persistIndex` 在**每次成功上传/下载之后**都会被调用
				// （那是"缓存刚长大"最直接的时刻），所以用它做"长大"这个信号。
				// 它也会被自愈之类的路径调到 —— 没关系：那一轮只花一次内存求和，
				// 而且轮换器自己带节流与并发保护。
				void this.rotation?.maybeRotate("growth");
			},
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			secretStorage: this.app.secretStorage,
			// 中转文件标记：批处理走 `existingPath`（字节已经在库里，不落盘），
			// 所以这条线当下用不到 —— 但留着它，将来任何在这条线上新增"落盘"的调用方
			// 都不会踩同一个坑（自写的中转文件被当成用户的新附件）。
			onStaged: (path) => this.stagedPaths.note(path),
		};
	}
}
