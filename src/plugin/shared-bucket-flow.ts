/**
 * R25 共享桶：**接线**（把注入式的 `DeclarationIo` 接到真实的 S3 客户端）。
 *
 * 这一层只做三件事：
 * 1. 把 `S3Client` 的四个方法包成 `DeclarationIo`（声明层因此不依赖 S3 客户端类型）；
 * 2. 给出本设备的身份（`vaultId` / `deviceId` 存在设置里，缺失就不参与 —— 见下）；
 * 3. 给调用方两个入口：**上传前**写声明（`rememberReferences`）、**删除前**读声明（`sharedBucketGuardFor`）。
 *
 * ## 为什么接缝在这里而不是在 `main.ts` 里
 *
 * `main.ts` 已经很长，而"什么时候写声明、失败怎么报"属于流程判断，不是宿主装配。
 * 这里只吃 `PluginContext`（窄接口），于是它能在套件里用替身跑。
 */

import { Notice } from "obsidian";
import type { S3Client } from "../s3/client";
import type { DeclarationIo, DeclarationPage } from "../s3/declaration";
import { DECLARATION_PAGE_LIMIT, isSafeId, loadDeviceState, mergeRefs } from "../s3/declaration";
import { utf8Bytes } from "../s3/hash";
import type { CleanupGuard, SelfIdentity } from "../maintenance/shared-bucket";
import { backlogCount, backlogRefs, enqueueName, settleNames } from "../maintenance/declaration-names";
import { createSharedBucketGuard, declareRefs, diffReferences, renameReference } from "../maintenance/shared-bucket";
import type { PluginContext } from "./context";
import { cloudReferencedKeys } from "./shared-flows";

/** 一次上传要登记的引用（`ingest` 在 PUT 之前拿得到的三个事实）。 */
export interface DeclaredRefInput {
	readonly hash: string;
	readonly name: string;
	readonly ext: string;
}

/** 把 S3 客户端的四个动作包成声明层的 I/O。 */
export function declarationIoFor(
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">
): DeclarationIo {
	return {
		list: async (prefix: string, token: string | null): Promise<DeclarationPage> => {
			const page = await client.listObjects({
				prefix,
				maxKeys: DECLARATION_PAGE_LIMIT,
				...(token === null ? {} : { continuationToken: token }),
			});
			return {
				files: page.objects.map((object) => ({
					key: object.key,
					lastModified: object.lastModified,
				})),
				nextToken: page.nextToken,
			};
		},
		get: async (key: string): Promise<string | null> => {
			// ⚠️ 对象不存在 ⇒ `getObject` 抛 404（不是返回 null）—— 这里要把它折成 `null`，
			// 与"网络/权限失败"分开：前者说明有人在读的时候改了声明（这一轮别判），
			// 后者说明我们读不到（也别判），但两句话不一样。
			try {
				const result = await client.getObject(key);
				return new TextDecoder().decode(result.data);
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		put: async (key: string, text: string): Promise<void> => {
			await client.putObject(key, utf8Bytes(text), "application/json");
		},
		remove: async (key: string): Promise<void> => {
			await client.deleteObject(key);
		},
	};
}

/** 404 / NoSuchKey ⇒ "它不在了"（与"读失败"要分开，见上面那段）。 */
function isNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const status = (error as { status?: unknown }).status;
	return status === 404 || (error as { code?: unknown }).code === "NoSuchKey";
}

/**
 * 本设备的身份；拿不到（设置为空或非法）返回 `null`。
 *
 * ⚠️ 拿不到时**不猜**：空串拼出来的前缀会让所有设备写到同一处、声明互相覆盖 ——
 * 症状是"某台设备的引用悄悄消失"，而那正是会误删的那种错。
 */
export function identityOf(settings: { vaultId: string; deviceId: string }): SelfIdentity | null {
	const { vaultId, deviceId } = settings;
	if (!isSafeId(vaultId) || !isSafeId(deviceId)) return null;
	return { vault: vaultId, device: deviceId };
}

/**
 * 把一批引用登记进本设备的声明。**必须在 PUT 对象之前调用**。
 *
 * 返回 `false` 时调用方必须**中止上传**（对象传上去却没有保护，等于给下一次清理
 * 准备了一个可以被误删的对象）。失败会自己发一条通知，不再要求调用方重复解释。
 */
export async function rememberReferences(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">,
	refs: readonly DeclaredRefInput[]
): Promise<boolean> {
	if (!ctx.settings.sharedBucket || refs.length === 0) return true;
	const self = identityOf(ctx.settings);
	if (!self) {
		// 身份缺失是**配置坏了**（不是网络）：说清是"没生成身份"，别让用户去查网络
		new Notice(ctx.t("sharedBucketNoIdentity"));
		return false;
	}
	const adds: Record<string, { name: string; ext: string; addedAt: string }> = {};
	const now = new Date().toISOString();
	for (const ref of refs) adds[ref.hash] = { name: ref.name, ext: ref.ext, addedAt: now };
	const result = await declareRefs({ io: declarationIoFor(client), self }, adds);
	if (result.ok) return true;
	new Notice(
		ctx.t(result.reason === "read-failed" ? "sharedBucketStateUnreadable" : "sharedBucketDeclareFailed", {
			error: result.detail,
		})
	);
	return false;
}

/**
 * 改名之后：把云端声明里的显示名改过来；写不进去就**记进待补队列**（CR-16）。
 *
 * 为什么不一失败就重试 / 就报错：改名是**本地整理动作**，宿主已经把全库链接改完了。
 * 为一次云端写去阻塞它，等于让"改个文件名"依赖网络。所以这里只做两件事：
 * 能写就写，写不了就记下来（下次上传 / 清理 / 迁移前补）。
 *
 * @returns `written` 已写（或本来就不需要写）/ `queued` 进队列了 / `off` 功能关着
 */
export async function rememberRenamedName(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">,
	ref: { readonly hash: string; readonly name: string; readonly ext: string }
): Promise<"written" | "queued" | "off"> {
	if (!ctx.settings.sharedBucket) return "off";
	const self = identityOf(ctx.settings);
	if (!self) return "off";

	let outcome: Awaited<ReturnType<typeof renameReference>>;
	try {
		outcome = await renameReference({
			io: declarationIoFor(client),
			self,
			hash: ref.hash,
			name: ref.name,
			ext: ref.ext,
		});
	} catch {
		// 连读现状都失败（断网 / 权限）⇒ 按"待补"处理，别让它冒泡打断改名那条链
		outcome = "failed";
	}

	// ⚠️ `absent` 也算"不用补"：云端声明里没有这条 hash 说明"本地有、云端没记"，
	// 那不是改名能修的（下一次对账或上传会处理），塞进队列只会让它永远补不上。
	if (outcome === "renamed" || outcome === "absent") {
		const backlog = ctx.settings.declarationNameBacklog ?? {};
		if (backlog[ref.hash]) {
			ctx.settings.declarationNameBacklog = settleNames(backlog, [ref.hash]);
			await ctx.hostContext().persistSettings?.().catch(() => undefined);
		}
		return "written";
	}

	ctx.settings.declarationNameBacklog = enqueueName(
		ctx.settings.declarationNameBacklog ?? {},
		ref.hash,
		ref.name,
		ref.ext,
		new Date().toISOString()
	);
	await ctx.hostContext().persistSettings?.().catch(() => undefined);
	return "queued";
}

/**
 * 把待补的显示名补写进声明（上传 / 清理 / 迁移**启动前**各调一次，CR-16）。
 *
 * ## 三条取舍
 *
 * - **一条失败就停**：失败通常是网络或权限，继续补只会把队列打乱（而且每一条都要一次读写）；
 * - 结清的才出队：`renamed` / `absent` 都算结清，其余留着下次；
 * - **不抛错**：调用方那件事（上传 / 删除 / 迁移）比"显示名"重要得多。
 *
 * @returns 本次结清了几条（0 = 没有待补，或这次一条都没成功）
 */
export async function flushDeclarationNames(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">
): Promise<number> {
	if (!ctx.settings.sharedBucket) return 0;
	const self = identityOf(ctx.settings);
	if (!self) return 0;
	const backlog = ctx.settings.declarationNameBacklog ?? {};
	if (backlogCount(backlog) === 0) return 0;

	const settled: string[] = [];
	for (const ref of backlogRefs(backlog)) {
		let outcome: Awaited<ReturnType<typeof renameReference>>;
		try {
			outcome = await renameReference({ io: declarationIoFor(client), self, hash: ref.hash, name: ref.name, ext: ref.ext });
		} catch {
			outcome = "failed";
		}
		if (outcome === "renamed" || outcome === "absent") {
			settled.push(ref.hash);
			continue;
		}
		break;
	}

	if (settled.length === 0) return 0;
	ctx.settings.declarationNameBacklog = settleNames(backlog, settled);
	await ctx.hostContext().persistSettings?.().catch(() => undefined);
	return settled.length;
}

/**
 * 把本设备的声明与**本库此刻的引用快照**对一次账（设计 §9.5 流程 2）。
 *
 * 与 {@link forgetReferences} 的分工：
 * - `forgetReferences` 是**一件事结束时**的快速路径（刚删掉的那个对象）；
 * - 这个函数是**周期性收口**：补上"手工敲进笔记的 URL"、摘掉"应用关着时被改掉的引用"。
 *   只做增量的话，声明会慢慢退化成流水账（每个上传过的对象都被永久保护）。
 *
 * ## 三个失败方向都是"什么都不改"
 *
 * 读不到笔记（`cloudReferencedKeys` 抛错）⇒ 不同步：那一侧是**删/摘**的方向，
 * 把"不知道"当成"没有引用"会摘掉真实的保护。读不到现状、身份缺失同理。
 * 代价只是"这一轮白跑"，而声明晚一轮收口不会造成误删。
 *
 * @returns 有没有真的写过（`false` = 跳过或失败，调用方不必处理）
 */
export async function syncDeclaration(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">
): Promise<boolean> {
	if (!ctx.settings.sharedBucket) return false;
	const self = identityOf(ctx.settings);
	if (!self) return false;

	let referenced: Set<string>;
	try {
		referenced = await cloudReferencedKeys(ctx);
	} catch {
		// 有笔记读不到 ⇒ 这一轮不对账（宁可不摘，也不摘错）
		return false;
	}

	const io = declarationIoFor(client);
	const state = await loadDeviceState(io, self.vault, self.device);
	if (!state) return false;

	const { adds, removes } = diffReferences(referenced, mergeRefs(state), new Date().toISOString());
	// 一条都不用改 ⇒ 不发任何请求（这条会在每次引用变化时被调到，静默是常态）
	if (Object.keys(adds).length === 0 && removes.length === 0) return false;

	const result = await declareRefs({ io, self }, adds, removes);
	return result.ok;
}

/**
 * 从本设备的声明里**摘掉**一批引用（对象真的没了之后）。
 *
 * ## 为什么要摘
 *
 * 声明是"本库当前引用了什么"的**状态**。删掉云端对象之后不摘，那条引用会永远留在声明里
 * ⇒ 本设备的记录一直在替一个不存在的对象做保护，别的设备清理时会被它挡下，
 * 而用户看到的是"待清理里删掉了，过一会儿又回到候选里"（或者更糟：永远删不掉）。
 *
 * ⚠️ 只在**对象真的不在云端**之后调用（`deleted` / `alreadyGone`）：
 * 删除失败时对象还在，摘掉引用等于让它失去保护。
 * ⚠️ 失败只发一条通知，不抛 —— 用户要的那件事（删）已经完成了，
 * 声明晚一轮再摘不会造成误删（方向是**多保护**）。
 */
export async function forgetReferences(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">,
	hashes: readonly string[]
): Promise<boolean> {
	if (!ctx.settings.sharedBucket || hashes.length === 0) return true;
	const self = identityOf(ctx.settings);
	if (!self) return false;
	const result = await declareRefs({ io: declarationIoFor(client), self }, {}, hashes);
	if (result.ok) return true;
	new Notice(
		ctx.t(result.reason === "read-failed" ? "sharedBucketStateUnreadable" : "sharedBucketDeclareFailed", {
			error: result.detail,
		})
	);
	return false;
}

/**
 * 删除云端对象之前用的守卫；功能关着（或身份缺失）返回 `null`（= 不启用跨库判据）。
 *
 * ⚠️ 关着时**一次网络请求都不多发**：守卫的代价是"一次全量读 ＋ 每 20 个一次指纹"，
 * 没打开共享桶的用户不该为它付钱。
 */
export function sharedBucketGuardFor(
	ctx: PluginContext,
	client: Pick<S3Client, "listObjects" | "getObject" | "putObject" | "deleteObject">
): CleanupGuard | null {
	if (!ctx.settings.sharedBucket) return null;
	const self = identityOf(ctx.settings);
	if (!self) return null;
	return createSharedBucketGuard({ io: declarationIoFor(client), self });
}
