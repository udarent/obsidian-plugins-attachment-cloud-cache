import { withLoadedTs } from "./lib/load-ts.mjs";
import { runProbeSampleSuite } from "./lib/probe-sample-suite.mjs";

/**
 * 「测试连接第二步该拿哪条对象去试」的测试（`src/probe-sample.ts`）。
 *
 * 需要 `src/s3/client` 一起进 bundle：套件用 `publicUrlFor` 钉住那条前提 ——
 * 探针 key 必须能拼成一条**合法地址**，否则这一步会直接抛配置错、界面只剩一句
 * 含糊的"测不了"。
 *
 * 为什么值得单独一套：这一层决定的是"**测不测得成**"（空库、换设备、没有列举权限），
 * 而不是"测得准不准"；它出错的形态全是静默的 —— 多一次白请求、永远测不了、
 * 或者往用户的桶里放一条他不认识的对象。
 */
await withLoadedTs(["src/probe-sample", "src/s3/client"], async (mod) => {
	await runProbeSampleSuite(mod);
	console.log(
		"Probe-sample tests passed (index first and never lists the bucket when it hits; empty keys are not " +
			"used; the first object in the bucket is used when the index is empty; a failed listing falls back " +
			"instead of breaking the test; the temporary probe is refused unless explicitly allowed; it is " +
			"always deleted — even when measuring throws — and a leftover is reported instead of hidden; a " +
			"failed upload means no probe happens at all)."
	);
});
