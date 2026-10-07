import { withLoadedTs } from "./lib/load-ts.mjs";
import { runRotationSuite } from "./lib/rotation-suite.mjs";

/**
 * 后台自动轮换的编排测试。
 *
 * 依赖全部注入（列目录、扫笔记、执行淘汰、提示都是假的），
 * 所以这套**不碰磁盘、不碰网络** —— 它要验的是"什么时候去动文件"，而不是"怎么动"。
 */
await withLoadedTs(["src/maintenance/rotation", "src/maintenance/eviction", "src/cache-path"], async (mod) => {
	await runRotationSuite(mod);
	console.log(
		"Rotation tests passed (the quota check works from disk state on startup, a cheap threshold stops it before " +
			"listing anything or scanning notes, one round at a time so two rounds never delete the same files, " +
			"failures are throttled instead of retried on every event, the background job never throws at its caller, " +
			"and it only speaks when something was really deleted)."
	);
});
