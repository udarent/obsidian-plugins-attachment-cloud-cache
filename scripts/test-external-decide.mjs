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
			"'external', host matching normalises case and keeps the port, loopback is refused even when an allow list names it, " +
			"LAN hosts still count as cacheable, the site list only constrains the automatic path while the explicit tools " +
			"(picking / batch) always pass through, an unconfigured plugin neither acts nor lists anything, and the " +
			"shape gates stay a 'does it look like a file' question (installers and disk images are the one exception: " +
			"a narrow blacklist for program distribution, so a note's 84 MB setup.exe link is never offered, while " +
			"types we simply do not know — .psd, .dwg, .bin — still are)."
	);
});
