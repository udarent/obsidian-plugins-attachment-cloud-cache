/**
 * 附件管理的枚举与四态（`src/gallery/enumerate.ts`，R24）。
 *
 * ## 这一层为什么值得一套穷举
 *
 * 它决定**列表里有哪些行**、以及**每行的状态**：
 * 少一行 = 用户看不见、也删不掉；多一行 = 同一个对象被处理两次；
 * 状态错 = 按钮可用性与数字跟着错（“能不能传”“能不能删云端”全挂在它上面）。
 *
 * | 判据 | 错了会怎样 |
 * |---|---|
 * | 笔记类不进列表 | 用户看到自己的笔记，勾上后“删除”= 删笔记 |
 * | 已在本地的条目不再出一条“云端”行 | 同一个附件出现两行，各删一次 |
 * | `evidence` 区分 index / ledger / none | “未上传”与“没核过”长得一样，用户以为可以传、实际云端早就有 |
 * | 引用要问两半（路径 ∪ URL） | 只问一半 ⇒ 一种写法全成“没人引用”，清理时会误删 |
 *
 * ⚠️ **断言顺序按危险度排**（不是按代码顺序）：每条锚点要能“最先失败在它自己那一句”上。
 */

import assert from "node:assert/strict";

/** 造一份“本地文件”的输入。 */
function file(path, size = 100, extension = path.split(".").pop() ?? "") {
	return { path, size, extension };
}

export async function runGalleryEnumerateSuite(mod) {
	const { enumerateGallery } = mod;

	const input = {
		files: [
			file("notes/a.md"),
			file("boards/b.canvas"),
			file("bases/c.base"),
			file("attachments/uploaded.png", 1000),
			file("attachments/cloud-deleted.png", 2000),
			file("attachments/never-uploaded.png", 3000),
			file("attachments/only-url.png", 4000),
			file("attachments/cached.jpg", 5000),
			file("attachments/uploaded.png", 1000),
		],
		entries: [
			{ key: "uploaded-<hash>.png", cachePath: "attachments/uploaded.png", size: 1000 },
			{ key: "gone-<hash>.png", cachePath: "attachments/cloud-deleted.png", size: 2000 },
			{ key: "only-url-<hash>.png", cachePath: "attachments/only-url.png", size: 4000 },
			{ key: "cached-<hash>.jpg", cachePath: "attachments/cached.jpg", size: 5000, origin: "external" },
			// 条目还在、文件已经不在 ⇒ 这一条要出“云端有本地无”。
			{ key: "orphaned-<hash>.pdf", cachePath: "attachments/deleted-local.pdf", size: 6000 },
		],
		uploadedKeys: [
			"uploaded-<hash>.png",
			"only-url-<hash>.png",
			"cached-<hash>.jpg",
			"orphaned-<hash>.pdf",
			// 只有台账：从来没留下副本（「不留副本」档的形态）。
			"purecloud-<hash>.docx",
		],
		referencedPaths: new Set(["attachments/uploaded.png"]),
		referencedKeys: new Set(["only-url-<hash>.png"]),
	};

	const snapshot = enumerateGallery(input);
	const byId = new Map(snapshot.items.map((item) => [item.id, item]));

	// ① 危险度最高：笔记类绝不能进来（删了就是删笔记）。
	assert.deepEqual(
		snapshot.items.filter((item) => /\.(md|canvas|base)$/.test(item.path ?? "")).length,
		0,
		"笔记 / 画布 / 数据库不进列表（它们不是附件）"
	);

	// ② 三种状态各自的代表：状态与证据都要对。
	assert.equal(byId.get("attachments/uploaded.png").state, "uploaded", "索引有条目且台账里有 ⇒ 已上传");
	assert.equal(
		byId.get("attachments/uploaded.png").evidence,
		"index",
		"有索引条目时证据是 index"
	);
	assert.equal(
		byId.get("attachments/cloud-deleted.png").state,
		"not-uploaded",
		"索引有条目但台账里没有（云端被删过）⇒ 未上传，且 key 仍已知"
	);
	assert.equal(
		byId.get("attachments/cloud-deleted.png").key,
		"gone-<hash>.png",
		"有条目就说明 key 已知，不能报 null"
	);
	assert.equal(
		byId.get("attachments/never-uploaded.png").state,
		"not-uploaded",
		"既无条目又无台账 ⇒ 未上传"
	);
	assert.equal(
		byId.get("attachments/never-uploaded.png").evidence,
		"none",
		"没有条目 ⇒ 证据是 none（“未上传”不等于“核过了”）"
	);
	assert.equal(
		byId.get("purecloud-<hash>.docx").state,
		"cloud-only",
		"只有台账（不留副本档）⇒ 云端有、本地无"
	);
	assert.equal(
		byId.get("purecloud-<hash>.docx").evidence,
		"ledger",
		"只在台账里的对象，证据是 ledger"
	);
	assert.equal(
		byId.get("orphaned-<hash>.pdf").state,
		"cloud-only",
		"条目还在但文件已不在 ⇒ 云端有、本地无"
	);
	assert.equal(
		byId.get("orphaned-<hash>.pdf").path,
		null,
		"云端有本地无的行没有本地路径"
	);

	// ③ 同一个对象不能出两行（否则“删除”会点第二次）。
	assert.equal(
		snapshot.items.filter((item) => item.id === "attachments/uploaded.png").length,
		1,
		"同一路径只出一行（输入重复也不行）"
	);
	assert.equal(
		snapshot.items.filter((item) => item.key === "cached-<hash>.jpg").length,
		1,
		"已在本地的条目不许再出一条“云端”行"
	);

	// ④ 引用问两半：本地路径那一半、远端 URL 那一半。
	assert.equal(
		byId.get("attachments/uploaded.png").referenced,
		true,
		"被本地路径指着 ⇒ 有引用"
	);
	assert.equal(
		byId.get("attachments/only-url.png").referenced,
		true,
		"只在笔记里写着远端 URL（没人再指着路径）⇒ 仍然算有引用"
	);
	assert.equal(
		byId.get("purecloud-<hash>.docx").referenced,
		false,
		"两半都没提到它 ⇒ 没人引用"
	);

	// ⑤ 站外缓存副本要能标出来（清理命令单独一栏、默认不勾）。
	assert.equal(byId.get("attachments/cached.jpg").origin, "external", "站外缓存副本要标 origin");
	assert.equal(byId.get("attachments/uploaded.png").origin, null, "自己上传的没有 origin");

	// ⑥ 聚合：三态互斥且总数对得上（放最后，避免掩盖上面的结构问题）。
	assert.deepEqual(
		snapshot.counts,
		{
			uploaded: 3,
			"not-uploaded": 2,
			"cloud-only": 2,
			total: 7,
			unreferenced: 5,
		},
		"计数要与行数一致：三态互斥，unreferenced 是叠加数"
	);

	// ⑦ 确定性：同一份输入两次结果逐字相同（分页与落盘都依赖它）。
	const again = enumerateGallery(input);
	assert.deepEqual(
		again.items.map((item) => item.id),
		snapshot.items.map((item) => item.id),
		"同一份输入的顺序必须稳定"
	);

	return { cases: 20 };
}
