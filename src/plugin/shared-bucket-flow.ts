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
import { DECLARATION_PAGE_LIMIT, isSafeId } from "../s3/declaration";
import { utf8Bytes } from "../s3/hash";
import type { CleanupGuard, SelfIdentity } from "../maintenance/shared-bucket";
import { createSharedBucketGuard, declareRefs } from "../maintenance/shared-bucket";
import type { PluginContext } from "./context";

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
