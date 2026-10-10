import { withLoadedTs } from "./lib/load-ts.mjs";
import { runAttachWatchSuite } from "./lib/attach-watch-suite.mjs";

/**
 * 「新增附件自动接管」的测试。
 *
 * 这条入口挂在 `vault.on("create")` 上 —— 宿主把文件落进库的任何方式都会经过它
 * （手机工具栏回形针、相册、相机、分享菜单、桌面把文件拷进库）。原先上传只有
 * `editor-paste` / `editor-drop` 两个触发点，而宿主的回形针走的是
 * `app.saveAttachment` + `replaceSelection`，**两个事件都不发** ——
 * 于是"手机上添加图片附件不会自动上传"。
 *
 * 入口把判定与编排打进同一个 bundle：判定复用了 `maintenance/batch` 的候选规则，
 * 分成两次 build 会让它拿到另一份 `CacheIndex` / `vault-files`，行为可能与线上不一致。
 *
 * 断言在 `lib/attach-watch-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(
	[
		"src/maintenance/attach-watch",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/vault-files",
		"src/settings",
		"src/types",
	],
	async (mod) => {
		const stats = await runAttachWatchSuite(mod);
		console.log(
			`Attach watch tests passed (${stats.decision} decision cases + ${stats.ledger} ledger cases + ` +
				`${stats.scheduling} scheduling scenarios: a file that just landed in the vault is adopted only ` +
				"once some note references it — the host writes the link *after* creating the file, so an " +
				"unreferenced file is retried on a backoff instead of being written off, and only that one " +
				"reason is retryable (every other skip — auto-upload off, inside the cache folder, our own " +
				"staging file, note-like files, empty sync placeholders, already-indexed copies — is final). " +
				"Hits are batched so three files created together mean one upload run and one notice, a file " +
				"that disappeared is dropped, files reported during a flush are never swept up with the batch " +
				"that gave up, unload cancels the pending timer, and a failing reference lookup or upload " +
				"never throws out of the host's file event)."
		);
	}
);
