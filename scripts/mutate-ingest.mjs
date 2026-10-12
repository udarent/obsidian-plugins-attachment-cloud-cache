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
 * 这里守的每一条都对应一条 P0 验收标准，或者是**不可逆**的后果：
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
		//
		// ⚠️ 1.2.0（D-17）：结果集从三个变成两个 —— `move-to-cache` 随缓存目录一起消失，
		// 老设置的 `"cache"` 与 keep 同义。所以这里守的是"回收站"与"原地保留"两条，
		// 各配一个方向的变异（漏判 + 误判）。
		{
			name: "「移入回收站」被当成普通情况（用户明确不要本地副本却留下了一份）",
			from: '\treturn action === "trash" ? "trash" : "keep-in-place";',
			to: '\treturn "keep-in-place";',
			expect: "选回收站就是回收站",
		},
		{
			name: "「原地保留」被当成「回收站」（用户的图全被丢进回收站）",
			from: '\treturn action === "trash" ? "trash" : "keep-in-place";',
			to: '\treturn "trash";',
			expect: "原地保留就是原地保留",
		},
		// ── 命名与类型 ──
		{
			// ⚠️ 1.2.0 起可见的后果**变了**：key 形状固定成 `<名字>-<哈希>[.<扩展名>]`，
			// 不再有"扩展名段为空 ⇒ key 以点结尾"那种形态 —— 扩展名没了就是没接上去。
			// 现在红的是"类型信息整个丢掉"（key 与**落盘名**都没有类型 ⇒
			// Obsidian 按名字判断怎么显示 ⇒ 用户看不到图）。
			name: "扩展名全缺时不再兜底（key 与落盘名都丢掉类型信息）",
			from: "return resolveExtension(name, mime) || FALLBACK_EXTENSION;",
			to: "return resolveExtension(name, mime);",
			expect: "未知类型应兜底成 .bin",
		},
		{
			name: "不再声明 Content-Type（浏览器里会变成下载而不是显示）",
			from: "const contentType = resolveContentType(request.name, request.mime);",
			to: 'const contentType = "application/octet-stream";',
			expect: "应声明 Content-Type",
		},
		// ── ⭐ 落点必须走**共用**的解析（1.2.0 起实现在 `vault-files.ts`）──
		//
		// 这条只钉"编排层确实用了那个共用函数"；解析内部的规则（覆盖优先 / 跟随宿主 /
		// `./` = 与笔记同目录）由 `mutate-vault-files.mjs` 在同名套件上逐条钉住。
		{
			name: "★ 上传落点不再走共用解析（自建一套 ⇒ 与下载那条路分叉）",
			from: "\tconst folder = attachmentFolderFor(deps.app, deps.settings.attachmentFolder, sourcePath);\n\treturn folder ? `${folder}/${fileName}` : fileName;",
			to: "\treturn fileName;",
			expect: "⭐ 填了覆盖就应落在覆盖目录里",
		},

		// ── ⭐ 迁移已有附件：字节已在库里，别动那个文件 ──
		{
			name: "迁移已有附件时仍然先落盘（附件目录里凭空多出一个中转副本）",
			from: '\tconst isMigration = existingPath !== "";',
			to: "\tconst isMigration = false;",
			// 期望落在"不得在附件目录里写/留中转副本"这一族断言上（套件里共两条，
			// 分别守"写盘动作"与"最终残留"）；两条都以这几个字开头。
			expect: "不得在附件目录里",
		},
		// ── ⭐ 上传台账：上传成功就记，**不分档位** ──
		{
			// 后果：只有"有本地副本"的那两档进台账，「不留副本」那一档不进 ⇒
			// 云端清理的自动入口在该档对**所有**对象答"不是我们的" ⇒ 那个询问
			// 在该档一次都不出现。而这一档正是"只当图床用"的人（云端只增不减、
			// 最需要回收空间）—— 一个功能在某个档位**静默永不触发**，最难被发现。
			// （2026-10-11 查出的 N11；与 P8「默认档下永不出现」是同一形状。）
			name: "★★ 不留副本这一档不记上传台账（该档的云端清理入口永不出现）",
			from: "\tlet dirty = index.markUploaded(key);",
			to: "\tlet dirty = false;",
			expect: "不留副本这一档也要记台账",
		},
	],
});
