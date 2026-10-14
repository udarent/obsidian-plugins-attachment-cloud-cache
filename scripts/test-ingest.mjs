import { withLoadedTs } from "./lib/load-ts.mjs";
import { runIngestSuite } from "./lib/ingest-suite.mjs";

/**
 * 上传编排的测试。
 *
 * 入口一次性把编排层与它依赖的模块打进**同一个** bundle ——
 * 分成两次 build 会让 `src/s3/errors.ts` 出现两份副本，
 * 于是 `error instanceof S3Error` 恒为 false（见 `lib/load-ts.mjs` 的说明）。
 *
 * 这一层要保证的性质全都只能端到端验证：字节一致、缓存真的落盘、
 * 恰好 1 次 PUT / 0 次 GET、失败时字节仍在。所以要真实磁盘 + 真实 HTTP。
 *
 * 断言在 `lib/ingest-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(
	[
		"src/core/ingest",
		"src/s3/client",
		"src/settings",
		"src/cache/index",
		"src/cache/store",
		"src/vault-files",
	],
	async (mod) => {
		const stats = await runIngestSuite(mod);
		console.log(
			`Ingest tests passed (${stats.scenarios} scenarios, real disk + real HTTP: ` +
				"byte-identical upload and a byte-identical local copy, exactly 1 PUT and 0 GETs, " +
				"the local file stays exactly where the user's attachment folder put it (no cache " +
				"folder is ever created), a repeat paste of the same image costs zero " +
				"requests, upload failure keeps the bytes in the attachment folder and registers " +
				"nothing, same-name files are never overwritten, the placement follows the " +
				"host's own attachment folder (including its `./` and `/` forms), migrating an " +
				"attachment that already lives in the " +
				"vault leaves no stray staging copy behind and does not move the user's file, " +
				"the upload ledger records every successful upload no matter whether a local copy " +
				"was kept (that is what keeps cloud cleanup working in the " +
				"'keep no local copy' setting), a name the host invents on a collision " +
				"(\"photo 1.png\") keys to the same object as \"photo.png\" when the bytes are " +
				"identical - so a second insert of the same image adds no second object and no " +
				"second address even on a device whose own index never recorded the first upload, " +
				"and when that object is in fact already up there the second insert sends **no " +
				"bytes at all** (it asks the cloud once instead of re-uploading) - " +
				"while files whose contents genuinely differ, or whose \" 1\" the user chose " +
				"themselves, are never merged, and a corrupt index degrades to empty instead of throwing)."
		);
	}
);
