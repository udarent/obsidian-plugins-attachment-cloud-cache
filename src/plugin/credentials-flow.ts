/**
 * 凭据：从一份文件导入连接参数，以及按当前设置造客户端。
 *
 * ## 为什么单独一个模块
 *
 * 这两件事原本是 `main.ts` 的私有方法。它们的共同点是**只与 S3 配置和钥匙串打交道**，
 * 与"编排"无关 —— 而导入这件事还要满足一条额外的约束：**真机探针要能直接调它**，
 * 不去点界面（点界面测的是"按钮接对了没有"，调它测的是"导入到底做了什么"）。
 * `main.ts` 上保留一个同名同签名的薄转发，就是为了那条探针路径与设置页的调用路径不变。
 *
 * ## 依赖方向（硬约束）
 *
 * `main.ts → plugin/* → 领域模块`。本模块**只许** import 领域模块
 * （`s3/*`、`ui/settings-logic`、`../types`），**不许** import `main.ts` 或任何其它 `plugin/*`。
 *
 * ## ⚠️ 顺序：先写钥匙串，再写设置
 *
 * 反过来的话，钥匙串写入失败就会留下「**ID 换了、秘密还是旧的**」这种组合 ——
 * 它能签出一个格式完全正确、但服务端必然拒绝的请求，而用户看到的是"凭据被拒"，
 * 会去怀疑自己抄错了密钥。所以任何一步失败都**整批不做**。
 *
 * ## 秘密的去向只有一处
 *
 * `parseCredentialFile` 把外来的 json 拆成「要写设置的字段」与「秘密」两半，
 * 这里也照着这个边界落：`patch` 里的字段进 `settings`，秘密只进钥匙串。
 * 秘密**永远不进** `data.json`（那个文件会随 vault 同步、备份、分享出去）。
 */

import type { CredentialFileProblem, SecretReader } from "../s3/credentials";
import { connectionReadiness, parseCredentialFile } from "../s3/credentials";
import type { S3Client } from "../s3/client";
import { createS3Client } from "../s3/client";
import { ensureSecretSlot, randomSlotPart } from "../ui/settings-logic";
import type { PluginSettings } from "../types";

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

/**
 * 写钥匙串需要的那一面。
 *
 * `SecretReader` 只声明了读（`connectionReadiness` 那边够用），导入这条路要写，
 * 所以在这里补一个更窄的接口 —— 于是本模块的依赖仍然是"两个方法"，不是整个 App。
 * `app.secretStorage` 天然满足 `SecretReader & SecretWriter`。
 */
export interface SecretWriter {
	setSecret(id: string, value: string): void;
}

/** 导入需要的三样东西（都从插件实例上取，便于真机探针直接调）。 */
export interface ImportCredentialsDeps {
	secretStorage: SecretReader & SecretWriter;
	/** ⚠️ **会被原地修改** —— 导入的本质就是改它。 */
	settings: PluginSettings;
	/** 落盘（导入成功后调一次）。 */
	saveSettings(): Promise<void>;
}

/**
 * 从一份**凭据文件**导入连接参数（MinIO 控制台「下载凭据」给的那个 json）。
 *
 * @returns 结果里**不含秘密值**，只含"改了哪几项"，供界面如实报告。
 */
export async function importCredentialsFile(
	deps: ImportCredentialsDeps,
	text: string
): Promise<ImportCredentialsOutcome> {
	const parsed = parseCredentialFile(text);
	if (!parsed.ok) return { ok: false, problem: parsed.problem };

	const s3 = deps.settings.s3;
	const patch = parsed.patch;

	// ① 秘密先进钥匙串（失败则什么都不改 —— 见模块头那段）
	let secretStored = false;
	if (parsed.secret !== null) {
		const slot = ensureSecretSlot(s3.secretAccessKeyRef, randomSlotPart());
		try {
			deps.secretStorage.setSecret(slot, parsed.secret);
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

	await deps.saveSettings();

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
export function buildClient(secretStorage: SecretReader, settings: PluginSettings): S3Client | null {
	const readiness = connectionReadiness(secretStorage, settings);
	return readiness.ready ? createS3Client(readiness.config) : null;
}
