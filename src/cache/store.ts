/**
 * 缓存索引的持久化（走宿主的 `DataAdapter`，不用 Node `fs`）。
 *
 * ## 两条硬要求
 *
 * 1. **读不到 / 读坏了都必须能继续跑。** 索引是"可以重建的派生数据"，
 *    而它读失败的时刻恰好是插件启动。若在这里抛错，用户看到的是
 *    "插件加载失败、连设置页都进不去" —— 为了一份缓存索引付出这个代价毫无道理。
 *    所以任何异常都降级成"空索引 + 一句记录"。
 * 2. **写入不能留下半截文件。** 写索引是覆盖式写入；若在写到一半时崩溃/断电，
 *    下次读到的就是一段截断的 JSON。先写临时文件再改名（`rename` 在同一目录内
 *    是原子的），可以保证读到的要么是旧内容、要么是新内容。
 *
 * ## 为什么用 `adapter` 而不是 `vault`
 *
 * 索引文件在插件目录里，而它是 `.obsidian/` 下的东西 ——
 * 宿主的 `vault` API 看不见这类路径（也不该看见）。`adapter` 是直接的文件访问层，
 * 正好用于这种"插件自己的数据文件"。手机上同样可用 —— 这正是"不用 Node fs、
 * 只用 DataAdapter"那条约束的实际落点。
 */

import type { DataAdapter } from "obsidian";
import { CacheIndex, type SkippedEntry } from "./index";
import { describeError } from "../error-text";
import { writeJsonAtomically } from "../atomic-write";

/** 索引文件名。以点开头：`adapter.list` 会列出它，但不会进宿主的文件索引。 */
export const CACHE_INDEX_FILE = ".cache-index.json";

/** 索引文件在插件目录下的完整 vault 相对路径。 */
export function indexFilePath(pluginDir: string): string {
	const clean = String(pluginDir ?? "")
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return clean ? `${clean}/${CACHE_INDEX_FILE}` : CACHE_INDEX_FILE;
}

/** 写入过程中用的临时文件名（写完就改名，所以它不会长期存在）。 */

export interface LoadCacheIndexResult {
	index: CacheIndex;
	/** 被丢弃的条目（坏数据），供日志与自检汇报。 */
	skipped: SkippedEntry[];
	/** 索引文件是否存在。用于区分"首次运行"与"文件丢了"。 */
	existed: boolean;
	/** 读失败时的原因；成功或文件不存在时为空串。 */
	error: string;
}

/**
 * 从适配器读取索引。
 *
 * @param adapter 宿主的 DataAdapter
 * @param path    索引文件的 vault 相对路径
 */
export async function loadCacheIndex(adapter: DataAdapter, path: string): Promise<LoadCacheIndexResult> {
	let text: string;
	try {
		if (!(await adapter.exists(path))) {
			return { index: new CacheIndex(), skipped: [], existed: false, error: "" };
		}
		text = await adapter.read(path);
	} catch (error) {
		// 读不到（权限、被占用、同步中的半截文件）→ 当作空索引继续
		return {
			index: new CacheIndex(),
			skipped: [],
			existed: true,
			error: `读取失败：${describeError(error)}`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		// 不是合法 JSON（多半是上次写入被打断）→ 空索引开始重建
		return {
			index: new CacheIndex(),
			skipped: [],
			existed: true,
			error: `JSON 解析失败：${describeError(error)}`,
		};
	}

	// 结构层面的容错在 CacheIndex.fromJSON 里（逐条校验、坏条目丢弃并计数）
	const { index, skipped } = CacheIndex.fromJSON(parsed);
	return { index, skipped, existed: true, error: "" };
}

/**
 * 原子化写入索引。
 *
 * 怎么原子、怎么兜底、怎么建目录都收在 `atomic-write.ts` 里（与站点记忆**共用同一份**）。
 * 这里只负责把索引序列化好交给它 —— 所以两个 store 的落盘语义只可能一致。
 */
export async function saveCacheIndex(adapter: DataAdapter, path: string, index: CacheIndex): Promise<void> {
	await writeJsonAtomically(adapter, path, JSON.stringify(index.toJSON()));
}



