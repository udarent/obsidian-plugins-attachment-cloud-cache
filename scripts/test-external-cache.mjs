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
	runExternalCacheSuite
);
