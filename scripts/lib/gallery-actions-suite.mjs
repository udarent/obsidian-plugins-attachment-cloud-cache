/**
 * 动作可用性（`src/gallery/actions.ts`，R24 / §5.5）。
 *
 * ## 这一层错了会怎样
 *
 * 它是“按钮灰不灰”“按钮数字是几”“批量执行前过滤掉谁”的**同一份判据**：
 *
 * | 判据 | 错了会怎样 |
 * |---|---|
 * | 「删云端」默认要求“没人引用” | 删掉仍被笔记引用的对象 ⇒ 笔记里立刻是死链，**且不可恢复** |
 * | 「删本地」要求本地有文件 | 对“云端有本地无”的行也放行 ⇒ 点了没反应，或删到别的东西 |
 * | 「上传」要求在上传候选里 | 把安装包等算进数字 ⇒ “按下只处理 N 个”变成假话 |
 * | 数字 = 能作用的件数 | 勾 10 个、数字写 10、实际只处理 7 个 ⇒ 用户以为全做了 |
 *
 * ⚠️ 断言顺序按危险度排：最不可恢复的那条排第一。
 */

import assert from "node:assert/strict";

/** 造一行（只给这一层关心的字段）。 */
function item(overrides) {
	return {
		id: overrides.id ?? "x",
		name: overrides.name ?? "x",
		path: overrides.path ?? null,
		key: overrides.key ?? null,
		state: overrides.state,
		evidence: overrides.evidence ?? "index",
		referenced: overrides.referenced ?? false,
		size: overrides.size ?? 1,
		origin: overrides.origin ?? null,
	};
}

const noCandidate = { isUploadCandidate: false };
const candidate = { isUploadCandidate: true };

export async function runGalleryActionsSuite(mod) {
	const { actionAvailability, countApplicable, outcomeOf } = mod;

	const uploadedFree = item({ id: "a", path: "a.png", key: "ka", state: "uploaded" });
	const uploadedUsed = item({
		id: "b",
		path: "b.png",
		key: "kb",
		state: "uploaded",
		referenced: true,
	});
	const neverUploaded = item({ id: "c", path: "c.png", state: "not-uploaded", evidence: "none" });
	const cloudOnly = item({ id: "d", key: "kd", state: "cloud-only" });

	// ① 最危险：删掉仍被引用的云端对象（不可恢复）。
	// ⭐ CR-05 定案（2026-10-25）：**没有**"放开"这一档 —— 原先那条
	// `{ cloudDeleteNeedsUnreferenced: false } ⇒ available: true` 的用例已删，
	// 连那个开关本身也一起删了（它从来没有调用点传过 false）。
	assert.deepEqual(
		actionAvailability(uploadedUsed, "delete-cloud", candidate),
		{ available: false, reason: "still-referenced" },
		"被引用的对象不许删云端（CR-05：永不放开）"
	);

	// ② 本地没有文件时，“删本地”不成立。
	assert.deepEqual(
		actionAvailability(cloudOnly, "delete-local", candidate),
		{ available: false, reason: "no-local-file" },
		"云端有本地无的行没有本地文件，删不了本地"
	);

	// ③ “未上传 ≠ 待上传”：不在候选里就不许出现在上传动作上。
	assert.deepEqual(
		actionAvailability(neverUploaded, "upload", noCandidate),
		{ available: false, reason: "not-a-candidate" },
		"不在上传候选里的文件不能传（未上传 ≠ 待上传）"
	);
	assert.deepEqual(
		actionAvailability(neverUploaded, "upload", candidate),
		{ available: true },
		"在上传候选里的未上传文件可以传"
	);
	assert.deepEqual(
		actionAvailability(uploadedFree, "upload", candidate),
		{ available: false, reason: "already-uploaded" },
		"已上传的不该再出现在上传动作里"
	);

	// ④ 其余动作的成立条件。
	assert.deepEqual(
		actionAvailability(neverUploaded, "delete-cloud", candidate),
		{ available: false, reason: "not-in-cloud" },
		"没上传过的对象删不了云端"
	);
	assert.deepEqual(
		actionAvailability(uploadedFree, "rename", candidate),
		{ available: true },
		"有本地文件就能改名"
	);
	assert.deepEqual(
		actionAvailability(cloudOnly, "rename", candidate),
		{ available: false, reason: "no-local-file" },
		"没有本地文件就没有可改的对象"
	);
	assert.deepEqual(
		actionAvailability(cloudOnly, "fetch-local", candidate),
		{ available: true },
		"云端有本地无 ⇒ 可以取回本地"
	);
	assert.deepEqual(
		actionAvailability(uploadedFree, "fetch-local", candidate),
		{ available: true },
		"本地已有副本也要成立：它的语义是“改为本地引用”，只改链接（删云端的正当出口）"
	);
	assert.deepEqual(
		actionAvailability(neverUploaded, "fetch-local", candidate),
		{ available: false, reason: "not-in-cloud" },
		"云端没有的对象取不回来"
	);

	// ⑤ 按钮数字 = 能作用的件数（放最后两段，避免掩盖上面的矩阵问题）。
	const all = [uploadedFree, uploadedUsed, neverUploaded, cloudOnly];
	assert.equal(
		countApplicable(all, "upload", candidate),
		1,
		"按钮数字 = 能作用的件数（不是勾选数）"
	);
	assert.equal(
		countApplicable(all, "delete-cloud", candidate),
		2,
		"四个里能删云端的是“没人引用的已上传”与“只在云端”两行"
	);
	assert.equal(countApplicable(all, "delete-local", candidate), 3, "三个有本地文件的都能删本地");

	// ⑥ 动作后的状态（界面据此更新行、决定要不要提示“没有云端备份了”）。
	assert.equal(
		outcomeOf(uploadedFree, "delete-local"),
		"cloud-only",
		"删本地：已上传的变云端有本地无，未上传的整行消失"
	);
	assert.equal(outcomeOf(neverUploaded, "delete-local"), "removed", "未上传的删本地等于整行消失");
	assert.equal(outcomeOf(cloudOnly, "fetch-local"), "uploaded", "取回本地后变已上传");
	assert.equal(outcomeOf(uploadedFree, "delete-cloud"), "not-uploaded", "删云端后变未上传");
	assert.equal(outcomeOf(uploadedFree, "rename"), "unchanged", "改名不改变存储状态");

	return { cases: 19 };
}
