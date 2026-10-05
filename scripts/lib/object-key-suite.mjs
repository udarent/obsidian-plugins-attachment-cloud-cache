/**
 * 对象 key 模块的断言套件。
 *
 * 与 `settings-suite.mjs` 同理：套件被**正式测试**与**变异验证**共用，
 * 这样"变异被抓住"证明的正是你日常跑的那批断言，而不是变异脚本自带的一套。
 */

import assert from "node:assert/strict";

export function runObjectKeySuite(mod) {
	const { renderObjectKey, sanitizeFilename, sanitizeKey, DEFAULT_KEY_TOKENS } = mod;

	const hash = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
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
		["date", "ext", "filename", "hash", "hash2"],
		"支持的占位符清单应与实现一致（设置页的说明由它生成）"
	);
}
