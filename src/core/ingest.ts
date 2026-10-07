/**
 * 上传编排：**字节 → 对象存储 + 本地副本 + 索引**。
 *
 * ## 顺序是这一层最重要的设计，不是实现细节
 *
 * 调用方（粘贴/拖拽钩子）会先 `preventDefault()` 把宿主的原生保存**挡掉**，
 * 再从剪贴板把字节交给我们。也就是说：**从这一刻起，字节能不能留下完全看我们**。
 *
 * 于是顺序只能是"**先落盘、再上传**"：
 *
 * ```
 * 读字节 → 算出 key/路径 → 字节先写进附件目录（此时已安全）→ 上传
 *        ├─ 成功 → 按 localFileAction 搬进缓存 / 原地保留 / 回收站 → 登记索引
 *        └─ 失败 → 字节就留在附件目录 → 返回本地路径（绝不丢图）
 * ```
 *
 * 反过来（先上传、成功后再写本地副本）有一处**结构性**隐患：
 * 上传成功而本地写入失败时（磁盘满、权限、移动端的存储配额），
 * 我们就只剩一个远端 URL，而离线能力没了 —— 更糟的是若连远端也失败，
 * 字节就真的没了。先落盘的话，最坏情况也只是"图还在、只是没上传"。
 *
 * 这也顺带贴合 P0 的措辞「本地副本**移动**进缓存」：文件本来就是先在附件目录落地的，
 * 上传成功后**移动**（rename）到缓存路径 —— 不是复制、不是删除。
 *
 * ## 为什么"命中缓存"要能跳过上传
 *
 * key 由内容哈希算出来（默认模板），所以同一张图重复粘贴会得到同一个 key。
 * 此时远端对象**一定已经存在**（上次上传的），本地副本也在。
 * 再 PUT 一次是纯浪费（可能是几十 MB 的上行）。所以命中且 URL 未变时直接复用 ——
 * **零网络请求**。这一条是可测的（断言 PUT 次数为 0）。
 *
 * 但只有在**索引里确认过**才敢跳过：光看缓存里有文件不够 ——
 * 那个文件可能是同步过来的、或者用户手工放进去的，我们并不确定它是否上传过。
 */

import type { App } from "obsidian";
import { CacheIndex, normalizeUrl, type CacheEntry } from "../cache/index";
import { cachePathFor } from "../cache-path";
import { renderObjectKey } from "../object-key";
import type { S3Client } from "../s3/client";
import { sha256Hex } from "../s3/hash";
import type { LocalCopyAction, PluginSettings } from "../types";
import {
	fallbackFileName,
	parentFolderOf,
	resolveContentType,
	resolveExtension,
	uniqueVaultPath,
} from "../vault-files";

/** 上传成功后，本地那份副本怎么办。 */
export type LocalCopyPlan =
	/** 搬进缓存目录（默认；离线可用的前提）。 */
	| "move-to-cache"
	/** 就地留着（用户选「原地保留」，或缓存功能被关掉）。 */
	| "keep-in-place"
	/** 移入回收站（用户明确不要本地副本 → 离线不可用，这是他自己的选择）。 */
	| "trash";

/**
 * 决定本地副本的处置方式（**纯函数**，便于穷举）。
 *
 * 抽成纯函数的理由与别名判定一样：这是"用户明确选了什么"与"我们实际做了什么"
 * 之间的翻译。翻错了不会有报错，只有"行为与设置不符"的长期困惑。
 *
 * ⚠️ 这个函数曾经接收 `localFileAction` + `cacheEnabled` **两个**参数，
 * 于是存在一类静默矛盾：用户选"移入缓存"但把缓存关掉 → 得到"原地保留"，
 * 而界面上看不出任何异常。两个字段合并成一个 `LocalCopyAction` 之后，
 * **矛盾状态在类型上就不存在了** —— 三个取值各自唯一对应一个结果。
 *
 * `cachePathUsable` 指缓存路径能否推导出来（缓存目录没配 / key 无法推导时为 false）。
 * 此时退回"原地保留"而不是报错 —— 用户的图能正常用，只是副本没进缓存目录，
 * 这比让上传直接失败好。
 */
export function planLocalCopy(action: LocalCopyAction, cachePathUsable: boolean): LocalCopyPlan {
	if (action === "trash") return "trash";
	if (action === "cache" && cachePathUsable) return "move-to-cache";
	return "keep-in-place";
}

export type IngestStatus =
	/** 已上传（并已落盘 + 登记索引）。 */
	| "uploaded"
	/** 内容与 URL 都已在索引里 → 跳过上传，零网络请求。 */
	| "reused"
	/** 上传失败：字节已保留在附件目录，链接要用本地路径。 */
	| "fallback";

export interface IngestResult {
	status: IngestStatus;
	/** 对象 key；连 key 都算不出来时为空串。 */
	key: string;
	/** 写进笔记的远端 URL；`fallback` 时为空串。 */
	remoteUrl: string;
	/**
	 * 本地副本的 vault 路径；`trash` 处置或**连本地都没落成**时为空串。
	 * 空串意味着"这张图没有本地副本"——调用方要么插远端链接，要么明确报错。
	 */
	localPath: string;
	etag: string;
	/** `fallback` 时的原因。 */
	error?: Error;
}

export interface IngestRequest {
	bytes: Uint8Array;
	/** 原始文件名。可能缺（截图粘贴常见）——那时按 MIME 造一个。 */
	name?: string;
	/** MIME 类型。 */
	mime?: string;
	/**
	 * 触发这次上传的笔记路径，用于让宿主决定附件落在哪个目录
	 * （Obsidian 支持"与笔记同目录"这类设置）。
	 */
	sourcePath?: string;
}

export interface IngestDeps {
	app: App;
	settings: PluginSettings;
	client: S3Client;
	index: CacheIndex;
	/** 索引变更后落盘。抽成回调是为了让测试与批处理控制时机。 */
	persistIndex: () => Promise<void>;
	/** 用户可见的提示（失败/警告）。 */
	notify?: (message: string) => void;
	/** 内容哈希。注入是为了让测试可确定，也为将来换算法留口子。 */
	hashBytes?: (bytes: Uint8Array) => Promise<string>;
	now?: () => Date;
}

/** 扩展名全缺时的兜底。用 `bin` 而不是空串 —— 见下方 `resolveKeyExtension`。 */
const FALLBACK_EXTENSION = "bin";

/**
 * key 里用的扩展名。
 *
 * ⚠️ **不能允许为空**：默认模板是 `{hash}.{ext}`，空扩展名会渲染成 `abc.` ——
 * 一个以点结尾的文件名。**Windows 会静默丢掉结尾的点**，于是同一个 key
 * 在 Windows 上变成 `abc`、在 Linux 上还是 `abc.`：
 * 缓存文件名与索引记录对不上，而且这种不一致只在部分平台上出现。
 */
function resolveKeyExtension(name: unknown, mime: unknown): string {
	return resolveExtension(name, mime) || FALLBACK_EXTENSION;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 同时看宿主的文件索引与真实磁盘 —— 两者的滞后方向相反，只看任一个都会撞名。 */
function makeExists(app: App): (path: string) => Promise<boolean> {
	return async (path: string) => {
		if (app.vault.getAbstractFileByPath(path)) return true;
		try {
			return await app.vault.adapter.exists(path);
		} catch {
			// 适配器出错时**当作已存在**：这是更保守的一侧 ——
			// 结果是"多拿一个序号"，而不是"覆盖掉一个真实文件"。
			return true;
		}
	};
}

/** 确保目录存在（已存在时宿主的 createFolder 会抛错，所以吞掉）。 */
async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder) return;
	if (app.vault.getAbstractFileByPath(folder)) return;
	try {
		await app.vault.createFolder(folder);
	} catch {
		// 并发创建 / 已存在：都不是错误
	}
}

/**
 * 问宿主"这个附件该放哪"，拿不到就按设置兜底。
 *
 * 优先问宿主是因为它知道用户的附件目录设置（含"与当前笔记同目录"这类模式），
 * 而这个信息插件读不到。`getAvailablePathForAttachment` 在部分版本/移动端可能缺失，
 * 所以必须**可选调用 + 兜底**，而不是假定它存在。
 */
function suggestAttachmentPath(deps: IngestDeps, fileName: string, sourcePath?: string): string {
	const manager = deps.app.fileManager as unknown as {
		getAvailablePathForAttachment?: (name: string, sourcePath?: string) => string;
	};

	if (typeof manager.getAvailablePathForAttachment === "function") {
		try {
			// ⚠️ 这个 API **不保证返回值未被占用**（官方文档明说），
			// 所以下面仍然要过 uniqueVaultPath，不能直接拿来用。
			const suggested = manager.getAvailablePathForAttachment(fileName, sourcePath);
			if (typeof suggested === "string" && suggested.trim() !== "") {
				return suggested.replace(/\\/g, "/").replace(/^\/+/, "");
			}
		} catch {
			// 版本差异 / 参数不符 → 落到兜底
		}
	}

	const folder = String(deps.settings.attachmentFolder ?? "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * 把字节落进附件目录，返回它的 vault 路径。
 *
 * **先落盘**是这一层安全性的来源：在这一步之后，字节已经不可能丢了。
 */
async function stageLocally(deps: IngestDeps, request: IngestRequest, fileName: string): Promise<string> {
	const app = deps.app;
	const desired = suggestAttachmentPath(deps, fileName, request.sourcePath);

	await ensureFolder(app, parentFolderOf(desired));
	const path = await uniqueVaultPath(desired, makeExists(app));

	await app.vault.createBinary(path, bytesToArrayBuffer(request.bytes));
	return path;
}

/** `createBinary` 要 ArrayBuffer；切成独立的那一段，避免把视图以外的字节一起写进去。 */
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * 执行一次"上传 + 缓存 + 登记"。
 *
 * 幂等性说明：同一份内容重复调用是安全的 —— 远端 PUT 幂等，
 * 本地因为内容寻址会命中缓存而跳过，落盘路径也因为 `uniqueVaultPath` 不会覆盖。
 */
export async function ingestAttachment(deps: IngestDeps, request: IngestRequest): Promise<IngestResult> {
	const { settings, client, index } = deps;
	const bytes = request.bytes instanceof Uint8Array ? request.bytes : new Uint8Array(0);
	const now = deps.now?.() ?? new Date();
	const hashBytes = deps.hashBytes ?? sha256Hex;

	// ── 1. 算出 key 与本地缓存路径（纯逻辑，先做完，避免"上传了才发现路径不合法"）──
	const ext = resolveKeyExtension(request.name, request.mime);
	let key: string;
	try {
		key = renderObjectKey(settings.s3.objectKeyTemplate, {
			hash: await hashBytes(bytes),
			ext,
			filename: request.name ?? fallbackFileName(ext, now),
			date: now,
		});
	} catch (error) {
		// renderObjectKey 是纯函数、不该抛；真抛了说明模板或哈希出了问题
		return { status: "fallback", key: "", remoteUrl: "", localPath: "", etag: "", error: asError(error) };
	}

	if (!key) {
		return {
			status: "fallback",
			key: "",
			remoteUrl: "",
			localPath: "",
			etag: "",
			error: new Error("对象 key 渲染为空 —— 请检查对象 key 模板设置"),
		};
	}

	const cachePath = cachePathFor(key, settings.cacheFolder);
	const remoteUrlFor = safePublicUrl(client, key);
	const contentType = resolveContentType(request.name, request.mime);

	// ── 2. 命中缓存 → 跳过上传（零网络）──
	// 三个条件缺一不可：索引里有记录、URL 没变过、本地副本真的还在。
	// 之前这里还有一个 `cacheEnabled` 前置判断，现在去掉了 —— 它是**多余**的：
	// 不留本地副本（`localCopy: "trash"`）时根本不会登记索引（见下面第 6 步），
	// 所以 `known` 必然是 undefined，这个分支自然不会进来。
	// 留着一个永远为真的条件，只会让读代码的人以为还有别的情况要考虑。
	const known = index.get(key);
	if (
		known &&
		known.remoteUrl &&
		remoteUrlFor &&
		normalizeUrl(known.remoteUrl) === normalizeUrl(remoteUrlFor)
	) {
		const present = await makeExists(deps.app)(known.cachePath);
		if (present) {
			return {
				status: "reused",
				key,
				remoteUrl: known.remoteUrl,
				localPath: known.cachePath,
				etag: known.etag,
			};
		}
	}

	// ── 3. 先落盘（此刻起字节已安全）──
	const fileName = request.name ?? fallbackFileName(ext, now);
	let stagedPath: string;
	try {
		stagedPath = await stageLocally(deps, { ...request, bytes }, fileName);
	} catch (error) {
		// 连本地都没能落成。调用方必须**大声报错** —— 此时用户粘贴的内容确实没留下，
		// 而这正是"绝不丢图"要避免的极端情况。
		return { status: "fallback", key, remoteUrl: "", localPath: "", etag: "", error: asError(error) };
	}

	// ── 4. 上传 ──
	let etag = "";
	let remoteUrl = "";
	try {
		const put = await client.putObject(key, bytes, contentType);
		etag = put.etag;
		remoteUrl = put.url;
	} catch (error) {
		// 上传失败：字节已经留在附件目录里 → 返回本地路径，绝不丢图
		return { status: "fallback", key, remoteUrl: "", localPath: stagedPath, etag: "", error: asError(error) };
	}

	// ── 5. 按设置处置本地副本 ──
	const plan = planLocalCopy(settings.localCopy, Boolean(cachePath));
	let localPath = stagedPath;

	if (plan === "trash") {
		localPath = "";
		await trashPath(deps.app, stagedPath);
	} else if (plan === "move-to-cache" && cachePath) {
		const moved = await moveIntoCache(deps, stagedPath, cachePath);
		// 搬失败时**保留原地**并在索引里记下真实位置 ——
		// 上传已经成功，没有必要因为一次 rename 失败而让整个操作变成失败。
		localPath = moved;
	}

	// ── 6. 登记索引 ──
	const entry: CacheEntry = {
		key,
		cachePath: localPath,
		remoteUrl,
		size: bytes.length,
		contentType,
		etag,
		uploadedAt: now.toISOString(),
		// 刚写下的副本就是"刚被用到"的：粘贴完用户多半马上要看它。
		// 这也让它在缓存轮换的宽限期内不会被立刻淘汰（见 maintenance/eviction.ts）。
		lastUsedAt: now.getTime(),
		sourceName: fileName,
	};
	// `trash` 处置时本地没有副本：仍登记，但 cachePath 记空串会被 normalizeEntry 丢弃 → 
	// 改为不登记。理由：索引的用途是"按 URL 找本地副本"，没有副本就没有可记的事实
	// （"远端有这么个对象"这件事本身由笔记里的 URL 承载）。
	if (localPath) {
		index.set(entry);
		try {
			await deps.persistIndex();
		} catch (error) {
			// 索引落盘失败不该让上传算失败（URL 已经能用）。
			// 但要**说出来** —— 否则用户会在下次重启后发现缓存"不被认识"而莫名其妙。
			deps.notify?.(`缓存索引保存失败：${describe(error)}`);
		}
	} else {
		// 即便不留本地副本，也把旧记录清掉，否则会指向一个已被删除的文件
		if (index.remove(key)) {
			try {
				await deps.persistIndex();
			} catch {
				// 同上，非致命
			}
		}
	}

	return { status: "uploaded", key, remoteUrl, localPath, etag };
}

/**
 * 把文件搬进缓存目录，返回它**实际**所在的路径。
 *
 * ⚠️ 目标已占用时**另取序号，绝不覆盖**：
 * 只有当模板含 `{hash}`（内容寻址）时"同路径 = 同内容"才成立。
 * 用户完全可以把模板改成 `{filename}` —— 那时同一个路径可能对应**不同内容**，
 * 覆盖就等于静默丢掉旧的那份。另取序号在任何模板下都是安全的，
 * 而多出来的那点路径不确定性由索引兜住（索引记的是真实路径，不是推导值）。
 */
async function moveIntoCache(deps: IngestDeps, stagedPath: string, cachePath: string): Promise<string> {
	const app = deps.app;
	await ensureFolder(app, parentFolderOf(cachePath));

	let target: string;
	try {
		target = await uniqueVaultPath(cachePath, makeExists(app));
	} catch (error) {
		deps.notify?.(`缓存目录里的目标路径不可用：${describe(error)}`);
		return stagedPath;
	}

	const file = app.vault.getAbstractFileByPath(stagedPath);
	if (!file) {
		// 宿主的索引还没看到刚写的文件（异步落盘的常见现象）→ 退回用适配器直接改名，
		// 这样至少文件位置是对的，只是宿主需要自己重新索引。
		try {
			await app.vault.adapter.rename(stagedPath, target);
			return target;
		} catch (error) {
			deps.notify?.(`缓存副本搬移失败：${describe(error)}`);
			return stagedPath;
		}
	}

	try {
		// 用 fileManager 而不是 adapter：它会同步更新宿主的文件索引，
		// 否则已打开的笔记里那条刚刚插入的链接会指向"不存在的文件"。
		await app.fileManager.renameFile(file, target);
		return target;
	} catch (error) {
		deps.notify?.(`缓存副本搬移失败：${describe(error)}`);
		return stagedPath;
	}
}

/** 移入回收站（走宿主的 trash，尊重用户的"删除即进回收站"设置）。 */
async function trashPath(app: App, path: string): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return;
	try {
		await app.fileManager.trashFile(file);
	} catch (error) {
		// 删不掉就留着 —— 多一个文件远好过丢一张图
		void error;
	}
}

/** `publicUrl` 可能因为路径不合法而抛错；这里吞掉并返回空串（由调用方决定怎么办）。 */
function safePublicUrl(client: S3Client, key: string): string {
	try {
		return client.publicUrl(key);
	} catch {
		return "";
	}
}

function asError(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(String(error));
}
