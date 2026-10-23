import { withLoadedTs } from "./lib/load-ts.mjs";
import { runVaultFilesSuite } from "./lib/vault-files-suite.mjs";

/**
 * vault 文件命名助手的测试。
 *
 * 这些函数决定"文件叫什么、写哪里"，而且**两条写入路径共用它们**
 * （粘贴时落盘、回退下载时补齐副本）。所以它们出错的后果不是"名字难看"：
 * 扩展名推错会让截图粘贴整类漏掉；唯一化失效会**覆盖用户的文件**；
 * 扩展名兜底失效会产出以点结尾的文件名（Windows 会静默丢掉那个点）。
 *
 * 断言在 `lib/vault-files-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/vault-files", async (mod) => {
	const stats = await runVaultFilesSuite(mod);
	console.log(
		`Vault-file tests passed (${stats.extensionCases} extension/type cases + ${stats.placementCases} attachment-placement cases + ${stats.duplicateNameCases} duplicate-name cases: the landing folder follows the host's own attachment setting, then the vault root — and the host's "./" means "next to the note", not a folder literally named "."; extension from name ` +
			"first and MIME second so both screenshot pastes and downloader drags work, a leading dot " +
			"is not an extension, and an extension has to *look* like one — the token a CDN leaves " +
			"after the last dot in a URL is not a type, so it falls back to the MIME (otherwise the " +
			"cached copy is named after the token and Obsidian does not even show unknown extensions); " +
			"Content-Type derived and defaulted for every common attachment kind (pdf/audio/video/archives/docs, plus the " +
			"macro/template Office variants, ODF, ebooks, fonts, CAD/3D, subtitles and source code) so public links preview " +
			"instead of force-downloading — with source code deliberately declared as plain text rather than as an " +
			"executable type, and the genuinely ambiguous or unregistered suffixes (ts/bin/z01/fbx/wps…) deliberately " +
			"left on the generic binary default, with the embeddable table pinned row by row (tiff/heic/ico are deliberately not embeddable in the host, so they degrade to plain links); and \"is this suffix a page or a file\" answered in one place — static pages (html/htm/xhtml/shtml) " +
			"and server-side page programs (php/asp/jsp/do/action/cgi/cfm) are pages, while real file " +
			"suffixes are not — including ones our type table does not know (exe/iso) and script *files* " +
			"(py/rb/pl), because the question is \"does this point at a page\", not \"do we recognise this " +
			"suffix\"; and \"does this address look like a file\" answered by two shape questions — the tail " +
			"must contain a dot, and that suffix must *look* like a file type (a repo branch such as " +
			"5.1-translation_terms or a version such as v1.2.3 is refused there) — while both stay silent for " +
			"an address the note is merely *pointing at* rather than displaying, and neither is ever a " +
			"whitelist (exe/iso are real files we simply do not know); parentFolderOf normalises " +
			"separators; uniqueVaultPath never overwrites — it consults both the host index and the " +
			"real disk, is capped, and fails loudly rather than looping or clobbering; and the host's " +
			"own duplicate-name convention (\"name 1.ext\") parses back to \"name.ext\" — and only that " +
			"one shape, so a file the user really named \"-1\" is never rewritten)."
	);
});
