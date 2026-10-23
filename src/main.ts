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

import { Component, MarkdownRenderer, Notice, Platform, Plugin, TFile, TFolder, getLanguage } from "obsidian";

import { SETTINGS_DEFAULTS, hasLegacyExternalImageDefault, hasLegacyObjectKeyTemplate, legacyAutoCacheEnabled, mergePluginSettings } from "./settings";
import type { LocalCopyAction, PluginSettings } from "./types";
import { detectLocale, translate } from "./i18n";
import { SettingsTab } from "./ui/settings-tab";
import { CacheIndex } from "./cache/index";
import { createIndexStore, makeSerializer } from "./host/runtime";
import type { HostContext } from "./host/runtime";
import { createEditorHandlers } from "./host/editor-bridge";
import { createAnnounceGate } from "./host/intercept";
import { runBatchUpload, runEviction, scanReferences } from "./maintenance/run";
import type { MaintenanceDeps } from "./maintenance/run";
import { createCacheRotator } from "./maintenance/rotation";
import type { CacheRotator } from "./maintenance/rotation";
import { createAttachWatcher, createSelfWriteLedger } from "./maintenance/attach-watch";
import type { AttachWatcher } from "./maintenance/attach-watch";
import { createAbsenceConfirmer, runSelfHeal } from "./maintenance/self-heal";
import type { SelfHealResult } from "./maintenance/self-heal";

import { describeError } from "./error-text";
import { ingestAttachment } from "./core/ingest";
import { confirmWithModal } from "./ui/confirm-modal";
import type { ConfirmOptions } from "./ui/confirm-modal";
import type { FileCardOpenTarget } from "./ui/file-cards";
import { planFileCards } from "./ui/file-cards";
import type { FileCard, FileCardInput } from "./ui/file-cards";
import type { S3Client } from "./s3/client";
import { connectionReadiness } from "./s3/credentials";
import {
	INITIAL_CONNECTION_STATE,
	UNKNOWN_ACCESS_PROBE,
	classifyPublicReach,
	probeAccess,
	probeUrlFor,
	stateAfterProbe,
	stateAfterRoundTrip,
} from "./link-access";
import type { AccessProbe, ConnectionState } from "./link-access";
import { TEMP_PROBE_BODY, runWithTempProbeObject, singleFlight, tempProbeKey } from "./probe-sample";
import { probePublicContent } from "./s3/client";
import type { PublicContentProbe } from "./s3/client";
import type { ProbeRoundTripMemo } from "./probe-sample";
import { utf8Bytes } from "./s3/hash";
import { createLocalCopyEnsurer } from "./core/download";
import {
	keyOfUrl,
	referencedVaultPaths,
	remoteUrlForKey,
	resourceUrlFor,
	vaultPathExists,
} from "./plugin/notes-query";
import {
	buildClient as buildClientFrom,
	importCredentialsFile as runCredentialsImport,
} from "./plugin/credentials-flow";
import type { ImportCredentialsOutcome } from "./plugin/credentials-flow";
import type { PluginContext } from "./plugin/context";
import { localFileExists, localPathFromUrl, localThumbCandidates } from "./local-file";
import { uploadExistingAttachments } from "./plugin/upload-existing-flow";
import { releaseLocalSpace } from "./plugin/release-space-flow";
import { revertLinksToLocal as revertLocalLinks } from "./plugin/revert-flow";
import { createOrphanFlow } from "./plugin/orphan-flow";
import { startBackgroundTasks } from "./plugin/background-tasks";
import type { BackgroundTasks } from "./plugin/background-tasks";
import type { OrphanFlow } from "./plugin/orphan-flow";
import type { LocalCopyOutcome } from "./core/download";
import { installImageSrcPatch, processImages } from "./render/render-hook";
import { createEmbedRebuildQueue, processEmbeds } from "./render/embed-rebuild";
import type { EmbedRebuildDeps, EmbedRebuildQueue } from "./render/embed-rebuild";
import { notePathForElement } from "./render/external-live";
import type { ImageElementLike, NonImageTarget, RenderHookDeps } from "./render/render-hook";
import { createExternalHook } from "./render/external-hook";
import type { ExternalHook } from "./render/external-hook";
import { createExternalLiveQueue } from "./render/external-live";
import type { ExternalLiveQueue, OpenViewLike } from "./render/external-live";
import { createExternalCacher } from "./core/external-cache";
import { askTaskList } from "./ui/task-list-modal";
import { GALLERY_VIEW_TYPE, GalleryView } from "./ui/gallery-view";
import type { TaskListOptions, TaskListResult } from "./ui/task-list-modal";

/**
 * 导入一份凭据文件的结果。
 *
 * 定义在 `plugin/credentials-flow.ts`，这里只 re-export —— 它是对外可见的公开形状
 * （设置页与真机探针都按它取字段），搬实现时把类型一起搬走、留个出口就够了。
 */
export type { ImportCredentialsOutcome } from "./plugin/credentials-flow";

/**
 * 预签名地址在本地的缓存时长：20 分钟。
 *
 * 签名本身是 30 分钟（`client.ts::DEFAULT_PRESIGN_EXPIRES`），留 10 分钟余量：
 * 一张图可能在你切走一会儿之后又被重新请求，宁可在边缘之前重签一次。
 */
const SIGNED_URL_CACHE_MS = 20 * 60 * 1000;

/**
 * 上传指示的**延迟显示**（毫秒）。
 *
 * 几百毫秒内就传完的不要闪一下 —— 一闪而过的提示比没有更烦；
 * 而超过这个时间的等待，用户确实需要知道"它在干活"。
 */
const UPLOAD_INDICATOR_DELAY_MS = 300;

/**
 * 「测试连接」一轮回路的**本次**结果。
 *
 * ⚠️ 必须是**返回值**而不是让界面回头读全局字段：连点 / 与自动探测并发时，全局那一格
 * 可能已经被另一轮覆盖，界面就会把"另一轮的对象名、字节数、删除状态"当成自己的结果显示 ——
 * 那种错配**看不出来**（数字都在合理范围内）。
 */
export interface ConnectionProbeResult {
	probe: AccessProbe;
	/**
	 * 这一轮之后**连接状态**（公开 / 私有 / 无法访问 / 检测中）。
	 *
	 * ⚠️ 与 `probe` 分开：状态是**结论**（还考虑了签名读），`probe` 只是匿名那一问的原始结果。
	 */
	state: ConnectionState;
	/** 这一轮的善后状态；`null` = 配置不全 / 回路没跑起来（没有探测对象）。 */
	sample: ProbeRoundTripMemo | null;
	/** 这一轮**真正**探测过的那条地址（`null` = 没跑起来）。 */
	url: string | null;
}

/** 缓存条数上限（防御用；超了整体清空，不做 LRU —— 这张表的体积本来就很小）。 */
const SIGNED_URL_CACHE_LIMIT = 512;

export default class AttachmentCloudCachePlugin extends Plugin {
	settings: PluginSettings = { ...SETTINGS_DEFAULTS };
	locale = "en";

	/**
	 * **连接状态**（2026-10-18：取代了原来的「笔记里的链接谁打得开」三档设置）。
	 *
	 * 三类读者共用：① 渲染/下载判定（缺副本的图走哪条路）；② 设置页（把状态显示出来）；
	 * ③ "测试连接"（刷新它）。判据本身在 `link-access.ts`，这里只持有结果。
	 *
	 * ⚠️ 初值是 `checking`（= 还没问出来），于是缺副本的图**先按私有处理** —— 安全方向：
	 * 多下一次，而不是在"其实私有"时留下一屏没有兜底的坏图。
	 * ⚠️ **从不持久化**：每次加载都重新问（桶的权限可能在那边被改过）。
	 */
	private connectionState: ConnectionState = INITIAL_CONNECTION_STATE;

	/** 最近一次匿名探测的原始结果（诊断用；状态由它推出来）。 */
	private lastProbe: AccessProbe = UNKNOWN_ACCESS_PROBE;

	/** 上一次探测用的地址 —— 用来避免"敲一个字就发一次 HEAD"。 */
	private probedUrl: string | null = null;

	/** 防抖句柄（`window.setTimeout` 的返回值是数字，见 {@link scheduleAccessProbe}）。 */
	private accessProbeTimer: number | null = null;

	/** 上传期间的状态栏指示（见 {@link beginUpload}）；元素由 `addStatusBarItem` 给。 */
	private uploadStatus: HTMLElement | null = null;

	/** 延迟显示的句柄 —— 几百毫秒内就传完的不要闪一下。 */
	private uploadStatusTimer: number | null = null;

	/**
	 * 「未配置」的提醒闸门（**每个会话一个**，粘贴与手机那条入口共用）。
	 *
	 * 由 `host/intercept.ts::createAnnounceGate` 实现：没配存储的人每粘一张图都会被念一次，
	 * 而图其实好好存着 —— 反复提醒只是噪音。插件重载 = 新会话 = 再提醒一次（刻意）。
	 */
	private readonly unconfiguredAnnounce = createAnnounceGate();

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
	 * 少了这条，编辑态里「上传外部文件…」那条命令就完全没有反应。
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
	 * 「某个已上传对象失去最后一个引用」（= 出现孤儿）那条入口（R17）。
	 *
	 * ⚠️ 它自己持有全部状态（引用快照 / 已问过的 key / 攒批 / 两个防抖定时器）——
	 * 那些状态必须跨事件活着，所以**在入口这里建一次、之后只转发事件**：
	 * 每次新建等于把"哪篇笔记引用过什么"全忘掉，于是谁都不会再变成孤儿。
	 * 见 `plugin/orphan-flow.ts` 的文件头（那里还写着"为什么不是删文件时问"）。
	 */
	private orphanFlow: OrphanFlow | null = null;

	/**
	 * 我们自己刚落盘的中转文件（`stageLocally` 上报，见 `SelfWriteLedger`）。
	 *
	 * 存在的理由：粘贴那条路的"先落盘再上传"与自动接管共用 `vault.on("create")`。
	 * 台账的作用是让后者认出"这是自己刚写的"，别去重复接管。
	 */
	private readonly stagedPaths = createSelfWriteLedger();

	/** 后台任务（启动延迟 + 周期兜底）。定时器本身与它们的取消都在 `plugin/background-tasks.ts`。 */
	private backgroundTasks: BackgroundTasks | null = null;

	/**
	 * 「选择要缓存的外链图片」那个弹窗的接缝。
	 *
	 * ⚠️ 默认是**真弹窗**；入口验收测试会覆写它（真弹窗在测试里点不了）。
	 * 这条接缝是这条链路唯一能被端到端驱动的地方 —— 没有它，
	 * "用户勾了几张之后到底发生了什么"就只能靠单元套件间接推断。
	 */
	/**
	 * 清单式弹窗（缩略图 + 勾选 + 进度，四条链共用）的接缝。
	 *
	 * ⚠️ 默认是**真弹窗**；入口验收会覆写它（宿主的 `Modal` 在 Node 里点不了，
	 * 而"点了按钮会发生什么"恰恰是那几条链最要紧的部分）。
	 * ⚠️ 必须挂成**实例字段**并让 `flowContext()` 转调它 —— 内联 `askTaskList(...)`
	 * 的话，覆写这个字段就**没有任何效果**（2026-10-15 实测踩到：验收卡在等待超时，
	 * 而现象只是"什么都没发生"，看不出是接缝没接上）。
	 */
	pickTasks: (options: TaskListOptions) => Promise<TaskListResult | null> = (options) =>
		askTaskList(this.app, {
			...options,
			// ⭐ 行尾「打开」（D-66）在装配点接上：判定（哪些行能打开、打开的是路径还是地址）
			// 在 `ui/file-cards.ts::planFileCards`，真正的打开动作只有这里知道怎么问宿主。
			onOpen: (target) => this.openCardTarget(target),
		});

	/**
	 * 打开清单里的一行（D-66）。
	 *
	 * - **库内文件**（`vault`）：交给宿主用它自己的视图打开（图片/PDF 都能开）。
	 *   ⚠️ 用**新标签**打开：清单还开着，把它顶掉的话用户回不去（而他要接着勾）。
	 *   ⚠️ 文件可能已经不在了（清单是几秒前算的，或用户刚在别处删掉）⇒ 明说，不静默。
	 * - **库外地址**（`url`）：交给系统浏览器。⚠️ 只对 `http(s)` 有意义；
	 *   本机 `file:///…` 那一类**根本不给打开**（在 `planFileCards` 里就没有目标）。
	 */
	private openCardTarget(target: FileCardOpenTarget): void {
		if (target.kind === "url") {
			window.open(target.value, "_blank");
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(target.value);
		if (!(file instanceof TFile)) {
			new Notice(this.t("fileCardOpenMissing", { path: target.value }));
			return;
		}
		void this.app.workspace.getLeaf("tab").openFile(file);
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// ⚠️ 语种要在**注册设置页之前**定下来 —— 设置页在 `display()` 里取文案，
		// 若此时 locale 还是初始的 "en"，中文用户第一次打开会看到英文界面。
		this.locale = detectLocale(getLanguage());

		this.addSettingTab(new SettingsTab(this.app, this));

		await this.loadCacheIndex();

		// ── 访问方式：启动后匿名摸一次「别人能不能打开笔记里那条链接」（1.7.0）──
		//
		// 为什么必须做：私有桶的用户在旧版本里看到的是**一屏坏图** —— 笔记里那条地址
		// 对外 403，而 `<img>` 的 403 不弹任何提示（只有控制台一条）。探测结果决定
		// 缺副本的图要不要**强制**取回（判据与降级规则见 `link-access.ts`）。
		//
		// ⚠️ 走 `scheduleAccessProbe`（定时器）而不是直接 `await`：
		// ① `onload` 不该被一次网络请求拖住（离线时那是 5 秒的空白）；
		// ② 定时器给了"卸载时清理"一个确定的对象（见下面的 `register`）。
		this.register(() => {
			// ⚠️ 即便它已经触发过，也要 clear 一次：`clearTimeout` 对已触发的 id 是空操作，
			// 而"卸载要干净"这条承诺不该取决于"它跑完没有"。
			if (this.accessProbeTimer !== null) window.clearTimeout(this.accessProbeTimer);
			this.accessProbeTimer = null;
		});
		this.scheduleAccessProbe(0);

		// ── 上传时的状态栏指示 ──
		//
		// ⭐ 粘贴后要等**全部**文件传完才插入链接（这样只占一步撤销），
		// 这期间编辑器里什么都没有 —— 大文件或慢网时用户以为没反应、会再粘一次。
		// 反馈放在编辑器之外：不打断输入、不占撤销、不给笔记留痕。
		this.uploadStatus = this.addStatusBarItem();
		this.uploadStatus.addClass("acc-upload-status");
		this.uploadStatus.hide();
		this.register(() => {
			if (this.uploadStatusTimer !== null) window.clearTimeout(this.uploadStatusTimer);
			this.uploadStatusTimer = null;
			this.uploadStatus?.remove();
			this.uploadStatus = null;
		});

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
			index: () => this.currentIndex(),
			settings: () => this.settings,
			// 每次现查（文件可能已经被别的流程搬走/删掉）—— 与 `TFile` 的形状解耦
			lookup: (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				return { path: file.path, extension: file.extension, stat: { size: file.stat?.size ?? 0 } };
			},
			referencedPaths: () =>
				referencedVaultPaths(this.app, { debug: this.settings.debugLogging }),
			adopt: async (paths) => {
				// 存储没就绪时**什么都不做**，只把"去哪配"说清楚 —— 与粘贴那条路的口径一致：
				// 不拦用户、不假装成功，也绝不留下半个动作（文件原地不动、笔记一个字不改）。
				const readiness = connectionReadiness(this.app.secretStorage, this.settings);
				if (!readiness.ready) {
					// 与粘贴那条路共用一个「每会话只提醒一次」的闸门（见 `createAnnounceGate`）：
					// 手机上加图是批量动作，逐个提醒会把通知栏刷满。
					if (this.unconfiguredAnnounce()) {
						new Notice(
							this.t("hookNotConfigured", {
								problem: readiness.problem,
								where: this.t(readiness.fixIn === "credentials" ? "hookFixCredentials" : "hookFixConnection"),
							})
						);
					}
					return { uploaded: 0, reused: 0, failed: 0, linksRewritten: 0, redundantRemoved: 0 };
				}
				// 复用批量那一趟（`referencedPaths` 只放这一个文件 ⇒ 候选也只有它）：
				// 于是"上传 → 搬入缓存 → 改写引用（含画布）"只有一份实现。
				// ⭐ 这一趟的收尾还可能**删掉宿主撞名另落的重复副本**（链接改写成功后，
				// 见 `dropRedundantCopies`）—— 提示不在这里发：这条路一次只处理一个文件、
				// 且用户刚刚亲手插了那张图，多弹一条只会变噪音（命令那条路会报）。
				// ⚠️ `repairablePaths` 留空：这条路只处理**刚进来的这一个文件**，
				// 它不可能"已经传过、只差改链接"（那种是「上传附件」重修的对象）。
				return runBatchUpload(this.maintenanceDeps(), {
					referencedPaths: new Set(paths),
					repairablePaths: new Set(),
				});
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
			// ⭐ 1.7.0：私有存储下"缺副本必须取回"这条判据要读探测结果（见 `link-access.ts`）
			connectionState: () => this.connectionState,
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
			// ⭐ "还有人用吗"的另一半（笔记直接指着的库内路径）—— 与上面那半合起来才算完整
			referencedPaths: () =>
				referencedVaultPaths(this.app, { debug: this.settings.debugLogging }),
			evict: (plan) => runEviction(this.maintenanceDeps(), plan),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			onError: (error) => console.error("[attachment-cloud-cache] 缓存轮换出错", error),
		});

		// ── 后台任务（启动延迟 + 周期兜底）──
		//
		// ⚠️ 所有定时器都在 `plugin/background-tasks.ts` 里排队与取消：那里是一张**表**
		//（id / 种类 / 间隔 / 为什么是这个触发点），于是"漏了一条线"是可数的，
		// 取消也不再需要在 `onunload` 里手写（每条都登记到 `register`）。
		// 轮换那四个触发点的全景（哪两个是定时线、哪两个在事件现场）见那张矩阵。
		this.backgroundTasks = startBackgroundTasks(
			{
				rotate: (reason) => void this.rotation?.maybeRotate(reason),
				selfHeal: () => void this.runIndexSelfHeal(),
			},
			(cleanup) => this.register(cleanup)
		);

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
				// 实时预览：非图片 ⇒ 不写 `src`，把元素交给重建队列。
				// 两条来路：有副本（用宿主渲染）／私有 + 不留副本（自己造 video/audio）。
				onNonImageEmbed: (element, target) => this.routeNonImageEmbed(element, target),
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
		// 而他**几乎不会去删那个文件**（默认档下它就留在附件目录里、是他自己的文件）
		// ⇒ 挂在"删文件"上的询问，默认配置下**一次都不会出现**（设计 §6.2.1）。
		this.orphanFlow = createOrphanFlow(this.flowContext());

		// ⚠️ `modify` 与 `create` 走**同一条**路（`createOrphanFlow` 里就是同一个函数）：
		// 新建的笔记/画布也要立刻登记进快照，否则它第一次内容变化会被当成"第一次见到这篇"
		// 而丢掉那一次的引用消失（症状：新建笔记里删掉一张图的引用，不问）。
		this.registerEvent(this.app.vault.on("modify", (file) => this.orphanFlow?.fileChanged(file)));
		this.registerEvent(this.app.vault.on("create", (file) => this.orphanFlow?.fileCreated(file)));
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				// 删整篇笔记也会让它引用过的图失去引用（缓存副本之类的路径从来不在快照里）
				this.orphanFlow?.noteRemoved(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// 快照跟着搬：改名不是"引用消失"，计数不变
				this.orphanFlow?.noteRenamed(oldPath, file.path);
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
			void this.orphanFlow?.warmUp();

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
	 * 跑一件**异步的**活，并保证**失败一定有人看见**。
	 *
	 * ⚠️ 这条兜底不是"顺手更稳一点"，它补的是一处**真实发生过的静默**
	 *（2026-10-16 用户实测）：命令回调是异步的，它一旦抛（那天是取 `fs` 的写法在宿主里不成立），
	 * 抛出的错就只是控制台里一条 unhandled rejection —— **界面上什么都不发生**。
	 * 用户看到的就是「**点击命令没有反应**」：他既不知道出了什么事，也无从报告。
	 * ⇒ 命令面板那几条**一律**从这里过：日志留完整错误（含堆栈，供排查），
	 * 提示里只给一句可读的话（"哪条命令 + 什么原因"）。
	 *
	 * ⚠️ 用 `Promise.resolve().then(run)` 而不是 `run().catch(...)`：后者只接得住
	 * **异步**失败，`run()` 自己**同步**抛的那一下照样静默（本项目吃过"一半路径有兜底"的亏）。
	 */
	private runCommand(id: string, run: () => Promise<void> | void): void {
		void Promise.resolve()
			.then(run)
			.catch((error: unknown) => {
				console.error(`[attachment-cloud-cache] 命令 ${id} 执行失败`, error);
				new Notice(this.t("cmdFailed", { error: describeError(error) }));
			});
	}

	/**
	 * 注册维护命令（P1 #8/#9/#10）。
	 *
	 * ⚠️ 破坏性命令（清理缓存）**必须先出确认框**，而且要写清"删几个、占多少空间"。
	 * 一条"确定要清理吗"等于让用户闭着眼睛按确认。
	 */
	private registerMaintenanceCommands(): void {
		// ⭐⭐ **唯一**的清理入口（2026-10-16 合并了原来那条「清理云端未使用对象…」）。
		//
		// ## 为什么只留这一条
		//
		// 原命令列的是**整个桶**（要 `ListBucket` 权限、慢、有页数上限），而它的独占能力是
		// "处理**不属于本插件**的对象" —— 那与这条的纪律**直接冲突**：候选的筛除里明写着
		// 「对不属于我们的对象，我们**没有任何处置权** —— 不问，也不删」（`selectOrphanAsks`
		// 的 `not-ours`）。⚠️ 而需求文档里也**查不到**"要处理桶里别人的对象"这个诉求。
		// ⇒ 候选改由**上传台账**产生（快、不需要列举权限、清单完整），并**继承了**那条命令
		// 唯一的正面贡献：**站外缓存的对象一律排除**（它的引用可能写在别处 —— 链接改写失败时
		// 笔记里留着的是**原来的站外地址**，而按 URL 回算 key 的判据根本认不出它）。
		//
		// ## 它同时是"那次询问被误关"的解药
		//
		// 三档询问**只自动出现一次**（冷却记住之后不再问），而弹窗可能被误关
		//（用户 2026-10-14 在 Android 上："点一下边上就不见了"）⇒ 他需要一条能自己重来的路。
		this.addCommand({
			id: "check-orphans",
			name: this.t("cmdCheckOrphans"),
			callback: () => this.runCommand("check-orphans", () => this.orphanFlow?.checkNow()),
		});

		this.addCommand({
			id: "upload-attachments",
			name: this.t("cmdUploadAttachments"),
			callback: () => this.runCommand("upload-attachments", () => this.runUploadAttachments()),
		});

		// ⭐ 附件管理（R24 / F22）：一个常驻视图 —— 列表 ＋ 筛选 ＋ 批量动作。
		// ⚠️ 它与上面两条命令**并存**是暂时的：R24 要求最终只留这一条（CR-02），
		// 而那一步必须等视图在真机上验过（旧入口一删就没有回退路）。
		this.registerView(GALLERY_VIEW_TYPE, (leaf) => new GalleryView(leaf, this.flowContext()));
		this.addCommand({
			id: "manage-attachments",
			name: this.t("cmdManageAttachments"),
			callback: () => this.runCommand("manage-attachments", () => this.openGallery()),
		});
	}

	/**
	 * 打开（或聚焦）附件管理视图。
	 *
	 * ⚠️ **不能**只试右侧栏：`getRightLeaf(false)` 在没有右侧栏（用户折叠了 / 工作区刚重置）时
	 * 返回 `null` ⇒ 命令点了**毫无反应**、也没有任何提示。真机踩过：同一份构建，一次能开一次不能开，
	 * 差别只是工作区里有没有右侧栏。
	 * ⇒ 依次退：已开的 leaf → 右侧栏 → **主区域新标签页** → 真不行就明确说一句。
	 */
	private async openGallery(): Promise<void> {
		const workspace = this.app.workspace;
		const existing = workspace.getLeavesOfType(GALLERY_VIEW_TYPE)[0];
		if (existing) {
			await workspace.revealLeaf?.(existing);
			return;
		}
		const leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
		if (!leaf) {
			new Notice(this.t("galleryNoLeaf"));
			return;
		}
		await leaf.setViewState({ type: GALLERY_VIEW_TYPE, active: true });
		await workspace.revealLeaf?.(leaf);
	}

	private maintenanceDeps(): MaintenanceDeps {
		return {
			app: this.app,
			settings: () => this.settings,
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			// ⭐ 本机文件的"还在不在"探测（列表阶段用：只 `stat`、不读内容）——
			// 缺了它，清单会开始列"点了一定失败"的条目（用户 2026-10-16 实测报的）。
			localFileExists: (path) => localFileExists(path),
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
						// ⭐ 上传前先问云端"这个对象在不在"：宿主撞名另落的那一份
						// （`照片 1.png`）本机台账可能答不上来，而它的字节**几乎肯定**
						// 早就在云端了 ⇒ 与其重传整份，不如问一句。见 `ingest.ts` 第 2c 步。
						// ⚠️ 只有这条路（批量 / 新增附件接管）会传：粘贴与站外缓存两条路
						// 不产生 `twinPath`，那个前提不成立，问了也不会被用上。
						probeRemote: (key) => this.probeRemoteObject(key),
						notify: (message) => new Notice(message),
						// ⚠️ 文案由这一层给：核心层只决定"说哪一句"（见 `IngestDeps.t`）
						t: (key, params) => this.t(key, params),
					},
					request
				);
			},
			// ⚠️ 复用「上传外部文件…」那条链，而不是另写一套下载+上传：
			// 于是同意复核、失败分类、"URL 在笔记里总是字面出现"那几条纪律只有一份实现。
			cacheExternal: (url, notePath) => this.cacheExternalImage(url, notePath),
			// ⭐ 淘汰本地副本前的**云端复核**（HEAD）：确认对象此刻真的还在。
			// 删文件前的安全线 —— 答不上来（离线、出错）一律当作"没有"，于是不删。
			confirmRemote: (key) => this.isObjectInCloud(key),
			// ⭐⭐ "这份副本还有人在用吗"的**另一半**：笔记/画布**直接指着**的库内路径。
			// ⚠️ 缺了它，笔记正在显示的那份副本会被报成"没有任何笔记引用"
			//（占用报告会骗人）、后台淘汰还会把它排到最前面（见 `audit.ts` 的 `referencedPaths`）。
			referencedPaths: (notes) =>
				referencedVaultPaths(this.app, { notes, debug: this.settings.debugLogging }),
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
	 * 设置页那个按钮的入口（F18 的**手动**入口）。
	 *
	 * ⚠️ 与"切档时的那次询问"共用同一个流程（`releaseLocalSpace`），
	 * 差别只在"没有可清项时要不要出声"：手动入口必须说一声（他是特地来的）。
	 */
	async freeUpLocalSpace(): Promise<void> {
		await releaseLocalSpace(this.flowContext(), "notice");
	}

	/**
	 * 「把链接改回本地路径」（**退出路径**）：不删云端、不删本地，只把笔记里的 URL 换回库内路径。
	 *
	 * ⚠️ 与 `freeUpLocalSpace` 方向**正好相反**，两者名字必须能一眼分开：
	 * 那个删本地副本腾空间，这个把笔记改回指着本地那份、一个文件都不删。
	 */
	async revertLinksToLocal(): Promise<void> {
		await revertLocalLinks(this.flowContext());
	}


	/**
	 * 跑一轮索引自愈（**只剩后台这一条线**：两轮确认）。
	 *
	 * ⚠️ 2026-10-16：「自检并修复本地副本索引」命令退役 ⇒ 原先给命令用的两个参数
	 * **都没有了生产者** ⇒ 一并删掉（`CONFIRM_IMMEDIATELY` 也随之删除）：
	 * - `silent`：让这一层不出声、由命令自己回话；
	 * - `immediate`：**单轮即摘**（显式动作、用户正等着结果，让他按两次才是坏体验）。
	 *
	 * ⭐ 后果如实记：**"立刻核一遍"这条能力现在没有入口** —— 剩下的只有这一条
	 * 「第一次判'不在'只标记、下一轮仍不在才摘」的线。那不是保守过头：
	 * 换设备 / 同步进行中时"这一轮读不到"很常见，一次就摘会把**还在路上**的记录
	 * 一起删掉（新设备上那可能就是整份索引）。
	 */
	private runIndexSelfHeal(): Promise<SelfHealResult> {
		return runSelfHeal({
			entries: () => this.currentIndex().toArray(),
			exists: (path) => vaultPathExists(this.app, path),
			forget: (key) => this.currentIndex().remove(key),
			persist: () => this.hostContext().persistIndex(),
			// 确认器的状态在**进程内**（见 `createAbsenceConfirmer` 的取舍）。
			confirmAbsent: this.absenceConfirmer,
			// ⚠️ 不分叉两套逻辑：`runSelfHeal` 自己只在"真的修了东西"时通知，0 条不打扰。
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			yieldNow: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
			onError: (error) => console.error("[attachment-cloud-cache] 索引自愈出错", error),
		});
	}






	/**
	 * **被引用着**的文件路径集合（宿主的链接索引 + 我们自己扫的画布文本）。
	 *
	 * 这条命令跑完**不搬动原文件**（1.2.0 起副本就是原地那份；早先承诺的"移进缓存目录"已取消），
	 * 所以"搬谁"仍必须由**引用**决定：
	 * 引用会被同一条命令改写成远端地址，而没有任何引用的文件我们一概不碰。
	 *
	 * ⚠️ 两条来源**都要看**（需求 R16：画布与笔记同等算数）：
	 * - 宿主的链接索引（`resolvedLinks`）—— 覆盖笔记里的所有写法；
	 * - **画布文本节点**里自己扫出来的目标 —— 那部分是文本内容，宿主是否索引没有保证
	 *   （取证点 E-1c），少了它"只被画布文本引用的附件"会永远不被处理。
	 *   多出来的候选由后续判据兜底，**少掉的那些才是真缺陷**。
	 */

	/**
	 * 问云端"这个对象在不在"（HEAD）：在 ⇒ 返回它的 etag；不在、或问不动 ⇒ `null`。
	 *
	 * 两个消费者，**失败方向一致**（答不上来就当作"没有"）：
	 * ① 淘汰本地副本前的复核 —— 见 {@link isObjectInCloud}（不确定 ⇒ 不删）；
	 * ② 上传前判断"这份字节要不要真的传" —— 见 `IngestDeps.probeRemote`（不确定 ⇒ 传）。
	 *
	 * ⚠️ 任何异常（离线、鉴权、404 之外的服务端错）一律 `null`。
	 * 两处都不能把"问不到"当成"在"或"不在"以外的第三种答案 —— 那正是本项目反复吃过的亏：
	 * 判据要么给出真实答案，要么明确落回安全的那一侧。
	 */
	private async probeRemoteObject(key: string): Promise<string | null> {
		const client = this.buildClient();
		if (!client) return null;
		try {
			const head = await client.headObject(key);
			return head ? head.etag : null;
		} catch (error) {
			console.debug(`[attachment-cloud-cache] 云端探测失败（按"不存在"处理：${key}）`, error);
			return null;
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
		return (await this.probeRemoteObject(key)) !== null;
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
		this.orphanFlow?.dispose();
		this.orphanFlow = null;
		this.backgroundTasks?.dispose();
		this.backgroundTasks = null;
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
	/**
	 * 本地副本的**索引口径**汇总（R10 / D-79：设置页那一行用）。
	 *
	 * ⚠️ 刻意**只读索引**、不逐个 `stat`：设置页是同步渲染的，几千份副本逐个问磁盘
	 * 会让打开设置卡住；而这里要回答的是「大概占了多少」，不是「哪一份真的在」。
	 * 界面上那句话也照实说「约」与「来自索引」。
	 *
	 * ⚠️ **不报"可回收"**：那要判断"还有没有人引用"，得读一遍全库正文（秒级）——
	 * 而这正是 D-75 撤掉那条"占用报告"命令的原因（数字是估算，用户真正要做的决定
	 * 是"清哪些"）。要看可回收的东西，跑「清理附件」，那里逐行列着。
	 */
	localCopyUsage(): { count: number; bytes: number } {
		let count = 0;
		let bytes = 0;
		for (const entry of this.currentIndex().toArray()) {
			// 没有 `cachePath` 的条目不是副本（只有台账记录）
			if (!entry.cachePath) continue;
			count += 1;
			bytes += entry.size;
		}
		return { count, bytes };
	}

	private currentIndex(): CacheIndex {
		return this.indexStore?.index ?? new CacheIndex();
	}

	/**
	 * 索引里任意一条对象的 key —— 供设置页验证「笔记里那条公开链接，**别人**打得开吗」。
	 *
	 * 没有则返回 `null`（还没上传过任何东西）。⚠️ 它只认**索引**：索引不是事实 —— 所以
	 * 这条**只供自动探测**用（一次匿名 HEAD、零写入）。按钮那条路（{@link runConnectionProbe}）
	 * 自带探针对象，与库里有没有东西无关。
	 */
	sampleObjectKey(): string | null {
		return this.currentIndex().keys()[0] ?? null;
	}

	/**
	 * 「别人能不能打开我笔记里那条链接」的**当前认知**（1.7.0）。
	 *
	 * 设置页用它把探测结论原样显示出来（含"还没探测过"），渲染/下载判定用同一份。
	 */
	currentAccessProbe(): AccessProbe {
		return this.lastProbe;
	}

	/** 当前的**连接状态**（公开 / 私有 / 无法访问 / 检测中）—— 设置页与判定层读它。 */
	currentConnectionState(): ConnectionState {
		return this.connectionState;
	}

	/**
	 * 匿名探测一次并**更新**认知。两个调用方，两条**不同**的路：
	 *
	 * | 谁 | 怎么做 | 写桶吗 |
	 * |---|---|---|
	 * | 自动探测（启动 / 保存设置） | 借**索引里已有**的对象发一次匿名 HEAD | ❌ 一次都不写 |
	 * | 「测试连接」（{@link runConnectionProbe}） | **探针回路**：写一个几十字节的对象 → 读回核对 → 匿名读 → 删掉 | ✅ 只在按钮里 |
	 *
	 * ## 四条刻意的边界
	 *
	 * 1. **匿名探测本身不需要凭据**（"桶是不是公开的"在配置阶段就该知道）。只有探针回路那三步
	 *    要凭据 —— 而那时设置页的第一步 `headBucket` 已经证明凭据可用了。
	 * 2. **没有对象可试** ⇒ 认知退回 `UNKNOWN`（而不是沿用上一次的结论）：这可能是
	 *    用户刚换了桶 / 清空了库，用旧结论去决定新地址的路径是错的。
	 * 3. **探测期间配置又变了** ⇒ 丢弃这次结果（`probedUrl` 对不上）。否则会拿
	 *    旧地址的结论决定新地址走哪条路，而那种错误只表现为"图时好时坏"。
	 * 4. ⭐ **自动探测绝不写桶、也不列举**：它可能每敲一个字符跑一次，回答的只是
	 *    "渲染该走哪条路"。需要更全的结论（写/读/删三段）时，用户点那个按钮。
	 *
	 * ⚠️ 这里只做**自动探测**（借索引、零写入）。用户点按钮走 `runConnectionProbe()` ——
	 * 那是另一条路（回路 + 把这一次的结果交回界面），不是这个函数的一个开关。
	 */
	async refreshAccessProbe(): Promise<AccessProbe> {
		// 自动探测：只认索引里已有的对象。索引空 ⇒ 不知道（按私有处理），
		// ⚠️ **不**为了它去列举或写桶。
		const indexedKey = this.sampleObjectKey();
		const url = probeUrlFor(this.settings.s3, indexedKey);
		if (!indexedKey || !url) return this.forgetAccessProbe();

		// 地址没变、且已经有一个结论 ⇒ 不重复发请求（保存设置可能是每个字符一次）。
		// ⚠️ 只有自动探测会走到这里；按钮那条路每次都真写一次，不需要「强制刷新」这种开关 ——
		// 一个此后再没人用的参数只会让下一个人以为它还有用。
		if (url === this.probedUrl && this.lastProbe.kind !== "unknown") {
			return this.lastProbe;
		}
		return this.recordAccessProbe(url);
	}

	/**
	 * 「测试连接」的入口：跑**一轮**探针回路，把**这一次**的结果交回调用方。
	 *
	 * ## 三件事一起保证（这就是"快速连点偶尔弹出错误结果"那个缺陷的修法）
	 *
	 * 1. **单飞**：同一时刻只允许一轮回路。两轮会抢同一个固定 key —— 后一轮的 DELETE 可能
	 *    落在前一轮的匿名 HEAD 之前，让前一轮看到 404（"对象不在，多半前缀写错了"），
	 *    一条**假的**结论。连点、或设置页被重渲染后按钮又能点，都会撞上。
	 * 2. **结果属于这一次**：`{ probe, sample, url }` 都是本次运行的局部值。界面若去读全局字段
	 *    （`currentAccessProbe*`），并发时可能读到**另一轮**的 memo —— 对象名 / 字节数对不上，
	 *    而界面上看不出来。
	 * 3. **全局那一格照样写**：渲染判定要它（`recordAccessProbe` 里那一处）。
	 */
	async runConnectionProbe(): Promise<ConnectionProbeResult> {
		return this.runSingleConnectionProbe();
	}

	/** 单飞包装：并发调用共用同一轮（`probe-sample.ts::singleFlight`，锚点在那里）。 */
	private readonly runSingleConnectionProbe = singleFlight(() => this.connectionProbeOnce());

	/**
	 * 「测试连接」第二步：**临时放一个几十字节的对象，写一次、读一次、删掉**。
	 *
	 * ## 为什么要走完整回路
	 *
	 * 三步各自对应插件的一件真实能力，任何一件不通它都是坏的：
	 *
	 * | 段 | 对应能力 | 坏了的症状 |
	 * |---|---|---|
	 * | PUT 探针对象 | 上传附件 | 粘贴/上传全失败 |
	 * | 签名 GET 读回 | 取回本地副本 / 离线渲染 | 「上传成功但图显示不出来」 |
	 * | 匿名 HEAD | **别人**打得开链接吗 | 发给别人的链接全是死链 |
	 * | DELETE 探针对象 | 云端清理 / 腾空间 | 桶里越积越多 |
	 *
	 * 借一条**已有的**对象只能测到第 3 段 —— 只有读权限的密钥会全绿通过，然后第一次上传就失败。
	 * 所以这里每次都真做一遍（用户点的这一下，多几次往返换一个"确凿"）。
	 *
	 * ## 读回为什么比"PUT 返回 200"更有价值
	 *
	 * `putObject` 自带的传后校验只问服务端"你记了多少字节"（HEAD），本方法问的是
	 * "**我把字节取回来**还对得上吗" —— 它顺带证明了 `GetObject` 权限，而那正是
	 * 私有桶渲染 / 离线副本要用的权限。⚠️ 读不回来**不影响**下一段：匿名那一问
	 * 与凭据无关，照样要问（两个结论都属于这次测试）。
	 */
	private async connectionProbeOnce(): Promise<ConnectionProbeResult> {
		const client = this.buildClient();
		// ⚠️ **每轮一个新 key**：固定 URL 会被中间层缓存，测出来的就不是权限而是缓存（见 `tempProbeKey`）。
		const key = tempProbeKey();
		const url = probeUrlFor(this.settings.s3, key);
		if (!client || !url) {
			this.forgetAccessProbe();
			return { probe: this.lastProbe, sample: null, url: null, state: this.connectionState };
		}

		const body = utf8Bytes(TEMP_PROBE_BODY);
		const memo: ProbeRoundTripMemo = { key, leftBehind: false };

		const outcome = await runWithTempProbeObject({
			key,
			put: async (probeKey) => {
				await client.putObject(probeKey, body, "text/plain");
			},
			remove: (probeKey) => client.deleteObject(probeKey),
			measure: async () => {
				// ② 读一次（**带签名**）：字节对得上才算"写成功了"，顺带证明 GetObject 权限
				try {
					const back = await client.getObject(key);
					memo.readBytes = back.data.length;
					if (back.data.length !== body.length) {
						memo.sizeMismatch = { written: body.length, read: back.data.length };
					}
				} catch (error) {
					// 读不回来**不中断**：匿名那一问与凭据无关，照样要问
					memo.readError = error;
				}
				// ③ 匿名读一次：别人打得开吗（这一步不写任何东西）
				//
				// ⚠️ **直接发，不走 `recordAccessProbe`**（2026-10-18 用户报「公开 / 私有交替出现」）：
				// 那个方法是给**自动探测**设计的 —— 它带一道"地址变了这次结论就作废"的闸门，并且与
				// 自动探测**共用** `lastProbe`。用在用户手点的这一下上，会拿到**另一轮**（甚至很久以前）
				// 的结论。用户点的这一下必须**只属于这一下**。
				//
				// ⚠️⚠️ 而且**不能只看状态码**：真机复现过「同一个桶、同一时刻，固定 key 的匿名 HEAD
				// 回 200，而内容哈希 key 回 403」—— 2xx 可能来自中间层。唯一可信的证据是
				// **把字节取回来、和写进去的比**（探针对象只有几十字节）。
				const toProbe = (anon: PublicContentProbe): AccessProbe => {
					const sameBody =
						anon.bytes !== null &&
						anon.bytes.length === body.length &&
						anon.bytes.every((byte, i) => byte === body[i]);
					const bodyMatches = anon.bytes !== null ? sameBody : anon.lengthMismatch ? false : undefined;
					return {
						kind: classifyPublicReach(anon.status, anon.contentType, bodyMatches),
						status: anon.status,
						at: Date.now(),
						contentType: anon.contentType,
						...(bodyMatches === undefined ? {} : { bodyMatches }),
					};
				};

				// ⚠️ **问两次**（串行，不是并发：并发更可能落到同一个后端上）。
				// 真机实测过「同一个桶、同一时刻，一次读得到、一次读不到」—— 一次成功不足以
				// 证明"别人打得开"，而把一次偶然写成「公开访问」正是用户 2026-10-18 报的那个错。
				// 两次结论不一致 ⇒ `unstable`（不改判），界面提示去查网关 / 反代。
				const first = toProbe(await probePublicContent(url, body.length));
				const second = toProbe(await probePublicContent(url, body.length));
				const probe: AccessProbe =
					first.kind === second.kind
						? first
						: { kind: "unstable", status: first.status, at: Date.now(), contentType: first.contentType };
				// 只更新诊断用的那一格，**不动 `probedUrl`**（那是自动探测的缓存键，混进来会让
				// 自动探测误以为"地址没变"而跳过真正该发的那次请求）。
				this.lastProbe = probe;
				return probe;
			},
		});

		if (!outcome.placed) {
			// ① 写不进去 ⇒ **回路没跑起来**。原始错误交回界面归类 —— 它才知道怎么说人话
			//（"连接正常但写不进去"与"网络不通"是两句不同的话，修法也不同）。
			this.probedUrl = null;
			this.lastProbe = UNKNOWN_ACCESS_PROBE;
			// 写不进去 ⇒ 插件做不了它该做的事（上传）：状态按"无法访问"说，别让界面绿着。
			this.connectionState = "unreachable";
			const failed: ProbeRoundTripMemo = { ...memo, writeError: outcome.putError };
			return { probe: this.lastProbe, sample: failed, url, state: this.connectionState };
		}

		// ④ 删掉（在 `finally` 里做的），结果回填到**同一条记录**上
		memo.leftBehind = outcome.leftBehind;
		const probe = outcome.value ?? this.lastProbe;
		// ⑤ 用**这一轮**的实测更新状态：匿名能读 ⇒ 公开；否则签名能读 ⇒ 私有；都不行 ⇒ 无法访问
		//（`missing` = 公开前缀可能写错了 ⇒ 不改判，界面会单独提示）
		const next = stateAfterRoundTrip({ anonymous: probe, signedReadOk: memo.readError === undefined });
		if (next) {
			this.connectionState = next;
			// 状态变了 ⇒ 之前"按私有处理"的结论作废（地址还是那条，缓存键照样记）
			this.probedUrl = url;
		}
		// ⚠️ 用本轮的 `next`（推不出来才回落到全局）：返回的 state 与 probe 必须**同源**，
		// 否则界面可能把「这一轮的证据」与「另一轮的状态」拼在一起（那正是「交替」的观感）。
		return { probe, sample: memo, url, state: next ?? this.connectionState };
	}

	/**
	 * 发一次匿名探测、过一遍"配置没变"的闸门，并把结论写进**唯一那一格**。
	 *
	 * 两件事必须在**同一处**做：`probedUrl` 既是"地址没变就别重复发"的缓存键，
	 * 也是"这次结论还属于当前配置吗"的凭据。分成两处写，就会出现
	 * "结论属于旧地址、却被当成新地址的结论"—— 那类错误只表现为"图时好时坏"。
	 *
	 * ⚠️ 界面**不读**这里写下的东西（它拿 `runConnectionProbe()` 的返回值）：
	 * 并发时全局那一格可能已经被另一轮覆盖。
	 */
	private async recordAccessProbe(url: string): Promise<AccessProbe> {
		this.probedUrl = url;
		const probe = await probeAccess(url);
		// 探测期间配置变了 ⇒ 这次结论不属于当前配置
		if (this.probedUrl !== url) return this.lastProbe;
		this.lastProbe = probe;
		// ⭐ 自动探测只问"匿名能不能读"：ok ⇒ 公开，403 ⇒ 私有，连不上 ⇒ 无法访问
		this.connectionState = stateAfterProbe(this.connectionState, probe);
		return probe;
	}

	/**
	 * 记录一次「**这次真的没连上**」—— 设置页第一步 `headBucket` 就失败（桶不存在 /
	 * 网络 / 凭据被拒）时由它调用。
	 *
	 * 为什么不让界面自己把状态写死：状态只有一份、判据只有一处（`link-access.ts`），
	 * 界面自己写会立刻造出两份结论，而症状正是\"测试说连不上、图却照旧走远端地址\"。
	 *
	 * ⚠️ 只用于**实测失败**：配置还没填完（`testFail_notReady`）不算 —— 那种情形下
	 * 凭据一次都没发出去，说\"无法访问\"是我们没验过的结论。
	 */
	noteConnectionUnreachable(): ConnectionState {
		// 这次没有任何测量 ⇒ 旧的探测结论与缓存键都作废（下次自动探测要真的再问一次）。
		this.probedUrl = null;
		this.lastProbe = UNKNOWN_ACCESS_PROBE;
		this.connectionState = "unreachable";
		return this.connectionState;
	}

	/** 忘掉上一次探测的结论（没有对象可试 / 配置不完整）：降级方向是"按私有处理"。 */
	private forgetAccessProbe(): AccessProbe {
		this.probedUrl = null;
		this.lastProbe = UNKNOWN_ACCESS_PROBE;
		// 没有对象可试 ⇒ 退回"还没问出来"（按私有处理），**不**沿用上一次的公开结论
		this.connectionState = INITIAL_CONNECTION_STATE;
		return this.lastProbe;
	}

	/**
	 * 安排一次探测（**防抖**）。`saveSettings` 每次改动都会调它 —— 包括每敲一个字符。
	 *
	 * 为什么不直接 `void this.refreshAccessProbe()`：那会在用户手打端点地址时
	 * 每敲一个字符发一条 HEAD（每条最多等 5 秒），既是噪音也是浪费。
	 */
	scheduleAccessProbe(delay = 800): void {
		if (this.accessProbeTimer !== null) window.clearTimeout(this.accessProbeTimer);
		this.accessProbeTimer = window.setTimeout(() => {
			// ⚠️ **不把字段置空**：卸载时那个 cleanup 要能对一个确定的句柄调 `clearTimeout`
			// （对已触发的 id 调用是安全的空操作）。置空会让"清理是否真的生效"取决于时机。
			void this.refreshAccessProbe().catch((error: unknown) => {
				// 探测自己不会抛（见 `probeAccess`）；这里是最后一道，只为不留下未处理的拒绝
				console.error("[attachment-cloud-cache] 更新访问方式探测结果失败", error);
			});
		}, delay);
	}

	/**
	 * 从一份**凭据文件**导入连接参数（MinIO 控制台「下载凭据」给的那个 json）。
	 *
	 * ⚠️ 这里是**薄转发**，实现在 `plugin/credentials-flow.ts`。保留这个公开方法，是因为
	 * 有**两条**路径指着它：设置页（`ui/settings-tab.ts`）与**真机探针**
	 * —— 探针直接调它而不去点界面（点界面测的是"按钮接对了没有"，调它测的是"导入做了什么"）。
	 */
	async importCredentialsFile(text: string): Promise<ImportCredentialsOutcome> {
		return runCredentialsImport(
			{
				secretStorage: this.app.secretStorage,
				settings: this.settings,
				saveSettings: () => this.saveSettings(),
			},
			text
		);
	}

	/**
	 * 按**当前**设置与钥匙串造一个客户端（薄转发，实现在 `plugin/credentials-flow.ts`）。
	 *
	 * 复用 `connectionReadiness`（设置页的"测试连接"用的是同一个判定）⇒
	 * 界面上说"能连"和实际上传/下载用的是同一套判据，不会出现
	 * "测试连接成功但粘贴报未配置"这种自相矛盾的表现。
	 */
	private buildClient(): S3Client | null {
		return buildClientFrom(this.app.secretStorage, this.settings);
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
	/**
	 * 「这一格不是图片」的三条来路，分别交给重建队列。
	 *
	 * ⚠️ 写成**具名方法**而不是嵌套三元：三条来路的差别不是"要不要重建"，而是
	 * **地址从哪来**（库内路径 / 预签名 / 笔记里那条远端地址）—— 混在一个表达式里，
	 * 加第四条时必然有人漏改一处，而症状只是"某些视频不显示"。
	 */
	private routeNonImageEmbed(element: Parameters<NonNullable<RenderHookDeps["onNonImageEmbed"]>>[0], target: NonImageTarget): void {
		if (target.kind === "local") {
			this.embedQueue().see(element, target.localPath, null);
			return;
		}
		if (target.kind === "signed") {
			this.embedQueue().seeSigned(element, target.key, null);
			return;
		}
		this.embedQueue().seeDirect(element, target.key, target.remoteUrl, null);
	}

	private embedDeps(sourcePath: string | null = null): EmbedRebuildDeps {
		return {
			settings: () => this.settings,
			index: () => this.currentIndex(),
			resourceUrlFor: (path) => resourceUrlFor(this.app, path),
			// ⭐ 1.7.0：私有存储 + 不留副本时，音频/视频改走**预签名地址**（自建节点）。
			// 与图片那条路共用同一份探测结果与同一份签名缓存（`signedUrlFor`）。
			connectionState: () => this.connectionState,
			signedUrlFor: (key) => this.signedUrlFor(key),
			createMediaNode: (kind, url) => this.createMediaNode(kind, url),
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
			// ⭐ 1.7.0：私有存储 + 不留副本时改给预签名地址（图床式，不落盘）。
			// 两个回调都只是转发，判据在 `link-access.ts` / `S3Client` 里。
			connectionState: () => this.connectionState,
			signedUrlFor: (key) => this.signedUrlFor(key),
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
	 * 预签名地址的缓存：`key → {url, 到期时刻}`。
	 *
	 * 为什么要缓存：同一张图会在滚动、切视图、重渲染时被反复赋值，而签名是**异步**的
	 * （SubtleCrypto 的 HMAC 链）。不缓存的话每滚一次都重算一遍，而且每次得到的 URL
	 * 都不同 —— 浏览器会把它们当成不同的资源，**缓存全废**。
	 *
	 * ⚠️ 保存设置就整体清空（端点 / 桶 / 密钥都可能变了，旧签名随之失效）。
	 * 上限只是防御：几千张图的库里不该攒着一个永不回收的表。
	 */
	private signedUrls = new Map<string, { url: string; expiresAt: number }>();

	/**
	 * 一张图在"私有存储 + 不留副本"下要用的**临时地址**（图床式：磁盘不落文件）。
	 *
	 * 失败一律返回 `null`（凭据没配、地址不合法、签名抛错）—— 调用方是渲染路径，
	 * 它会在签不出来时保留远端地址。**绝不抛错**：那会让一张图拖垮整块渲染。
	 *
	 * ⚠️ 这里**不判**"该不该用预签名"：那是 `link-access.ts::usesSignedUrls` 的事，
	 * 由渲染判定在调这里之前问过。两处各判一次必然分叉。
	 */
	private async signedUrlFor(key: string): Promise<string | null> {
		const cached = this.signedUrls.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.url;

		const client = this.buildClient();
		if (!client) return null;

		try {
			const url = await client.presignedGetUrl(key);
			// 缓存留得比签名短：宁可早一点重签，也不要让一张图在有效期边缘忽然坏掉。
			if (this.signedUrls.size >= SIGNED_URL_CACHE_LIMIT) this.signedUrls.clear();
			this.signedUrls.set(key, { url, expiresAt: Date.now() + SIGNED_URL_CACHE_MS });
			return url;
		} catch (error) {
			console.error("[attachment-cloud-cache] 生成预签名地址失败（图将保持远端地址）", error);
			return null;
		}
	}

	/**
	 * 造一个媒体节点（私有 + 不留副本时，音频/视频没有本地文件可用）。
	 *
	 * 与"库内嵌入"那条路的差别如实说：宿主那条会给它套上 `internal-embed` 的包装与样式，
	 * 这里给的是**裸的原生播放器**（`controls` / `preload=metadata`）。功能都在
	 *（播放、进度、音量、全屏、画中画都由浏览器提供），只是外观不完全跟主题一致。
	 *
	 * ⚠️ 宽度用 CSS 收着（`styles.css` 里的 `.acc-signed-media`）：不设上限的话，
	 * 一条 4K 视频会把整篇笔记撑出横向滚动条。
	 */
	private createMediaNode(kind: "audio" | "video", url: string): HTMLElement | null {
		if (!url) return null;
		try {
			return createEl(kind, {
				cls: "acc-signed-media",
				attr: { src: url, controls: "true", preload: "metadata" },
			});
		} catch (error) {
			console.error("[attachment-cloud-cache] 造媒体节点失败（保留原元素）", error);
			return null;
		}
	}

	/**
	 * 索引指向的本地副本其实不存在 → 把这条记录摘掉并落盘。
	 *
	 * 这是**自愈**而不是清理：只改索引，不动任何文件。发生的时机是渲染时
	 * `<img>` 加载失败（用户删了本地副本 —— 那随时可做，是承诺过的）。
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

	/**
	 * 把实例能力组装成流程能吃的上下文（见 `plugin/context.ts`）。
	 *
	 * ⚠️ 每次调用**新建**一个：`settings` 是字段、`loadSettings` 会整体替换它，
	 * 缓存下来会拿到上一份（设置页改完立刻用到的那条路径就会用到旧值）。
	 * 它只是一层转发，开销可忽略。
	 */
	/**
	 * 「上传附件」——**唯一的**批量入口（D-68）。
	 *
	 * ⚠️ 它同时是命令面板那条命令与设置页那个按钮的实现：两处各写一遍就会出现
	 * "命令里带未引用附件、按钮里不带"这类分叉。`public` 是为了让设置页能调
	 * （`flowContext()` 本身仍是 private，装配细节不外泄）。
	 */
	async runUploadAttachments(): Promise<void> {
		await uploadExistingAttachments(this.flowContext());
	}

	private flowContext(): PluginContext {
		return {
			app: this.app,
			manifest: this.manifest,
			settings: this.settings,
			t: (key, params) => this.t(key, params),
			currentIndex: () => this.currentIndex(),
			hostContext: () => this.hostContext(),
			buildClient: () => this.buildClient(),
			fileCards: (items, limit) => this.fileCards(items, limit),
			confirmMaintenance: (options) => this.confirmMaintenance(options),
			pickTasks: (options) => this.pickTasks(options),
			maintenanceDeps: () => this.maintenanceDeps(),
			isDesktop: () => this.isDesktopHost(),
			localThumbUrls: (url) => this.localThumbUrls(url),
		};
	}

	/**
	 * 当前是不是桌面端 —— ⚠️ **全库唯一一处问平台**。
	 *
	 * 只有一件事靠它：`file:///D:/…` 这类**本机绝对路径**只有桌面读得到
	 * （手机端那个路径不存在）。所以判据留在这里（装配点），而**纯判定层收的是结果**
	 * （`decideLocalFile({ isDesktop })`）—— 于是那一层可穷举，测试里也不用去替换宿主标志。
	 */
	private isDesktopHost(): boolean {
		return Platform.isDesktopApp === true;
	}

	/**
	 * 一条库外文件地址 → 清单行里**该用哪些地址当缩略图**（按优先次序）。
	 *
	 * ⚠️ 全库只有这里问 `Platform.resourcePathPrefix`（宿主自己的本地文件前缀：
	 * 移动端 `file:///`、桌面 `app://random-id/`）。理同 {@link isDesktopHost}：
	 * "谁去问宿主"只有一处，流程层与界面层收的是**结果**。
	 *
	 * ⚠️ 三种输入不到位时都会**少给一条候选**而不是抛错（`localPathFromUrl` 解析不出来
	 * 就只剩原地址那一条）—— 判据本身在 `local-file.ts::localThumbCandidates`（纯函数，
	 * 可以穷举）；这里只负责把宿主那一段补上。
	 */
	private localThumbUrls(url: string): string[] {
		return localThumbCandidates({
			url,
			path: localPathFromUrl(url),
			prefix: Platform.resourcePathPrefix,
		});
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
		// 「站外文件也上传到云端」这一个开关（折算规则见 `legacyAutoCacheEnabled`）。
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

		// 访问方式可能刚变（换了桶 / 补了公开前缀 / 关掉了公开读）：
		// 探测结果必须跟着走，否则"判定用的是上一个配置的结论"——表现为图时好时坏。
		// ⚠️ 这条路径每敲一个字符都会被调到，所以是**防抖**的（见 `scheduleAccessProbe`）。
		this.scheduleAccessProbe();

		// 端点 / 桶 / 密钥可能都变了 ⇒ 旧的预签名地址立刻作废（它们签的是旧配置）
		this.signedUrls.clear();

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
			void releaseLocalSpace(this.flowContext(), "silent").catch((error: unknown) => {
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
	 * 上传开始：**延迟**显示状态栏指示（见 `UPLOAD_INDICATOR_DELAY_MS`）。
	 *
	 * 只说"在传几个"，不报百分比 —— 串行上传没有可靠的分母（还会让用户以为卡住了）。
	 */
	private beginUpload(count: number): void {
		if (!this.uploadStatus || count <= 0) return;
		if (this.uploadStatusTimer !== null) window.clearTimeout(this.uploadStatusTimer);
		this.uploadStatusTimer = window.setTimeout(() => {
			this.uploadStatusTimer = null;
			this.uploadStatus?.setText(this.t("statusUploading", { count }));
			this.uploadStatus?.show();
		}, UPLOAD_INDICATOR_DELAY_MS);
	}

	/** 上传结束（**成功与失败都调**，见 `editor-bridge` 的 `finally`）：取消延迟、收起指示。 */
	private endUpload(): void {
		if (this.uploadStatusTimer !== null) {
			window.clearTimeout(this.uploadStatusTimer);
			this.uploadStatusTimer = null;
		}
		this.uploadStatus?.hide();
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
			beginUpload: (count) => this.beginUpload(count),
			endUpload: () => this.endUpload(),
			claimUnconfiguredNotice: () => this.unconfiguredAnnounce(),
		};
	}
}
