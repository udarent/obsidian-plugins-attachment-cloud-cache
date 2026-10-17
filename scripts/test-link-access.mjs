import { withLoadedTs } from "./lib/load-ts.mjs";
import { runLinkAccessSuite } from "./lib/link-access-suite.mjs";

/**
 * 「公开读取 / 内部访问」判定的测试（`src/link-access.ts`）。
 *
 * 需要 `src/s3/client` 一起进 bundle：套件用 `publicUrlFor` 钉住那条**结构性承诺** ——
 * 笔记里的地址与访问方式无关（切换模式不改写任何一条链接）。
 *
 * 为什么这套断言值得单独存在：判错的两个方向都**不报错**，而且都发生在用户看不见的地方 ——
 * 走错方向要么给私有桶的用户一屏坏图，要么让每张图都白下载一遍。
 */
await withLoadedTs(["src/link-access", "src/s3/client"], async (mod) => {
	await runLinkAccessSuite(mod);
	console.log(
		"Link-access decisions passed (auto follows the probe — 2xx public, 401/403/404/network/unknown " +
			"all fall back to internal; explicit modes win over the probe; missing copies must be fetched " +
			"when access is internal unless no local copy is kept; the note URL is byte-identical across " +
			"modes and the probe uses that very URL; probing never throws and a timeout is marked)."
	);
});
