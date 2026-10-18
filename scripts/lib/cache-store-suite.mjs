/**
 * 索引持久化的套件（`src/cache/store.ts`）。
 *
 * ## 两条硬要求，各有一组断言
 *
 * 1. **读不到 / 读坏了都必须能继续跑。** 索引是派生数据，而它读失败的时刻恰好是
 *    插件启动 —— 在这里抛错，用户看到的是"插件加载失败、连设置页都进不去"。
 *    所以这里逐格钉住三种降级：文件不存在（首次运行，**不算错**）、读失败、坏 JSON。
 * 2. **写入不能留下半截文件。** 走 `atomic-write`（先写临时文件再 rename）。
 *    断言"内容真的写进去了"与"必须经过 rename"两件事 —— 少任何一条，
 *    "写到一半崩溃"在下一次启动时就会变成一段截断的 JSON。
 */

import assert from "node:assert/strict";

/** 最小的 DataAdapter 替身：只实现 store / atomic-write 用到的六个口。 */
function makeAdapter({ files = {}, readFails = false } = {}) {
	const state = { ...files };
	const calls = { exists: [], read: [], write: [], rename: [], mkdir: [], remove: [] };
	const adapter = {
		exists: async (path) => {
			calls.exists.push(path);
			return path in state;
		},
		read: async (path) => {
			calls.read.push(path);
			if (readFails) throw new Error("文件被占用");
			if (!(path in state)) throw new Error("文件不存在");
			return state[path];
		},
		write: async (path, text) => {
			calls.write.push([path, text]);
			state[path] = text;
		},
		rename: async (from, to) => {
			calls.rename.push([from, to]);
			if (from in state) {
				state[to] = state[from];
				delete state[from];
			}
		},
		mkdir: async (path) => {
			calls.mkdir.push(path);
		},
		remove: async (path) => {
			calls.remove.push(path);
			delete state[path];
		},
	};
	return { adapter, calls, state };
}

const VALID_INDEX = JSON.stringify({
	version: 1,
	entries: [{ key: "img/k.png", cachePath: "attachments/k.png", size: 10, lastUsedAt: 5 }],
	uploaded: ["img/k.png"],
});

export async function runCacheStoreSuite(mod) {
	const { indexFilePath, loadCacheIndex, saveCacheIndex, CACHE_INDEX_FILE } = mod;
	const path = "plugins/attachment-cloud-cache/.cache-index.json";

	// ============================================================
	// 1. 路径：必须落在插件目录下，且清掉两端的斜杠
	// ============================================================
	assert.equal(indexFilePath(""), CACHE_INDEX_FILE, "插件目录未知时退化成裸文件名（不是以斜杠开头）");
	assert.equal(
		indexFilePath("plugins/attachment-cloud-cache/"),
		path,
		"索引文件路径必须落在插件目录下（前导/尾随斜杠要清掉）"
	);
	assert.equal(indexFilePath("plugins\\attachment-cloud-cache"), path, "反斜杠必须归一成斜杠（跨平台）");

	// ============================================================
	// 2. 读：三种降级，一种成功
	// ============================================================
	{
		const { adapter } = makeAdapter();
		const result = await loadCacheIndex(adapter, path);
		assert.equal(result.existed, false, "文件不存在 ⇒ existed=false（用来区分首次运行）");
		assert.equal(result.error, "", "文件不存在是首次运行：不该报错");
		assert.equal(result.index.get("img/k.png"), undefined, "空索引里不该有条目");
	}
	{
		const { adapter } = makeAdapter({ files: { [path]: VALID_INDEX }, readFails: true });
		const result = await loadCacheIndex(adapter, path);
		assert.equal(result.existed, true, "读失败时文件是存在的（existed 要如实）");
		assert.equal(result.error.startsWith("读取失败"), true, "读失败必须降级成空索引，但如实给原因");
	}
	{
		const { adapter } = makeAdapter({ files: { [path]: "{ 这不是 JSON" } });
		const result = await loadCacheIndex(adapter, path);
		assert.equal(result.error.startsWith("JSON 解析失败"), true, "坏 JSON 必须降级成空索引，但如实给原因");
		assert.equal(result.skipped.length, 0, "解析层面的失败不计入「坏条目」");
	}
	{
		const { adapter } = makeAdapter({ files: { [path]: VALID_INDEX } });
		const result = await loadCacheIndex(adapter, path);
		const entry = result.index.get("img/k.png");
		assert.equal(entry?.cachePath, "attachments/k.png", "合法索引必须被读出来（key → 副本路径）");
		assert.equal(result.error, "", "读成功时不该有错误");
	}

	// ============================================================
	// 3. 写：内容真的进去，且必须经过 rename（原子写）
	// ============================================================
	{
		const { adapter, calls } = makeAdapter({ files: { [path]: VALID_INDEX } });
		const loaded = await loadCacheIndex(adapter, path);
		await saveCacheIndex(adapter, path, loaded.index);

		const lastWrite = calls.write[calls.write.length - 1];
		const parsed = JSON.parse(lastWrite[1]);
		assert.equal(parsed.entries.length, 1, "写出去的内容必须保留条目（否则下次启动索引就丢了）");
		assert.equal(parsed.entries[0].key, "img/k.png", "写出去的内容必须保留 key");
		assert.ok(calls.rename.length >= 1, "写入必须经 rename（原子写，不能留下半截文件）");
	}

	return { loadCases: 4 };
}
