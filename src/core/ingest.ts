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
 *        ├─ 成功 → 原地保留（副本就是它自己）/ 回收站 → 登记索引
 *        └─ 失败 → 字节就留在附件目录 → 返回本地路径（绝不丢图）
 * ```
 *
 * 反过来（先上传、成功后再写本地副本）有一处**结构性**隐患：
 * 上传成功而本地写入失败时（磁盘满、权限、移动端的存储配额），
 * 我们就只剩一个远端 URL，而离线能力没了 —— 更糟的是若连远端也失败，
 * 字节就真的没了。先落盘的话，最坏情况也只是"图还在、只是没上传"。
 *
 * ⭐ 1.2.0（D-17）之后这里**不再搬运**：上传成功时文件就留在附件目录原地，
 * 那份文件本身就是本地副本（"缓冲区文件夹"整个取消了）。老用户缓存目录里的旧副本
 * 由迁移命令搬回附件目录，见设计 §20.11。
 *
 * ## 为什么"命中缓存"要能跳过上传
 *
 * key 里带**完整内容哈希**（1.2.0 起形状固定成 `<名字>-<哈希>.<扩展名>`），所以**同一个文件**
 * （同名同内容）重复粘贴会得到同一个 key —— 此时远端对象**一定已经存在**（上次上传的），本地副本也在。
 * ⚠️ 反过来不成立：同一份内容**换个名字**得到的是另一个 key ⇒ 桶里各存一份（跨名去重失效，D-18 的既定代价）。
 * 再 PUT 一次是纯浪费（可能是几十 MB 的上行）。所以命中且 URL 未变时直接复用 ——
 * **零网络请求**。这一条是可测的（断言 PUT 次数为 0）。
 *
 * 但只有在**索引里确认过**才敢跳过：光看缓存里有文件不够 ——
 * 那个文件可能是同步过来的、或者用户手工放进去的，我们并不确定它是否上传过。
 */

import type { App } from "obsidian";
import { CacheIndex, normalizeUrl, type CacheEntry } from "../cache/index";
import { displayNameForKey, hashFromKey, objectKeyFor } from "../object-key";
import type { S3Client } from "../s3/client";
import { sha256Hex } from "../s3/hash";
import type { LocalCopyAction, PluginSettings } from "../types";
import { describeError } from "../error-text";
import { notifyUser } from "../notify-user";
import type { NotifySink } from "../notify-user";
import {
	baseNameForDuplicate,
	extensionOfName,
	fallbackFileName,
	hostAttachmentFolder,
	normalizeVaultPath,
	parentFolderOf,
	resolveContentType,
	resolveExtension,
	uniqueVaultPath,
} from "../vault-files";

/** 上传成功后，本地那份副本怎么办。 */
export type LocalCopyPlan =
	/** 就地留着（**唯一**的保留形态：副本就是附件本身）。 */
	| "keep-in-place"
	/** 移入回收站（用户明确不要本地副本 → 离线不可用，这是他自己的选择）。 */
	| "trash";

/**
 * 决定本地副本的处置方式（**纯函数**，便于穷举）。
 *
 * ## 1.2.0（D-17）：这里曾经有一条"搬进缓存目录"，它被删掉了
 *
 * 那时的计划是三态（`move-to-cache` / `keep-in-place` / `trash`），而
 * `move-to-cache` 意味着"上传成功后把文件搬走、只在缓存目录里留一份"——
 * 也就是"缓冲区文件夹"这个设计。取消缓存目录之后，**附件原地不动就是副本**，
 * 于是这条计划没有存在的位置：搬运这一步整个消失（`moveIntoCache` 随之删除）。
 *
 * ⚠️ 老用户设置里存的 `"cache"`（1.2.0 之前的值）**已经在读设置时被折成 `"keep"`**
 * （`settings.ts::localCopyValue`），所以这里收到的只可能是两态 —— 不需要再判一次。
 * 已有副本在老缓存目录里的，渲染与索引照常按路径服务；新上传一律原地保留。
 *
 * ⚠️ 这个函数曾接收 `localFileAction` + `cacheEnabled` **两个**参数，
 * 于是存在一类静默矛盾：用户选"移入缓存"但把缓存关掉 → 得到"原地保留"，
 * 而界面上看不出任何异常。字段合并成一个 `LocalCopyAction` 之后，
 * **矛盾状态在类型上就不存在了**。
 */
export function planLocalCopy(action: LocalCopyAction): LocalCopyPlan {
	return action === "trash" ? "trash" : "keep-in-place";
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
	/**
	 * 归一化后的小写扩展名（**不含点**）；推不出来时是兜底的 `bin`。
	 *
	 * 为什么让它跟着结果一起出来：调用方要拿"类型"决定链接**形态**
	 * （可嵌入类型用 `![]()`，其余用 `[]()`），而它手上只有字节与文件名。
	 * 让它在链接生成处重新猜一遍，就会与这里（key 用的是同一个值）出现分叉 ——
	 * 同一份文件可能"存成 .png 却当成普通链接"这种不一致。
	 */
	ext: string;
	/**
	 * 这次用的**文件名**：调用方给的，或（没给时）我们按 MIME 造的那个可读名。
	 *
	 * 链接的显示位用它（`![report.pdf](url)` / `[report.pdf](url)`）——
	 * 用户在一篇笔记里要靠它认出"这是哪个文件"，而 `<哈希>.png` 认不出来。
	 */
	name: string;
	/**
	 * 链接里该显示的**名字**（`![这里](url)`）—— 从 key 反推，于是与链接**目标**里的
	 * 文件名逐字一致；取不到时退回 {@link name}。
	 *
	 * ⚠️ 为什么不能直接用 {@link name}（用户 2026-10-14 在 Android 上报的第五件事）：
	 * 宿主撞名另落的重复副本叫 `照片 1.png`，而 key 用的是**主干名字**（`照片-<哈希>.png`）
	 * ⇒ 显示位写 `照片 1.png` 时，笔记里就成了 `![照片 1.png](…/照片-<哈希>.png)`：
	 * 同一个链接里两个名字不一样，而且那个 ` 1` 是宿主的去重序号、不是用户的东西。
	 *
	 * 反推（而不是把 keyName 一路传下来）的理由与 `download-target` 取本地副本名一致：
	 * key 是名字的**唯一**真相，清洗（`sanitizeFilename`）也在那一层做 ——
	 * 两处各留一份名字，迟早会出现"显示的名字与地址里的名字不是一个"。
	 */
	displayName: string;
	/** 写进笔记的远端 URL；`fallback` 时为空串。 */
	remoteUrl: string;
	/**
	 * 本地副本的 vault 路径；`trash` 处置或**连本地都没落成**时为空串。
	 * 空串意味着"这张图没有本地副本"——调用方要么插远端链接，要么明确报错。
	 */
	localPath: string;
	etag: string;
	/**
	 * ⭐ 这一份是**宿主撞名另落的重复副本**时，指向那份"主干文件"的路径
	 * （`照片 1.png` ⇒ `照片.png`）。见 {@link nameForHostDuplicate}。
	 *
	 * 调用方据此可以**在链接改写成功、且这一份已零引用之后**把它删掉
	 * （`runBatchUpload` 的收尾步，用户 2026-10-14 要求"链接 ok 以后就可以删掉"）。
	 * 只有**迁移模式**下才可能出现：粘贴那条路的落盘名是我们自己取的，不会有这种副本。
	 */
	redundantDuplicateOf?: string;
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
	/**
	 * 字节**已经在 vault 的这个路径上**（迁移已有附件时由调用方指出）。
	 *
	 * 给了它就进入**迁移模式**，与粘贴路径有三处不同：
	 * 1. **不再落盘** —— 字节已经在库里，"先落盘"这一步天然满足；
	 *    照搬会在附件目录里凭空多出一个 `xxx 1.png`（原文件占着名字 ⇒ 另取序号）。
	 * 2. **上传成功后不搬动它**（1.2.0 起：没有缓存目录可搬）。那个文件从此
	 *    既是用户的附件、也是插件认的本地副本 —— 索引把它按**真实路径**记下来。
	 *    ⚠️ 调用方仍然只把"确实被笔记引用着的"文件交进来（见
	 *    `selectUploadCandidates` 的 `referencedPaths`）：命令会把这些引用改写成
	 *    远端地址，而那之后文件留在原处正是我们要的结果。
	 * 3. 因此 `localCopy: "trash"` 在这个模式下**降级为原地保留** ——
	 *    用户要的是"别为我留副本"，而那个文件不是我们的副本，删它超出授权范围。
	 *
	 * 空串 / 缺省 = 普通粘贴路径（字节在内存里，必须先落盘）。
	 */
	existingPath?: string;
}

export interface IngestDeps extends NotifySink {
	app: App;
	settings: PluginSettings;
	client: S3Client;
	index: CacheIndex;
	/** 索引变更后落盘。抽成回调是为了让测试与批处理控制时机。 */
	persistIndex: () => Promise<void>;
	/**
	 * 这份对象**从哪来**（只区分"站外缓存"这一种，见 `CacheEntry.origin`）。
	 *
	 * 云端清理靠它把"用户明确要求缓存、但链接没改写成功"的对象排除在候选之外 ——
	 * 少了这一条，那种对象会因为"笔记里写的是原站外地址"而被误判成没人用。
	 */
	origin?: CacheEntry["origin"];
	/** 内容哈希。注入是为了让测试可确定，也为将来换算法留口子。 */
	hashBytes?: (bytes: Uint8Array) => Promise<string>;
	now?: () => Date;
	/**
	 * ⭐ 问云端"这个对象在不在"（HEAD）。在 ⇒ 返回它的 etag（拿不到细节时空串）；
	 * **不在、或问不动（离线 / 鉴权 / 服务端错）⇒ 返回 `null`**。
	 *
	 * 用途只有一个：**别把已经传过的字节再传一遍**。见第 2c 步 ——
	 * 宿主为撞名另落一份（`名字 1.ext`）时我们已经知道"这份内容很可能早就在云端"
	 * （同内容的兄弟文件就摆在旁边），可本机台账不一定答得上（换设备、索引被覆盖、首装
	 * 都答不上）⇒ 与其把整份字节重传，先问云端一句。
	 *
	 * ⚠️ **只在"要传的这份是重复副本"时才问**（第 2c 步的前提是 `twinPath` 非空），
	 * 不是每次上传都问：真正的**新**文件云端按定义不可能有，多一次往返纯属浪费
	 *（手机上"插图"是最常用的动作，给它每次加一个 RTT 不划算）。这是**量过的取舍**。
	 *
	 * ⚠️ 失败方向是安全的：**答不上来一律当作"不在"** ⇒ 退回 PUT。同样的字节、同一个 key，
	 * 重传是幂等的；而把"不在"当成"在"会留下一张**打不开的图**。
	 */
	probeRemote?: (key: string) => Promise<string | null>;
	/**
	 * ⭐ 刚刚在附件目录里落下了一份**中转文件**（`path` 是它的库内路径）。
	 *
	 * 存在的理由只有一个：新增附件自动接管那条链挂在 `vault.on("create")` 上，
	 * 而"先落盘再上传"这条纪律**也会触发同一个事件**（`vault.createBinary`）。
	 * 少了这个标记，那条链会把自己刚写下去的中转文件当成"用户新加的附件"
	 * 再接管一次 —— 重复上传，而且两条路会抢同一个文件。
	 */
	onStaged?: (path: string) => void;
}

/** 扩展名全缺时的兜底。用 `bin` 而不是空串 —— 见下方 `resolveKeyExtension`。 */
const FALLBACK_EXTENSION = "bin";

/**
 * key 里用的扩展名。
 *
 * ⚠️ **不能允许为空**：key 是 `<名字>-<哈希>` 加一个 `.<扩展名>`，空扩展名会渲染成 `abc.` ——
 * 一个以点结尾的文件名。**Windows 会静默丢掉结尾的点**，于是同一个 key
 * 在 Windows 上变成 `abc`、在 Linux 上还是 `abc.`：
 * 缓存文件名与索引记录对不上，而且这种不一致只在部分平台上出现。
 */
function resolveKeyExtension(name: unknown, mime: unknown): string {
	return resolveExtension(name, mime) || FALLBACK_EXTENSION;
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
 * 决定这次落盘的路径：**宿主自己的附件位置 → vault 根目录**。
 *
 * ⚠️ 目录解析本身在 `vault-files.ts` 的 `hostAttachmentFolder`（回退下载那条路
 * 也要用同一个答案 —— 两条路各自实现一次就会分叉）。这里只做"目录 + 文件名"。
 */
function suggestAttachmentPath(deps: IngestDeps, fileName: string, sourcePath?: string): string {
	const folder = hostAttachmentFolder(deps.app, sourcePath);
	return folder ? `${folder}/${fileName}` : fileName;
}

/**
 * **落盘**用的文件名：必须带一个**真实的**扩展名。
 *
 * ⚠️ 这条看着多余，其实是一条不可逆缺陷的修复（1.2.0 / D-17 才暴露出来）：
 * 从前本地副本会被搬进缓存目录、并按 key 重命名（key 一定带正确的扩展名），
 * 所以"名字里没有可用扩展名"从来不影响显示。取消缓存目录之后**落地的那份名字就是最终名字**，
 * 于是站外图片那种 URL 尾巴（`OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA`）会变成一个
 * **没有类型的文件** —— 而 Obsidian 按名字判断怎么显示它：
 * 结果是缓存明明成功了，用户却看不到图，以为"没缓存"。
 *
 * 判据用 `extensionOfName`（"最后一个点后面那段像不像扩展名"），不猜内容类型：
 * 名字里那段不像扩展名（或压根没有）⇒ **去掉它**、改成真实类型 ——
 * 站外图片的 URL 尾巴（`OIP-C.<23 位令牌>`）正是这种噪音，留着它等于给文件起了个
 * Obsidian 不认识的名字。名字里的扩展名看起来正常时**一律不动**（用户起的名字优先）。
 */
function stagedFileName(name: string, ext: string): string {
	const current = extensionOfName(name).toLowerCase();
	if (current === ext) return name;

	// 切掉"最后一个点之后"的那一段：它要么不是扩展名（令牌），要么与真实类型不符。
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const clean = stem.replace(/[.\s]+$/, "");
	return clean ? `${clean}.${ext}` : `file.${ext}`;
}

/**
 * 把字节落进附件目录，返回它的 vault 路径。
 *
 * **先落盘**是这一层安全性的来源：在这一步之后，字节已经不可能丢了。
 */
async function stageLocally(
	deps: IngestDeps,
	request: IngestRequest,
	fileName: string,
	ext: string
): Promise<string> {
	const app = deps.app;
	const desired = suggestAttachmentPath(deps, stagedFileName(fileName, ext), request.sourcePath);

	await ensureFolder(app, parentFolderOf(desired));
	const path = await uniqueVaultPath(desired, makeExists(app));

	await app.vault.createBinary(path, bytesToArrayBuffer(request.bytes));
	// ⚠️ 落盘之后**立刻**上报（而不是等上传完）：自动接管那条链可能在 create 的
	// 下一拍就来问"这个新文件是不是用户加的"，晚一拍就会把它当成用户的附件。
	deps.onStaged?.(path);
	return path;
}

/** `createBinary` 要 ArrayBuffer；切成独立的那一段，避免把视图以外的字节一起写进去。 */
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * 宿主为"撞名"另落的那一份 ⇒ 用**原来那个名字**算 key（用户 2026-10-14 Android 直报）。
 *
 * 现场：同一张图插第二次，宿主发现 `照片.png` 已在，就把新文件叫 `照片 1.png`
 * （它的唯一化规矩，我们拦不住）⇒ 名字不同、key 不同 ⇒ 云端多存一份**完全相同**的内容，
 * 笔记里两处引用指着两个对象。用户看到的正是"新建了一个带 1 的地址"。
 *
 * ## 判据只有两条，且**都不依赖本机台账**
 *
 * ① 名字是 `<主干> <序号><扩展名>` 这个形状（{@link baseNameForDuplicate}，纯字符串）；
 * ② 同目录下 `<主干><扩展名>` 确实存在，**且内容哈希和我们一致**。
 *
 * 两条都成立 ⇒ 它就是"同一份内容被宿主另起了一个名字" ⇒ 用主干那个名字算 key。
 * 于是两份文件的 key（以及由 key 推出的 URL）**完全相同**：桶里只有一个对象，
 * 笔记里两处引用指向同一个地址。
 * 同时把那份**主干文件的路径**回报给调用方（{@link IngestResult.redundantDuplicateOf}）：
 * 这一份是宿主为撞名另落下的，调用方可以在**链接改写成功且它已零引用**之后删掉它。
 *
 * ⚠️⚠️ 这一版**刻意不再靠上传台账**。上一版修法（"内容是云端已有的 ⇒ 复用那个 key"）
 * 在真机上失效了：台账（`uploaded`）是**本机状态**，换设备 / 丢了 `.cache-index.json`
 * 时它里面没有第一笔记录，"这份内容传过吗"就永远答"没有" —— 于是照样传了第二份。
 * 而"同目录下有没有一个同内容的兄弟文件"是 **vault 里的事实**，与台账无关，问得出答案。
 * （台账那条路仍然保留，它管的是"跨目录、完全换了名字"的更宽的情形。）
 *
 * ## 出错方向
 *
 * 任何一步问不出来（探针抛错、读不动）一律**返回原文件名** ⇒ 照常上传。
 * 代价是"可能多一个对象"（可回收），而另一侧是"把两份**内容不同**的文件并到同一个
 * 对象上"（覆盖，不可逆）—— 与 `download-target.ts` 的"先比内容再加序号"同一个方向。
 */
async function nameForHostDuplicate(
	deps: IngestDeps,
	fileName: string,
	contentHash: string,
	hashBytes: (bytes: Uint8Array) => Promise<string>,
	existingPath: string
): Promise<{ keyName: string; twinPath: string | null }> {
	// 只在**迁移模式**下判：带序号的名字只可能出现在宿主已经写进 vault 的文件上。
	// 粘贴那条路由我们自己落盘（`uniqueVaultPath`），而 key 用的是**原始文件名** ——
	// 那里不会有这种后缀。
	if (!existingPath || !contentHash) return { keyName: fileName, twinPath: null };

	const original = baseNameForDuplicate(fileName);
	if (!original) return { keyName: fileName, twinPath: null };

	const folder = parentFolderOf(existingPath);
	const sibling = folder ? `${folder}/${original}` : original;
	try {
		const adapter = deps.app.vault.adapter;
		if (!(await adapter.exists(sibling))) return { keyName: fileName, twinPath: null };
		const siblingHash = await hashBytes(new Uint8Array(await adapter.readBinary(sibling)));
		if (siblingHash !== contentHash) return { keyName: fileName, twinPath: null };
		return { keyName: original, twinPath: sibling };
	} catch {
		// 问不动就按原名处理：多一个对象是可回收的，认错文件不是
		return { keyName: fileName, twinPath: null };
	}
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

	// 字节的来源：**先落盘（粘贴）还是指向已有文件（迁移）**。这一步判定要在
	// 算 key 之前就完成 —— 因为"宿主撞名另落的那一份"只出现在迁移模式下，
	// key 推导要用它（见 `nameForHostDuplicate`）。
	const existingPath = normalizeVaultPath(request.existingPath);
	const isMigration = existingPath !== "";

	// ── 1. 算出 key 与本地缓存路径（纯逻辑，先做完，避免"上传了才发现路径不合法"）──
	const ext = resolveKeyExtension(request.name, request.mime);
	// 文件名也是**一次算定**：key 渲染、落盘、显示名、索引都共用它。
	// 分成两处算会让"没文件名时造的名字"出现两个不同时间戳（截图粘贴的常态）。
	const fileName = request.name ?? fallbackFileName(ext, now);
	/**
	 * 链接里该显示的名字（见 {@link IngestResult.displayName}）：从 key 反推，
	 * 取不到（key 为空，或不是默认形状）时退回调用方给的文件名。
	 */
	const displayFor = (candidate: string): string => displayNameForKey(candidate) || fileName;
	let key: string;
	/**
	 * 宿主撞名另落的那一份对应的**主干文件**路径（不是这一份）。
	 * 非空 = 这一份是重复副本，调用方可在链接改写成功、它已零引用之后删掉它。
	 */
	let twinPath: string | null = null;
	/** 内容哈希：算 key 与"这份内容传过吗"共用一次。 */
	let contentHash = "";
	try {
		// ⭐ 1.2.0：key 的形状不再可配置（模板设置已取消）——
		// 固定 `<名字>-<完整哈希>.<扩展名>`，两个分量分别给人看与给机器判身份。
		contentHash = await hashBytes(bytes);
		// ⭐ 2026-10-14：宿主为撞名另落的那一份（`照片 1.png`）用**主干名字**算 key ——
		// 否则同一份内容会因为名字不同而多存一个对象，笔记里两处引用各指一处。
		const normalized = await nameForHostDuplicate(deps, fileName, contentHash, hashBytes, existingPath);
		twinPath = normalized.twinPath;
		key = objectKeyFor({
			hash: contentHash,
			ext,
			filename: normalized.keyName,
		});
	} catch (error) {
		// `objectKeyFor` 是纯函数、不该抛；真抛了说明**哈希那一步**出了问题
		return { status: "fallback", key: "", ext, name: fileName, displayName: fileName, remoteUrl: "", localPath: "", etag: "", error: asError(error) };
	}

	/** 成功返回时统一带上"这一份是重复副本"这条信息（没有时不带这个字段）。 */
	const redundantFields = twinPath ? { redundantDuplicateOf: twinPath } : {};

	if (!key) {
		return {
			status: "fallback",
			key: "",
			ext,
			name: fileName,
			displayName: fileName,
			remoteUrl: "",
			localPath: "",
			etag: "",
			// 只有一种成因：哈希不是 sha256 的形状 ⇒ 拿不到对象身份。
			// 这时**必须**放弃这次上传（绝不生成"所有文件共用"的 key），
			// 而字节已经/仍然在本地，用户的图不会丢。
			error: new Error("对象 key 为空 —— 内容哈希不可用，无法为对象生成身份"),
		};
	}

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
				ext,
				name: known.sourceName || fileName,
				// ⚠️ 显示名**从 key 反推**，不用 `known.sourceName`：名字的真相在 key 里，
				// 台账那一份是"上次那次上传时叫什么"，可能带着当时的宿主序号。
				displayName: displayFor(key),
				remoteUrl: known.remoteUrl,
				localPath: known.cachePath,
				etag: known.etag,
				...redundantFields,
			};
		}
	}

	// ── 2b. 同一份内容、**换了个名字** ⇒ 复用已有对象（零网络）──
	//
	// 用户 2026-10-14 在 Android 上报的场景：把同一张图**再插一次**，宿主发现同名文件
	// 已存在，会另落一份 `名字 1.ext`（宿主的唯一化行为，我们拦不住）⇒ 名字不同、key 不同 ——
	// 而 key 里带名字是 D-18 的既定取舍（"跨名去重失效"）。于是桶里会多存一份**完全相同**的内容。
	//
	// ⚠️ 这条路**只管"更宽的情形"**（跨目录、名字完全换了），因为它靠的是本机上传台账
	// （`uploaded`）—— 台账是**本机状态**，换设备 / 丢了 `.cache-index.json` 时就答不上来。
	// 「宿主撞名另落一份」这个**具体**场景改由 `nameForHostDuplicate` 在算 key 之前处理，
	// 判据是 vault 里的事实（同目录下有没有同内容的兄弟文件），不依赖台账。
	// 两条并存：先归名字（步骤 1），再按内容认亲（这里）。
	const twinKey = contentHash && index.wasContentUploaded(contentHash)
		? (index.uploadedKeys().find((candidate) => candidate !== key && hashFromKey(candidate) === contentHash) ?? null)
		: null;
	/** 对象已在云端、只是名字不同 ⇒ 后面跳过 PUT（但本地那一步照常走）。 */
	let reuseCloudObject = false;
	if (twinKey) {
		const twinEntry = index.get(twinKey);
		const twinUrl = safePublicUrl(client, twinKey);
		if (twinEntry && twinUrl && normalizeUrl(twinEntry.remoteUrl) === normalizeUrl(twinUrl)) {
			const twinPresent = await makeExists(deps.app)(twinEntry.cachePath);
			if (twinPresent) {
				// ⭐ 本地副本就是**那一份** ⇒ 这一份是重复落下的：索引一个字都不改，
				// 引用会被改写成那个对象的地址（调用方用返回的 remoteUrl 改写）。
				return {
					status: "reused",
					key: twinKey,
					ext,
					name: twinEntry.sourceName || fileName,
					// ⭐ 这一份是宿主撞名另落的重复副本 ⇒ 显示名必须用**主干名字**
					//（`照片.png` 而不是 `照片 1.png`），与链接目标里的名字一致。
					displayName: displayFor(twinKey),
					remoteUrl: twinEntry.remoteUrl,
					localPath: twinEntry.cachePath,
					etag: twinEntry.etag,
					...redundantFields,
				};
			}
		}
		// 对象在云端、本地却没有可用的副本（例如「不留副本」档：只记台账、不记条目）⇒
		// 复用那个 key，但不 PUT 第二份；下面照常按档位处置这一份文件并登记。
		key = twinKey;
		reuseCloudObject = true;
	}

	/**
	 * 云端对象的 etag（`reuseCloudObject` 时从第 2c 步的 HEAD 拿到，否则留空）。
	 *
	 * ⚠️ 台账那条路拿不到它（台账不记 etag）：那种情况留空。它只供展示与复核，
	 * **不参与任何判据** —— 所以缺它不是"信息不完整"，是"这一路本来就没有"。
	 */
	let etag = "";

	// ── 2c. ⭐ 台账答不上来，但这一份**确是宿主撞名另落的重复副本** ⇒ 先问云端一句 ──
	//
	// 第 2 步（索引条目）与第 2b 步（上传台账）都靠**本机簿记**：换设备、
	// `.cache-index.json` 被覆盖或丢了、首装，它们都答不上"这份内容在云端吗"。
	// 而 `twinPath` 非空说明**同目录下就摆着一份逐字节相同的兄弟文件** ——
	// 那份对象十有八九早就在云端了（真机现场正是如此：这台设备上一次插入已经把它传上去了，
	// 第二次插入却又把整份字节传了一遍 —— 用户看到的"上传成功"提示与事实相反）。
	//
	// 所以这里花**一次 HEAD**问云端这个"事实"，而不是把整份字节重传：
	// 在 ⇒ 跳过 PUT（etag 记进条目）；不在、问不动 ⇒ 照常上传（第 4 步）。
	//
	// ⚠️ 只在这一种情形下问。新文件云端按定义没有它，若每次上传都问，
	// 就是给"插图"这个最常用的动作每次都加一个往返。
	//
	// ⚠️ 探测**自己抛错**也当作"不在"（多一次 PUT 是幂等的，反过来会留下打不开的图）。
	if (!reuseCloudObject && twinPath && deps.probeRemote) {
		try {
			const probedEtag = await deps.probeRemote(key);
			if (probedEtag !== null) {
				reuseCloudObject = true;
				etag = probedEtag;
			}
		} catch {
			// 问不动 ⇒ 当作"不在"，下面照常上传
		}
	}

	// ── 3. 字节的来源：先落盘（粘贴）还是指向已有文件（迁移）──
	//
	// 两条路的差别不只是"省一次 I/O"：迁移模式下那个文件是**用户的资产**，
	// 我们不能像对待自己落的临时副本那样把它搬进缓存或丢进回收站。
	// （判定本身已在步骤 1 之前做完 —— key 推导要用它。）
	let stagedPath: string;
	if (isMigration) {
		// 字节已经在用户的 vault 里躺着 ⇒ 不做任何落盘动作。
		// （这不是"跳过了安全步骤"：安全的是**字节还留着**这件事，而它本来就在。）
		stagedPath = existingPath;
	} else {
		try {
			stagedPath = await stageLocally(deps, { ...request, bytes }, fileName, ext);
		} catch (error) {
			// 连本地都没能落成。调用方必须**大声报错** —— 此时用户粘贴的内容确实没留下，
			// 而这正是"绝不丢图"要避免的极端情况。
			return { status: "fallback", key, ext, name: fileName, displayName: displayFor(key), remoteUrl: "", localPath: "", etag: "", error: asError(error) };
		}
	}

	// ── 4. 上传 ──
	let remoteUrl = "";
	if (reuseCloudObject) {
		// 这份内容的对象已经在云端了（台账认亲、或第 2c 步刚问过云端）⇒ **不 PUT**。
		remoteUrl = safePublicUrl(client, key);
	} else {
		try {
			const put = await client.putObject(key, bytes, contentType);
			etag = put.etag;
			remoteUrl = put.url;
		} catch (error) {
			// 上传失败：字节已经留在附件目录里 → 返回本地路径，绝不丢图
			return { status: "fallback", key, ext, name: fileName, displayName: displayFor(key), remoteUrl: "", localPath: stagedPath, etag: "", error: asError(error) };
		}
	}

	// ── 5. 按设置处置本地副本 ──
	const plan = planLocalCopy(settings.localCopy);
	let localPath = stagedPath;

	// ⭐ 1.2.0（D-17）：搬运分支已删除 —— 副本**就是**附件本身，原地不动。
	//
	// ⚠️ 唯一还会动文件的是「不留副本」那一档，而且**只对粘贴路径下我们自己刚落的
	// 那份中转文件**生效：迁移模式下 `plan === "trash"` 不删任何东西（那个文件是
	// **用户的资产**，删它超出授权范围 —— 用户要的是"别为我留副本"，不是"删我的文件"）。
	if (!isMigration && plan === "trash") {
		localPath = "";
		await trashPath(deps.app, stagedPath);
	}

	// ── 6. 登记索引 + 上传台账 ──
	//
	// ⚠️ `cachePath` 在"这一份是宿主撞名另落的重复副本"时指向**主干那一份**（`twinPath`）：
	// 这一份马上会被调用方删掉（链接改写成功且零引用之后），把索引记在它身上等于留一条
	// **悬空条目** —— 而主干那份与它逐字节相同、且会留下，才是"我们的本地副本"。
	const entry: CacheEntry = {
		key,
		cachePath: twinPath ?? localPath,
		remoteUrl,
		size: bytes.length,
		contentType,
		etag,
		uploadedAt: now.toISOString(),
		// 刚写下的副本就是"刚被用到"的：粘贴完用户多半马上要看它。
		// 这也让它在缓存轮换的宽限期内不会被立刻淘汰（见 maintenance/eviction.ts）。
		lastUsedAt: now.getTime(),
		sourceName: fileName,
		...(deps.origin === "external" ? { origin: "external" as const } : {}),
	};

	// ⭐ 台账与条目是**两件事**，判据不同、去处也不同：
	// - 条目 = 「本地副本在哪」⇒ 只在真有副本时记（`trash` 档记空路径没有用途，
	//   `normalizeEntry` 也会把它丢掉 —— 那是刻意的，见 `cache/index.ts`）；
	// - 台账 = 「我们上传过它」⇒ **不分档位一律记**。R17 的自动入口靠它认领对象，
	//   而「不留副本」档正是没有条目那一档 —— 少记这一笔，那个入口在该档就永不出现。
	let dirty = index.markUploaded(key);

	if (localPath) {
		index.set(entry);
		dirty = true;
	} else if (index.remove(key)) {
		// 即便不留本地副本，也把旧记录清掉，否则会指向一个已被删除的文件
		dirty = true;
	}

	if (dirty) {
		try {
			await deps.persistIndex();
		} catch (error) {
			// 索引落盘失败不该让上传算失败（URL 已经能用）。
			// 但要**说出来** —— 否则用户会在下次重启后发现缓存"不被认识"而莫名其妙。
			notifyUser(deps, "ingestIndexPersistFailed", { error: describeError(error) });
		}
	}

	// ⭐ 状态要**如实**：`reused` = 这一次**没有把字节传上去**（云端本来就有）。
	//
	// ⚠️ 这个字段是**用户可见提示**的源头（调用方按它分别计数"上传了几个 / 已有的几个"），
	// 所以它写的必须是**真实发生的动作**，而不是"这条流程走完了"。
	// 用户 2026-10-14 在 Android 上报的正是它写错时的样子：重复插图明明只是拿回了
	// 已有对象的地址，提示却说"上传成功"。
	return {
		status: reuseCloudObject ? "reused" : "uploaded",
		key,
		ext,
		name: fileName,
		displayName: displayFor(key),
		remoteUrl,
		localPath,
		etag,
		...redundantFields,
	};
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
