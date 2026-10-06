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
 * 正好用于这种"插件自己的数据文件"。手机上同样可用（这正是 SCOPE 里
 * "不用 Node fs、只用 DataAdapter"那条约束的实际落点）。
 */

import type { DataAdapter } from "obsidian";
import { CacheIndex, type SkippedEntry } from "./index";

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
const TEMP_SUFFIX = ".tmp";

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
			error: `读取失败：${describe(error)}`,
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
			error: `JSON 解析失败：${describe(error)}`,
		};
	}

	// 结构层面的容错在 CacheIndex.fromJSON 里（逐条校验、坏条目丢弃并计数）
	const { index, skipped } = CacheIndex.fromJSON(parsed);
	return { index, skipped, existed: true, error: "" };
}

/**
 * 原子化写入索引。
 *
 * 先写 `path.tmp` 再 `rename` 覆盖，避免"写到一半"留下截断的 JSON。
 * 父目录缺失时先建 —— 插件目录通常已存在，但自建目录能在
 * "用户手工删过插件目录下文件"的情况下自愈。
 */
export async function saveCacheIndex(adapter: DataAdapter, path: string, index: CacheIndex): Promise<void> {
	const folder = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").slice(0, -1).join("/");
	if (folder && !(await adapter.exists(folder))) {
		// ⚠️ 此处**没有**跳过多层创建的余地：`DataAdapter.mkdir` 本身会建出中间层
		// （桌面与移动的实现都是如此）。若将来某个宿主不这么做，
		// 最坏结果是这一步抛错 —— 那会被下面的调用方当作"索引没存上"处理，
		// 而不会影响上传本身。
		await adapter.mkdir(folder);
	}

	const payload = JSON.stringify(index.toJSON());
	const temp = `${path}${TEMP_SUFFIX}`;

	await adapter.write(temp, payload);
	try {
		await adapter.rename(temp, path);
	} catch (error) {
		// 某些适配器可能不允许覆盖式改名。此时退回"直接写目标文件"，
		// 并尽力清掉临时文件 —— 退化的只是原子性，不是可用性。
		try {
			await adapter.write(path, payload);
		} finally {
			await removeQuietly(adapter, temp);
		}
		void error;
	}
}

/** 删掉临时文件；失败无所谓（它只是个中间产物），绝不能因此让主流程失败。 */
async function removeQuietly(adapter: DataAdapter, path: string): Promise<void> {
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
	} catch {
		// 忽略
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
