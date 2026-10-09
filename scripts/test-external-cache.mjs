import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalCacheSuite } from "./lib/external-cache-suite.mjs";

/**
 * 站外图搬进自己存储的测试。
 *
 * 需要把 `S3Client` 与 `CacheIndex` 一起进 bundle：套件要自己造客户端、
 * 自己读索引（跨模块的 `instanceof` 必须落在同一份副本上）。
 */
await withLoadedTs(
	["src/core/external-cache", "src/s3/client", "src/cache/index"],
	async (mod) => {
		await runExternalCacheSuite(mod);
		console.log(
			"External-cache tests passed (real HTTP + real disk + real S3 stand-in: with consent off not a single request " +
				"is sent and the note is left untouched, the bytes land on disk identically, a web page or plain-text body is refused while audio/video/pdf/archives are accepted (the deliberate limit is 'never move a web page'), a 403 is read as hotlink " +
				"protection rather than success, the third-party link is rewritten, a download failure never uploads, " +
				"loopback hosts are never fetched, and every refusal is reported instead of passing silently)."
		);
	}
);
