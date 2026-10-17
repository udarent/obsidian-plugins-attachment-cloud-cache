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
		// 这条只钉"编排层确实用了那个共用函数"；解析内部的规则（跟随宿主 / `./` = 与笔记
		// 同目录 / `/` = 没指定）由 `mutate-vault-files.mjs` 在同名套件上逐条钉住。
		{
			name: "★ 上传落点不再走共用解析（自建一套 ⇒ 与下载那条路分叉）",
			from: "\tconst folder = hostAttachmentFolder(deps.app, sourcePath);\n\treturn folder ? `${folder}/${fileName}` : fileName;",
			to: "\treturn fileName;",
			expect: "应跟随宿主的附件设置",
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
		// ── ⭐ 跨名复用：内容哈希才是对象身份（用户 2026-10-14 在 Android 上报的缺陷）──
		//
		// 少了"按哈希找回孪生 key"这一步，重复插入同一张图就会在桶里多存一份
		// 完全相同的内容，而笔记里两处引用指着两个不同对象 —— 那正是用户看到的
		// "不去重"。注意它保护的是**跨名**那一路：同内容同名由第 2 步的索引复用
		// 兜着（那条已有锚点之外还有 3. 那条用例钉住）。
		{
			name: "★ 跨名复用失效（重复插入同一张图 ⇒ 桶里多一份、引用指向两个对象）",
			from: "\t\t? (index.uploadedKeys().find((candidate) => candidate !== key && hashFromKey(candidate) === contentHash) ?? null)",
			to: "\t\t? null",
			expect: "复用已有对象，不再另存一份",
		},

		// ── ⭐⭐ 宿主撞名另落的那一份：用**主干名字**算 key ──
		//
		// 这是"跨名复用"那一条的**替代路**（也是真机上真正管用的那一条）：
		// 上面那条靠本机上传台账，台账一丢就答不上来；这里靠的是 vault 里的事实
		// （同目录下有个同内容的兄弟文件），所以换设备、索引被覆盖都照样成立。
		{
			// 后果：`photo 1.png` 照原名进 key ⇒ 与 `photo.png` 是两个对象、两个地址。
			// 用户 2026-10-14 在 Android 上看到的就是这个（"地址里文件名也加了 1"）。
			//
			// ⚠️ 锚点打的是**归一函数里那句返回**，不是调用点：改调用点会让 `normalized`
			// 变成 undefined ⇒ 整个上传退化成 fallback，那时红的是一条与"序号没剥掉"
			// 无关的断言（报出来的原因会指向错误的地方 —— 锚点要选"会造成那个后果"的那一行）。
			name: "★ 宿主撞名的序号没被剥掉（同一份内容在云端存两份、笔记里多一个地址）",
			from: "\t\treturn { keyName: original, twinPath: sibling };",
			to: "\t\treturn { keyName: fileName, twinPath: sibling };",
			expect: "要用主干名字算 key",
		},
		{
			// 后果：**只按名字形状**就归一，内容不看了 ⇒ 同目录下两个内容不同的文件
			// （`photo.png` 与 `photo 1.png`）被并到同一个 key 上 —— 那是覆盖，不可逆。
			name: "★★ 撞名归一不再比内容（两份**不同**的东西被并到一个对象上）",
			from: "\t\tif (siblingHash !== contentHash) return { keyName: fileName, twinPath: null };",
			to: "\t\tif (false) return { keyName: fileName, twinPath: null };",
			expect: "不能并到一个对象上",
		},

		// ── ⭐⭐ 上传前先问云端"这个对象在不在"（用户 2026-10-14 报的第二件事）──
		//
		// 现场：重复插同一张图时**整份字节又传了一遍**，而它的成因是"判断云端有没有"
		// 只能靠本机台账（换设备 / 索引被覆盖就答不上来）。这三条各守一个方向：
		// 不问 / 问到了却当成没有 / 什么都不做却报"上传成功"。
		{
			// 后果：只要有对象就重传整份字节（用户明确说过"并不需要上传，只要更新链接"）。
			name: "★ 撞名副本不再问云端（云端已有也照传一遍字节）",
			from: "\tif (!reuseCloudObject && twinPath) {",
			to: "\tif (false) {",
			expect: "一个字节都不许重传",
		},
		{
			// 后果：把"答不上来"当成"在" ⇒ **跳过上传**。
			// 这一条是**危险**的那一侧：对象其实不在云端时，笔记里会留下一个打不开的图。
			name: "★★ 探测答不上来也当成'在'（跳过上传 ⇒ 笔记里出现打不开的图）",
			// ⚠️ 锚点必须带上下文：同一个判断在"重复副本"与"批量预检"两处各有一行，
			// 只写那一行会被运行器判成不唯一（会静默改到另一处）。
			from:
				"\tif (!reuseCloudObject && twinPath) {\n\t\tconst probedEtag = await askCloud();",
			to:
				"\tif (!reuseCloudObject && twinPath) {\n\t\tconst probedEtag = await askCloud() ?? \"forced-etag\";",
			expect: "必须传一次",
		},
		{
			// 后果：复用被写死成"上传" ⇒ 提示说"上传成功"而实际一个字节都没发
			//（用户 2026-10-14 在 Android 上看到的就是这句话）。
			name: "★ 复用被报成'上传'（用户看到的提示与事实相反）",
			from: '\t\tstatus: reuseCloudObject ? "reused" : "uploaded",',
			to: '\t\tstatus: "uploaded",',
			expect: "必须是 reused",
		},
		{
			// 后果：探测**抛错**（离线 / 服务端错）时不再兜底 ⇒ 异常直接冒到上传链外面，
			// 而"问不动"本该稳稳落回"照常上传"那一侧。
			name: "★ 探测抛错时不再兜底（问不动 = 上传链整体崩掉）",
			from:
				'\t\t} catch {\n\t\t\t// 问不动 ⇒ 当作"不在"（多一次 PUT 是幂等的；反过来会留下打不开的图）\n\t\t\treturn null;\n\t\t}',
			to: "\t\t} catch {\n\t\t\treuseCloudObject = true;\n\t\t}",
			expect: "问不动（抛错）⇒ 当作",
		},
		{
			// 后果：链接里该显示的名字沿用**宿主给的文件名** ⇒ 宿主撞名另落的那一份
			// （`photo 1.png`）会把序号留在链接文字里，而地址里是主干名字
			//（`photo-<哈希>.png`）—— 用户 2026-10-14 报的第五件事：
			// 同一个链接里两个名字不一样，而那个「 1」根本不是他的东西。
			name: "★ 显示名不用主干名字（链接文字里留着宿主的「 1」）",
			from: "\t\tname: fileName,\n\t\tdisplayName: displayFor(key),\n\t\tremoteUrl,",
			to: "\t\tname: fileName,\n\t\tdisplayName: fileName,\n\t\tremoteUrl,",
			expect: "★ 链接里该显示的名字要与**链接目标**逐字一致（不能用宿主的序号名）",
		},
		{
			// 后果：**批量那一条退回"每件都整份重传"** —— 换设备/重装后明明云端已有，
			// 却把整批字节又走一遍（用户等得更久，也不省钱）。
			name: "★★ 批量上传不做云端预检（已有对象重新传一遍）",
			from: "if (!reuseCloudObject && request.preflight && !index.get(key)) {",
			to: "if (false) {",
			expect: "云端已有 ⇒ 直接复用（不许再传一遍）",
		},
	],
});
