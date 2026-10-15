/**
 * 对象 key 模块的断言套件。
 *
 * 与 `settings-suite.mjs` 同理：套件被**正式测试**与**变异验证**共用，
 * 这样"变异被抓住"证明的正是你日常跑的那批断言，而不是变异脚本自带的一套。
 *
 * ⚠️ 1.2.0 起模板设置取消，这一层只剩**一种**形状（`<名字>-<完整哈希>[.<扩展名>]`），
 * 所以套件从"穷举模板组合"改成"穷举**身份**与**名字**两侧的边界"：
 * 身份那一侧（哈希对不对）现在是安全关键 —— 它出错的后果是静默串内容。
 */

import assert from "node:assert/strict";

export function runObjectKeySuite(mod) {
	const { objectKeyFor, sanitizeFilename, sanitizeKey, displayNameForKey, hashFromKey } = mod;

	const fullHash = "d472a4c9f0b8e1a2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef00123"; // 恰好 64 位
	const otherHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const ctx = { hash: fullHash, ext: "png", filename: "photo.png" };

	// ---------- 1. 唯一的命名规则：名字 + 完整哈希 + 扩展名 ----------
	assert.equal(objectKeyFor(ctx), `photo-${fullHash}.png`, "key 应带原始文件名与完整哈希");
	assert.equal(
		objectKeyFor({ hash: fullHash, ext: "pdf", filename: "报告 扫描.pdf" }),
		`报告 扫描-${fullHash}.pdf`,
		"中文与空格应原样进 key（对象存储里合法；编码会让链接 404）"
	);
	// ⭐ C2 的产品诉求就是"桶里能按名字认文件"：名字必须在 key 的**最前面**（前缀搜索的前提）
	assert.ok(
		objectKeyFor({ hash: fullHash, ext: "png", filename: "发票.png" }).startsWith("发票-"),
		"名字应在 key 最前面（桶里按前缀才搜得到）"
	);

	// ---------- 2. ⭐ 身份：内容决定 key（安全关键）----------
	//
	// 两半都要成立，而且它们守的是**不同**的事故：
	// 同内容 ⇒ 同 key 是"去重"与"跨设备幂等"的前提；
	// 不同内容 ⇒ 不同 key 是"永不互相覆盖"的前提。少了后者，同名不同内容会撞成
	// 同一个 key，而上传路径的复用判定不比内容 ⇒ 静默复用错文件、甚至覆盖桶里对象。
	const sameA = objectKeyFor(ctx);
	const sameB = objectKeyFor({ hash: fullHash, ext: "png", filename: "photo.png" });
	assert.equal(sameA, sameB, "同内容同名 ⇒ 同 key（去重的前提）");
	assert.notEqual(
		objectKeyFor({ hash: otherHash, ext: "png", filename: "photo.png" }),
		sameA,
		"★ 同名但内容不同 ⇒ **必须**不同 key（否则会复用错文件、甚至覆盖桶里的对象）"
	);
	// 改名不改身份：名字段会变，哈希段必须还在 —— 否则"这份内容是不是我们传过的"就判不出来了
	assert.equal(
		hashFromKey(objectKeyFor({ hash: fullHash, ext: "png", filename: "别的名字.png" })),
		fullHash,
		"改名只应改名字段，哈希段必须仍在（`wasContentUploaded` 全靠它）"
	);

	// ---------- 3. ⭐ 哈希形状不对 ⇒ 拒绝生成（绝不产出一个"所有文件共用"的 key）----------
	//
	// 这条是模板时代那类事故的**结构性防线**：只要身份不可用，就宁可不传，
	// 也绝不生成一个共用 key（那会让所有笔记指向同一个对象）。
	const badHashes = [
		"",
		"   ",
		"a1b2c3d4",
		fullHash.slice(0, 63),
		`${fullHash}0`,
		fullHash.replace("d", "z"),
	];
	for (const bad of badHashes) {
		assert.equal(
			objectKeyFor({ hash: bad, ext: "png", filename: "photo.png" }),
			"",
			`非法哈希必须返回空串（调用方据此放弃本次上传）：${JSON.stringify(bad)}`
		);
	}
	assert.equal(objectKeyFor({ hash: null, ext: "png", filename: "photo.png" }), "", "哈希缺失同样返回空串");
	// ⚠️ 大写哈希也**拒绝**（而不是转小写后接受）：解析器只认小写（见 §11），
	// 生成器接受大写就会造出"生成得出、却解析不回来"的 key ——
	// 那类缺陷不报错，只表现为"同步到达的文件判不出来"或"确认框里突然只剩哈希名"。
	assert.equal(
		objectKeyFor({ hash: fullHash.toUpperCase(), ext: "png", filename: "photo.png" }),
		"",
		"大写哈希应拒绝：生成器接受的形状必须与解析器认得的形状一致"
	);

	// ---------- 4. 恶意文件名绝不能产出危险 key ----------
	const hostileNames = [
		"../../etc/passwd",
		"..\\..\\windows\\system32\\evil",
		"....//....//etc/passwd",
		"/absolute/path.png",
		"a/../../b.png",
		"..%2f..%2fescaped.png",
	];
	for (const name of hostileNames) {
		const key = objectKeyFor({ ...ctx, filename: name });
		assert.ok(!key.startsWith("/"), `key 不应是绝对路径：${name} → ${key}`);
		assert.ok(!key.includes(".."), `不应含 ..（穿越）：${name} → ${key}`);
		assert.ok(!key.includes("\\"), `不应含反斜杠：${name} → ${key}`);
		assert.ok(key.length > 0, `展开后不应为空：${name}`);
	}

	// ⚠️ 反斜杠归一化需要一条**专属**断言：穿越用例的输入同时含 `..`，
	// 若归一化坏了，"去掉穿越"那条会先失败，反斜杠规则即使坏了也被掩护着通过。
	// 变异验证正是靠报错内容区分「抓住了」与「因正确原因抓住」。
	assert.equal(sanitizeKey("a\\b\\c.png"), "a/b/c.png", "反斜杠应归一化为正斜杠");

	for (const hostileKey of ["../../x.png", "/etc/passwd", "a/../../../b.png", "..\\..\\x"]) {
		const cleaned = sanitizeKey(hostileKey);
		assert.ok(!cleaned.includes(".."), `sanitizeKey 应去掉穿越：${hostileKey} → ${cleaned}`);
		assert.ok(!cleaned.startsWith("/"), `sanitizeKey 应去掉开头的斜杠：${hostileKey} → ${cleaned}`);
		assert.ok(!cleaned.includes("\\"), `sanitizeKey 应把反斜杠归一化：${hostileKey} → ${cleaned}`);
	}

	// ---------- 5. 空段与多余斜杠收敛 ----------
	assert.equal(sanitizeKey("a//b.png"), "a/b.png", "重复斜杠应收敛");
	assert.equal(sanitizeKey("/a/b.png/"), "a/b.png", "首尾斜杠应去掉");
	assert.equal(sanitizeKey("./a/b.png"), "a/b.png", "./ 应去掉");
	assert.equal(sanitizeKey("a/./b.png"), "a/b.png", "中间的 ./ 应去掉");
	assert.equal(sanitizeKey(""), "", "空 key 应返回空串（由调用方判定为非法）");

	// ---------- 6. 文件名清洗 ----------
	assert.equal(sanitizeFilename("photo.png"), "photo.png", "普通文件名应保持");
	assert.equal(sanitizeFilename("中文 名字.png"), "中文 名字.png", "中文与空格应保留");
	assert.equal(sanitizeFilename("a?b#c.png"), "a_b_c.png", "URL 里有特殊含义的字符应替换");
	// 同样要**专属**断言，且放在上一条之后：反斜杠也属于"不安全字符"那一类，
	// 若只靠上一条，字符类被改窄时会先由上一条报错，反斜杠规则坏了看不出来。
	assert.equal(sanitizeFilename("a\\b.png"), "a_b.png", "文件名里的反斜杠应替换掉（不是当分隔符）");
	assert.equal(sanitizeFilename("a b\tc\nd.png"), "a b c d.png", "控制字符应替换为空格");
	assert.equal(sanitizeFilename(""), "file", "空名应有兜底");
	assert.equal(sanitizeFilename("   "), "file", "纯空白同样兜底");
	assert.equal(sanitizeFilename("."), "file", "`.` 不能成为文件名");
	assert.equal(sanitizeFilename(".."), "file", "`..` 不能成为文件名");

	const longName = `${"x".repeat(400)}.png`;
	const shortened = sanitizeFilename(longName);
	assert.ok(shortened.length <= 120, `超长文件名应被截断，实际 ${shortened.length}`);
	assert.ok(shortened.endsWith(".png"), "截断时必须保留扩展名");

	// ---------- 7. 名字只剥**最后一个**扩展名（不然会出现 `报告.pdf-<hash>.pdf`）----------
	assert.equal(
		objectKeyFor({ hash: fullHash, ext: "pdf", filename: "存档.v2.pdf" }),
		`存档.v2-${fullHash}.pdf`,
		"多点文件名只剥最后一个扩展名"
	);
	// 点在开头不算扩展名（`.gitignore` 整体是名字）
	assert.equal(objectKeyFor({ hash: fullHash, ext: "", filename: ".gitignore" }), `.gitignore-${fullHash}`, "开头的点不是扩展名");

	// ---------- 8. 扩展名段：归一、可缺 ----------
	assert.equal(objectKeyFor({ hash: fullHash, ext: ".PNG", filename: "photo.png" }), `photo-${fullHash}.png`, "扩展名应小写且去掉前导点");
	assert.equal(objectKeyFor({ hash: fullHash, ext: "", filename: "photo" }), `photo-${fullHash}`, "没有扩展名时不该留一个孤零零的点");

	// ---------- 9. ⭐ 生成器与解析器必须同源：写出去的 key 要能读回来 ----------
	const roundTrip = objectKeyFor({ hash: fullHash, ext: "pdf", filename: "报告 扫描.pdf" });
	assert.equal(displayNameForKey(roundTrip), "报告 扫描.pdf", "生成的名字必须能被解析回来（确认框靠它显示原始文件名）");
	assert.equal(hashFromKey(roundTrip), fullHash, "生成的哈希必须能被解析回来（同步到达的识别靠它）");

	// ---------- 10. displayNameForKey：老格式安全返回空（绝不能硬猜）----------
	assert.equal(displayNameForKey(`${fullHash}.png`), "", "老格式纯哈希 key 应解析为空");
	assert.equal(displayNameForKey("photo-abc.png"), "", "短十六进制尾不算哈希尾");
	assert.equal(displayNameForKey(""), "", "空 key 返回空串");

	// ---------- 11. displayNameForKey：哈希尾必须恰好 64 位 ----------
	assert.equal(displayNameForKey("报告-a1b2c3d4.png"), "", "短十六进制尾不应被当成哈希尾剥掉");

	// ---------- 12. displayNameForKey：路径入参只取末段（含 Windows 分隔符）----------
	assert.equal(
		displayNameForKey(`C:\\cache\\报告-${fullHash}.pdf`),
		"报告.pdf",
		"Windows 路径应按分隔符取末段再解析"
	);

	// ---------- 13. displayNameForKey：文件名自带类哈希尾时只剥一段 ----------
	assert.equal(
		displayNameForKey(`数据-${"e".repeat(64)}-${fullHash}.pdf`),
		`数据-${"e".repeat(64)}.pdf`,
		"文件名以 64 位十六进制结尾时也只剥最右一段"
	);

	// ---------- 14. displayNameForKey：无扩展名的 key 也能还原 ----------
	assert.equal(displayNameForKey(`报告-${fullHash}`), "报告", "无扩展名时返回纯名字");

	// ---------- 15. hashFromKey：名字在前的形状取哈希段 ----------
	//
	// 这一条是"这份内容我们传过吗"的判据基础（`CacheIndex.wasContentUploaded`）——
	// 名字进了 key 之后，拿文件哈希直接比 key 会**永远不相等**，必须能取哈希段。
	assert.equal(hashFromKey(`报告 扫描-${fullHash}.pdf`), fullHash, "应取出哈希段（名字与扩展名都要剥掉）");

	// ---------- 16. hashFromKey：老形状整个基名就是哈希 ----------
	assert.equal(hashFromKey(`${fullHash}.png`), fullHash, "老 key 的基名就是哈希");
	assert.equal(hashFromKey(fullHash), fullHash, "没有扩展名时也认");

	// ---------- 17. hashFromKey：取不到一律 null（绝不猜）----------
	assert.equal(hashFromKey("报告-a1b2c3d4.png"), null, "短十六进制尾不是哈希（放宽会把用户的名字当哈希）");
	assert.equal(hashFromKey("report.pdf"), null, "与内容无可推导关系的 key 必须返回 null（老用户自定义过模板）");
	assert.equal(hashFromKey(""), null, "空 key 返回 null");
	assert.equal(hashFromKey(null), null, "非字符串返回 null");

	// ---------- 18. hashFromKey：路径入参只取末段、大写不认 ----------
	assert.equal(hashFromKey(`C:////cache////报告-${fullHash}.pdf`), fullHash, "Windows 路径应取末段");
	// ⚠️ 上一条用的是**正斜杠**路径 —— 它连 `split("/")` 都能过。真正认"Windows 路径"
	// 必须有**反斜杠**这一条（2026-10-15 加：那是锚点唯一性检查顺带查出来的覆盖缺口 ——
	// 同一个"按分隔符取末段"的规则在 `displayNameForKey` 与 `hashFromKey` 里各写了一遍，
	// 而锚点与断言此前都只盖住了前一个）。
	//
	// ⚠️⚠️ 用**纯哈希**当末段，别用 `名字-哈希.ext`：后者的正则允许 `.+` 吃掉整条路径
	//（`^(.+)-(哈希)(\.扩展名)?$` 没锚住前缀），于是"没切分隔符"也能匹配上 ⇒ 那条断言
	// 看着很对、其实**分不出对错**（2026-10-15 实测：第一版就是这么写的，变异报"漏过"）。
	// 纯哈希形状必须**整段等于**哈希，一旦没切分隔符就必然取不到 ⇒ 才有牙。
	assert.equal(
		hashFromKey(`C:\\cache\\${fullHash}.png`),
		fullHash,
		"反斜杠路径（Windows）也要取末段再解析 —— 只按 / 切会把整条路径当基名（纯哈希名就取不到了）"
	);
	assert.equal(
		hashFromKey(`报告-${fullHash.toUpperCase()}.pdf`),
		null,
		"大写十六进制不认（与生成器的拒绝同源）"
	);
}
