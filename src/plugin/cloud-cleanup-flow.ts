/**
 * **入口 B**：「清理云端未使用对象…」（R17 / F15 的显式那一路）。
 *
 * 候选公式（见 `maintenance/cloud-cleanup.ts`）：桶内对象 − 本库引用着的 key −
 * 站外缓存的 key。用户看到的是**清单 + 总体积 + 共享风险**，确认之后才真的删。
 *
 * ## 为什么它自成一个模块
 *
 * 这条流程从头到尾只做一件事（列桶 → 算候选 → 给人看 → 删 → 留痕），
 * 用到的宿主能力恰好就是 `PluginContext` 那一组，与孤儿询问、空间回收都不重叠。
 * 留它在 `main.ts` 里，它就只是那两千行里的一段（搬家前 `main.ts` 2257 行）。
 *
 * ⚠️ 它借用 `shared-flows.ts` 的 `cloudReferencedKeys` / `writeDeleteLog` ——
 * 那两个是**跨流程**的（"仍被引用"与"删除留痕"各有两条流程在用），
 * 所以按本项目的分层，**流程可以 import 共享层，共享层不许 import 流程**（见 `shared-flows.ts` 头）。
 */

import { Notice } from "obsidian";
import { describeError } from "../error-text";
import {
	externalKeysOf,
	listAllObjects,
	runCloudCleanup,
	selectCleanupCandidates,
} from "../maintenance/cloud-cleanup";
import type { CloudCleanupResult } from "../maintenance/cloud-cleanup";
import type { DeletedObjectRecord } from "../maintenance/delete-log";
import { displayNameForKey } from "../object-key";
import { buildTaskLabels } from "../ui/task-list";
import type { PluginContext } from "./context";
import { cloudReferencedKeys, writeDeleteLog } from "./shared-flows";

/**
 * **入口 B**：「清理云端未使用对象…」。
 *
 * 候选公式（见 `cloud-cleanup.ts`）：桶内对象 − 本库引用着的 key − 站外缓存的 key。
 * 用户看到的是**清单 + 总体积 + 共享风险**，勾选之后才真的删。
 *
 * ⚠️ 列举有页数上限；中途停下时**如实说**"清单可能不全"
 * （假装完整会让用户以为"剩下那些都还有人用"）。
 */
export async function cleanupCloudObjects(ctx: PluginContext): Promise<void> {
	const client = ctx.buildClient();
	if (!client) {
		new Notice(ctx.t("maintainNotConfigured"));
		return;
	}

	let listed;
	try {
		listed = await listAllObjects(client);
	} catch (error) {
		new Notice(ctx.t("cloudCleanupListFailed", { error: describeError(error) }));
		return;
	}

	// ⚠️ 扫引用失败（有笔记读不到）⇒ **什么都不删**，并把原因说清楚。
	//
	// **不能**"跳过那篇笔记继续"：漏掉的那篇可能正是引用着这些对象的笔记，
	// 于是候选会凭空变大 —— 这是这条流程唯一能**因为读不到而多删**的方向。
	//
	// ⚠️⚠️ 这条兜底必须与 `plugin/release-space-flow.ts` 那份**成对存在**：
	// 两条路径共用 `cloudReferencedKeys`，而它抛错的唯一原因就是"有笔记读不到"。
	// 只在一半路径上做兜底 = 没有兜底 —— 另一半会静默变成一句
	// unhandled rejection（用户什么都看不到，而 i18n 里那句文案写着"因此取消了这次清理"）。
	let referenced: Set<string>;
	try {
		referenced = await cloudReferencedKeys(ctx);
	} catch (error) {
		new Notice(describeError(error));
		return;
	}
	const selection = selectCleanupCandidates({
		objects: listed.objects,
		referencedKeys: referenced,
		externalKeys: externalKeysOf(ctx.currentIndex()),
	});

	if (selection.candidates.length === 0) {
		new Notice(
			listed.truncated ? ctx.t("cloudCleanupTruncatedNothing") : ctx.t("cloudCleanupNothing")
		);
		return;
	}

	const index = ctx.currentIndex();
	const inputs = selection.candidates.map((object) => {
		const entry = index.get(object.key);
		return {
			id: object.key,
			name: entry?.sourceName || displayNameForKey(object.key),
			localPath: entry?.cachePath,
			remoteKey: object.key,
			// 副标题给对象 key：光看名字认不出是**哪一份**（同名对象是常态）
			meta: object.key,
		};
	});
	// ⚠️ **不截断**：这一份清单现在是可以逐项勾选的，截断会让"全选"漏掉没列出来的那些
	//（以前截断是因为它只是一段给人看的文字，塞两百行等于什么都没说）。
	const cards = ctx.fileCards(inputs, inputs.length);

	const lines = [
		ctx.t("cloudCleanupSummary", {
			count: selection.candidates.length,
			mb: Math.max(1, Math.round(selection.bytes / (1024 * 1024))),
		}),
		// ⚠️ 显著位置：这两句是"多设备盲区"与"不可恢复"的如实告知
		ctx.t("cloudCleanupDeviceBlindSpot"),
		ctx.t("cloudCleanupCannotUndo"),
		...(listed.truncated ? [ctx.t("cloudCleanupTruncatedWarning")] : []),
	];

	const records: DeletedObjectRecord[] = [];
	/** 执行结果（在 `run` 回调里填；用盒子装的理由见 `upload-existing-flow.ts` 同处注释）。 */
	const state: { summary: CloudCleanupResult | null } = { summary: null };

	const answer = await ctx.pickTasks({
		title: ctx.t("cloudCleanupTitle"),
		lines,
		cards,
		labels: buildTaskLabels(ctx.t, "cloudCleanupCta"),
		// ⚠️ 删云端对象**不可撤销** ⇒ 主按钮必须标成破坏性（真机验证链条盯着这一点）
		destructive: true,
		// ⭐ 勾中的那些才删（勾选在这里生效；候选公式仍只有 `selectCleanupCandidates` 一处）
		run: async (selected, report) => {
			state.summary = await runCloudCleanup(
				{
					client,
					index: () => ctx.currentIndex(),
					persistIndex: () => ctx.hostContext().persistIndex(),
					notify: (message) => new Notice(message),
					// ⚠️ 这里**直接**用 `ctx.t`：它是 `flowContext()` 里造的普通箭头函数属性，
					// 不像实例方法那样会被"摘下来"（那边要包一层，lint 的 unbound-method 在拦）。
					t: ctx.t,
					onRemoved: (record) => records.push({ ...record, scope: "command" }),
					// 进度：成功 / 404 / 失败都算"这一件走完了"（与留痕那份回调分开，见 `CloudCleanupDeps`）
					onItem: (event) => report(event.key, event.status),
				},
				selected
			);
		},
	});
	if (!answer) {
		new Notice(ctx.t("maintainCancelled"));
		return;
	}
	if (!state.summary) return;
	const outcome: CloudCleanupResult = state.summary;
	await writeDeleteLog(ctx, records);

	new Notice(
		ctx.t("cloudCleanupDone", {
			deleted: outcome.deleted,
			alreadyGone: outcome.alreadyGone,
			failed: outcome.failed,
			unindexed: outcome.unindexed,
		})
	);
}
