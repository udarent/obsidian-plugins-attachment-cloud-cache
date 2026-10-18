/**
 * 新增附件自动接管 —— 上传的**第三条入口**。
 *
 * ## 这个模块补的是哪个洞
 *
 * 上传原先只有两个触发点：`editor-paste` 与 `editor-drop`（`editor/editor-hooks.ts`）。
 * 而**手机上把图片加进笔记根本不走这两条路**：底部工具栏的回形针执行的是宿主自己的
 * `editor:attach-file` 命令，它的实现（1.14 宿主字节码实测）是
 *
 *     app.saveAttachment(name, ext, bytes)     // → vault.createBinary(...)  ⭐ 触发 vault.on("create")
 *     fileManager.generateMarkdownLink(file)   // → 生成指向库内文件的链接
 *     editor.replaceSelection("!" + link)      // → 插进笔记
 *
 * 也就是说：文件**先落进库里**，链接**随后**才写进笔记，全程**没有任何插件可见的
 * 粘贴/拖拽事件**。插件对"用户刚加了一张图"一无所知 —— 症状正是
 * 「手机上添加图片附件不会自动上传」。需求文档 R2 原文写的是"粘贴/拖拽即传"，
 * 所以这**不是回归**，是那条需求从来没覆盖过的入口。
 *
 * ## 为什么以 `vault.on("create")` 为入口，而不是做平台分支
 *
 * 上面那三个 API 是**全平台同一份实现**（`app.saveAttachment` 内部就是
 * `vault.getAvailablePathForAttachments` + `vault.createBinary`），所以
 * "库内出现了一个新文件"是一个**与平台无关**的观察点，一次覆盖：
 * 手机相册 / 相机 / 分享菜单 / 桌面把文件拷进库 / 别的插件导出的附件。
 * 附录 A 那条"移动端一等公民、不做平台分支"的原则在这里恰好也是最省事的做法。
 *
 * ## ⚠️ 时序是这里最要紧的事：create 发生在链接之前
 *
 * 实测（宿主字节码：`await saveAttachment` 之后才 `replaceSelection`）：
 * `vault.on("create")` 触发时，**笔记里还没有那条链接**。而接管有一个硬前提 ——
 * **只有被引用着的文件才敢动**：而这一趟会把笔记里的引用改写成远端地址 ——
 * 那是"这一趟确实动过它、而且动干净了"的凭据（与批量命令同一条纪律）。
 * ⚠️ 2026-10-12 起（D-17）上传**不再搬运原文件**（副本就是附件目录里那份原地文件，见设计 §3.4.2 与 §4.1）。
 *
 * 所以判定**不能只在 create 那一刻做一次**，必须退避重试：等笔记落盘、等宿主的链接
 * 索引解析出这条引用，再决定接管。时刻表见 {@link DEFAULT_RETRY_DELAYS_MS}。
 *
 * ## 攒批：一次 create 一个文件，但同一批一起处理
 *
 * 分享 5 张图、桌面一次拷进 3 个文件，都会连着触发多次 create。逐个上传会把
 * "扫全库求引用集合 + 改笔记"重复 N 次，还会**并发改写同一篇笔记**。
 * 所以攒成一个批次：一次求引用、一次执行、一条通知。
 *
 * ## ⭐ 1.2.0（D-17）：判据从"物理边界"改成"三重簿记"
 *
 * 从前这里有一道**物理**闸门：新文件落在缓存目录里就一定是我们自己的副本
 * （回退下载写的、同步过来的）—— "少了这条，一次同步就能让每台设备互相传一遍"。
 * 取消缓存目录之后，我们的副本与用户的附件**混在同一个目录里**，物理边界没有了，
 * 于是这件事改由三条**可查的簿记**判定（任一命中即终局跳过）：
 *
 * ① **自写台账命中**（`isSelfWrite`）：插件往 vault 里写任何文件之前都会登记
 *    （粘贴的中转文件、回退下载的副本、将来的迁移落点）；
 * ② **索引里已有一条指向这个路径的副本**（`findByCachePath`）：我们自己的副本，
 *    索引在就认得出来；
 * ③ ~~**文件内容在上传台账里** ⇒ 终局跳过~~ —— ⚠️ **2026-10-14 拆掉了这道闸门**，
 *    理由见下。
 *
 * ⚠️⚠️ **为什么 ③ 必须拆（用户 2026-10-14 在 Android 上报的那条缺陷）**
 *
 * ③ 的前提是"它的内容我们早就传过 ⇒ 引用它的是**云端地址** ⇒ 不会再有本地引用出现"。
 * 这个前提在**重复插入同一张图**时是假的：宿主发现同名文件已存在，会另落一份
 * `名字 1.ext`（宿主的唯一化行为，我们拦不住），并**照样往笔记里插一条本地链接**。
 * 于是那一刻的判定是：还没被引用（链接是文件落盘**之后**才写的）+ 内容已在云端
 * ⇒ **终局跳过、不进重试** —— 而 `vault.on("create")` 是唯一入口，此后再没有任何
 * 事件会回头看它 ⇒ 那份文件永远停在本地链接上，既不接管也不提示。
 *
 * 桌面端通常看不出来：1.2 s 后第一轮判定时链接多半已经写好，于是走到"接管"那条路。
 * **Android 上笔记保存 + 元数据解析更慢**，第一轮判定正好落在窗口里 ⇒ 稳定复现。
 *
 * ⇒ 现在的规矩：**"内容已在云端"不再是终局判定，它和普通的新文件一样走退避窗口**
 * （见 {@link DEFAULT_RETRY_DELAYS_MS}）。真正同步到达的副本没有任何本地引用，
 * 窗口走满后照样**静默丢弃**（与从前同样的结局，只是晚 ~10 秒）；而重复插入的那份
 * 会在下一轮拿到本地链接、正常接管。代价是同步文件多白跑几轮，收益是"重复插入"
 * 这条真实路径不再静默失效。
 *
 * ⚠️ 这三条与 N11 那个教训（借**会缺档的**簿记判归属 ⇒ 判据在某一档恒假）
 * 的区别在于：① 由我们自己在写之前登记、② 靠索引，**都不依赖档位**；
 * 而且万一判错也**不是静默失效**：误把自家副本当新附件，走到上传那一步会因为
 * 内容寻址命中已有 key 而**零网络幂等**（见 `core/ingest.ts` 第 2 步）。
 *
 * ⚠️ ③ 只在"文件还没被任何笔记引用"时才问（被引用的文件本来就该接管），
 * 而且失败方向是**不接管**：漏接管一个外部新文件是可恢复的（文件原地不动，
 * 「上传已有的附件」命令随时可补），而误判的代价是让自家副本反复走接管流程。
 *
 * ## 两类"不接管"的处置：静默 + 日志
 *
 * - **上传失败**：不重试。在手机上刷第二条失败通知解决不了问题，重试的正确入口是
 *   「上传已有的附件」命令（它会把原因一次说清）。
 * - **一直没被任何笔记引用**：等满时刻表后**静默丢弃**。这正是"用户把文件拷进库、
 *   却没在笔记里引用它"的常见情形（那种文件搬走只会让人以为丢东西），
 *   把正常操作报成错误比不报更糟。文件仍在库里，命令随时可补。
 */

import type { CacheIndex } from "../cache/index";
import type { PluginSettings } from "../types";
import { describeError } from "../error-text";
import { selectUploadCandidates, type VaultFileLike } from "./batch";

/**
 * 重试时刻表（毫秒，从 create 那一刻起算）。
 *
 * 头一档 1.2 s 是"宿主的自动保存 + 元数据解析"的典型量级（真机实测见维护手册）；
 * 后面拉到 3/6/10 s 是给慢设备与长笔记留余量。**总窗口约 10 秒** ——
 * 再长就变成"用户早已忘了这件事，图突然传上去了"，那时候的惊喜是惊吓。
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1200, 3000, 6000, 10000];

export interface AttachWatchDecisionInput {
	/** 现查到的文件（宿主 `TFile` 的形状子集）。 */
	file: VaultFileLike | null | undefined;
	/** 设置项 `autoUpload`（关掉则这一步**一步都不碰**，与粘贴那条路一致）。 */
	autoUpload: boolean;
	/** 这个路径是不是我们自己刚写下的文件（见 `IngestDeps.onStaged` / `LocalCopyDeps.onStaged`）。 */
	isSelfWrite: boolean;
	/** 索引（判断"是不是已经登记过的副本"）。 */
	index: CacheIndex;
	settings: PluginSettings;
	/** 现在被引用着的库内路径集合（宿主的链接索引 + 画布扫描，调用方算好）。 */
	referencedPaths: ReadonlySet<string>;
}

export interface AttachWatchDecision {
	adopt: boolean;
	/** 诊断用的原因（进日志，不进用户界面）。 */
	reason: string;
	/**
	 * 值得**再等一轮**吗。
	 *
	 * 只有一种情况为 true：文件还没被任何笔记引用 —— 因为宿主的链接是在文件落盘
	 * **之后**才插进笔记的（见模块头）。其余原因（是笔记文件、在缓存目录里、
	 * 已经在索引里……）都是**终局**判定，再等也不会变。
	 *
	 * ⚠️ 这里判的是"引用集合里有没有它"这个**事实**，不是去认跳过的文案 ——
	 * 文案改了，认文案的判据会**静默失效**（本项目已经吃过这个形状的亏）。
	 */
	retry: boolean;
}

/**
 * 单文件判定：**这个刚出现的文件要不要接管**。
 *
 * 分工：
 * - create 专属的三条闸门（开关 / **索引里已有该路径的副本** / 自写台账）在这里；
 * - "什么算附件、什么算已经被处理过"这些**共享判据**一律交给
 *   `selectUploadCandidates` —— 那一条命令与这一条入口绝不能对"什么算候选"
 *   给出两个答案。
 */
export function decideAdoptCreatedFile(input: AttachWatchDecisionInput): AttachWatchDecision {
	const path = typeof input.file?.path === "string" ? input.file.path : "";
	if (path.trim() === "") return { adopt: false, reason: "路径为空", retry: false };

	if (!input.autoUpload) return { adopt: false, reason: "自动上传已关闭", retry: false };

	// ① 我们自己刚写下的文件（粘贴的中转文件、回退下载的副本、将来的迁移落点）。
	// 这条路自己会接管它，这里再管一次就是重复上传。
	if (input.isSelfWrite) return { adopt: false, reason: "是我们自己刚写下的文件", retry: false };

	// ② 索引里已经有一条指向这个路径的副本 ⇒ 它是我们的副本（老缓存目录里搬出来的、
	// 或从别的设备同步过来的索引）。终局判定：再等也不会变。
	if (input.index.findByCachePath(path)) {
		return { adopt: false, reason: "已经是索引里登记的本地副本", retry: false };
	}

	const selection = selectUploadCandidates([input.file as VaultFileLike], {
		settings: input.settings,
		index: input.index,
		referencedPaths: input.referencedPaths,
	});
	if (selection.paths.length === 1) return { adopt: true, reason: "ok", retry: false };

	const reason = selection.skipped[0]?.reason ?? "未知原因";

	// ⭐ 只有"**只差一个引用**"值得等一轮。
	//
	// 判法：把这条路径**假装成被引用**再筛一次 —— 它若通过，说明唯一的拦路条件就是
	// "还没被引用"（宿主的链接是在文件落盘**之后**才插进笔记的，所以那是"还没到时候"）；
	// 若仍被拒（笔记文件 / 空文件 / 已在索引……），那就是终局，再等也不会变。
	//
	// ⚠️ 刻意**不去认那句跳过的文案**：文案改了，认文案的判据会**静默失效**
	// （本项目已经吃过这个形状的亏）。
	const onlyMissingReference =
		selectUploadCandidates([input.file as VaultFileLike], {
			settings: input.settings,
			index: input.index,
			referencedPaths: new Set([path]),
		}).paths.length === 1;
	if (!onlyMissingReference) return { adopt: false, reason, retry: false };

	// ⚠️ 这里曾经还有一条"内容已在云端 ⇒ 终局跳过"，2026-10-14 拆掉了：
	// 它把"现在还没被引用"读成了"永远不会被本地引用"，而**重复插入同一张图**时
	// 那句判断正好反过来（链接是落盘之后才写的）⇒ 判定一出，此后没有任何事件回头看它。
	// 现在一律走"再等一轮"，让退避窗口自己分辨这两种情况（见模块头 ⚠️⚠️ 那段）。
	return { adopt: false, reason, retry: true };
}

/** 一次接管的执行结果（`runBatchUpload` 的返回值是这个形状的超集）。 */
export interface AttachAdoptResult {
	uploaded: number;
	reused: number;
	failed: number;
	linksRewritten: number;
	/**
	 * ⭐ 这一趟顺手删掉的**宿主撞名另落的重复副本**份数（见 `dropRedundantCopies`）。
	 *
	 * 加进这个接口只为一件事：**让这个数字可见**（手机上唯一的排查通道是日志）。
	 * 不弹通知：用户刚刚亲手插了那张图，而"同一张图不该在本地存两份"本来就是承诺，
	 * 每插一次就弹一条只会变噪音（命令那条路跑了 N 个文件，所以那里会报）。
	 */
	redundantRemoved: number;
}

/** 「这个路径是我们自己刚写下去的」台账。 */
export interface SelfWriteLedger {
	/** 记下一条（`stageLocally` 落盘之后立刻调用）。 */
	note: (path: string) => void;
	has: (path: string) => boolean;
	/** 当前条数（诊断用；也用来钉住"过期会清理"这条行为）。 */
	size: () => number;
}

/**
 * 造一份「自写台账」。
 *
 * 只解决一件事：粘贴那条路的"先落盘再上传"会往附件目录里写一份**中转文件**，
 * 而它也会触发 `vault.on("create")` —— 那份文件归粘贴那条路管（上传完就搬进缓存），
 * 自动接管再管一次就是重复上传、还会跟它抢文件。
 *
 * ## 为什么要 TTL，而不是"上传完就删掉这条"
 *
 * 删除需要"这条中转文件的生命周期什么时候结束"的准确信号，而它其实没有：
 * 成功时文件被搬进缓存（路径变了）、失败时它还留在原地、取消时也可能留着。
 * 与其在每个出口补一次删除（漏一处就变成**永久**误判），不如给它一个上界：
 * TTL 到期后判定会落到别的闸门上（索引里有记录 / 已被引用 / 搬走后又回来），
 * 那几道闸门本身就能得出正确答案 —— 所以**过期是安全的**。
 *
 * 反过来说：**过期之后还留着更糟** —— 用户将来真的有一个附件叫那个路径时，
 * 会被误判成"我们自己写的"而永远不上传。
 */
export function createSelfWriteLedger(options: { ttlMs?: number; now?: () => number } = {}): SelfWriteLedger {
	const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
	const now = options.now ?? (() => Date.now());
	/** 路径 → 过期时刻。 */
	const entries = new Map<string, number>();

	const prune = (): void => {
		const at = now();
		for (const [path, expiresAt] of entries) {
			if (expiresAt <= at) entries.delete(path);
		}
	};

	return {
		note(path: string): void {
			if (typeof path !== "string" || path.trim() === "") return;
			prune();
			entries.set(path, now() + ttlMs);
		},
		has(path: string): boolean {
			const expiresAt = entries.get(path);
			if (expiresAt === undefined) return false;
			if (expiresAt <= now()) {
				entries.delete(path);
				return false;
			}
			return true;
		},
		size(): number {
			prune();
			return entries.size;
		},
	};
}

export interface AttachWatchDeps {
	autoUpload: () => boolean;
	isSelfWrite: (path: string) => boolean;
	index: () => CacheIndex;
	settings: () => PluginSettings;
	/** 现查文件（已经不在库里时返回 `null`）。 */
	lookup: (path: string) => VaultFileLike | null;
	/** 现算"被引用着的路径集合"（每次 flush 取一次，不缓存）。 */
	referencedPaths: () => Promise<ReadonlySet<string>>;
	/** 执行接管（复用批量那一趟：上传 + 搬入缓存 + 改写引用）。 */
	adopt: (paths: readonly string[]) => Promise<AttachAdoptResult>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
	/** 调度器。注入是为了让测试**同步**驱动，不依赖真时钟。 */
	schedule?: (run: () => void, delayMs: number) => unknown;
	cancel?: (handle: unknown) => void;
	/** 重试时刻表（默认 {@link DEFAULT_RETRY_DELAYS_MS}）。 */
	retryDelaysMs?: readonly number[];
	/** 诊断日志口（默认静默；这条路径跑在宿主的文件事件里，不该往外抛）。 */
	log?: (message: string) => void;
}

export interface AttachWatcher {
	/** 接住一次 `vault.on("create")`。**同步、不抛错**（它跑在宿主的文件事件里）。 */
	onCreated: (file: unknown) => void;
	/** 立刻处理攒下的（测试、卸载用）。 */
	flush: () => Promise<void>;
	/** 取消已排的调度并清空攒批（插件卸载时调用）。 */
	dispose: () => void;
	/** 当前攒了多少（诊断用）。 */
	pending: () => number;
}

export function createAttachWatcher(deps: AttachWatchDeps): AttachWatcher {
	const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
	// ⚠️ 走 `window.setTimeout` 而不是全局 `setTimeout`：宿主页面里两者等价，
	// 但本项目的 lint 规则要求显式写出宿主（见 eslint 配置），测试垫片也照此提供 `window`。
	const schedule = deps.schedule ?? ((run, delayMs) => window.setTimeout(run, delayMs));
	const cancel = deps.cancel ?? ((handle) => window.clearTimeout(handle as number));

	const log = (message: string): void => {
		try {
			deps.log?.(message);
		} catch {
			// 日志口出错不该影响接管本身
		}
	};

	/** 攒着的路径。用 Set：同一个文件被连着报两次（宿主有时会）只算一次。 */
	const pendingPaths = new Set<string>();
	let handle: unknown = null;
	let attemptIndex = 0;
	let inflight: Promise<void> | null = null;
	let disposed = false;

	const scheduleFlush = (): void => {
		if (disposed || handle !== null || inflight || pendingPaths.size === 0) return;
		if (attemptIndex >= delays.length) return;
		const delay = delays[attemptIndex] ?? delays[delays.length - 1] ?? 0;
		handle = schedule(() => {
			handle = null;
			void flush();
		}, delay);
	};

	/** 求引用集合；失败时当作"空集"（= 都还没被引用 ⇒ 继续等，是保守的那一侧）。 */
	const readReferenced = async (): Promise<ReadonlySet<string>> => {
		try {
			return await deps.referencedPaths();
		} catch (error) {
			log(`求引用集合失败，这一轮按「都还没被引用」处理：${describeError(error)}`);
			return new Set<string>();
		}
	};

	const doFlush = async (): Promise<void> => {
		const batch = [...pendingPaths];
		if (batch.length === 0) return;

		const referenced = await readReferenced();
		const adoptable: string[] = [];
		const waiting: string[] = [];

		for (const path of batch) {
			// ⚠️ 每次现查文件：文件可能已经被别的流程搬走/删掉了（粘贴那条路的
			// 中转文件就是这样消失的）。
			const file = deps.lookup(path);
			if (!file) {
				log(`跳过（已经不在了）：${path}`);
				pendingPaths.delete(path);
				continue;
			}

			const base = {
				file,
				autoUpload: deps.autoUpload(),
				isSelfWrite: deps.isSelfWrite(path),
				index: deps.index(),
				settings: deps.settings(),
				referencedPaths: referenced,
			};

			const verdict = decideAdoptCreatedFile(base);

			if (verdict.adopt) {
				adoptable.push(path);
				pendingPaths.delete(path);
				continue;
			}
			if (verdict.retry) {
				// ⭐ 走到这里说明"只差一个引用" —— 再等一轮。
				//
				// ⚠️ 这里曾经还会再花一次哈希问"内容是不是早就传过的"，是的话当场丢掉
				// （同步到达的副本）。2026-10-14 拆了：那句话对**重复插入同一张图**是错的
				// （它的本地链接只是还没写进笔记），而丢掉是**终局**的 —— 见模块头 ⚠️⚠️。
				// 现在两种情形都走这条"再等一轮"，由窗口自己分辨：真的没引用 ⇒ 等满就放弃。
				waiting.push(path);
				continue;
			}
			log(`跳过（${verdict.reason}）：${path}`);
			pendingPaths.delete(path);
		}

		if (adoptable.length > 0) {
			try {
				const result = await deps.adopt(adoptable);
				// ⭐ **上传**与"云端已有、只是换了链接"要分开报：两者是**不同的动作**，
				// 合并成一句"已自动上传 N 个"会让没传的那几个也显示成传了
				//（用户 2026-10-14 在 Android 上报的正是这个：重复插同一张图，
				// 提示说"上传成功"，而实际上一个字节都没出去）。
				// 数量仍然只报**真实发生**的那部分。
				if (result.uploaded > 0) deps.notify(deps.t("attachAutoUploaded", { count: result.uploaded }));
				if (result.reused > 0) deps.notify(deps.t("attachAutoReused", { count: result.reused }));
				if (result.failed > 0) deps.notify(deps.t("attachAutoFailed", { count: result.failed }));
				// 顺手删掉的重复副本只记日志（见 `AttachAdoptResult.redundantRemoved`）
				if (result.redundantRemoved > 0) {
					log(`删掉宿主撞名另落的重复副本 ${result.redundantRemoved} 份（同内容、链接已改写）`);
				}
			} catch (error) {
				// 摘出来的文件已经不在攒批里了（重试也救不了这一次），如实说一句
				log(`接管失败（${adoptable.length} 个）：${describeError(error)}`);
				deps.notify(deps.t("attachAutoFailed", { count: adoptable.length }));
			}
		}

		// ── 收尾：决定"还要不要再等一轮" ──
		//
		// ⚠️ 只删**这一批**里放弃的那些：等待期间可能又来了新文件，
		// 直接 `clear()` 会把它们一起吞掉。
		if (waiting.length > 0) {
			attemptIndex += 1;
			if (attemptIndex >= delays.length) {
				for (const path of waiting) pendingPaths.delete(path);
				log(`等满了 ${delays.length} 轮仍没被任何笔记引用，放弃：${waiting.join(", ")}`);
				attemptIndex = 0;
			}
		} else if (pendingPaths.size > 0) {
			// 攒批里只剩新来的 → 从头开始等（它们的链接也还没写进笔记）
			attemptIndex = 0;
		} else {
			attemptIndex = 0;
		}
	};

	const flush = (): Promise<void> => {
		if (inflight) return inflight;
		const run = doFlush()
			.catch((error) => {
				// 这条路径绝不能往外抛：它挂在宿主的文件事件上
				log(`这一轮接管出错：${describeError(error)}`);
			})
			.finally(() => {
				inflight = null;
				// ⭐ **重试的排期必须放在这里**，不能放在 `doFlush` 的末尾：
				// 那一行执行时 `inflight` 还挂着，`scheduleFlush` 会因此直接返回 ——
				// 于是"没等到引用的文件"再也不会被重试（这一条是套件 S1 抓出来的真 bug：
				// 表现是首次判定之后彻底静默，正好回到用户报的那个症状上）。
				scheduleFlush();
			});
		inflight = run;
		return run;
	};

	return {
		onCreated(file: unknown): void {
			try {
				if (disposed) return;
				const path = (file as { path?: unknown } | null | undefined)?.path;
				if (typeof path !== "string" || path.trim() === "") return;
				if (pendingPaths.has(path)) return;

				pendingPaths.add(path);
				log(`库里新增了文件，记下等引用：${path}`);
				scheduleFlush();
			} catch (error) {
				log(`记下新增文件时出错：${describeError(error)}`);
			}
		},
		flush,
		dispose(): void {
			disposed = true;
			if (handle !== null) cancel(handle);
			handle = null;
			pendingPaths.clear();
		},
		pending(): number {
			return pendingPaths.size;
		},
	};
}
