/**
 * vault 文件命名助手的断言套件（正式测试与变异验证共用）。
 *
 * ## 为什么这些"小函数"值得一整套断言
 *
 * 它们决定**文件叫什么、写哪里**，而两条写入路径（粘贴落盘、批量迁移）
 * 都用它们。所以：
 * - 「扩展名怎么推」错了 → 截图粘贴批量漏掉（只有 MIME 没有文件名是常态）；
 * - 「重名怎么办」错了 → **覆盖用户的文件**（本项目唯一不可逆的损失）；
 * - 「扩展名兜底」错了 → 产出以点结尾的文件名，而 **Windows 会静默丢掉那个点**，
 *   于是同一个 key 在不同平台上指向不同文件。
 *
 * 三处都不会报错，只会"行为不对"。所以必须穷举，而不是挑几个例子。
 */

import assert from "node:assert/strict";

/** 假的宿主：`getConfig("attachmentFolderPath")` 返回给定的值（真机实测它存在且可用）。 */
function hostApp(configured) {
	return { vault: { getConfig: () => configured } };
}

const app = hostApp("attachments");
const sameFolderApp = hostApp("./");

export async function runVaultFilesSuite(mod) {
	const {
		cleanFolderPath,
		contentTypeForExtension,
		DEFAULT_CONTENT_TYPE,
		embedKindFor,
		extensionFromMime,
		extensionFromUrl,
		extensionOfName,
		fallbackFileName,
		hostAttachmentFolder,
		isEmbeddable,
		isNoteLikeExtension,
		isWebPageExtension,
		looksLikeFileName,
		NOTE_LIKE_REASON,
		parentFolderOf,
		resolveContentType,
		resolveExtension,
		uniqueVaultPath,
		normalizeVaultPath,
		baseNameForDuplicate,
		urlHasFileTypeSuffix,
		urlLooksLikeFileName,
	} = mod;

	// ============================================================
	// 1. 从文件名取扩展名
	// ============================================================
	assert.equal(extensionOfName("photo.png"), "png");
	assert.equal(extensionOfName("photo.PNG"), "png", "扩展名应统一小写（大小写不同会被当成不同类型）");
	assert.equal(extensionOfName("a.b.c.jpeg"), "jpeg", "应取**最后**一个点之后的部分");
	assert.equal(extensionOfName("dir/sub/x.webp"), "webp", "带目录的路径也要能取到");
	assert.equal(extensionOfName("dir\\sub\\x.webp"), "webp", "反斜杠分隔同样要认（从剪贴板来的路径常是 Windows 风格）");
	assert.equal(extensionOfName("noext"), "", "没有点就没有扩展名");
	assert.equal(extensionOfName("trailing."), "", "点结尾等于没有扩展名（不是空字符串扩展名）");
	assert.equal(extensionOfName(".gitignore"), "", "⭐ 前导点是隐藏文件而不是扩展名");
	assert.equal(extensionOfName(".env.local"), "local", "隐藏文件也按最后一个点算");
	assert.equal(extensionOfName(""), "");
	assert.equal(extensionOfName("   "), "");
	assert.equal(extensionOfName(null), "", "非字符串不应抛错");
	assert.equal(extensionOfName(42), "", "非字符串不应抛错");

	// ⭐ `extensionFromUrl`：从**地址**取扩展名 —— 与文件名那条共用同一个形状判据，
	// 差别只有"先切掉查询串与锚点"。2026-10-16 从 `core/external-cache.ts` 挪来这里
	// （站外判定层 `decideExternalCache` 也要用它，而那边不能反向 import external-cache），
	// 断言跟着搬 —— 于是"扩展名怎么取"全库仍只有一处定义、一处穷举。
	assert.equal(extensionFromUrl("https://x.com/a.png?v=1#f"), "png", "★ 扩展名要切掉查询串与锚点");
	assert.equal(extensionFromUrl("https://x.com/a.PNG"), "png", "大小写归一");
	assert.equal(extensionFromUrl("https://x.com/a"), "", "没有扩展名");
	assert.equal(extensionFromUrl(null), "", "非字符串");

	// ⭐⭐ `urlLooksLikeFileName` / `looksLikeFileName`：**"尾巴像不像文件名"** ——
	// 只要求末尾那一段里有点，**不要求后缀可信**。它与上面那条的差别是刻意的：
	// 上面那条决定落盘的文件名与 Content-Type（所以要过形状检查、会退到 MIME），
	// 这一条只回答"这条地址看起来是不是一个文件"（站外候选的形状判据）。
	assert.equal(urlLooksLikeFileName("https://x.com/a.png?v=1#f"), true, "★ 后缀在查询串之前");
	assert.equal(urlLooksLikeFileName("https://x.com/page"), false, "★ 没有点的尾巴是页面/目录的形状");
	assert.equal(urlLooksLikeFileName("https://x.com/download/"), false, "只有结尾斜杠");
	assert.equal(urlLooksLikeFileName("https://x.com/2024.10/notes"), false, "★ 点在前面的目录里不算");
	// ⚠️ **后缀不可信 ≠ 不是文件**：令牌形状（Bing CDN 那种）末尾带点，它就是个文件。
	assert.equal(
		urlLooksLikeFileName("https://x.com/th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208"),
		true,
		"★★ 后缀是令牌也算文件（不能被「后缀得可信」误伤）"
	);
	assert.equal(looksLikeFileName(".gitignore"), false, "★ 开头的点不算后缀（与 extensionOfName 同一条）");
	assert.equal(looksLikeFileName("a.b"), true, "带点的名字");
	assert.equal(urlLooksLikeFileName(null), false, "非字符串不抛错");
	assert.equal(looksLikeFileName(undefined), false, "非字符串不抛错");

	// ⭐⭐ 宿主自己的文本文件（笔记 / 画布 / 数据库）**不是附件** ——
	// 两个入口（库内候选 `selectUploadCandidates` / 站外判定 `decideExternalCache`）
	// 共用这一份判据，所以穷举也放在这里。
	assert.equal(isNoteLikeExtension("md"), true, "★ 笔记（.md）要认出来");
	assert.equal(isNoteLikeExtension("canvas"), true, "画布");
	assert.equal(isNoteLikeExtension("base"), true, "数据库");
	assert.equal(isNoteLikeExtension(".MD"), true, "⭐ 调用方可能带着点、也可能大写");
	assert.equal(isNoteLikeExtension("  Canvas  "), true, "空白要能容忍");
	assert.equal(isNoteLikeExtension("markdown"), false, "⚠️ 只有这三种（宿主不把 .markdown 当笔记）");
	assert.equal(isNoteLikeExtension("mdx"), false, "⚠️ 不许前缀式放行");
	assert.equal(isNoteLikeExtension("png"), false, "图片不是笔记");
	assert.equal(isNoteLikeExtension(""), false);
	assert.equal(isNoteLikeExtension(undefined), false, "非字符串不应抛错");
	assert.equal(
		NOTE_LIKE_REASON,
		"是笔记/画布/数据库文件，不是附件",
		"★ 判据的文案只有一份（两个调用点共用，别让它漂成两种说法）"
	);

	// ⭐⭐ "最后一个点之后的东西"不一定是扩展名。
	//
	// 外站图片的 URL 经常长这样（Bing 的图片 CDN 就是）：最后一段自己带一个点，
	// 点后面是一串**令牌**而不是类型。按"取最后一个点之后的部分"算出来的"扩展名"
	// 会是 23~32 个字符的乱码，于是：
	//   ① 上传对象的名字变成 `<哈希>.spb8lvtxu-zleqgemugctwaaaa`；
	//   ② 缓存目录里的本地副本也是这个名字 —— 而 **Obsidian 默认不显示它不认识的扩展名**，
	//      用户在缓存目录里就"看不到这张图被缓存了"（实测报过这一条）。
	// ⇒ 判据：扩展名必须**长得像扩展名**（字母数字、够短），否则一律当"取不到"，
	//   让 `resolveExtension` 退到 MIME —— 那才是这一类图片唯一可靠的类型来源。
	const TOKEN_AFTER_DOT = "OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA";
	assert.equal(
		extensionOfName(TOKEN_AFTER_DOT),
		"",
		"★ 点后面是长令牌（含连字符、23 字符）时，不算扩展名 —— 否则拼出的文件名没人认得出来"
	);
	assert.equal(
		extensionOfName("R-C.fee004adf34307a501723fa65fed9d64"),
		"",
		"★ 同上：32 个字符的十六进制串也不是扩展名"
	);
	assert.equal(
		extensionOfName("photo." + "a".repeat(40)),
		"",
		"★ 超长一律不算（真实扩展名没有这么长的）"
	);
	assert.equal(
		extensionOfName("x.7z"),
		"7z",
		"（数字开头的**真实**扩展名要保住：它是短且纯字母数字的）"
	);
	assert.equal(extensionOfName("board.canvas"), "canvas", "（最长的真实扩展名之一：canvas）");
	assert.equal(extensionOfName("a.jpeg"), "jpeg");
	// ⭐ 这一条是**给"前导点"那条变异用的**：`.gitignore` 的尾巴有 9 个字符，
	// 会被上面的长度检查顺手挡掉 —— 于是那个变异看起来"测试无牙"。
	// 用一个短名字（`env`，3 个字符，能通过形状检查）才真的测得着。
	assert.equal(
		extensionOfName(".env"),
		"",
		"⭐ 前导点是隐藏文件而不是扩展名（短名字也要挡住 —— 长名字会被长度检查顺手挡掉，测不出这一条）"
	);

	// ⭐⭐ `urlHasFileTypeSuffix`：**"那个后缀像不像文件类型"** —— 站外候选的**第二道**形状判据
	//（第一道是上面那条"尾巴得有点"）。两道合起来才拦得住用户 2026-10-16 报的那一串：
	// 尾巴有点、可后缀取不出来（分支名）或是纯数字（版本号）。
	//
	// ⚠️ 位置刻意在**"扩展名必须长得像扩展名"那一组之后**：这条判据**依赖**它
	//（`extensionFromUrl` 取不出后缀时这里必须答 false）—— 断言顺序反过来的话，
	// "形状检查被去掉"那个既有变异的**最先失败**会挪到这一组来，把它的锚点带偏
	//（2026-10-16 当场踩到：报「期望含『长令牌』、实际『后缀不像文件类型』」）。
	for (const src of [
		// 分支名 / 版本号：点后面取不出扩展名（含 `-`）或纯数字
		"https://github.com/maxrossello/redmine_translation_terms/tree/5.1-translation_terms",
		"https://x.com/tree/v1.2.3",
		"https://x.com/releases/1.0",
		"https://x.com/page", // 没有点（第一道判据负责，这里也答 false）
		"https://x.com/download/",
		"https://x.com/2024.10/notes",
	]) {
		assert.equal(urlHasFileTypeSuffix(src), false, `★ 后缀不像文件类型（分支名 / 版本号 / 无后缀）：${src}`);
	}
	for (const src of [
		"https://x.com/report.pdf",
		"https://x.com/tools/installer.exe",
		"https://x.com/os/ubuntu.iso",
		"https://x.com/backup.7z",
		"https://x.com/2024.10/photo.jpg",
		"https://x.com/a.b",
		"https://x.com/some/file.PDF?v=1#f",
	]) {
		assert.equal(
			urlHasFileTypeSuffix(src),
			true,
			`★★ 真实文件类型后缀要放行（**不按「我们认不认识」判**）：${src}`
		);
	}
	assert.equal(urlHasFileTypeSuffix(null), false, "非字符串不抛错");

	// ============================================================
	// 2. 从 MIME 推扩展名
	// ============================================================
	assert.equal(extensionFromMime("image/png"), "png");
	assert.equal(extensionFromMime("image/jpeg"), "jpg", "image/jpeg 推 jpg（与常见附件命名一致）");
	assert.equal(extensionFromMime("IMAGE/PNG"), "png", "MIME 大小写不敏感");
	assert.equal(extensionFromMime("image/png; charset=binary"), "png", "应忽略 MIME 的参数部分");
	assert.equal(extensionFromMime("  image/webp  "), "webp", "应容忍首尾空白");
	assert.equal(extensionFromMime("image/svg+xml"), "svg", "带 +xml 的 MIME 也能推");
	assert.equal(extensionFromMime("image/heif"), "heic", "heif 归一到 heic（同一个格式的不同写法）");
	// ⭐ 1.1.0 起 MIME 表补齐到**所有常见附件类型**（不再只管图片）：
	// 站外抓取时常常只有 MIME、没有文件名，推不出扩展名就会存成 `<哈希>.bin`，
	// 而 Obsidian 不显示它不认识的类型 —— 用户在缓存目录里"看不到这个文件被缓存了"。
	assert.equal(extensionFromMime("application/pdf"), "pdf", "PDF 要能反推（浏览器可直接预览它）");
	assert.equal(extensionFromMime("audio/mpeg"), "mp3", "音频要能反推");
	assert.equal(extensionFromMime("video/mp4"), "mp4", "视频要能反推");
	assert.equal(extensionFromMime("application/zip"), "zip", "压缩包要能反推");
	assert.equal(extensionFromMime("text/plain"), "txt", "文本要能反推");
	assert.equal(extensionFromMime("application/x-unknown-thing"), "", "推不出就返回空串，由调用方兜底");
	assert.equal(extensionFromMime(""), "");
	assert.equal(extensionFromMime(null), "");
	assert.equal(extensionFromMime(undefined), "");

	// ============================================================
	// 3. ⭐ 扩展名的最终判定：**文件名优先**，其次 MIME
	//
	// 两个方向都真实存在，缺一个就会整类漏掉：
	// - 截图粘贴：只有 MIME、没有文件名 → 必须靠 MIME；
	// - 下载器拖出的文件：MIME 是 `application/octet-stream` → 必须靠文件名。
	// ============================================================
	assert.equal(resolveExtension("photo.svg", "image/png"), "svg", "⭐ 两者冲突时以**文件名**为准");
	assert.equal(resolveExtension("photo.png", "application/octet-stream"), "png", "通用 MIME 时应靠文件名");
	assert.equal(resolveExtension("", "image/png"), "png", "没有文件名时靠 MIME（截图粘贴）");
	assert.equal(resolveExtension(undefined, "image/webp"), "webp", "文件名缺失（不仅仅是空串）");
	assert.equal(resolveExtension("noext", ""), "", "两边都推不出就返回空串");
	assert.equal(resolveExtension("noext", "application/pdf"), "pdf", "文件名缺扩展名时，PDF 的 MIME 照样能定类型");

	// ⭐⭐ 最终判定的**后果**：外站 URL 的点后令牌（不是扩展名）必须被忽略，改用 MIME。
	// 这就是用户实测报的那件事 —— 缓存下来的副本应当叫 `…hash….png`，
	// 而不是 `…hash….spb8lvtxu-zleqgemugctwaaaa`（后者 Obsidian 默认不显示，
	// 于是用户在缓存目录里"看不到这张图被缓存了"）。
	// ⚠️ 这几条**必须放在既有断言之后**：套件是"第一条失败的断言决定报错"，
	// 插到前面会把上面两条变异（只看 MIME / 只看文件名）的报错换成这里的，
	// 它们的 `expect` 就对不上了（我第一版就是这么插的，预检立刻抓出来）。
	assert.equal(
		resolveExtension(TOKEN_AFTER_DOT, "image/png"),
		"png",
		"★ 外站 URL 的点后令牌要被忽略，改用 MIME 推扩展名（否则缓存副本的名字没人认得出来）"
	);
	assert.equal(
		resolveExtension("R-C.fee004adf34307a501723fa65fed9d64", "image/jpeg"),
		"jpg",
		"★ 同上（jpg 来自 MIME 映射表）"
	);
	// 但没有 MIME 可退时不要凭空造一个：交给调用方的兜底（`resolveKeyExtension` → bin）
	assert.equal(resolveExtension(TOKEN_AFTER_DOT, ""), "", "取不到就老实返回空串，让调用方兜底");
	// 真实扩展名仍然优先于 MIME（原有纪律，不能因为这次的改动被推翻）
	assert.equal(resolveExtension("x.png", "image/jpeg"), "png", "（文件名优先于 MIME —— 原有纪律）");

	// ============================================================
	// 4. Content-Type
	// ============================================================
	assert.equal(contentTypeForExtension("png"), "image/png");
	assert.equal(contentTypeForExtension(".PNG"), "image/png", "带点、大写都要认");
	assert.equal(contentTypeForExtension("jpg"), "image/jpeg", "jpg 的规范类型是 image/jpeg");
	assert.equal(contentTypeForExtension("svg"), "image/svg+xml");
	assert.equal(contentTypeForExtension("avif"), "image/avif");
	assert.equal(contentTypeForExtension("heic"), "image/heic");
	assert.equal(contentTypeForExtension("pdf"), "application/pdf", "PDF 要声明真实类型（否则浏览器只会下载）");
	assert.equal(contentTypeForExtension("mp3"), "audio/mpeg", "音频同理");
	assert.equal(contentTypeForExtension("mp4"), "video/mp4", "视频同理");
	assert.equal(contentTypeForExtension("docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.equal(contentTypeForExtension("zip"), "application/zip");
	assert.equal(contentTypeForExtension("txt"), "text/plain");
	assert.equal(contentTypeForExtension("exe"), DEFAULT_CONTENT_TYPE, "未知扩展名应兜底");
	assert.equal(contentTypeForExtension(""), DEFAULT_CONTENT_TYPE, "空扩展名应兜底");
	assert.equal(contentTypeForExtension(null), DEFAULT_CONTENT_TYPE);
	assert.equal(DEFAULT_CONTENT_TYPE, "application/octet-stream", "兜底类型应是通用二进制（否则浏览器会试图当文本渲染）");

	// resolveContentType：宿主给的 MIME 优先，但通用类型不算"给了"
	assert.equal(resolveContentType("photo.png", "image/png"), "image/png");
	assert.equal(resolveContentType("photo.png", "image/png; charset=binary"), "image/png", "应去掉参数");
	assert.equal(
		resolveContentType("photo.png", "application/octet-stream"),
		"image/png",
		"通用类型等于没给 —— 应按扩展名推出真实类型"
	);
	assert.equal(resolveContentType("photo.png", ""), "image/png", "空 MIME 应按扩展名推");
	assert.equal(resolveContentType("photo.xyz", ""), DEFAULT_CONTENT_TYPE, "推不出就兜底");

	// ⭐⭐ isWebPageExtension：**这个后缀指向的是页面，还是一个文件**。
	// 站外候选那一层的"网页不算附件"闸门用的就是它（`decideExternalCache`），
	// 而判据的**定义**在这里 —— 所以这一组断言与 `external-decide-suite` 里那一组
	// 是同一条通路的两个端点，各有一条变异锚点守着。
	//
	// 2026-10-16 用户**第三次**实测报的：他笔记里 `[原文链接](…/pd.jsp?id=172#:~:text=…)`
	// 进了「上传附件」的清单。它尾巴有点（过了"像个文件名"那条），
	// 后缀也不是 `text/html`（过了第一版网页闸门），但它是**服务端现算出来的一张页面**。
	// 用户的原话：「实际上这是一个网页地址」；同时补了界限：
	// 「如果是外部网站的文件下载链接，应该看做是附件才对」。
	for (const ext of ["html", "htm", ".HTML"]) {
		assert.equal(isWebPageExtension(ext), true, `★ 静态页面不算附件（后缀 ${ext}）`);
	}
	// ⚠️ 顺序刻意：**集合那半**的断言放在类型表那半之后，而且从"服务端页面"这一组开始 ——
	// 于是"集合判据被删掉"这个变异会**首先**红在这一组的第一条上（锚点的 `expect` 抄的就是它）。
	for (const ext of ["php", "php5", "asp", "aspx", "jsp", "jspx", "do", "action", "cgi", "cfm", "phtml"]) {
		assert.equal(
			isWebPageExtension(ext),
			true,
			`★★ 服务端页面（后缀是脚本语言 / 框架的名字）同样不算附件：${ext}`
		);
	}
	// 静态页面的**同类写法**（类型表里没有它们，所以它们由上面那个集合负责）
	for (const ext of ["xhtml", "shtml"]) {
		assert.equal(isWebPageExtension(ext), true, `★ 静态页面的同类写法不算附件（后缀 ${ext}）`);
	}
	// ⚠️ 反向：**真实文件后缀照旧是文件** —— 闸门按"是不是页面"判，
	// 不按"我们认不认识这个后缀"（后者会把用户的真实文件静默拦在清单外）。
	for (const ext of ["pdf", "zip", "png", "mp3", "txt", "csv", "json", "xml", "docx", "exe", "iso"]) {
		assert.equal(
			isWebPageExtension(ext),
			false,
			`★ 真实文件后缀不是页面，别一起拦掉：${ext}`
		);
	}
	// ⚠️ 反向之二：**脚本文件 ≠ 页面程序**。`py` / `rb` / `pl` 是可以下载的源码文件。
	for (const ext of ["py", "rb", "pl"]) {
		assert.equal(isWebPageExtension(ext), false, `★ 脚本文件（源码可下载）不是页面：${ext}`);
	}
	assert.equal(isWebPageExtension(""), false, "空扩展名不是页面（由形状判据负责）");
	assert.equal(isWebPageExtension(null), false, "非字符串不抛错");

	// ============================================================
	// 5. 无文件名时造一个（截图粘贴）
	// ============================================================
	const at = new Date("2026-10-06T05:06:58Z");
	const generated = fallbackFileName("png", at);
	assert.ok(generated.endsWith(".png"), `造出的名字应带扩展名：${generated}`);
	assert.ok(generated.includes("Pasted image"), `名字应可读、能一眼看出是粘贴来的：${generated}`);
	assert.ok(!generated.includes(":"), "名字里不能有冒号（Windows 非法字符）");
	assert.equal(fallbackFileName("png", at), generated, "同一时刻应得到同一个名字（可复现）");
	assert.notEqual(fallbackFileName("png", new Date("2026-10-06T05:06:59Z")), generated, "不同时刻应不同（否则同名会被唯一化加序号）");
	assert.ok(!fallbackFileName("", at).includes("."), "没有扩展名时不该留下孤零零的点");
	assert.ok(fallbackFileName(undefined, at).startsWith("Pasted image"), "扩展名缺失也要能造名字");

	// ============================================================
	// 6. 父目录
	// ============================================================
	assert.equal(parentFolderOf("a/b/c.png"), "a/b");
	assert.equal(parentFolderOf("c.png"), "", "顶层文件的父目录是空串（不是 '/'）");
	assert.equal(parentFolderOf("/a.png"), "", "前导斜杠要清掉");
	assert.equal(parentFolderOf("a\\b\\c.png"), "a/b", "反斜杠要归一化");
	// 尾斜杠先被清掉，于是 "a/" 被当成**单个段**处理 → 父目录是空串。
	// 这是刻意的：这个助手的输入是**文件路径**，"目录的父目录"不在它的语义里；
	// 与其在这里猜用户意图（是想要 "a" 还是想要 ""），不如保持"清掉分隔符再看"的一致规则。
	assert.equal(parentFolderOf("a/"), "", "尾斜杠先清掉，剩下的段在顶层 → 父目录为空");
	assert.equal(parentFolderOf("a/b/"), "a", "多层路径同理：清掉尾斜杠后取上一层");
	assert.equal(parentFolderOf("///"), "", "全斜杠 → 空");
	assert.equal(parentFolderOf(""), "");
	assert.equal(parentFolderOf(null), "", "非字符串不应抛错");

	// ============================================================
	// 7. ⭐ uniqueVaultPath —— 绝不覆盖
	// ============================================================
	const taken = (...paths) => (candidate) => paths.includes(candidate);

	assert.equal(await uniqueVaultPath("a.png", () => false), "a.png", "没占用就用原名");

	// ⚠️ 断言顺序是刻意的，分三层，让每种缺陷都能**报出自己的原因**：
	//   ① 最高层性质「占用了就必须换一个」—— 用 `notEqual` 表达，不涉及具体格式；
	//   ② 序号加在**哪里** —— 用两段扩展名（a.tar.gz）最能暴露位置错误；
	//   ③ 完整形状 —— 断言逐字相等。
	// 若把 ③ 放在最前，那么"序号位置写错"与"根本没检查占用"会报同一句话，
	// 变异验证的"因自己的原因失败"就退化成了摆设。
	assert.notEqual(
		await uniqueVaultPath("a.png", taken("a.png")),
		"a.png",
		"⭐ 占用时必须换一个路径，绝不覆盖"
	);
	assert.equal(
		await uniqueVaultPath("a.tar.gz", taken("a.tar.gz")),
		"a.tar 1.gz",
		"序号应加在最后一段扩展名之前（否则 `a.png 1` 会丢掉文件类型）"
	);
	assert.equal(await uniqueVaultPath("a.png", taken("a.png")), "a 1.png", "⭐ 占用时加序号（与宿主自己的行为一致）");
	assert.equal(
		await uniqueVaultPath("a.png", taken("a.png", "a 1.png")),
		"a 2.png",
		"多个占用应继续往后找"
	);
	assert.equal(
		await uniqueVaultPath("a.png", taken("a.png", "a 1.png", "a 2.png", "a 3.png")),
		"a 4.png",
		"应一直找到空位"
	);
	assert.equal(await uniqueVaultPath("noext", taken("noext")), "noext 1", "没有扩展名时只加序号");
	assert.equal(
		await uniqueVaultPath("dir/sub/a.png", taken("dir/sub/a.png")),
		"dir/sub/a 1.png",
		"应保留目录部分，只在文件名上加序号"
	);
	assert.equal(await uniqueVaultPath("/a.png", () => false), "a.png", "前导斜杠要清掉");
	assert.equal(await uniqueVaultPath("a\\b.png", () => false), "a/b.png", "反斜杠要归一化");

	// ⭐ 必须支持**异步**的 exists：真实实现要同时看宿主的文件索引（同步）与磁盘（异步），
	// 只看同步那一个会漏掉"磁盘上有、索引里还没有"的文件，恰好是最危险的情形。
	let asyncCalls = 0;
	const asyncExists = async (candidate) => {
		asyncCalls += 1;
		return candidate === "a.png";
	};
	assert.equal(await uniqueVaultPath("a.png", asyncExists), "a 1.png", "exists 返回 Promise 时也要正确工作");
	assert.ok(asyncCalls >= 2, "异步 exists 应被真的调用（且不只一次）");

	// 空目标应明确报错，而不是产出畸形路径
	await assert.rejects(() => uniqueVaultPath("", () => false), /非空目标路径/, "空路径应报错");
	await assert.rejects(() => uniqueVaultPath("   ", () => true), /非空目标路径|无法为/, "纯空白同样不该被安静接受");

	// 上千个同名都占着 → 明确失败，而不是死循环或静默覆盖
	const alwaysTaken = () => true;
	const started = Date.now();
	await assert.rejects(() => uniqueVaultPath("a.png", alwaysTaken), /无法为/, "全被占用时应明确失败");
	assert.ok(Date.now() - started < 5000, "失败要快 —— 不能退化成无限循环");

	// 反向守护：只要有一个空位就必须返回它，不得"因为嫌麻烦就直接报错"
	const almostAllTaken = (candidate) => candidate !== "a 7.png";
	assert.equal(await uniqueVaultPath("a.png", almostAllTaken), "a 7.png", "应在有限的尝试内找到唯一的空位");

	// ============================================================
	// ⭐ 宿主撞名那条约定（`名字 1.ext`）的**读法**（`baseNameForDuplicate`）
	//
	// 2026-10-14（Android 用户直报）：同一张图插第二次时，**宿主自己**会把新文件叫
	// `照片 1.png`（它的唯一化规矩，与上面的 `uniqueVaultPath` 同一形状）
	// ⇒ 名字不同 ⇒ key 不同 ⇒ 云端多存一份**完全相同**的内容，笔记里两处引用指着两个对象。
	// 这个函数就是那条约定的**解析侧**（`uniqueVaultPath` 是写入侧），两侧必须逐字一致。
	//
	// ⚠️ 它只判**形状**：`照片 1.png` 完全可能是用户自己的命名。所以"要不要归一"
	// 还要看同目录下 `照片.png` 在不在、内容一不一样（见 `core/ingest.ts`）。
	// ============================================================
	assert.equal(baseNameForDuplicate("照片 1.png"), "照片.png", "⭐ 空格 + 序号要认出来");
	assert.equal(baseNameForDuplicate("photo 1.png"), "photo.png");
	assert.equal(baseNameForDuplicate("照片 2.png"), "照片.png", "序号是几都要认（宿主会一直加下去）");
	assert.equal(baseNameForDuplicate("无名 12 3.zip"), "无名 12.zip", "⭐ 只剥**最后**一段序号（中间那个「 12」是名字的一部分）");
	assert.equal(baseNameForDuplicate("dir/sub/a 1.png"), "a.png", "带目录的路径也能认（只取最后一段）");
	assert.equal(baseNameForDuplicate("dir\\sub\\a 1.png"), "a.png", "反斜杠同样要认");
	assert.equal(baseNameForDuplicate("存档.v2 1.pdf"), "存档.v2.pdf", "点在名字里（v2）时，剥的是最后一段");
	assert.equal(baseNameForDuplicate("照片 1"), "照片", "没有扩展名时只剥序号");

	// ⚠️ 反向守护：认不出来一律给空串，**绝不"顺手改一下"** ——
	// 放宽判据的后果是"用户真叫 `名字-1` 的文件在云端被改名"，而那种错不报错、只改名。
	assert.equal(baseNameForDuplicate("照片.png"), "", "没有序号 ⇒ 认不出来（绝不能返回自己）");
	assert.equal(baseNameForDuplicate("照片-1.png"), "", "`-1` 不是我们的约定（不猜）");
	assert.equal(baseNameForDuplicate("照片(1).png"), "", "`(1)` 同理（不猜）");
	assert.equal(baseNameForDuplicate("照片 1x.png"), "", "序号后面还有东西 ⇒ 不是宿主的形状");
	assert.equal(baseNameForDuplicate(" 1.png"), "", "没有主干的名字没有意义");
	assert.equal(baseNameForDuplicate("照片 1.png/"), "", "⭐ 目录（以斜杠结尾）不是文件名，不认");
	assert.equal(baseNameForDuplicate(""), "");
	assert.equal(baseNameForDuplicate(null), "", "非字符串不应抛错");

	// ============================================================
	// ⭐ 路径归一（`normalizeVaultPath`）
	//
	// 审计与淘汰都要拿"索引里记的路径"与"磁盘上枚举到的路径"做**字符串比较**，
	// 所以两侧的写法必须同源。原来两处各写了一份自己的归一（只处理反斜杠与前导斜杠），
	// 而正确做法是走宿主的 `normalizePath()` —— 那正是宿主往索引里写路径时用的规则。
	//
	// ⚠️ 两者的差别是**真实存在**的：老实现保留 `a//b` 与 `a/`，
	// 新实现把它们折成 `a/b` 与 `a`。把差别写进断言，是为了让"行为变了"
	// 这件事显式可见，而不是靠人去读 diff。
	// ============================================================
	assert.equal(normalizeVaultPath("a\\b.png"), "a/b.png", "反斜杠要折成正斜杠");
	assert.equal(normalizeVaultPath("a//b.png"), "a/b.png", "重复斜杠要折叠（老实现不会折叠）");
	assert.equal(normalizeVaultPath("/a/b/"), "a/b", "前后斜杠要去掉");
	assert.equal(normalizeVaultPath("./a.png"), "a.png", "开头的 ./ 要去掉");
	assert.equal(normalizeVaultPath(""), "", "空串还是空串");
	assert.equal(normalizeVaultPath(null), "", "非字符串给空串（调用方拿它当'无路径'）");
	assert.equal(normalizeVaultPath(undefined), "", "undefined 同理");
	assert.equal(normalizeVaultPath("a/b.png"), "a/b.png", "归一必须幂等");

	// ============================================================
	// ⭐ 可嵌入类型表（1.1.0 新增，需求 R15）
	//
	// 这张表决定"生成 `![]()` 还是 `[]()`"，而它的**唯一依据**是宿主能不能渲染：
	// 表里多写一个 ⇒ 笔记里出现一个坏图；漏写一个 ⇒ 用户要点一下才能看。
	// 所以这里把**完整内容**逐项钉住（改表一行，这里必红）。
	//
	// 证据：Obsidian 1.14.4 的 asar 载荷复核（2026-10-09）。
	// ⚠️ `tiff` / `heic` / `ico` **不可嵌入** —— 它们在 1.1.0 之前被当成图片嵌入，
	// 现在必须是普通链接：这是对老用户**可见**的行为变化。
	// ============================================================
	const embeddable = {
		image: ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"],
		audio: ["3gp", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"],
		video: ["mkv", "mov", "mp4", "ogv", "webm"],
		pdf: ["pdf"],
	};
	for (const [kind, extensions] of Object.entries(embeddable)) {
		for (const ext of extensions) {
			assert.equal(embedKindFor(ext), kind, `${ext} 应当是可嵌入的 ${kind}`);
			assert.equal(isEmbeddable(ext), true, `isEmbeddable(${ext}) 应为 true`);
		}
	}
	// 归一：大写、前导点、空白都要认（调用方给的值来自文件名/配置，写法不统一）
	assert.equal(embedKindFor("PDF"), "pdf", "大写要认");
	assert.equal(embedKindFor(".PNG"), "image", "前导点要认");
	assert.equal(embedKindFor(" mp4 "), "video", "空白要认");
	// ⚠️ 不可嵌入 / 未知 / 缺值 ⇒ null（这正是"普通链接"的那一侧）
	for (const ext of ["tiff", "heic", "ico", "zip", "docx", "exe", "noext", "", null, undefined, 42]) {
		assert.equal(embedKindFor(ext), null, `${JSON.stringify(ext)} 不可嵌入 ⇒ 必须是普通链接`);
		assert.equal(isEmbeddable(ext), false, `isEmbeddable(${JSON.stringify(ext)}) 应为 false`);
	}

	// ============================================================
	// 落点目录的解析（1.2.0 起从 ingest 搬到这一层：下载那条路也要用**同一个**答案）
	//
	// ⚠️ 2026-10-12（D-20）：原本这节还测"**用户的覆盖值**优先"那一层，那层随
	// 「附件目录覆盖」设置项一起取消 ⇒ 落点只剩"跟随宿主"一个答案。
	// ============================================================

	// ① 跟随宿主的附件位置（宿主没配就是 vault 根）
	assert.equal(hostAttachmentFolder(app, "notes/a.md"), "attachments", "应跟随宿主的附件设置");
	assert.equal(hostAttachmentFolder({}, "notes/a.md"), "", "拿不到宿主配置时退回 vault 根（不是失败）");
	// ⚠️ 这条排在"跟随"那句之后：`/` 只是"没填"的另一种写法，同样依赖宿主那一层。
	// 顺序颠倒会让"宿主被忽略"那个变异红在这一句上，而不是红在"跟随"那句上。
	assert.equal(hostAttachmentFolder(hostApp("/"), "notes/a.md"), "", "宿主填 `/` = 没指定目录 ⇒ vault 根");

	// ② 宿主的 `./` = 与笔记同目录（相对写法，必须按触发它的笔记反推）
	assert.equal(hostAttachmentFolder(sameFolderApp, "notes/子目录/a.md"), "notes/子目录", "`./` 应落在笔记旁边");
	assert.equal(hostAttachmentFolder(sameFolderApp, ""), "", "拿不到笔记路径时退回 vault 根");

	// ③ 归一：`/` 与空串都表示"根"；非字符串当作"没填"
	assert.equal(cleanFolderPath("/"), "", "`/` 表示没指定目录");
	assert.equal(cleanFolderPath("/a/b/"), "a/b", "首尾斜杠要剥掉");
	assert.equal(cleanFolderPath(42), "", "非字符串当作没填（`String(对象)` 会造出一个怪目录名）");

	return {
		extensionCases: 12 + 9 + 6 + 9 + 6,
		placementCases: 8,
		duplicateNameCases: 16,
	};
}
