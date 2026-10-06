import { runMutations } from "./lib/mutate.mjs";
import { runIngestSuite } from "./lib/ingest-suite.mjs";

/**
 * 变异验证：上传编排。
 *
 * ⚠️ 每条 `expect` 都是**实测下来真正先红的那条断言**，不是"应该会报那句"。
 * 因为套件的断言顺序决定了：更宽泛的断言会永久剥夺具体规则的发言权，
 * 而这一层同时有"纯函数判定"与"端到端行为"两类断言 ——
 * 顺序错了就会出现"每个变异都报同一句无关的话"，那样变异验证就退化成了摆设。
 *
 * 这里守的每一条都对应 SCOPE 里的一条 P0 验收标准，或者是**不可逆**的后果：
 * 丢用户的图、覆盖用户的文件。
 */
await runMutations({
	source: "src/core/ingest.ts",
	// 编排层的套件要同时用 `S3Client`：必须与 ingest 进**同一个** bundle，
	// 否则 `src/s3/errors.ts` 会有两份副本，跨模块的 `instanceof` 恒为 false。
	entries: ["src/core/ingest", "src/s3/client", "src/settings", "src/cache/index", "src/cache/store", "src/vault-files"],
	suite: runIngestSuite,
	mutations: [
		// ── 本地副本的处置策略（纯函数）──
		{
			name: "「移入回收站」被当成普通情况（用户明确不要本地副本却留下了一份）",
			from: '\tif (action === "trash") return "trash";\n',
			to: "",
			expect: "选回收站就是回收站",
		},
		{
			name: "「原地保留」被当成「移入缓存」（用户选了什么不再作数）",
			from: 'if (action === "cache" && cachePathUsable) return "move-to-cache";',
			to: 'if (action !== "trash" && cachePathUsable) return "move-to-cache";',
			expect: "原地保留就是原地保留",
		},
		{
			name: "忽略缓存路径是否可推导（拿到 null 路径还去搬，等于没有副本）",
			from: 'if (action === "cache" && cachePathUsable) return "move-to-cache";',
			to: 'if (action === "cache") return "move-to-cache";',
			expect: "缓存路径不可推导时原地保留",
		},
		// ⚠️ 这里原本还有一条"忽略缓存开关"的变异。它已随参数重设计一起删除：
		// `cacheEnabled` 与 `localFileAction` 合并成了单个 `localCopy`，
		// "开着缓存但选不留副本"这种矛盾状态在类型上已经不存在，
		// 于是那条变异没有可改的代码了 —— 留一个匹配不到的变异点比没有更糟。
		//
		// 我一度想补一条"三个取值结果不再互不相同"来填补它，但发现：
		// 那与"原地保留被当成移入缓存"是同一个缺陷，而套件里也不该有一条只被它触发的断言。
		// 所以没有补 —— 凑数出来的变异看着更绿，实际什么都没多守。

		// ── ⭐ 绝不丢图 ──
		{
			name: "上传失败时不再返回本地路径（用户粘贴的图就此消失）",
			from: 'return { status: "fallback", key, remoteUrl: "", localPath: stagedPath, etag: "", error: asError(error) };',
			to: 'return { status: "fallback", key, remoteUrl: "", localPath: "", etag: "", error: asError(error) };',
			expect: "否则用户粘贴的图就没了",
		},
		{
			name: "上传失败被当成成功（笔记会写进一个根本不存在的 URL）",
			from: 'return { status: "fallback", key, remoteUrl: "", localPath: stagedPath, etag: "", error: asError(error) };',
			to: 'return { status: "uploaded", key, remoteUrl: remoteUrlFor, localPath: stagedPath, etag: "", error: asError(error) };',
			expect: "上传失败应走降级",
		},
		{
			name: "降级副本被放进缓存目录（缓存被清理时用户就真的丢了）",
			from: "const desired = suggestAttachmentPath(deps, fileName, request.sourcePath);",
			to: "const desired = `${deps.settings.cacheFolder}/${fileName}`;",
			expect: "降级副本不应落在缓存目录里",
		},

		// ── ⭐ 绝不覆盖用户的文件 ──
		{
			name: "落盘时不再做唯一化（粘贴一张图就可能覆盖掉同名文件）",
			from: "const path = await uniqueVaultPath(desired, makeExists(app));",
			to: "const path = desired.replace(/\\\\/g, \"/\").replace(/^\\/+/, \"\");",
			expect: "目标已占用时必须另取名字",
		},

		// ── 复用 / 跳过上传 ──
		{
			name: "缓存命中不再复用（每次都重新 PUT 几十 MB）",
			from: "\tif (\n\t\tknown &&",
			to: "\tif (\n\t\tfalse &&",
			expect: "应复用，而不是重新上传",
		},
		{
			name: "复用时不检查本地副本是否还在（返回一个不存在的路径）",
			from: "\t\tconst present = await makeExists(deps.app)(known.cachePath);\n\t\tif (present) {",
			to: "\t\tif (true) {",
			expect: "不得直接复用并返回一个不存在的路径",
		},
		{
			name: "复用时不比对 URL（改了公开域名仍写旧地址）",
			from: "\t\tnormalizeUrl(known.remoteUrl) === normalizeUrl(remoteUrlFor)\n\t) {",
			to: "\t\ttrue\n\t) {",
			expect: "应使用新的公开地址",
		},

		// ── 索引登记 ──
		{
			name: "没有本地副本时仍登记索引（渲染会以为本地有文件）",
			from: "\tif (localPath) {\n\t\tindex.set(entry);",
			to: "\tif (true) {\n\t\tindex.set(entry);",
			expect: "不该登记索引",
		},
		{
			name: "索引落盘失败被静默吞掉（用户永远不知道缓存不被认识）",
			from: '\t\t\tdeps.notify?.(`缓存索引保存失败：${describe(error)}`);',
			to: "\t\t\tvoid error;",
			expect: "必须让用户知道",
		},

		// ── 命名与类型 ──
		{
			name: "扩展名全缺时不再兜底（产出以点结尾的 key，Windows 会丢掉那个点）",
			from: "return resolveExtension(name, mime) || FALLBACK_EXTENSION;",
			to: "return resolveExtension(name, mime);",
			expect: "key 不得以点结尾",
		},
		{
			name: "不再声明 Content-Type（浏览器里会变成下载而不是显示）",
			from: "const contentType = resolveContentType(request.name, request.mime);",
			to: 'const contentType = "application/octet-stream";',
			expect: "应声明 Content-Type",
		},
		{
			// 注意报错落在**基础用例**上而不是嵌套用例：一旦不建缓存目录，
			// 连平坦路径都搬不过去（真实文件系统的 rename 在父目录不存在时会失败），
			// 于是第一个"缓存路径应等于 key"的断言先红。如实记录这条映射关系。
			name: "搬进缓存前不再创建缓存目录（文件搬不过去，只能留在附件目录）",
			from: "\tawait ensureFolder(app, parentFolderOf(cachePath));",
			to: "\t// 变异：不建目录",
			expect: "默认布局是 mirror",
		},
	],
});
