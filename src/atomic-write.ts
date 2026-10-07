/**
 * 原子化写入一个 JSON 文件 —— 缓存索引与站点记忆**共用**的落盘方式。
 *
 * ## 为什么值得单独一个模块
 *
 * 这段实现原本在 `cache/store.ts` 与 `host/site-store.ts` 里**各有一份逐字相同**
 * 的版本（25 行 ×2，连注释都一样）。抽到一处之后，"两个 store 的落盘语义一致"
 * 从"靠人记得同步改两处"变成"结构上只可能一致"。
 *
 * 这不是洁癖：两处里任意一处被改坏（比如漏了 rename 的兜底），
 * 症状是**那一份数据在特定宿主上永远存不上**，而用户只看到"设置没保存"。
 *
 * ## 语义
 *
 * 1. **先写 `path.tmp`，再 `rename` 覆盖** —— 直接写目标文件会在写到一半时
 *    留下截断的 JSON，而同步工具（Syncthing / iCloud / git）可能在任何时刻读到它。
 * 2. **父目录缺失时先建** —— 插件目录通常已存在，这一步是为了
 *    "用户手工删过插件目录下文件"时能自愈（`DataAdapter.mkdir` 本身会建出中间层，
 *    桌面与移动的实现都是如此；若将来某个宿主不这么做，最坏结果是这一步抛错，
 *    那会被调用方当作"没存上"处理，而不会影响上传本身）。
 * 3. **`rename` 不被支持时退回直接写** —— 某些适配器不允许覆盖式改名。
 *    没有这条兜底，那类宿主上会变成"永远存不上"。退化的只是原子性，不是可用性。
 * 4. **清临时文件失败一律吞掉** —— 它只是个中间产物；
 *    为了删不掉它而让"保存"失败，损失大得多。
 *
 * ⚠️ 载荷由调用方 `JSON.stringify` 好再传进来：这一层只管"怎么安全地落盘"，
 * 不管"内容是什么"，所以它对索引与记忆的差异一无所知。
 */

import type { DataAdapter } from "obsidian";

/** 临时文件后缀。写成常量是为了让"临时文件长什么样"只有一处定义。 */
const TEMP_SUFFIX = ".tmp";

/**
 * 把 `payload` 原子地写进 `path`。
 *
 * 调用方负责提供**已序列化**的内容；本函数负责建目录、写临时文件、
 * rename 覆盖、以及不被支持时的退回。
 */
export async function writeJsonAtomically(adapter: DataAdapter, path: string, payload: string): Promise<void> {
	// 路径归一：两个 store 的路径来源不同（插件目录推演 / 用户配置），
	// 反斜杠与多余的前导斜杠都要在这里抹平 —— 否则会在 vault 里建出奇怪的层级。
	const folder = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").slice(0, -1).join("/");
	if (folder && !(await adapter.exists(folder))) {
		await adapter.mkdir(folder);
	}

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
