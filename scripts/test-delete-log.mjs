import { withLoadedTs } from "./lib/load-ts.mjs";
import { runDeleteLogSuite } from "./lib/delete-log-suite.mjs";

/**
 * 删除留痕的测试。
 *
 * 删云端对象**不可恢复**，而这条询问自 2026-10-11 起是**自动出现**的 ——
 * 「自动触发」+「不可恢复」+「不留痕迹」三件事叠在一起，是本产品风险最集中的一处。
 * 这一层只补最便宜的那一层：**事后查得到**（它**不是**回收站，日志里的对象恢复不了）。
 *
 * 这一套最要紧的一条不是"写对格式"，而是"**写失败不许抛错**"：
 * 留痕是加强项，删除是主流程，主流程不能被附属功能炸断。
 * 次要紧的是"**插件目录未知就别写**"：那种时候给兜底文件名，日志会落到 vault 根。
 *
 * 断言在 `lib/delete-log-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/maintenance/delete-log", async (mod) => {
	const stats = await runDeleteLogSuite(mod);
	console.log(
		`Delete-log tests passed (${stats.cases} cases: the log lives next to the cache index in the ` +
			"plugin folder - NOT in the cache folder, which the plugin promises you can delete wholesale, " +
			"and which would take the evidence with it; when the plugin folder is unknown the path is " +
			"refused outright instead of being defaulted, because a default name would drop a file into " +
			"the vault root; entries are one JSON object per line so a script can " +
			"read them back and a filename with commas or Chinese survives; a whole batch is appended in one " +
			"write, never one write per object; a 404 is recorded as 'already gone' rather than as a deletion; " +
			"unrecognisable input is dropped instead of writing a line nobody can read; and a write failure " +
			"is reported but NEVER thrown - an unremovable cloud object has just been confirmed by the user, " +
			"and a stuck log file must not turn that into a failure)."
	);
});
