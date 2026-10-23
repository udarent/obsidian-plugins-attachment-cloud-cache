/**
 * 「没有任何引用的**本地文件**」怎么挑（`src/maintenance/local-orphans.ts`，D-74）。
 *
 * ## 这一层为什么值得一套穷举
 *
 * 它的产物是**清理命令的候选** —— 一旦挑错，用户勾上、点删除，删的是他自己的文件。
 * 五条排除各自对应一件真实的坏事：
 *
 * | 排除 | 漏了会怎样 |
 * |---|---|
 * | **宿主自己的目录**（`.obsidian/` 等） | 删掉插件与设置（本插件自己的索引文件就在那儿） |
 * | **被远端 URL 引用的对象**（`usedPaths` 的另一半） | 删掉正在显示的图（那份副本没了就得重新下载，离线直接看不到） |
 * | 被引用的站外缓存副本 | 删掉正在显示的那张图（与普通文件同一道判据，只是标签不同） |
 * | 云端清单已覆盖的路径 | 同一个文件在清单里出现两行，两行各删一次 |
 * | 笔记 / 画布 / 数据库 | 删掉一篇笔记（它不是附件） |
 *
 * ⚠️ 第一格是**实测抓到的**：第一版只看"非笔记类 + 没引用"，于是
 * `.obsidian/plugins/attachment-cloud-cache/.cache-index.json` 被列成了可清理项。
 *
 * ## ⭐ 2026-10-22（D-77）：站外缓存副本**不再被排除**，改成单独一栏
 *
 * 它们进 `cachedPaths`（界面标「站外缓存」、**默认不勾**）。理由：
 * 原来那条排除说的是“认不出引用、可能误删”—— 那只属于**云端那一半**；
 * 删本地副本不碰云端、不改笔记，代价只是下次显示要重新下载。
 * ⚠️ 但「还在被引用」仍然先行 —— 被引用的缓存副本两份清单都不进。
 *
 * ⚠️ **断言顺序按危险度排**（不是按代码顺序）：每条锚点都要能"最先失败在它自己那一句"上，
 * 否则变异运行器会报「原因不符」。
 */

import assert from "node:assert/strict";

export async function runLocalOrphansSuite(mod) {
	const { selectLocalOrphans } = mod;

	const files = [
		{ path: "notes/a.md", extension: "md" },
		{ path: "attachments/used-by-note.png", extension: "png" },
		{ path: "attachments/used-remotely.png", extension: "png" },
		{ path: "attachments/covered.png", extension: "png" },
		{ path: "attachments/external-cache.jpg", extension: "jpg" },
		{ path: "attachments/lonely.png", extension: "png" },
		{ path: "attachments/also-lonely.pdf", extension: "pdf" },
		{ path: ".obsidian/plugins/x/data.json", extension: "json" },
		{ path: ".trash/old.png", extension: "png" },
		{ path: "", extension: "png" },
	];

	const options = {
		usedPaths: new Set(["attachments/used-by-note.png", "attachments/used-remotely.png"]),
		coveredPaths: new Set(["attachments/covered.png"]),
		externalPaths: new Set(["attachments/external-cache.jpg"]),
		// ⚠️ 配置目录名是用户可配的 ⇒ 由调用方给（这里就按默认的 `.obsidian` 与回收站）
		excludedPrefixes: [".obsidian/", ".trash/"],
	};

	const picked = selectLocalOrphans(files, options);
	const reasons = Object.fromEntries(picked.skipped.map((row) => [row.reason, row.count]));

	// ① 最危险的一格先说话：删了宿主目录 = 插件与设置坏了
	assert.equal(
		reasons["宿主自己的目录（配置目录 / 回收站）"] ?? 0,
		2,
		"★★★ 宿主自己的目录（配置目录 / 回收站）里的文件一个都不许列 —— 删了插件与设置就坏了"
	);

	// ② 被引用（含**远端 URL 引用**那一半）：删了就是删正在显示的图
	assert.equal(
		reasons["还有笔记或画布在引用"] ?? 0,
		2,
		"★★ 两份「有人在用」的都要排除 —— 尤其**链接已改成远端地址**的那份（只查本地引用就会误删）"
	);

	// ③ 站外缓存的本地副本：**单独一栏**（D-77），不得混进普通候选
	assert.deepEqual(
		picked.cachedPaths,
		["attachments/external-cache.jpg"],
		`★★ 站外缓存副本要单独一栏（界面标「站外缓存」、默认不勾）：${picked.cachedPaths.join(" | ")}`
	);

	// ④ 云端清单已列过：不列两行（否则两行各删一次）
	assert.equal(reasons["已经在云端对象那条清单里"] ?? 0, 1, "★★ 云端清单已覆盖的路径不重复列");

	// ⑤ 笔记类：删了就是删笔记
	assert.equal(
		reasons["是笔记/画布/数据库文件，不是附件"] ?? 0,
		1,
		"★★ 笔记类必须排除（删了就是删一篇笔记）"
	);

	// ⑥ 空路径：不该被当成"一份文件"
	assert.equal(reasons["路径为空"] ?? 0, 1, "★ 空路径不计入候选");

	// ⑦ 最后才是"该列的都在"：真正该清的必须一个不少
	assert.deepEqual(
		picked.paths,
		["attachments/lonely.png", "attachments/also-lonely.pdf"],
		`★★ 只有「没人引用」的普通附件在这一栏（缓存那份在「cachedPaths」那一栏）：${picked.paths.join(" | ")}`
	);

	// 反向：没有输入 ⇒ 两份都空（不能把"什么都没排除"读成"全都要清"）
	const none = selectLocalOrphans([], options);
	assert.deepEqual(none.paths, [], "★ 没有输入时返回空（不给调用方一个「全都删」的清单）");
	assert.deepEqual(none.cachedPaths, [], "★ 缓存那一栏同理");

	return { cases: files.length };
}
