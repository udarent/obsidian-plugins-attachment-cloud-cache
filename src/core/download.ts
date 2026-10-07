/**
 * 回退下载：把"属于本存储但没有本地副本"的图取回本地。
 *
 * ## 它补的是哪个洞
 *
 * 本地副本只存在于**上传过它、或下载过它**的设备上。于是有两类图在我们的
 * 索引里查不到，而在笔记里又确实指向我们的存储：
 *
 * 1. **换设备 / 重装**：笔记同步过来了，缓存目录没跟过来；
 * 2. **缓存被清**：SCOPE 明确承诺"缓存目录可随时整体删除"。
 *
 * 这两类图在断网时就是破的 —— 直到我们把副本取回来。所以这一层是
 * "离线可用"这个定位在**新设备**上的入口。
 *
 * ## 三条硬边界
 *
 * 1. **只下载属于本存储的 URL。** 判定侧已经用前缀/索引筛过一遍，这里**再验一次**
 *    （`keyFromUrl(url) === key`）。理由是防线不能只有一道：这一层是**唯一**会
 *    把远端字节写进用户 vault 的地方，越界的代价是把别人的图拉进来
 *    （SCOPE 把"站外图永不下载"列为红线，也点明了那会与 `attachments-cache` 的定位冲突）。
 * 2. **并发去重：同一个 key 同时只下载一次。** 一屏里同一张图可能出现多次
 *    （同一张图被多篇笔记引用），而渲染钩子会对**每一个** `<img>` 各调用一次。
 *    不去重的话一屏就能发出 N 个重复的 GET —— 在移动端尤其明显。
 *    ⚠️ 去重表按 **key** 而不是 URL：同一对象的 URL 可能有多种写法。
 * 3. **绝不覆盖。** 目标路径已被占用时另取序号（与上传路径同一条纪律）：
 *    模板被用户改成 `{filename}` 时，"同路径"不再等于"同内容"。
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
import type { CacheIndex, CacheEntry } from "../cache/index";
import { cachePathFor } from "../cache-path";
import { parentFolderOf, uniqueVaultPath } from "../vault-files";
import { keyFromUrl } from "../render/render-target";
import type { S3Client } from "../s3/client";

/** 一次补齐尝试的结果。 */
export interface LocalCopyOutcome {
	status:
		/** 下载并落盘成功。 */
		| "downloaded"
		/** 本地已经有了（索引 + 文件都在）—— 零网络。 */
		| "reused"
		/** 设置里关掉了回退下载。 */
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

export interface LocalCopyDeps {
	app: App;
	settings: () => PluginSettings;
	/** 当前的客户端；配置/凭据没齐时返回 `null`（见 `unavailable`）。 */
	client: () => S3Client | null;
	index: () => CacheIndex;
	persistIndex: () => Promise<void>;
	notify?: (message: string) => void;
	t?: (key: string, params?: Record<string, unknown>) => string;
	now?: () => Date;
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

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
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

	async function run(key: string, remoteUrl: string): Promise<LocalCopyOutcome> {
		const settings = deps.settings();

		// 判定的顺序是刻意的，四步都由不同的原因拒绝，且**都不发请求**：
		// ① 用户主动关掉 → ② 不是我们的 URL（红线）→ ③ 还没配置好 → ④ 本地已有。
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

		const target = cachePathFor(key, settings.cacheFolder);
		if (!target) {
			// 缓存目录为空会让路径推不出来 —— 那是设置问题，不是网络问题
			deps.notify?.(
				deps.t ? deps.t("fallbackNoCacheFolder", {}) : "缓存目录未设置，无法保存下载的副本"
			);
			return { status: "failed", key, localPath: "" };
		}

		let downloaded;
		try {
			downloaded = await client.getObject(key);
		} catch (error) {
			if (shouldReportDownloadFailure(error)) {
				deps.notify?.(
					deps.t
						? deps.t("fallbackDownloadFailed", { error: describe(error) })
						: `下载缓存副本失败：${describe(error)}`
				);
			}
			return { status: "failed", key, localPath: "", error };
		}

		try {
			await ensureFolder(target);
			const path = await uniqueVaultPath(target, exists);
			const bytes = downloaded.data;
			await deps.app.vault.createBinary(
				path,
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			);

			const entry: CacheEntry = {
				key,
				cachePath: path,
				remoteUrl,
				size: bytes.length,
				contentType: downloaded.contentType,
				etag: downloaded.etag,
				uploadedAt: (deps.now?.() ?? new Date()).toISOString(),
				// 刚下载的副本就是"刚被用到"的（这次渲染正是在等它）
				lastUsedAt: (deps.now?.() ?? new Date()).getTime(),
				// 下载来的副本没有"原始文件名"这个概念，留空（字段本身只用于报告可读性）
				sourceName: "",
			};
			deps.index().set(entry);
			try {
				await deps.persistIndex();
			} catch (error) {
				// 索引落盘失败不该让"图上能看了"这件事作废：文件已经在磁盘上
				deps.notify?.(
					deps.t
						? deps.t("fallbackIndexPersistFailed", { error: describe(error) })
						: `缓存索引保存失败：${describe(error)}`
				);
			}
			return { status: "downloaded", key, localPath: path };
		} catch (error) {
			deps.notify?.(
				deps.t
					? deps.t("fallbackWriteFailed", { error: describe(error) })
					: `下载的副本写入 vault 失败：${describe(error)}`
			);
			return { status: "failed", key, localPath: "", error };
		}
	}

	return function ensureLocalCopy(key: unknown, remoteUrl: unknown): Promise<LocalCopyOutcome> {
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

		const task = run(cleanKey, cleanUrl).finally(() => {
			inflight.delete(cleanKey);
		});
		inflight.set(cleanKey, task);
		return task;
	};
}
