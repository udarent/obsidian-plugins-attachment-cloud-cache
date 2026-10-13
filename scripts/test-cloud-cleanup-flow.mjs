import { withLoadedTs } from "./lib/load-ts.mjs";
import { runCloudCleanupFlowSuite } from "./lib/cloud-cleanup-flow-suite.mjs";

/**
 * 「清理云端未使用对象」（入口 B）**编排层**的测试。
 *
 * 这段流程会不可恢复地删云端对象，而它此前是 `main.ts` 的私有方法 ——
 * 套件加载不了插件类，于是整条编排零覆盖。2026-10-13 的 A1 重构把它搬到
 * `src/plugin/cloud-cleanup-flow.ts` 之后才可测。
 *
 * ⚠️ 同时打包 `src/s3/client` 与 `src/i18n`：前者给 `publicUrlFor`（造"笔记里
 * 真实的链接"，而不是自己拼一个字符串），后者给真实的 `translate`
 * （断言里对文案的期待直接来自 en 表，不另抄一份）。
 *
 * 断言在 `lib/cloud-cleanup-flow-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/plugin/cloud-cleanup-flow", "src/i18n", "src/s3/client"], async (mod) => {
	const stats = await runCloudCleanupFlowSuite(mod);
	console.log(
		`Cloud-cleanup flow tests passed (${stats.cases} cases: an unreadable note or canvas cancels the ` +
			"whole cleanup and deletes nothing — the shared judgement that used to exist on only one of the two " +
			"paths calling cloudReferencedKeys; an unconfigured client and a failed listing both say so out loud; " +
			"objects still referenced from a note, from a canvas, or held as an off-site cache never become " +
			"candidates while the rest do; an empty list and a truncated one report differently; the confirmation " +
			"carries the size, the multi-device blind spot, the irreversibility and the incompleteness; cancelling " +
			"deletes nothing and writes no log; and a confirmed run deletes the whole batch and leaves one " +
			"`scope: command` line per object.)"
	);
});
