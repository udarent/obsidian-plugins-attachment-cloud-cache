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

import { TFile, Notice, Plugin, getLanguage } from "obsidian";

import { SETTINGS_DEFAULTS, mergePluginSettings } from "./settings";
import type { PluginSettings } from "./types";
import { detectLocale, translate } from "./i18n";
import { SettingsTab } from "./ui/settings-tab";
import { CacheIndex } from "./cache/index";
import { createIndexStore, makeSerializer } from "./host/runtime";
import type { HostContext } from "./host/runtime";
import { createEditorHandlers } from "./host/editor-bridge";
import { auditForCleanup, collectCacheFiles, runBatchUpload, runCleanup, runEviction, scanReferences } from "./maintenance/run";
import type { MaintenanceDeps } from "./maintenance/run";
import { createCacheRotator } from "./maintenance/rotation";
import type { CacheRotator } from "./maintenance/rotation";
import { selectExternalUploadCandidates, selectUploadCandidates } from "./maintenance/batch";
import type { NoteTextLike } from "./maintenance/batch";
import { ingestAttachment } from "./core/ingest";
import { confirmWithModal } from "./ui/confirm-modal";
import type { ConfirmOptions } from "./ui/confirm-modal";
import { keyFromUrl } from "./render/render-target";
import { createS3Client } from "./s3/client";
import type { S3Client } from "./s3/client";
import { connectionReadiness } from "./s3/credentials";
import { createLocalCopyEnsurer } from "./core/download";
import type { LocalCopyOutcome } from "./core/download";
import { installImageSrcPatch, processImages } from "./render/render-hook";
import type { ImageElementLike, RenderHookDeps } from "./render/render-hook";
import { createSiteStore } from "./host/site-store";
import { SiteDecisions } from "./render/site-decisions";
import { createExternalHook } from "./render/external-hook";
import type { ExternalAskChoice, ExternalAskInfo, ExternalHook } from "./render/external-hook";
import { createExternalLiveQueue } from "./render/external-live";
import type { ExternalLiveQueue, OpenViewLike } from "./render/external-live";
import { createExternalCacher } from "./core/external-cache";
import { askExternalCacheWithNotice } from "./ui/external-notice";

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

export default class AttachmentCloudCachePlugin extends Plugin {
	settings: PluginSettings = { ...SETTINGS_DEFAULTS };
	locale = "en";

	/** 索引的读写（含串行化落盘）。`onload` 里初始化。 */
	private indexStore: ReturnType<typeof createIndexStore> | null = null;

	/**
	 * 补齐器（回退下载）。**必须是稳定的一份**：它的并发去重表挂在闭包里，
	 * 每次新建就等于没有去重 —— 一屏里同一张图会被下载 N 次。
	 */
	private ensureLocalCopy: (key: string, remoteUrl: string) => Promise<LocalCopyOutcome> = async () => ({
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

	/** 站点决定记忆的持久化。**稳定单例**（`load()` 之后对象会换，所以要现取）。 */
	private siteStore: ReturnType<typeof createSiteStore> | null = null;

	/** 站外缓存的编排。**必须是稳定的一份** —— 去重表挂在它的闭包里。 */
	private externalHook: ExternalHook | null = null;

	/**
	 * 实时预览下的站外图：`src` 拦截上报候选 → 攒批 → 延后解析归属 → 交给上面那份编排。
	 *
	 * ⚠️ 必须是**稳定的一份**：待处理的那批挂在上面的闭包里。
	 * 而且不能省 —— 后处理器**在实时预览下不跑**（真机实测 0 次），
	 * 少了这条，编辑态里「缓存外站图片」就完全没有反应。
	 */
	private externalLive: ExternalLiveQueue | null = null;

	/** 缓存上限的自动轮换。同上：节流与并发标志挂在它的闭包里。 */
	private rotation: CacheRotator | null = null;

	/**
	 * 询问接缝。
	 *
	 * ⚠️ 默认是**真实的通知**；入口验收测试会覆写它（真通知在测试里点不了）。
	 * 这条接缝是这条链路唯一能被端到端驱动的地方 —— 没有它，
	 * "用户选「缓存」之后到底发生了什么"就只能靠单元套件间接推断。
	 */
	askExternalCache: (info: ExternalAskInfo) => Promise<ExternalAskChoice> = (info) =>
		askExternalCacheWithNotice({
			message: this.t("externalAskMessage", { host: info.host }),
			cacheLabel: this.t("externalAskCache"),
			neverLabel: this.t("externalAskNever"),
		});

	async onload(): Promise<void> {
		await this.loadSettings();
		// ⚠️ 语种要在**注册设置页之前**定下来 —— 设置页在 `display()` 里取文案，
		// 若此时 locale 还是初始的 "en"，中文用户第一次打开会看到英文界面。
		this.locale = detectLocale(getLanguage());

		this.addSettingTab(new SettingsTab(this.app, this));

		await this.loadCacheIndex();
		// 站点决定记忆要**在渲染挂钩子之前**载入：渲染路径上的判定是同步的，
		// 只能读内存 —— 那时读不到记忆就等于"用户答过也照问"。
		this.siteStore = createSiteStore(this.app, this.manifest.dir, this.manifest.id);
		await this.loadSiteDecisions();

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

		this.ensureLocalCopy = createLocalCopyEnsurer({
			app: this.app,
			settings: () => this.settings,
			// 每次现造：用户可能刚在设置页改完/选好密钥，抓快照会让"改了不生效"
			// 以最难查的形式出现。拿不到客户端时返回 null（未配置 → 静默不下载）。
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		});

		// ── 站外图：按站点询问一次，同意后下载 → 上传 → 改写链接 ──
		//
		// ⚠️ 这里是全库**唯一**会下载"别人的图"、也是唯一会**改写用户笔记**的链路。
		// 它的前置条件是"用户明确同意"，而那个同意由 `askExternalCache` 拿到；
		// 执行层还会再复核一次（用户可能在询问与执行之间把功能关掉）。
		const cacheExternalImage = createExternalCacher({
			app: this.app,
			settings: () => this.settings,
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		});

		// ⚠️ 稳定单例：三张去重表（正在问的站点 / 问过的站点 / 正在下载的 URL）
		// 都挂在它的闭包里。每次渲染新建一份 = 没有去重 = 同一篇文章里
		// 同一个站点被反复询问（而渲染会因滚动、切视图而反复发生）。
		this.externalHook = createExternalHook({
			settings: () => this.settings,
			decisions: () => this.siteDecisionsSnapshot(),
			// 同步算：判定层是同步的，而一次渲染里只算一次
			configured: () => connectionReadiness(this.app.secretStorage, this.settings).ready,
			ask: (info) => this.askExternalCache(info),
			remember: (host, decision) => {
				this.siteDecisionsSnapshot().set(host, decision);
				// 落盘失败不该让这次操作算失败（决定在本次会话内已经生效），
				// 所以只记日志 —— 与索引落盘失败的处理方式一致。
				void this.persistSiteDecisions().catch((error) =>
					console.error("[attachment-cloud-cache] 站点决定记忆写入失败", error)
				);
			},
			cache: (url, notePath) => cacheExternalImage(url, notePath),
			onError: (error) => console.error("[attachment-cloud-cache] 站外图片处理出错", error),
		});

		// ⚠️ 后处理器**在实时预览（编辑态）下根本不跑**（真机实测：同一篇笔记
		// 阅读视图触发 5 次、编辑态 0 次），而编辑态是用户待得最久的地方 ——
		// 少了这条，站外图在编辑态里既不问也不缓存，症状是"什么都没发生"。
		//
		// 候选从 `src` 拦截里来（那条路能收到编辑器造的每一张图），
		// 而"这张图属于哪篇笔记"必须**等元素进了 DOM** 之后才问得出来（也是实测的）。
		this.externalLive = createExternalLiveQueue({
			openViews: () => this.openNoteViews(),
			handle: (element, notePath) => {
				// 复用同一个编排（含三张去重表）：容器只有这一个元素。
				// 于是"问过一次"的判断在两条路径之间是**共享**的 —— 同一个站点
				// 不会因为在编辑态和阅读态各渲染一次而被问两遍。
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
			// 复用维护功能那几个函数，而不是另写一套：列目录、扫引用、按设置删文件
			// 都只有一处实现，行为不会因为"从哪条路径进来"而不同。
			collectFiles: () => collectCacheFiles(this.app, this.settings.cacheFolder),
			scanReferencedKeys: async () => (await scanReferences(this.app, (url) => this.keyOfUrl(url))).keys,
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

		// ── 渲染：把属于本存储的图换成本地副本（离线可用的落点）──
		//
		// 两条路径缺一不可：阅读视图（后处理器）与实时预览（setter 拦截）。
		// 只做前者，用户在离线时编辑笔记会看到满屏破图；只做后者，导出与阅读模式不受益。
		//
		// 站外图的询问与缓存也挂在这条路径上（第二个参数 `ctx.sourcePath` 是
		// "该改哪篇笔记"的唯一权威来源 —— 没有它就没法改写，链路也就没有意义）。
		this.registerMarkdownPostProcessor((element, ctx) => {
			// ⚠️ 这里**同步**完成，不 await —— 一旦 await，元素可能已连上 DOM
			// 并开始加载远端图片，"零请求"就不成立了。理由见 render-hook 的头注释。
			processImages(element, this.renderDeps());
			// 站外图：判定同样只查内存记忆（同步），真正的下载/上传是 fire-and-forget。
			this.externalHook?.process(element, ctx);
		});

		const uninstallSrcPatch = installImageSrcPatch(
			{
				...this.renderDeps(),
				// 站外候选只从**这条路**上报：阅读视图那边的外站图由上面的后处理器
				// 整批交给编排（那里天然带着 `ctx.sourcePath`，不需要延后解析归属）。
				onExternalSrc: (element) => this.externalLive?.see(element),
			},
			{
				view: typeof window === "undefined" ? null : window,
				log: (error) => console.error("[attachment-cloud-cache] 改写图片地址时出错", error),
			}
		);
		// 卸载时把原 setter 放回去 —— 插件卸载后还在改全局 prototype 是最典型的
		// "卸载不干净"，而且症状出现在**别的插件**身上，极难归因。
		this.register(() => uninstallSrcPatch());

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
			id: "repair-index",
			name: this.t("cmdRepairIndex"),
			callback: () => void this.repairIndex(),
		});

		this.addCommand({
			id: "clean-cache",
			name: this.t("cmdCleanCache"),
			callback: () => void this.cleanCache(),
		});

		this.addCommand({
			id: "upload-attachments",
			name: this.t("cmdUploadAttachments"),
			callback: () => void this.uploadExistingAttachments(),
		});
	}

	/** 维护命令共用的依赖装配。 */
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
					},
					request
				);
			},
			// ⚠️ 复用「缓存站外图片」那条链，而不是另写一套下载+上传：
			// 于是同意复核、失败分类、"URL 在笔记里总是字面出现"那几条纪律只有一份实现。
			cacheExternal: (url, notePath) => this.cacheExternalImage(url, notePath),
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
		};
	}

	/**
	 * 站外图的"下载 → 上传 → 改写链接"（批量上传复用同一条链）。
	 *
	 * ⚠️ 这里**刻意不给 `notify`**：那条链默认每张图弹一条通知 —— 按需缓存时是对的
	 * （用户正看着那张图），批量命令里就是刷屏（50 张图 = 50 条）。
	 * 逐张的说明留给"打开那篇笔记"那条路：失败的外链仍然留在笔记里，
	 * 再看它一次就会重新问、也会重新报。命令这边只报总数。
	 */
	private cacheExternalImage(url: string, notePath: string | undefined) {
		return createExternalCacher({
			app: this.app,
			settings: () => this.settings,
			// 每次现造：用户可能刚在设置页改完密钥（与 `ensureLocalCopy` 同一条纪律）
			client: () => this.buildClient(),
			index: () => this.currentIndex(),
			persistIndex: () => this.hostContext().persistIndex(),
		})(url, notePath);
	}

	/** 本存储 URL → key（判定层的推导，维护功能复用同一套）。 */
	private keyOfUrl(url: string): string | null {
		return keyFromUrl(url, this.settings.s3);
	}

	/** 查看缓存占用（只读，不动任何文件）。 */
	private async reportCacheUsage(): Promise<void> {
		const deps = this.maintenanceDeps();
		const { audit } = await auditForCleanup(deps, (url) => this.keyOfUrl(url));
		const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

		// 上限：0 = 不限制。用一句人话表示，而不是把 0 直接摆给用户看
		// （"上限：0 MB" 会被读成"上限是零"，那是相反的意思）。
		const limit = this.settings.cacheLimitMb > 0
			? this.t("cacheLimitValue", { mb: this.settings.cacheLimitMb })
			: this.t("cacheLimitNone");

		new Notice(
			this.t("maintainUsageReport", {
				total: audit.bytes.total,
				totalMb: mb(audit.bytes.total),
				count: audit.healthy.length + audit.unused.length + audit.orphans.length,
				reclaimableMb: mb(audit.bytes.reclaimable),
				orphans: audit.orphans.length,
				unused: audit.unused.length,
				missing: audit.missingCopies.length,
				limit,
			})
		);
	}

	/** 自检并修复索引（只改索引，不碰任何文件）。 */
	private async repairIndex(): Promise<void> {
		const deps = this.maintenanceDeps();
		const { plan } = await auditForCleanup(deps, (url) => this.keyOfUrl(url));
		const result = await runCleanup(deps, { ...plan, all: [] });

		new Notice(this.t("maintainRepaired", { healed: result.healed, skipped: result.skipped.length }));
	}

	/** 清理未使用的缓存（**破坏性**：先确认，删除不可撤销）。 */
	private async cleanCache(): Promise<void> {
		const deps = this.maintenanceDeps();
		const { plan } = await auditForCleanup(deps, (url) => this.keyOfUrl(url));

		if (plan.all.length === 0) {
			new Notice(this.t("maintainNothingToClean", { healed: plan.healKeys.length }));
			// 没有可清理的对象时仍然自愈（那是零风险的）
			if (plan.healKeys.length > 0) await runCleanup(deps, plan);
			return;
		}

		const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
		// ⚠️ 确认框里那句话是用户按下**不可逆**按钮前唯一读到的安全信息：
		// 它必须说清"删了没法撤销、空间立刻释放"，否则用户会以为还能找回。
		const confirmed = await this.confirmMaintenance({
			title: this.t("maintainCleanTitle"),
			lines: [
				this.t("maintainCleanSummary", { count: plan.all.length, mb: mb(plan.bytes) }),
				...plan.preview,
				...(plan.hidden > 0 ? [this.t("maintainCleanMore", { count: plan.hidden })] : []),
				this.t("maintainCleanSafety"),
			],
			cta: this.t("maintainCleanCta"),
			destructive: true,
		});
		if (!confirmed) {
			new Notice(this.t("maintainCancelled"));
			return;
		}

		const result = await runCleanup(deps, plan);
		new Notice(
			this.t("maintainCleaned", {
				removed: result.removed,
				healed: result.healed,
				skipped: result.skipped.length,
			})
		);
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
		const selection = selectUploadCandidates(files, { settings: this.settings, index: this.currentIndex() });

		// ⭐ 笔记里的**外链图**也算候选：这条命令补的是"把还没进你自己存储的图搬进去"，
		// 而指向别处的图同样没进存储 —— 只是它们在别人的服务器上。
		// 判定用的是**按需缓存那一条**（`decideExternalCache`），所以"功能关掉 /
		// 自己的存储 / 回环地址 / 用户标过「不再询问」"全都自动一致，不另立一套标准。
		const external = selectExternalUploadCandidates(await this.readAllNoteTexts(), {
			settings: this.settings,
			decisions: this.siteDecisionsSnapshot(),
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
				? [this.t("maintainCleanMore", { count: selection.paths.length - 10 })]
				: []),
			// ⚠️ 必须说清"原文件不会删" —— 否则用户会以为磁盘会腾出来，
			// 结果发现文件还在，以为命令没生效。
			this.t("maintainBatchKeepsOriginals"),
		];

		if (external.candidates.length > 0) {
			// ⚠️ 必须把**站点**列出来：**这个确认框就是那份授权**（未获明确同意前，
			// 站外图永不下载）。只说"还有 3 张站外图"等于让用户盲签一份许可。
			lines.push(
				this.t("maintainBatchExternal", {
					count: external.candidates.length,
					sites: external.sites.length,
					hosts: external.sites.map((site) => site.host).join(", "),
				})
			);
			if (external.needsConsent) lines.push(this.t("maintainBatchExternalConsent"));
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

		// 点确认 = 对这些站点授权。**必须记在跑之前**：那条链在路上只看记忆，
		// 它并不知道用户答没答过（按需缓存那条路是"先问、问到了才调它"）。
		// 记下来之后，以后看笔记也不会为同一个站点再打扰他。
		if (external.needsConsent) {
			for (const site of external.sites) {
				if (site.needsConsent) this.siteDecisionsSnapshot().set(site.host, "allow");
			}
			void this.persistSiteDecisions().catch((error) =>
				console.error("[attachment-cloud-cache] 站点决定记忆写入失败", error)
			);
		}

		const result = await runBatchUpload(deps, { external });
		new Notice(
			this.t("maintainBatchDone", {
				uploaded: result.uploaded,
				reused: result.reused,
				failed: result.failed,
				notes: result.notesChanged,
				links: result.linksRewritten,
			})
		);
	}

	/**
	 * 读一遍全库笔记的正文（外链扫描要用）。
	 *
	 * 单篇读不到就跳过：这条命令要处理的是**其它**东西，
	 * 不该因为一篇笔记读不了而整条失败（用户只会看到"什么都没发生"）。
	 */
	private async readAllNoteTexts(): Promise<NoteTextLike[]> {
		const notes: NoteTextLike[] = [];
		for (const note of this.app.vault.getMarkdownFiles()) {
			try {
				notes.push({ path: note.path, text: await this.app.vault.read(note) });
			} catch {
				// 跳过这一篇
			}
		}
		return notes;
	}

	/** 抽成方法是为了让测试能替换掉它（真弹窗点不了）。 */
	private confirmMaintenance(options: ConfirmOptions): Promise<boolean> {
		return confirmWithModal(this.app, options);
	}

	onunload(): void {
		// 事件与 prototype 补丁都由 `registerEvent` / `register` 自动撤销，无需手写。
		// 这里只清掉自有引用，避免插件实例被延长引用（热重载时尤其明显）。
		this.indexStore = null;
		this.siteStore = null;
		this.externalHook = null;
		this.externalLive = null;
		this.rotation = null;
	}

	/**
	 * 载入站点决定记忆。
	 *
	 * 读失败**不是**致命错误（`loadSiteDecisions` 已经降级为空记忆）：
	 * 代价只是"用户要重新回答一遍"，而为此让插件起不来完全不成比例。
	 */
	private async loadSiteDecisions(): Promise<void> {
		const store = this.siteStore;
		if (!store) return;
		const result = await store.load();
		if (result.error) {
			console.error("[attachment-cloud-cache] 站点决定记忆读取失败，已按空记忆继续", result.error);
		}
	}

	/** 站点决定记忆的当前快照（设置页与本文件都用它；`load()` 后对象会换）。 */
	siteDecisionsSnapshot(): SiteDecisions {
		return this.siteStore?.decisions ?? new SiteDecisions();
	}

	/** 清掉全部已记住的站点；返回清掉的条数（设置页据此汇报）。 */
	clearSiteDecisions(): number {
		const cleared = this.siteDecisionsSnapshot().clear();
		// ⚠️ 清完还要让**当前打开着的笔记重新走一遍判定**：记忆虽然空了，
		// 但已经渲染出来的那些图不会自己重跑 —— 用户点完「清除」什么都看不到，
		// 只会以为按钮坏了（实测踩到过：清完记忆，站外图再也不问了）。
		this.reprocessOpenNotes();
		return cleared;
	}

	/**
	 * 让当前打开着的笔记重新走一遍站外图判定。
	 *
	 * 复用 `externalLive` 那条路（它自带攒批、以及"等元素进 DOM 之后再解析归属"），
	 * 而不是另写一套扫描：于是"哪张图属于哪篇笔记"、去重表、错误隔离都只有一份实现。
	 *
	 * 属于本存储的图会被判定层直接忽略（`app://` 不是 http(s)），所以多走一遍是安全的 ——
	 * 真正会被处理的只有站外图，而它们本来就该在记忆变化之后重新判定一次。
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

	/** 把记忆落盘（串行化，避免两次写入互相插队）。 */
	async persistSiteDecisions(): Promise<void> {
		const store = this.siteStore;
		if (!store) return;
		await this.serialize(() => store.save());
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

	/**
	 * vault 相对路径 → 能直接放进 `img[src]` 的地址。
	 *
	 * ⚠️ 用 `Vault.getResourcePath(file)`（要 `TFile`）而**不是**
	 * `adapter.getResourcePath(path)`：后者只声明在 `FileSystemAdapter`
	 * （桌面）与 `CapacitorAdapter`（移动）上，基类 `DataAdapter` **没有**这一项 ——
	 * 用它在移动端会直接抛错。本项目"不做平台假设"的纪律就是这个意思。
	 *
	 * 拿不到文件（不在宿主索引里、或路径不对）时返回 `null`：调用方据此**保持原样**，
	 * 而不是写一个坏地址进去（那会让在线用户也看不到图）。
	 */
	private resourceUrlFor(vaultPath: string): string | null {
		try {
			const file = this.app.vault.getAbstractFileByPath(vaultPath);
			if (file instanceof TFile) return this.app.vault.getResourcePath(file);
		} catch (error) {
			// 宿主实现差异不该让整篇笔记渲染失败
			console.error("[attachment-cloud-cache] 取本地资源地址失败", error);
		}
		return null;
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

	private renderDeps(): RenderHookDeps {
		return {
			settings: () => this.settings,
			index: () => this.currentIndex(),
			resourceUrlFor: (path) => this.resourceUrlFor(path),
			// 渲染钩子只关心"补上了没有、在哪"，所以在这里把结果收敛成路径 ——
			// 让渲染层不必知道下载层那套状态机（downloaded/reused/refused…）。
			ensureLocalCopy: async (key, remoteUrl) => {
				const outcome = await this.ensureLocalCopy(key, remoteUrl);
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
		this.settings = mergePluginSettings(SETTINGS_DEFAULTS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 触发 ③：用户可能刚把上限调小（甚至从"不限制"改成有值），
		// 那时他期待的是"立刻生效"，而不是等下一个周期。
		// ⚠️ 这条路径每次改设置都会被调到（包括每敲一个字符），
		// 所以轮换器自带**节流**，而门槛检查只花一次内存求和 —— 不会变成打字卡顿。
		void this.rotation?.maybeRotate("settings");
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
		};
	}
}
