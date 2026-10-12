import { withLoadedTs } from "./lib/load-ts.mjs";
import { runObjectKeySuite } from "./lib/object-key-suite.mjs";

/**
 * 对象 key 的测试。
 *
 * 为什么必须穷举：key 由**用户数据（文件名）**拼出来，然后变成桶里对象的身份。
 * 所以缺陷不只是"名字难看"：路径穿越会把越界段写进桶里，非 ASCII 处理不当会让链接 404，
 * 而**身份**那一侧出错更严重 —— 同名不同内容撞成同一个 key 会静默串内容。
 *
 * ⚠️ 1.2.0 起模板设置取消，形状固定成一种（`<名字>-<完整哈希>[.<扩展名>]`），
 * 所以这一层的用例从"穷举模板组合"换成"穷举身份与名字两侧的边界"。
 *
 * 断言在 `lib/object-key-suite.mjs`（与变异验证共用，避免两套断言漂移）。
 */
await withLoadedTs("src/object-key.ts", (mod) => {
	runObjectKeySuite(mod);
	console.log(
		"Object-key tests passed (one fixed shape — name plus the full content hash, so same content always " +
			"maps to the same key and different content never collides; an unusable hash is refused instead of " +
			"producing a key every file would share; the display name and the content hash are both parsed back " +
			"out of a key and read back to the same values they were built from; path traversal blocked, empty " +
			"segments collapsed, non-ASCII kept, over-long names truncated)."
	);
});
