/**
 * 站点决定记忆的持久化（走宿主的 `DataAdapter`，不用 Node `fs`）。
 *
 * 与 `cache/store.ts` 是同一套纪律（那里有更详细的理由），这里只记**不同**的两点：
 *
 * 1. **丢了这份文件不会丢数据，只会重新问一遍。** 所以"读坏 / 读不到就降级为
 *    空记忆"在这里更没争议 —— 缓存索引尚且有重建的代价，这份文件连重建都不需要。
 * 2. **它是"用户回答过的内容"，所以要能被用户看见与清掉。**
 *    存放在插件目录（`.obsidian/plugins/<id>/`）下还有个附带好处：
 *    它会**随 vault 一起同步** —— 用户在新设备上不必把所有站点再答一遍。
 *
 * ⚠️ 放在插件目录而不是 vault 里，是因为宿主的 `vault` API 看不见 `.obsidian/`
 * 下的路径（也不该看见）。`adapter` 正是用于"插件自己的数据文件"的那一层，
 * 手机上同样可用。
 */

import type { App, DataAdapter } from "obsidian";

import { SiteDecisions } from "../render/site-decisions";
import { isPlainRecord } from "../records";
import { describeError } from "../error-text";
import { writeJsonAtomically } from "../atomic-write";

/** 文件名。以点开头：`adapter.list` 会列出它，但不会进宿主的文件索引。 */
export const SITE_DECISIONS_FILE = ".site-decisions.json";

/** 记忆文件在插件目录下的完整 vault 相对路径。 */
export function siteDecisionsFilePath(pluginDir: string | undefined): string {
	const clean = String(pluginDir ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return clean ? `${clean}/${SITE_DECISIONS_FILE}` : SITE_DECISIONS_FILE;
}

/** 写入过程中用的临时文件名（写完就改名，所以它不会长期存在）。 */

export interface LoadSiteDecisionsResult {
	decisions: SiteDecisions;
	/** 文件是否存在。用于区分"首次运行"与"文件丢了"。 */
	existed: boolean;
	/** 读失败时的原因；成功或文件不存在时为空串。 */
	error: string;
}

/**
 * 从适配器读取记忆。**任何异常都降级成"空记忆 + 一句记录"**（理由见模块头注释）。
 */
export async function loadSiteDecisions(adapter: DataAdapter, path: string): Promise<LoadSiteDecisionsResult> {
	let text: string;
	try {
		if (!(await adapter.exists(path))) {
			return { decisions: new SiteDecisions(), existed: false, error: "" };
		}
		text = await adapter.read(path);
	} catch (error) {
		// 读不到（权限、被占用、同步中的半截文件）→ 当作空记忆继续
		return { decisions: new SiteDecisions(), existed: true, error: `读取失败：${describeError(error)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// 不是合法 JSON（多半是上次写入被打断）→ 空记忆，用户下次会被重新问一遍
		return { decisions: new SiteDecisions(), existed: true, error: `JSON 解析失败：${describeError(error)}` };
	}

	// ⚠️ "能解析成 JSON" 与 "是我们的格式" 是两件事。一份合法但形状不对的文件
	// （`42`、`[]`、`{"decisions":"nope"}`）必须**报出原因**，而不是静默当成空记忆 ——
	// 否则症状是"我答过的站点又问我了"，而用户永远查不出为什么。
	if (!isPlainRecord(parsed)) {
		return { decisions: new SiteDecisions(), existed: true, error: "结构不对：不是一个对象" };
	}
	if (!Array.isArray(parsed.decisions)) {
		return { decisions: new SiteDecisions(), existed: true, error: "结构不对：decisions 不是数组" };
	}

	// 逐条校验在 `SiteDecisions.fromJSON` 里（坏条目跳过、好条目留下）。
	return { decisions: SiteDecisions.fromJSON(parsed), existed: true, error: "" };
}

/**
 * 原子化写入记忆。
 *
 * 同步工具可能在任何时刻读到这份文件，所以必须原子落盘 —— 具体做法与兜底
 * 收在 `atomic-write.ts` 里（与缓存索引**共用同一份**）。
 */
export async function saveSiteDecisions(
	adapter: DataAdapter,
	path: string,
	decisions: SiteDecisions
): Promise<void> {
	await writeJsonAtomically(adapter, path, JSON.stringify(decisions.toJSON()));
}




/** 记忆的读写。对象由它持有，接线层直接读 `.decisions`。 */
export interface SiteStore {
	/** **当前**记忆对象。`load()` 之后会被换成新的一份，所以要现取。 */
	readonly decisions: SiteDecisions;
	load: () => Promise<{ error: string; existed: boolean }>;
	save: () => Promise<void>;
}

/**
 * 按插件目录定位并读写记忆。
 *
 * `pluginDir` 取 `manifest.dir`（装好的插件一定有值）；缺失时按 `id` 拼一个兜底路径 ——
 * 记忆写错位置只会导致"用户要重新回答一遍"，比整个插件起不来轻得多。
 *
 * `save()` 里**不排队**（与索引不同）：这里的写入由用户的一次点击触发，
 * 频率极低（人手点不快），而排队会引入"点了却还没落盘"的额外状态。
 * 真正的并发场景（同一轮渲染里多个站点同时被答复）由编排层按站点去重，
 * 不会走到这里。
 */
export function createSiteStore(app: App, pluginDir: string | undefined, pluginId: string): SiteStore {
	const path = siteDecisionsFilePath(pluginDir ?? `.obsidian/plugins/${pluginId}`);
	let current = new SiteDecisions();

	return {
		get decisions() {
			return current;
		},
		async load() {
			const result = await loadSiteDecisions(app.vault.adapter, path);
			// 换掉整个对象而不是逐条搬：`loadSiteDecisions` 已经把坏条目筛过一遍。
			current = result.decisions;
			return { error: result.error, existed: result.existed };
		},
		async save() {
			// 在**执行时**读 `current`：排队期间若又答了一个站点，写下去的应当包含它。
			await saveSiteDecisions(app.vault.adapter, path, current);
		},
	};
}
