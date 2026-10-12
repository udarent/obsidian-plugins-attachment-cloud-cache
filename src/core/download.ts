/**
 * 回退下载：把"属于本存储但没有本地副本"的图取回本地。
 *
 * ## 它补的是哪个洞
 *
 * 本地副本只存在于**上传过它、或下载过它**的设备上。于是有两类图在我们的
 * 索引里查不到，而在笔记里又确实指向我们的存储：
 *
 * 1. **换设备 / 重装**：笔记同步过来了，缓存目录没跟过来；
 * 2. **缓存被清**：本项目明确承诺"缓存目录可随时整体删除"。
 *
 * 这两类图在断网时就是破的 —— 直到我们把副本取回来。所以这一层是
 * "离线可用"这个定位在**新设备**上的入口。
 *
 * ⚠️ 但它只在**缓存开着**的时候动手：「本地副本的处理」选「不留副本」时，
 * 这一档等于关闭缓存（用户口径："只保留常规图床的功能"），
 * 于是不为任何图取回副本 —— 判定见 `types.ts` 的 `isCacheDisabled`。
 * 已经存在的副本不受影响（那由渲染判定使用，与"要不要写"是两件事）。
 *
 * ## 落点（1.2.0 / D-17：不再有缓存目录）
 *
 * 补回来的副本落在**附件目录**，文件名取**原始文件名**（三层兜底与撞名规则见
 * `download-target.ts`）—— 用户能认出它是哪张图，也能参与检索。
 * 写入**之前**要把它登记进「自写台账」：那份文件同样会触发宿主的 `create` 事件，
 * 而"新增附件自动接管"那条链必须认得出"这是我们自己刚写下去的"。
 *
 * ## 三条硬边界
 *
 * 1. **只下载属于本存储的 URL。** 判定侧已经用前缀/索引筛过一遍，这里**再验一次**
 *    （`keyFromUrl(url) === key`）。理由是防线不能只有一道：这一层是**唯一**会
 *    把远端字节写进用户 vault 的地方，越界的代价是把别人的图拉进来
 *    （"站外图永不下载"是红线 —— 越界就等于把用户的 vault 变成了别人的图床）。
 * 2. **并发去重：同一个 key 同时只下载一次。** 一屏里同一张图可能出现多次
 *    （同一张图被多篇笔记引用），而渲染钩子会对**每一个** `<img>` 各调用一次。
 *    不去重的话一屏就能发出 N 个重复的 GET —— 在移动端尤其明显。
 *    ⚠️ 去重表按 **key** 而不是 URL：同一对象的 URL 可能有多种写法。
 * 3. **绝不覆盖。** 目标路径已被占用时：内容相同 ⇒ 复用那一份；内容不同 ⇒
 *    另取序号（`名字 1.ext`，与粘贴落盘那条路同一条约定）。判据与实现见 `download-target.ts`：
 *    不比路径、而是**比内容** —— 两代 key 都带完整哈希（老 `<哈希>.ext`、1.2.0 起
 *    `<名字>-<哈希>.<扩展名>`）⇒ 这一步**永远有依据**；取不到哈希的遗留对象按"内容不同"处理。
 *
 * ## 失败时该不该打扰用户
 *
 * 逐张图片弹提示会把界面刷爆；而**离线时下载失败是预期行为**（用户就是断网了），
 * 提示他"下载失败"既无用又惹人烦。所以按错误性质分流：
 * 网络类失败**静默**（那是离线的正常表现），配置类失败（403/404/桶名错）才提示 ——
 * 那种情况下用户确实需要知道"有东西配错了"。
 */

import type { App } from "obsidian";

import type { PluginSettings } from "../types";
import { isCacheDisabled } from "../types";
import type { CacheIndex, CacheEntry } from "../cache/index";
import { attachmentFolderFor, parentFolderOf } from "../vault-files";
import { planDownloadTarget } from "../download-target";
import { sha256Hex } from "../s3/hash";
import { keyFromUrl } from "../render/render-target";
import { notifyUser } from "../notify-user";
import type { NotifySink } from "../notify-user";
import type { S3Client } from "../s3/client";
import { describeError } from "../error-text";

/** 一次补齐尝试的结果。 */
export interface LocalCopyOutcome {
	status:
		/** 下载并落盘成功。 */
		| "downloaded"
		/** 本地已经有了（索引 + 文件都在）—— 零网络。 */
		| "reused"
		/**
		 * 缓存被关掉，所以不下载：设置里关掉了回退下载，**或者**「本地副本的处理」选了
		 * 「不留副本」（那一档等于关闭缓存，见 `types.ts` 的 `isCacheDisabled`）。
		 */
		| "disabled"
		/** 不下载：这个 URL 不属于本存储。 */
		| "refused"
		/**
		 * 下载不了：存储配置或凭据还没齐（拿不到客户端）。
		 *
		 * ⚠️ 与 `disabled` 分开是刻意的：一个是"用户主动关掉"，一个是"还没配好"。
		 * 两者**都不提示**用户，但原因不同 —— 合并成一个状态会让排查时看不出是哪种。
		 * 这里不提示的理由：渲染路径上每张图都会走到这里，逐张弹"未配置"会把界面刷爆；
		 * 而"未配置"这件事在粘贴时与设置页里都已经说过了。
		 */
		| "unavailable"
		/** 下载或落盘失败。 */
		| "failed";
	key: string;
	/** 本地副本的 vault 相对路径（失败/未下载时为空串）。 */
	localPath: string;
	error?: unknown;
}

export interface LocalCopyDeps extends NotifySink {
	app: App;
	settings: () => PluginSettings;
	/** 当前的客户端；配置/凭据没齐时返回 `null`（见 `unavailable`）。 */
	client: () => S3Client | null;
	index: () => CacheIndex;
	persistIndex: () => Promise<void>;
	now?: () => Date;
	/**
	 * ⭐ 刚刚往 vault 里写下了一份副本（落盘**之前**调用）。
	 *
	 * 与上传路径的 `IngestDeps.onStaged` 是**同一本台账**：那份文件也会触发
	 * 宿主的 `create` 事件，而自动接管那条链必须认得出"这是我们自己写的"。
	 */
	onStaged?: (path: string) => void;
}

/**
 * 读一个错误的 `kind`。
 *
 * ⚠️ 用**结构化读取**而不是 `instanceof S3Error`：本项目反复强调过，
 * 跨 bundle 的 `instanceof` 会因"各带一份副本"而**恒为 false** ——
 * 而症状是"错误分类静默失效"，不报错。既有的 `classifyConnectionFailure`
 * 用的也是这个写法（见 `ui/settings-logic.ts`）。
 */
function kindOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("kind" in error)) return undefined;
	const kind = (error as { kind?: unknown }).kind;
	return typeof kind === "string" ? kind : undefined;
}

/**
 * 该不该把这次失败说给用户听。
 *
 * **纯函数**，因为这条规则很容易写反（把离线当故障、或把配置错静默掉），
 * 而两种写反的后果都不好：前者在离线时刷屏，后者让用户永远查不出配错了。
 */
export function shouldReportDownloadFailure(error: unknown): boolean {
	const kind = kindOf(error);
	if (!kind) return true; // 不认识的错误：宁可说出来
	// 断网 / DNS / TLS / 超时 —— 这些正是"离线"本身，不是故障
	if (kind === "network") return false;
	// 限流与服务端故障是临时的，用户此刻做不了什么，也没必要打扰
	if (kind === "throttled" || kind === "server") return false;
	// 其余（auth / notFound / client / unknown）说明有东西配错了
	return true;
}


/**
 * 造一条索引记录（下载这条路的两处登记共用：新落盘的、复用已有文件的）。
 *
 * 抽出来是为了**字段不会漂移**：两处各自拼一份 `CacheEntry`，早晚会有一处忘了
 * 跟着改（此前"下载来的副本 `sourceName` 留空"就是这样写了两遍）。
 *
 * ⭐ `sourceName` 现在**有值可填**（`known?.sourceName`）—— 它是确认框与桶内
 * 可辨认度的来源，能填就填；真没有（老对象且无条目）时留空，显示层会退化成 key。
 */
function makeEntry(
	key: string,
	cachePath: string,
	remoteUrl: string,
	size: number,
	sourceName: string,
	contentType = "",
	etag = "",
	now = new Date()
): CacheEntry {
	return {
		key,
		cachePath,
		remoteUrl,
		size,
		contentType,
		etag,
		uploadedAt: now.toISOString(),
		// 刚下载/刚复用的副本就是"刚被用到"的（这次渲染正是在等它）
		lastUsedAt: now.getTime(),
		sourceName,
	};
}

/**
 * 造一个"补齐器"。返回的函数可以长期持有 —— **并发去重表挂在它内部**，
 * 于是去重范围正好是"同一个插件实例"，不多也不少。
 */
export function createLocalCopyEnsurer(deps: LocalCopyDeps) {
	/** key → 进行中的下载。存在的理由见模块头注释第 2 条。 */
	const inflight = new Map<string, Promise<LocalCopyOutcome>>();

	async function exists(path: string): Promise<boolean> {
		if (deps.app.vault.getAbstractFileByPath(path)) return true;
		try {
			return await deps.app.vault.adapter.exists(path);
		} catch {
			return false;
		}
	}

	async function ensureFolder(path: string): Promise<void> {
		const folder = parentFolderOf(path);
		if (!folder) return;
		if (deps.app.vault.getAbstractFileByPath(folder)) return;
		try {
			await deps.app.vault.createFolder(folder);
		} catch {
			// 并发创建 / 已存在：都不是错误
		}
	}

	/** 读一个已存在文件的 sha256（读不到返回 `null` ⇒ 调用方按"内容不同"处理）。 */
	async function hashOf(path: string): Promise<string | null> {
		try {
			const buffer = await deps.app.vault.adapter.readBinary(path);
			return await sha256Hex(new Uint8Array(buffer));
		} catch {
			return null;
		}
	}

	async function run(key: string, remoteUrl: string, sourcePath?: string | null): Promise<LocalCopyOutcome> {
		const settings = deps.settings();

		// 判定的顺序是刻意的，五步都由不同的原因拒绝，且**都不发请求**：
		// ① 缓存整体被关掉 → ② 用户关掉了回退下载 → ③ 不是我们的 URL（红线）
		// → ④ 还没配置好 → ⑤ 本地已有。
		//
		// ⭐ ① 是「不留副本」档：那一档下渲染判定已经不产生 `fetch`（见 `render/render-target.ts`），
		// 但这里**再拦一次**。理由是这一层是**唯一**会把远端字节写进用户 vault 的地方，
		// 而"不留副本"的语义就是"不要往里写" —— 防线只有一道的话，
		// 将来任一条新入口（命令、别的调用点）都能悄悄绕过用户的选择，且不报错。
		if (isCacheDisabled(settings.localCopy)) {
			return { status: "disabled", key, localPath: "" };
		}

		if (!settings.fallbackDownload) {
			return { status: "disabled", key, localPath: "" };
		}

		// ⭐ 再验一次"这是我们自己的 URL"。这一层是唯一会把远端字节写进 vault 的地方。
		const derived = keyFromUrl(remoteUrl, settings.s3);
		if (derived !== key) {
			return { status: "refused", key, localPath: "" };
		}

		const client = deps.client();
		if (!client) {
			return { status: "unavailable", key, localPath: "" };
		}

		// 本地已经有 → 零网络（渲染钩子可能因为索引滞后而走到这里）
		const known = deps.index().get(key);
		if (known?.cachePath && (await exists(known.cachePath))) {
			return { status: "reused", key, localPath: known.cachePath };
		}

		// ⭐ 1.2.0（D-17）：落点 = **附件目录 + 原始文件名**（不再有缓存目录）。
		//
		// 取名靠三级兜底（条目 `sourceName` → key 反推 → key 本身），撞名先比内容哈希、
		// 再走序号 —— 全部在 `download-target.ts` 里，这里只负责给它两个探针。
		// ⚠️ 那个"没配缓存目录所以推不出路径"的失败分支（`fallbackNoCacheFolder`）随之消失：
		// 附件目录任何时候都能确定（用户覆盖值 → 宿主配置 → vault 根），这条路径不再有
		// "设置没填所以下载不了"的形态。
		const plan = await planDownloadTarget({
			key,
			sourceName: known?.sourceName,
			folder: attachmentFolderFor(deps.app, settings.attachmentFolder, sourcePath ?? undefined),
			exists,
			hashOf,
		});

		// 内容相同 ⇒ 那一份就是我们要的副本：登记进索引（否则每次渲染都要重走一遍判定）
		if (plan.kind === "reuse") {
			const store = deps.index();
			store.set(makeEntry(key, plan.path, remoteUrl, 0, known?.sourceName ?? ""));
			store.markUploaded(key);
			try {
				await deps.persistIndex();
			} catch (error) {
				notifyUser(deps, "fallbackIndexPersistFailed", { error: describeError(error) });
			}
			return { status: "reused", key, localPath: plan.path };
		}

		const target = plan.path;

		let downloaded;
		try {
			downloaded = await client.getObject(key);
		} catch (error) {
			if (shouldReportDownloadFailure(error)) {
				notifyUser(deps, "fallbackDownloadFailed", { error: describeError(error) });
			}
			return { status: "failed", key, localPath: "", error };
		}

		try {
			await ensureFolder(target);
			// ⚠️ 落盘**之前**登记自写台账：这条路写下的文件同样会触发宿主的 `create`，
			// 而自动接管那条链全靠这本台账/索引认出"这是我们自己写的"（见 `attach-watch`）。
			deps.onStaged?.(target);

			const bytes = downloaded.data;
			await deps.app.vault.createBinary(
				target,
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			);

			const path = target;
			const entry: CacheEntry = makeEntry(
				key,
				path,
				remoteUrl,
				bytes.length,
				known?.sourceName ?? "",
				downloaded.contentType,
				downloaded.etag,
				deps.now?.() ?? new Date()
			);
			const store = deps.index();
			store.set(entry);
			// ⭐ 顺带记进**上传台账**（"这个 key 在我们的系统里"）。
			//
			// 为什么这里也要记：`CacheIndex.fromJSON` 读文件时取的是「台账 ∪ 条目里的 key」，
			// 所以只要有条目，**下次启动后台账里就会有它**。若这里不记，同一个对象
			// 在本会话被判成"不是我们的"、重启后却变成"是我们的" ——
			// 那种"重启就变"的不一致正是本项目反复消除的一类问题。
			store.markUploaded(key);
			try {
				await deps.persistIndex();
			} catch (error) {
				// 索引落盘失败不该让"图上能看了"这件事作废：文件已经在磁盘上
				notifyUser(deps, "fallbackIndexPersistFailed", { error: describeError(error) });
			}
			return { status: "downloaded", key, localPath: path };
		} catch (error) {
			notifyUser(deps, "fallbackWriteFailed", { error: describeError(error) });
			return { status: "failed", key, localPath: "", error };
		}
	}

	return function ensureLocalCopy(
		key: unknown,
		remoteUrl: unknown,
		sourcePath?: string | null
	): Promise<LocalCopyOutcome> {
		const cleanKey = typeof key === "string" ? key.trim() : "";
		const cleanUrl = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
		if (!cleanKey || !cleanUrl) {
			return Promise.resolve({ status: "failed", key: cleanKey, localPath: "" });
		}

		// ⭐ 去重：同一个 key 已在下载中 → 复用同一个 promise。
		// 用 `finally` 摘除而不是 `then`：失败时也必须摘掉，
		// 否则一次失败会让这个 key **永远**被判为"正在下载"（后续再也不会重试）。
		const existing = inflight.get(cleanKey);
		if (existing) return existing;

		const task = run(cleanKey, cleanUrl, sourcePath).finally(() => {
			inflight.delete(cleanKey);
		});
		inflight.set(cleanKey, task);
		return task;
	};
}
