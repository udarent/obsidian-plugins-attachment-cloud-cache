import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalDecideSuite } from "./lib/external-decide-suite.mjs";

/**
 * 站外缓存判定的测试。
 *
 * 判定层现在**不依赖任何外部状态**（站点记忆已经拆掉），所以只把自己的模块进 bundle
 * 就够 —— `s3/client` 由 `render-target`（`urlPrefixes`）带进来，靠打包解析即可。
 */
await withLoadedTs(["src/render/external-decide"], (mod) => {
	runExternalDecideSuite(mod);
	console.log(
		"External-decide tests passed (every input lands in the right bucket: our own endpoint and public prefix are not " +
			"'external', host matching normalises case and keeps the port, loopback is refused whatever the default says, " +
			"LAN hosts still count as candidates, the default setting decides only 'now or later' and can never override " +
			"the safety or ownership checks, and an unconfigured plugin neither acts nor lists anything)."
	);
});
