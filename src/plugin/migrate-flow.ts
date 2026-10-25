/**
 * 「统一对象名」的编排（CR-15）—— 五个阶段、两阶段提交。
 *
 * 判据全在 `maintenance/migrate-keys.ts`（纯函数、套件逐条钉住）；这一层只负责
 * **按顺序做、按片让出、把结果说清楚**。分工的理由很直接：这一层碰网络与用户笔记，
 * 无法穷举；而"哪些要复制、改哪几处、什么时候算全绿"必须能穷举。
 *
 * ## 两阶段提交（整个功能的正确性就靠这一条）
 *
 * ```
 * A copy ──▶ B relink ──▶ C verify ─┬─ 全绿 ─▶ D delete ──▶ E ledger
 *                                   └─ 有残留 / 读不到 ─▶ 停（一个旧对象都不删）
 * ```
 *
 * A–C 全部完成之前**一个旧对象都不删**，所以任何时刻中断都只可能"多留垃圾"，
 * 不可能出现"链接指向不存在的对象"。这也是这里没有回滚代码的原因 —— 不需要。
 *
 * ## 三条"少做一步就出事"的顺序
 *
 * 1. **先复制、再改链接**：反了会有一段"笔记指着还没到位的对象"的窗口。
 * 2. **全绿才删旧 key**：`canDeleteOldKeys` 是唯一闸门（读不到 > 残留 > 新对象缺失）。
 * 3. **删完才搬账**：台账与索引都按 key 存。先搬账再删旧，中途失败只会让索引指向
 *    一个还在的对象（无害）；反过来会让索引指向已删的对象（渲染永远失败、每次重下）。
 *
 * ## 状态位（`migrationState`）
 *
 * 开始**先写** `running`（写失败就不启动 —— 宁可不迁），收尾写 `idle`，中途抛错写
 * `interrupted`。崩溃时来不及写 ⇒ 留在 `running`，重启后改名仍被拒，直到用户明确
 * 选「继续」或「放弃」。判据读这个字段，不是界面。
 */

import { Notice } from "obsidian";

import { debugTimed } from "../debug-log";
import { describeError } from "../error-text";
import type { DeletedObjectRecord } from "../maintenance/delete-log";
import {
	canDeleteOldKeys,
	leftoverOldKeys,
	migrationRules,
	pendingTotal,
	planMigration,
	type MigrationCounts,
} from "../maintenance/migrate-keys";
import { planCanvasRewrites, planLinkRewrites } from "../maintenance/references";
import { S3Error, type S3Client } from "../s3/client";
import type { MigrationState } from "../types";
import type { PluginContext } from "./context";
import { remoteUrlForKey } from "./notes-query";
import { cloudReferencedKeys, writeDeleteLog } from "./shared-flows";

/** 列桶时一页多少条（S3 上限）。 */
const LIST_PAGE = 1000;

/**
 * 最多翻几页；超过就算"不知道桶里有什么"（`cloudKeys = null`，全部按 `copy`）。
 *
 * 为什么不继续翻：`copy` 是幂等的（已存在则服务端覆盖同一份字节），而"翻不完就猜"
 * 会让分档看起来精确、实际随机。10000 个对象已远超这个插件的设计规模（它管笔记附件）。
 */
const LIST_MAX_PAGES = 10;

/**
 * B 阶段每片多少篇。
 *
 * 每篇都要 `read` + `modify`，而 `modify` 是**整文件覆盖**。一次改几百篇会让界面
 * 长时间无响应，用户以为卡死就强杀 —— 那正好落在"改了一半"的时刻（不丢数据，但他不敢再点）。
 */
const SLICE = 20;

/** 进度事件（只用于报数，不参与判定）。 */
export interface MigrateProgress {
	readonly phase: "copy" | "relink" | "verify" | "delete" | "ledger";
	readonly done: number;
	readonly total: number;
}

export interface MigrateNamesDeps {
	readonly client: Pick<S3Client, "listObjects" | "headObject" | "copyObject" | "deleteObject">;
	/** 状态位落盘（"谁负责落盘"只有一处，所以由装配点给）。 */
	readonly setState: (state: MigrationState) => Promise<void>;
	readonly onProgress?: (event: MigrateProgress) => void;
}

export interface MigrateNamesResult {
	readonly counts: MigrationCounts;
	readonly copied: number;
	readonly notesChanged: number;
	readonly linksRewritten: number;
	readonly deleted: number;
	/** 非空 ⇒ 一个旧对象都没删。 */
	readonly blocked: "" | "unreadable" | "leftover" | "new-missing";
	readonly leftoverCount: number;
	readonly missingNewKeys: number;
	readonly unreadable: number;
	readonly failed: number;
	readonly cancelled: boolean;
	readonly unknown: number;
}

const ZERO_COUNTS: MigrationCounts = { copy: 0, relink: 0, drop: 0, unknown: 0 };

/**
 * 列桶里现有的 key；翻不完返回 `null`（=「不知道」，与"空桶"必须分得开）。
 *
 * 两者都会退化成 `copy`，区别在**报数**：`null` 时预检不能声称"新 key 都不在"。
 */
async function listAllKeys(client: Pick<S3Client, "listObjects">): Promise<Set<string> | null> {
	const keys = new Set<string>();
	let token: string | null = null;
	for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
		const result = await client.listObjects({ maxKeys: LIST_PAGE, continuationToken: token ?? undefined });
		for (const object of result.objects) keys.add(object.key);
		token = result.nextToken;
		if (!token) return keys;
	}
	return null;
}

/** 库里的正文文件（`.md` 与 `.canvas` 都要改；画布不在 `getMarkdownFiles` 里）。 */
function textPaths(ctx: PluginContext): { path: string; extension: string }[] {
	const markdown = ctx.app.vault.getMarkdownFiles().map((file) => ({ path: file.path, extension: "md" }));
	const canvas = ctx.app.vault
		.getFiles()
		.filter((file) => file.extension === "canvas")
		.map((file) => ({ path: file.path, extension: "canvas" }));
	return [...markdown, ...canvas];
}

/**
 * 取一篇正文对象；不是可读文件就 `null`。
 *
 * 用"有没有 `path` 字符串"做鸭子判定，而不是 `instanceof TFile`：宿主在
 * `getAbstractFileByPath` 里给的就是 `TFile`，但这个模块的替身（套件）只需要一个
 * `{ path }` —— 让产品代码依赖一个只有测试才会造的具体类，等于逼着替身去冒充宿主。
 */
function textFileAt(ctx: PluginContext, path: string): { path: string } | null {
	const file = ctx.app.vault.getAbstractFileByPath(path) as { path?: unknown } | null;
	if (!file || typeof file.path !== "string") return null;
	return file as { path: string };
}

/** 读一篇正文；读不到返回 `null`（**绝不**用空串顶替 —— `modify` 是整文件覆盖）。 */
async function readTextOf(ctx: PluginContext, path: string): Promise<string | null> {
	const file = textFileAt(ctx, path);
	if (!file) return null;
	try {
		return await ctx.app.vault.read(file as never);
	} catch {
		return null;
	}
}

/** 改写一篇正文（画布走 canvas 那一套，只改 `text` 节点里的链接）。 */
function rewriteText(text: string, extension: string, rules: { from: string; to: string; display: string }[]) {
	if (extension === "canvas") {
		// ⚠️ `fileRules` 为空：画布 `file` 节点指向**库内文件**，而迁移只换云端 key，
		// 本地文件一个都没动（设计 §9.6 的边界）。
		return planCanvasRewrites(text, { linkRules: rules, fileRules: [] });
	}
	return planLinkRewrites(text, rules);
}

/**
 * 预检里"会改到几篇"：只读一遍、只数不改。
 *
 * ⚠️ 读不到的不计入（与 B 阶段一致：跳过），否则确认框报的篇数比实际大，
 * 用户会以为有东西漏改了。
 */
async function countAffected(ctx: PluginContext, rules: { from: string; to: string; display: string }[]): Promise<number> {
	let affected = 0;
	for (const file of textPaths(ctx)) {
		const text = await readTextOf(ctx, file.path);
		if (text === null || text === "") continue;
		if (rewriteText(text, file.extension, rules).count > 0) affected += 1;
	}
	return affected;
}

/**
 * 一键把桶里存量的旧 key（`<名字>-<哈希>.<ext>`）搬成纯内容寻址（`<哈希>.<ext>`）。
 *
 * 用户**显式**触发（设置页按钮）；幂等可重跑 —— 已经搬过的对象在新一轮预检里是 0。
 */
export async function unifyObjectNames(ctx: PluginContext, deps: MigrateNamesDeps): Promise<MigrateNamesResult> {
	const debug = ctx.settings.debugLogging;
	const startedAt = Date.now();
	const urlFor = (key: string): string | null => remoteUrlForKey(ctx.settings, key);

	const idle = (counts: MigrationCounts, patch: Partial<MigrateNamesResult> = {}): MigrateNamesResult => ({
		counts,
		copied: 0,
		notesChanged: 0,
		linksRewritten: 0,
		deleted: 0,
		blocked: "",
		leftoverCount: 0,
		missingNewKeys: 0,
		unreadable: 0,
		failed: 0,
		cancelled: false,
		unknown: counts.unknown,
		...patch,
	});

	// ── 预检：台账 × 引用 × 桶 ──
	let referenced: Set<string>;
	try {
		referenced = await cloudReferencedKeys(ctx);
	} catch (error) {
		// ⚠️ 有笔记读不到 ⇒ **不开始**：这份集合决定"哪些可以直接删"，
		// 把"不知道"当成"没有引用"会删掉还在被引用的对象。
		new Notice(ctx.t("unifyNamesUnreadable", { error: describeError(error) }));
		return idle(ZERO_COUNTS);
	}
	const plan = planMigration({
		ledgerKeys: ctx.currentIndex().uploadedKeys(),
		cloudKeys: await listAllKeys(deps.client),
		referencedKeys: referenced,
	});
	const counts = plan.counts;

	debugTimed(debug, "统一对象名预检", startedAt, {
		待复制: counts.copy,
		只改链接: counts.relink,
		无引用可删: counts.drop,
		无法识别: counts.unknown,
	});

	if (pendingTotal(counts) === 0) {
		new Notice(ctx.t("unifyNamesNothing"));
		return idle(counts);
	}

	const rules = migrationRules(plan, urlFor);
	const affected = await countAffected(ctx, rules);
	const go = await ctx.confirmMaintenance({
		title: ctx.t("unifyNamesConfirmTitle"),
		lines: [
			ctx.t("unifyNamesConfirmCopy", { count: counts.copy }),
			ctx.t("unifyNamesConfirmRelink", { count: counts.relink }),
			ctx.t("unifyNamesConfirmDrop", { count: counts.drop }),
			...(counts.unknown > 0 ? [ctx.t("unifyNamesConfirmUnknown", { count: counts.unknown })] : []),
			ctx.t("unifyNamesConfirmNotes", { count: affected }),
		],
		cta: ctx.t("unifyNamesConfirmCta"),
		destructive: true,
	});
	if (!go) return idle(counts, { cancelled: true });

	// ── 状态位：先写 running 再动手（写不进去就不启动）──
	try {
		await deps.setState("running");
	} catch (error) {
		new Notice(ctx.t("unifyNamesStateUnwritable", { error: describeError(error) }));
		return idle(counts);
	}

	let copied = 0;
	let deleted = 0;
	let failed = 0;
	let notesChanged = 0;
	let linksRewritten = 0;
	let leftoverCount = 0;
	let missingNewKeys = 0;
	let unreadable = 0;
	let blocked: MigrateNamesResult["blocked"] = "";

	try {
		// ── A. 复制（已存在则跳过；复制后 HEAD 核长度）──
		const toCopy = plan.candidates.filter((candidate) => candidate.bucket === "copy");
		/** 本批复制出来的对象长度（C 阶段用来核"字节真的到了"）。 */
		const copiedSizes = new Map<string, number>();
		let copyDone = 0;
		for (const candidate of toCopy) {
			copyDone += 1;
			deps.onProgress?.({ phase: "copy", done: copyDone, total: toCopy.length });
			try {
				const source = await deps.client.headObject(candidate.oldKey);
				if (!source) {
					// 台账里有、桶里没有（别的设备删过）⇒ 没有可复制的源。
					// 如实计数：C 阶段会因为"新 key 缺失"把整批拦下，而不是悄悄跳过。
					failed += 1;
					continue;
				}
				await deps.client.copyObject(candidate.oldKey, candidate.newKey);
				// ⚠️ COPY 不返回字节数 ⇒ 必须自己 HEAD 核一次（设计 A 阶段的完成判据）
				const target = await deps.client.headObject(candidate.newKey);
				if (!target || target.size !== source.size) {
					failed += 1;
					continue;
				}
				copied += 1;
				copiedSizes.set(candidate.newKey, source.size);
			} catch (error) {
				failed += 1;
				if (error instanceof S3Error && error.kind === "auth") {
					// COPY 被拒是**权限**问题（密钥缺 `CopyObject`）⇒ 继续跑没有意义
					throw new Error(ctx.t("unifyNamesNeedCopyPermission"));
				}
			}
		}

		// ── B. 改写链接（每片 SLICE 篇）──
		const files = textPaths(ctx);
		let index = 0;
		for (const file of files) {
			index += 1;
			if (index % SLICE === 0) deps.onProgress?.({ phase: "relink", done: index, total: files.length });
			const text = await readTextOf(ctx, file.path);
			if (text === null || text === "") continue;
			const rewritten = rewriteText(text, file.extension, rules);
			if (rewritten.count === 0) continue;
			const target = textFileAt(ctx, file.path);
			if (!target) continue;
			try {
				await ctx.app.vault.modify(target as never, rewritten.text);
				notesChanged += 1;
				linksRewritten += rewritten.count;
			} catch {
				failed += 1;
			}
		}

		// ── C. 复核：读不到的算"不知道"（一样拦），残留与新对象缺失各有计数 ──
		deps.onProgress?.({ phase: "verify", done: 0, total: 1 });
		const texts: string[] = [];
		for (const file of textPaths(ctx)) {
			const text = await readTextOf(ctx, file.path);
			// ⚠️ 读不到**不能**当成"这篇里没有旧 key" —— 那是最危险的默认值。
			if (text === null) unreadable += 1;
			else texts.push(text);
		}
		const needsNew = plan.candidates.filter((candidate) => candidate.newKey !== "" && candidate.bucket !== "drop");
		const leftovers = leftoverOldKeys({
			texts,
			oldKeys: needsNew.map((candidate) => candidate.oldKey),
			urlFor,
		});
		const newKeys: { key: string; ok: boolean }[] = [];
		for (const candidate of needsNew) {
			const head = await deps.client.headObject(candidate.newKey);
			const want = copiedSizes.get(candidate.newKey);
			// ⚠️ 两种"长度未知"必须分开：
			// · `relink`（上次跑过 / 另一台设备搬的）⇒ 长度本来就不在我们手里，对象在就算到位；
			// · `copy`（这一轮本该复制）⇒ 长度**必须**有，没有就说明它失败了 ——
			//   把它也当成"对象在就行"，会让一次失败的复制直接放行到删旧那一步。
			const sizeOk = want === undefined ? candidate.bucket !== "copy" : head?.size === want;
			newKeys.push({ key: candidate.newKey, ok: Boolean(head) && sizeOk });
		}
		const gate = canDeleteOldKeys({ leftovers, newKeys, unreadable });
		leftoverCount = leftovers.length;
		missingNewKeys = newKeys.filter((item) => !item.ok).length;
		blocked = gate.ok ? "" : gate.reason;

		if (gate.ok) {
			// ── D. 删旧 key（写留痕，`scope: "migration"`）──
			const removable = plan.candidates.filter((candidate) => candidate.newKey !== "");
			const records: DeletedObjectRecord[] = [];
			let done = 0;
			for (const candidate of removable) {
				done += 1;
				deps.onProgress?.({ phase: "delete", done, total: removable.length });
				try {
					const ok = await deps.client.deleteObject(candidate.oldKey);
					deleted += 1;
					records.push({
						key: candidate.oldKey,
						name: candidate.name,
						outcome: ok ? "deleted" : "alreadyGone",
						scope: "migration",
					});
				} catch {
					failed += 1;
				}
			}
			await writeDeleteLog(ctx, records);

			// ── E. 搬账（台账 + 索引条目的 key 与 remoteUrl）──
			//
			// ⚠️ **只搬 copy / relink**：`drop` 那批从来没复制过（没人引用它们），
			// 把它们的条目改指到一个**不存在的 key** 上，渲染时就会永远下载失败。
			// 它们的条目在下面就摘掉（对象已经不在云端了）。
			const store = ctx.currentIndex();
			const rekeyable = removable.filter((candidate) => candidate.bucket !== "drop");
			let moved = 0;
			for (const candidate of rekeyable) {
				moved += 1;
				if (moved % SLICE === 0) deps.onProgress?.({ phase: "ledger", done: moved, total: rekeyable.length });
				store.rekey(candidate.oldKey, candidate.newKey, urlFor(candidate.newKey) ?? "");
			}
			// 没人引用、直接删掉的那批：索引里若还有条目，摘掉（对象已不在云端）
			for (const candidate of plan.candidates.filter((item) => item.bucket === "drop")) {
				store.remove(candidate.oldKey);
				store.forgetUploaded(candidate.oldKey);
			}
			if (removable.length > 0 || counts.drop > 0) await ctx.hostContext().persistIndex();
		}
	} catch (error) {
		// 中断：状态位落到 `interrupted`（**不**写 idle —— 改名应当继续被拦）
		await deps.setState("interrupted").catch(() => undefined);
		new Notice(ctx.t("unifyNamesInterrupted", { error: describeError(error) }));
		return idle(counts, {
			copied,
			deleted,
			failed,
			notesChanged,
			linksRewritten,
			leftoverCount,
			missingNewKeys,
			unreadable,
			blocked,
		});
	}

	await deps.setState("idle").catch(() => undefined);

	debugTimed(debug, "统一对象名结果", startedAt, {
		复制: copied,
		改写篇数: notesChanged,
		改写链接: linksRewritten,
		删旧: deleted,
		跳过无法识别: counts.unknown,
		被挡下: blocked || "—",
		失败: failed,
	});

	const result = idle(counts, {
		copied,
		deleted,
		failed,
		notesChanged,
		linksRewritten,
		leftoverCount,
		missingNewKeys,
		unreadable,
		blocked,
	});

	if (blocked !== "") {
		const key =
			blocked === "unreadable"
				? "unifyNamesBlockedUnreadable"
				: blocked === "leftover"
					? "unifyNamesBlockedLeftover"
					: "unifyNamesBlockedNew";
		const count = blocked === "unreadable" ? unreadable : blocked === "leftover" ? leftoverCount : missingNewKeys;
		new Notice(ctx.t(key, { count }));
		return result;
	}

	new Notice(
		ctx.t("unifyNamesDone", { copied, deleted, notes: notesChanged, unknown: counts.unknown })
	);
	return result;
}
