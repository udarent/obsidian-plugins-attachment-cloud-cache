/**
 * 对象 key 模块的断言套件。
 *
 * 与 `settings-suite.mjs` 同理：套件被**正式测试**与**变异验证**共用，
 * 这样"变异被抓住"证明的正是你日常跑的那批断言，而不是变异脚本自带的一套。
 */

import assert from "node:assert/strict";

export function runObjectKeySuite(mod) {
	const { renderObjectKey, sanitizeFilename, sanitizeKey, displayNameForKey, hashFromKey, DEFAULT_KEY_TOKENS, DEFAULT_OBJECT_KEY_TEMPLATE } = mod;

	const hash = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
	const fullHash = "d472a4c9f0b8e1a2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef00123"; // 恰好 64 位
	const ctx = { hash, ext: "png", filename: "photo.png", date: new Date(Date.UTC(2026, 9, 5)) };

	// ---------- 1. 基本渲染 ----------
	assert.equal(renderObjectKey("{hash}.{ext}", ctx), `${hash}.png`, "默认模板应为单段");
	assert.equal(renderObjectKey("{hash2}/{hash}.{ext}", ctx), `a1/${hash}.png`, "hash2 是前两位");
	assert.equal(renderObjectKey("{ext}/{hash}.{ext}", ctx), `png/${hash}.png`);
	assert.equal(renderObjectKey("attachments/{hash}.{ext}", ctx), `attachments/${hash}.png`);
	assert.equal(renderObjectKey("{date}/{hash}.{ext}", ctx), `2026-10-05/${hash}.png`);

	// 内容寻址：改名不应改变 key
	assert.equal(
		renderObjectKey("{hash}.{ext}", ctx),
		renderObjectKey("{hash}.{ext}", { ...ctx, filename: "别的名字.png" }),
		"key 只由 hash 决定时，改名不应改变 key"
	);

	// ---------- 2. 未知占位符保留原样 ----------
	assert.equal(
		renderObjectKey("{hash}.{nope}.{ext}", ctx),
		`${hash}.{nope}.png`,
		"未知占位符应保留原样（看得见），而不是静默变空"
	);

	// ---------- 3. 路径穿越必须被挡住 ----------
	const hostileNames = [
		"../../etc/passwd",
		"..\\..\\windows\\system32\\evil",
		"....//....//etc/passwd",
		"/absolute/path.png",
		"a/../../b.png",
		"..%2f..%2fescaped.png",
	];
	for (const name of hostileNames) {
		const key = renderObjectKey("{filename}", { ...ctx, filename: name });
		assert.ok(!key.startsWith("/"), `key 不应是绝对路径：${key}`);
		assert.ok(!key.includes(".."), `key 不应含 ..（穿越）：${name} → ${key}`);
		assert.ok(!key.includes("\\"), `key 不应含反斜杠：${name} → ${key}`);
	}

	// ⚠️ 反斜杠归一化需要一条**专属**断言，且必须放在穿越用例**之前**：
	// 穿越用例的输入同时含 `..`，若归一化坏了，"去掉穿越"那条会先失败，
	// 反斜杠规则即使坏了也被掩护着通过。
	// 变异验证正是靠报错内容区分「抓住了」与「因正确原因抓住」。
	assert.equal(sanitizeKey("a\\b\\c.png"), "a/b/c.png", "反斜杠应归一化为正斜杠");

	for (const hostileKey of ["../../x.png", "/etc/passwd", "a/../../../b.png", "..\\..\\x"]) {
		const cleaned = sanitizeKey(hostileKey);
		assert.ok(!cleaned.includes(".."), `sanitizeKey 应去掉穿越：${hostileKey} → ${cleaned}`);
		assert.ok(!cleaned.startsWith("/"), `sanitizeKey 应去掉开头的斜杠：${hostileKey} → ${cleaned}`);
		assert.ok(!cleaned.includes("\\"), `sanitizeKey 应把反斜杠归一化：${hostileKey} → ${cleaned}`);
	}

	// ---------- 4. 空段与多余斜杠收敛 ----------
	assert.equal(sanitizeKey("a//b.png"), "a/b.png", "重复斜杠应收敛");
	assert.equal(sanitizeKey("/a/b.png/"), "a/b.png", "首尾斜杠应去掉");
	assert.equal(sanitizeKey("./a/b.png"), "a/b.png", "./ 应去掉");
	assert.equal(sanitizeKey("a/./b.png"), "a/b.png", "中间的 ./ 应去掉");
	assert.equal(sanitizeKey(""), "", "空 key 应返回空串（由调用方判定为非法）");

	// ---------- 5. 文件名清洗 ----------
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

	// ---------- 6. 展开后的整体结果仍必须是安全 key ----------
	const allTemplates = [
		"{hash}.{ext}",
		"{filename}",
		"{date}/{filename}",
		"{ext}/{hash2}/{hash}.{ext}",
		"attachments/{date}/{filename}",
	];
	for (const template of allTemplates) {
		for (const name of hostileNames) {
			const key = renderObjectKey(template, { ...ctx, filename: name });
			assert.ok(key.length > 0, `模板 ${template} 展开后不应为空`);
			assert.ok(!key.startsWith("/") && !key.endsWith("/"), `不应有首尾斜杠：${template} → ${key}`);
			assert.ok(!key.includes("//"), `不应有空段：${template} → ${key}`);
			assert.ok(!key.includes(".."), `不应含穿越：${template} → ${key}`);
			assert.ok(!key.includes("\\"), `不应含反斜杠：${template} → ${key}`);
		}
	}

	// ---------- 7. token 清单与实现一致 ----------
	assert.deepEqual(
		[...DEFAULT_KEY_TOKENS].sort(),
		["date", "ext", "filename", "hash", "hash2", "name"],
		"支持的占位符清单应与实现一致（设置页的说明由它生成）"
	);

	// ---------- 8. `{name}` = 不含扩展名的文件名（且只去**最后一个**扩展名）----------
	assert.equal(renderObjectKey("{name}.{ext}", ctx), "photo.png", "{name} 应去掉扩展名");
	assert.equal(
		renderObjectKey("{name}-{hash}.{ext}", { ...ctx, ext: "pdf", filename: "存档.v2.pdf" }),
		`存档.v2-${hash}.pdf`,
		"多点文件名只剥最后一个扩展名"
	);

	// ---------- 9. 默认模板 = 名字 + 完整哈希尾 ----------
	assert.equal(DEFAULT_OBJECT_KEY_TEMPLATE, "{name}-{hash}.{ext}", "默认模板应自带文件名");
	assert.equal(
		renderObjectKey("", { ...ctx, hash: fullHash, ext: "pdf", filename: "报告 扫描.pdf" }),
		`报告 扫描-${fullHash}.pdf`,
		"空模板应回落到默认模板（名字 + 完整哈希尾）"
	);

	// ---------- 10. displayNameForKey：新格式还原 ----------
	const rendered = renderObjectKey(DEFAULT_OBJECT_KEY_TEMPLATE, { ...ctx, hash: fullHash, ext: "pdf", filename: "报告 扫描.pdf" });
	assert.equal(displayNameForKey(rendered), "报告 扫描.pdf", "新格式 key 应能解析回原始文件名");

	// ---------- 11. displayNameForKey：老格式安全返回空（绝不能硬猜）----------
	assert.equal(displayNameForKey(`${fullHash}.png`), "", "老格式纯哈希 key 应解析为空");

	// ---------- 12. displayNameForKey：哈希尾必须恰好 64 位 ----------
	assert.equal(displayNameForKey("报告-a1b2c3d4.png"), "", "短十六进制尾不应被当成哈希尾剥掉");

	// ---------- 13. displayNameForKey：路径入参只取末段（含 Windows 分隔符）----------
	assert.equal(
		displayNameForKey(`C:\\cache\\报告-${fullHash}.pdf`),
		"报告.pdf",
		"Windows 路径应按分隔符取末段再解析"
	);

	// ---------- 14. displayNameForKey：文件名自带类哈希尾时只剥一段 ----------
	assert.equal(
		displayNameForKey(`数据-${"e".repeat(64)}-${fullHash}.pdf`),
		`数据-${"e".repeat(64)}.pdf`,
		"文件名以 64 位十六进制结尾时也只剥最右一段"
	);

	// ---------- 15. displayNameForKey：无扩展名的 key 也能还原 ----------
	assert.equal(displayNameForKey(`报告-${fullHash}`), "报告", "无扩展名时返回纯名字");

	// ---------- 16. hashFromKey：C2 形状取哈希段 ----------
	//
	// 这一条是"这份内容我们传过吗"的判据基础（`CacheIndex.wasContentUploaded`）——
	// C2 之后 key 里有名字，拿文件哈希直接比 key 会**永远不相等**，必须能取哈希段。
	assert.equal(hashFromKey(`报告 扫描-${fullHash}.pdf`), fullHash, "C2 key 应取出哈希段（名字与扩展名都要剥掉）");

	// ---------- 17. hashFromKey：老形状整个基名就是哈希 ----------
	assert.equal(hashFromKey(`${fullHash}.png`), fullHash, "老 key 的基名就是哈希");
	assert.equal(hashFromKey(fullHash), fullHash, "没有扩展名时也认");

	// ---------- 18. hashFromKey：取不到一律 null（绝不猜）----------
	assert.equal(hashFromKey("报告-a1b2c3d4.png"), null, "短十六进制尾不是哈希（放宽会把用户的名字当哈希）");
	assert.equal(hashFromKey("report.pdf"), null, "自定义模板的 key 与内容无可推导关系 ⇒ 必须返回 null");
	assert.equal(hashFromKey(""), null, "空 key 返回 null");
	assert.equal(hashFromKey(null), null, "非字符串返回 null");

	// ---------- 19. hashFromKey：路径入参只取末段、大小写归一 ----------
	assert.equal(hashFromKey(`C:////cache////报告-${fullHash}.pdf`), fullHash, "Windows 路径应取末段");
	assert.equal(hashFromKey(`报告-${fullHash.toUpperCase()}.pdf`), null, "大写十六进制不认（与 displayNameForKey 同一判据）");
}
