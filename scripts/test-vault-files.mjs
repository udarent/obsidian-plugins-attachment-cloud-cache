import { withLoadedTs } from "./lib/load-ts.mjs";
import { runVaultFilesSuite } from "./lib/vault-files-suite.mjs";

/**
 * vault 文件命名助手的测试。
 *
 * 这些函数决定"文件叫什么、写哪里"，而且**两条写入路径共用它们**
 * （粘贴时先落盘、批量迁移时改笔记）。所以它们出错的后果不是"名字难看"：
 * 扩展名推错会让截图粘贴整类漏掉；唯一化失效会**覆盖用户的文件**；
 * 扩展名兜底失效会产出以点结尾的文件名（Windows 会静默丢掉那个点）。
 *
 * 断言在 `lib/vault-files-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/vault-files", async (mod) => {
	const stats = await runVaultFilesSuite(mod);
	console.log(
		`Vault-file tests passed (${stats.extensionCases} extension/type cases: extension from name ` +
			"first and MIME second so both screenshot pastes and downloader drags work, a leading dot " +
			"is not an extension, Content-Type derived and defaulted; parentFolderOf normalises " +
			"separators; uniqueVaultPath never overwrites — it consults both the host index and the " +
			"real disk, is capped, and fails loudly rather than looping or clobbering)."
	);
});
