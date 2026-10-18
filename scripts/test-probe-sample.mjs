import { withLoadedTs } from "./lib/load-ts.mjs";
import { runProbeSampleSuite } from "./lib/probe-sample-suite.mjs";

/**
 * 「测试连接」探针回路（`src/probe-sample.ts`）的测试。
 *
 * 需要 `src/s3/client` 一起进 bundle：套件用 `publicUrlFor` 钉住那条前提 ——
 * 探针 key 必须能拼成一条**合法地址**，否则这一步会直接抛配置错、界面只剩一句含糊的"测不了"。
 *
 * 为什么值得单独一套：回路坏掉的形态**都不报错** —— 忘了真的写就去测（结论是假的）、
 * 测量失败不清理（垃圾留在用户桶里）、删不掉却报已删（用户永远不知道）、
 * 探针内容为空（0 == 0 的比对永远通过）。
 */
await withLoadedTs(["src/probe-sample", "src/s3/client"], async (mod) => {
	await runProbeSampleSuite(mod);
	console.log(
		"Probe-sample tests passed (the round trip is write then measure then delete, in that order; a " +
			"measurement that throws still deletes the object; a delete that fails is reported instead of " +
			"hidden, while a missing object counts as clean; a failed write means the probe never runs and " +
			"nothing is deleted; concurrent clicks share one run (two runs would delete each other's probe " +
			"object and report a false 404) while the handle is cleared afterwards so the next click really " +
			"runs again; the probe key builds a legal address and the body is non-empty, so 'read back " +
			"identical' actually compares something)."
	);
});
