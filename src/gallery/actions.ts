/**
 * 附件管理（R24 / F22）的**动作可用性判定** —— 纯函数。
 *
 * ## ⭐ 核心口径：动作 = 把选中项从一个状态改到另一个状态
 *
 * 所以判据不是“有哪些动作”，而是“**这个动作对当前这一行成立吗**”。
 * 不成立时不许“点了没反应”，也不许悄悄跳过 —— 返回**具体原因**，由界面灰掉并说清。
 *
 * ## 为什么这一层必须是纯函数
 *
 * ① 同一份判据要同时供“按钮灰不灰”“按钮上的数字”“批量执行前的过滤”三处使用，
 *    写三遍必然分叉；② 它要能穷举（状态 × 动作 × 是否候选），而 UI 层没法穷举。
 *
 * ## ⚠️ 三条容易做错的规则（都是真会丢数据的）
 *
 * 1. **「删本地」对“未上传”的文件 = 删掉唯一一份**。所以它**不是**“清缓存”，
 *    必须走回收站并由界面明示“没有云端副本”（本层只回答可用性，文案在界面）。
 * 2. **「删云端」对“仍被引用”的默认禁用**（CR-05 默认档）：删完笔记里就是死链，
 *    且这是全产品唯一**不可恢复**的动作。要放开必须显式改 `cloudDeleteNeedsUnreferenced`。
 *    ⭐ **正当出口是「改为本地引用」**（`fetch-local`）：先把链接换回库内路径，那份对象于是
 *    “没人引用”，再删云端。用户 2026-10-23 定的顺序：「需要先把状态从云端转换成本地，然后才能删」。
 * 3. **「上传」只对“上传候选”成立**：`未上传 ≠ 待上传` —— 安装包、算不出 key 的都不在候选里，
 *    把它们算进按钮数字就会让“按下只处理 N 个”变成假话。
 */

import type { GalleryItem, GalleryState } from "./enumerate";

export type GalleryAction =
	| "upload"
	| "delete-local"
	| "delete-cloud"
	| "rename"
	| "fetch-local";

/** 不可用原因（**代码**，不是文案 —— 核心层不写死中文，文案由界面按它查）。 */
export type GalleryUnavailableReason =
	| "already-uploaded"
	| "not-a-candidate"
	| "no-local-file"
	| "not-in-cloud"
	| "still-referenced"
	| "local-copy-present";

export interface GalleryActionContext {
	/** 这一项在**上传候选**里吗（由上传候选函数判定，不是“它没上传过”）。 */
	isUploadCandidate: boolean;
	/**
	 * 云端删除是否要求“没人引用”。
	 *
	 * 默认 `true`（CR-05 的默认档）。⚠️ 传 `false` 等于放开“删掉仍被引用的对象”，
	 * 那会让笔记里立刻出现死链 —— 只有产品明确改口径时才允许。
	 */
	cloudDeleteNeedsUnreferenced?: boolean;
}

export type GalleryAvailability =
	| { available: true }
	| { available: false; reason: GalleryUnavailableReason };

const AVAILABLE: GalleryAvailability = { available: true };

function unavailable(reason: GalleryUnavailableReason): GalleryAvailability {
	return { available: false, reason };
}

/** 单个动作对单个条目成立吗。 */
export function actionAvailability(
	item: GalleryItem,
	action: GalleryAction,
	context: GalleryActionContext
): GalleryAvailability {
	switch (action) {
		case "upload":
			// 已上传的（含只在云端的）不该再出现在上传里；按钮数字也不该算它们。
			if (item.state !== "not-uploaded") return unavailable("already-uploaded");
			if (!context.isUploadCandidate) return unavailable("not-a-candidate");
			return AVAILABLE;

		case "delete-local":
			// 本地没有文件就没有可删的（云端那份由「删云端」管）。
			if (item.path === null) return unavailable("no-local-file");
			return AVAILABLE;

		case "delete-cloud": {
			// 云端没有它（未上传 / 无 key）时，这个动作不成立。
			if (item.key === null || item.state === "not-uploaded") {
				return unavailable("not-in-cloud");
			}
			const needsUnreferenced = context.cloudDeleteNeedsUnreferenced !== false;
			if (needsUnreferenced && item.referenced) return unavailable("still-referenced");
			return AVAILABLE;
		}

		case "rename":
			// 重命名 / 移动改的是本地路径；云端 key 不变（R1 / LLD 4.2）。
			if (item.path === null) return unavailable("no-local-file");
			return AVAILABLE;

		case "fetch-local":
			// ⭐ 语义是「**改为本地引用**」：把笔记里的远端 URL 换成库内路径。
			// - `cloud-only`：本地没副本 ⇒ 先下载再改链接；
			// - `uploaded`：本地已有副本 ⇒ 只改链接（这一步过去被当成“不需要”，
			//   但那让“仍被引用”的对象永远删不掉云端 —— CR-05 的正确出口就在这儿）；
			// - `not-uploaded`：云端没有它，没什么可“改成本地引用”的。
			if (item.state === "cloud-only" || item.state === "uploaded") return AVAILABLE;
			return unavailable("not-in-cloud");
	}
}

/**
 * 按钮上的数字 = **能作用的件数**，不是勾选数。
 *
 * ⚠️ 这一条是“数字不能说谎”的落点：勾了 10 个、其中 3 个已在云端 ⇒ 上传返回 7，
 * 按下只处理那 7 个，其余由界面如实说“跳过 3 个”。
 */
export function countApplicable(
	items: readonly GalleryItem[],
	action: GalleryAction,
	context: GalleryActionContext
): number {
	let count = 0;
	for (const item of items) {
		if (actionAvailability(item, action, context).available) count += 1;
	}
	return count;
}

/**
 * 动作执行后这一行变成什么。
 *
 * - `removed` = 这一行消失（本地唯一一份被删掉）；
 * - `unchanged` = 只改了路径 / 名字，存储状态不变；
 * - 其余返回目标状态。
 *
 * ⚠️ 只在**动作可用**的前提下调用（不可用时没有“结果状态”可言）。
 * ⚠️ `delete-cloud` 之后本地那份从“可再生副本”变成**唯一一份** —— 状态的文字结论是
 * `not-uploaded`，但界面必须把“它现在没有云端备份”说出来（R24 / §5.5 硬规则 3）。
 */
export function outcomeOf(item: GalleryItem, action: GalleryAction): GalleryState | "removed" | "unchanged" {
	switch (action) {
		case "upload":
			return "uploaded";
		case "delete-local":
			// 已上传的少一份本地副本 ⇒ 变“云端有本地无”；未上传的删掉就是没了。
			return item.state === "uploaded" ? "cloud-only" : "removed";
		case "delete-cloud":
			return "not-uploaded";
		case "rename":
			return "unchanged";
		case "fetch-local":
			return "uploaded";
	}
}
