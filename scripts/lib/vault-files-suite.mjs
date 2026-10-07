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

export async function runVaultFilesSuite(mod) {
	const {
		contentTypeForExtension,
		DEFAULT_CONTENT_TYPE,
		extensionFromMime,
		extensionOfName,
		fallbackFileName,
		parentFolderOf,
		resolveContentType,
		resolveExtension,
		uniqueVaultPath,
		normalizeVaultPath,
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
	assert.equal(extensionFromMime("application/pdf"), "", "推不出就返回空串，由调用方兜底");
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
	assert.equal(resolveExtension("noext", "application/pdf"), "", "推不出的 MIME 不算数");

	// ============================================================
	// 4. Content-Type
	// ============================================================
	assert.equal(contentTypeForExtension("png"), "image/png");
	assert.equal(contentTypeForExtension(".PNG"), "image/png", "带点、大写都要认");
	assert.equal(contentTypeForExtension("jpg"), "image/jpeg", "jpg 的规范类型是 image/jpeg");
	assert.equal(contentTypeForExtension("svg"), "image/svg+xml");
	assert.equal(contentTypeForExtension("avif"), "image/avif");
	assert.equal(contentTypeForExtension("heic"), "image/heic");
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

	return {
		extensionCases: 12 + 9 + 6 + 9 + 6,
	};
}
