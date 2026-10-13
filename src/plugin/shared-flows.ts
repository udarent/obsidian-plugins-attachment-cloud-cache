/**
 * **跨流程共享**的几件小流程。
 *
 * 判断一个方法该进这里还是进某条流程的文件，看的是**谁在用它**：
 * - `writeDeleteLog`：孤儿询问（R17）与云端清理**两条**流程都要留痕；
 * - `cloudReferencedKeys`：云端清理与"上传已有附件"**两条**都要问"哪些对象仍被引用"；
 * - `extractStoredKeys`：孤儿监视的取数口，被判定的两个入口共用。
 *
 * 放错地方的后果是具体的：塞进某一条流程里，另一条就得回头 import 它 ——
 * 于是两条流程之间长出一条本不该有的依赖。
 *
 * ## `plugin/` 内的分层（A1 第四批定下）
 *
 * ```
 *  main.ts                    编排：装配 + 事件接线 + 定时器
 *    └─ plugin/<流程>.ts       一条流程（cloud-cleanup / credentials / …）
 *         └─ shared-flows.ts  ← 本文件：被 ≥2 条流程共用的动作
 *              └─ context.ts  流程能看到的宿主能力（最底层，不 import 上面任何东西）
 * ```
 *
 * ⚠️ 规矩的准确说法是**"不许依赖回去"**，不是"互不 import"：流程**可以**用共享层
 * （它存在的意义就是这个），但**共享层不许** import 任何一条流程，**流程之间也不许**互相 import。
 * 这样 `plugin/` 永远是一张有向无环图 —— 加第五条流程时不会长出环，也不会出现
 * "改 A 流程顺手要动 B 流程"。
 */

import type { DeletedObjectRecord } from "../maintenance/delete-log";
import { deleteLogTargetPath, recordDeletions } from "../maintenance/delete-log";
import { referencedKeysFromUrls } from "../maintenance/cloud-cleanup";
import type { NoteKind } from "../maintenance/orphan-watch";
import { canvasTextTargets, keysInText } from "../maintenance/references";
import { keyFromUrl } from "../render/render-target";
import type { PluginContext } from "./context";

/**
 * 删除留痕：把这一批**云端删除**追加写到插件目录下的日志里。
 *
 * ## 为什么要留痕
 *
 * 删云端对象是**不可恢复**的，而这条询问自 2026-10-11 起是**自动出现**的。
 * 「自动触发」+「不可恢复」+「不留痕迹」三件事叠在一起，是本产品风险最集中的一处 ——
 * 至少要让"删了什么、什么时候删的、走哪条入口"事后查得到。
 *
 * ## 两条刻意的选择
 *
 * ① **写在插件目录，不写本地副本所在处**：本地副本（附件目录里那份）是承诺过
 *   "可以整体删除"的 —— 留痕写在那里，用户清理一次副本就把证据一起抹掉了，等于白留。
 * ② **写失败绝不抛错**：见 `maintenance/delete-log.ts`。为一个附属功能炸断一条
 *   不可恢复的主流程，代价完全不成比例。
 *
 * ⚠️ 它**不是回收站**：日志里的对象恢复不了。真正的宽限期是另一件事（尚未做）。
 */
export async function writeDeleteLog(
	ctx: PluginContext,
	records: readonly DeletedObjectRecord[]
): Promise<void> {
	if (records.length === 0) return;
	// ⚠️ 插件目录未知 ⇒ **不写**（见 `deleteLogTargetPath`：兜底名会落到 vault 根）。
	// 这只在开发/探针环境发生，删除本身照常已经完成，所以只留一行开发者可见的说明。
	const path = deleteLogTargetPath(ctx.manifest.dir);
	if (!path) {
		console.warn("[attachment-cloud-cache] 插件目录未知，跳过写删除日志", records.length);
		return;
	}
	const adapter = ctx.app.vault.adapter;
	await recordDeletions(
		{
			append: async (text) => {
				// ⚠️ 不依赖 `append` 的"文件不存在就创建"这条约定：先看一眼，
				// 没有就 `write`。多一次 `exists` 换掉一个宿主行为假设，划算 ——
				// 假设不成立时这条链会**静默**什么都不写。
				if (await adapter.exists(path)) await adapter.append(path, text);
				else await adapter.write(path, text);
			},
			onError: (error) => {
				// 只说给开发者看（控制台）：用户此刻刚看到"已删除 N 个"，
				// 再弹一条"日志写不进去"只会让人以为删除失败了。
				console.error("[attachment-cloud-cache] 写删除日志失败", error);
			},
		},
		records
	);
}

/**
 * 从一篇正文里取出"属于本存储的对象 key"（孤儿监视的取数口）。
 *
 * 复用 `keysInText`（与入口 B 的引用扫描、与渲染判定共用同一个 `keyFromUrl`）
 * ⇒ "哪些对象算被引用"与"渲染时认不认这条 URL"永远是同一套规则。
 *
 * 画布的引用藏在 JSON 字符串里：先按画布规则把文本目标取出来，再走同一套 URL 识别
 *（`canvasTextTargets` 已处理"转义解不开就跳过那一条"的纪律）。
 */
export function extractStoredKeys(ctx: PluginContext, kind: NoteKind, text: string): Set<string> {
	const keyOf = (url: string): string | null => keyFromUrl(url, ctx.settings.s3);
	if (kind !== "canvas") return keysInText(text, keyOf);

	const keys = new Set<string>();
	for (const raw of canvasTextTargets(text)) {
		for (const key of keysInText(raw, keyOf)) keys.add(key);
	}
	return keys;
}

/**
 * 笔记与画布里**属于本存储**的对象 key 集合（云端清理的"仍被引用"判据）。
 *
 * 两处来源都扫：Markdown 笔记的正文，加上**画布的原始文本**（画布里的链接
 * 也是文本内容，宿主的索引不保证覆盖 —— 与 `referencedVaultPaths` 同一条理由）。
 * 换算用的是同一个 `keyFromUrl`，也就是**渲染判定用的那个**回算函数：
 * 于是"哪些对象算被引用"与"渲染时认不认这个 URL"永远一致。
 */
export async function cloudReferencedKeys(ctx: PluginContext): Promise<Set<string>> {
	const urls: string[] = [];
	const collect = (text: string): void => {
		for (const key of keysInText(text, (url) => keyFromUrl(url, ctx.settings.s3))) {
			urls.push(key);
		}
	};

	for (const note of ctx.app.vault.getMarkdownFiles()) {
		try {
			collect(await ctx.app.vault.read(note));
		} catch {
			// 读不到就当它没有引用 —— 但这一侧是**危险**的方向，
			// 所以这里**整体放弃**这次清理（抛出去，让调用方看到"有一篇读不了"）。
			throw new Error(ctx.t("cloudCleanupUnreadableNote", { path: note.path }));
		}
	}
	for (const file of ctx.app.vault.getFiles()) {
		if (file.extension !== "canvas") continue;
		try {
			collect(await ctx.app.vault.read(file));
		} catch {
			throw new Error(ctx.t("cloudCleanupUnreadableNote", { path: file.path }));
		}
	}

	// ⚠️ 这里收到的其实是 key（`keysInText` 已经把 URL 换算过了），
	// 所以只是去重成一个集合 —— 再换算一次是多余的，也会引入第二套规则。
	return referencedKeysFromUrls(urls, (value) => value);
}
