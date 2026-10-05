import { withLoadedTs } from "./lib/load-ts.mjs";
import { runObjectKeySuite } from "./lib/object-key-suite.mjs";

/**
 * 对象 key 模板的测试。
 *
 * 为什么必须穷举：key 由**用户数据（文件名）**拼出来，然后同时变成
 * 对象存储里的 key 与本地缓存文件的路径。所以缺陷不只是"名字难看"：
 * 路径穿越能把缓存写到 vault 之外，非 ASCII 处理不当会让链接 404，
 * key 里出现空段会让缓存目录结构崩塌。
 *
 * 断言在 `lib/object-key-suite.mjs`（与变异验证共用，避免两套断言漂移）。
 */
await withLoadedTs("src/object-key.ts", (mod) => {
	runObjectKeySuite(mod);
	console.log(
		"Object-key tests passed (template rendering, unknown tokens preserved, " +
			"path traversal blocked, empty segments collapsed, non-ASCII kept, over-long names truncated)."
	);
});
