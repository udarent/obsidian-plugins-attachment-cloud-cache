import assert from "node:assert/strict";

import { withLoadedTs } from "./lib/load-ts.mjs";

/**
 * 文案（i18n）的测试。
 *
 * 双语插件最容易静默漏掉的三类问题：
 * 1. 加了新 key 只写了英文、忘了中文 → 中文用户看到英文（或空白）
 * 2. 两表键名不一致 → 同上
 * 3. 文案要 `{count}` 但调用处传了别的名字 → 界面上一句读不通的话
 *
 * 这三类都**不会报错**，只有在真实使用中才被发现，所以必须单独测。
 */
await withLoadedTs("src/i18n.ts", (mod) => {
	const { I18N, detectLocale, translate } = mod;

	// ============================================================
	// 1. 两表键名必须完全一致，且都不能是空串
	// ============================================================
	const en = Object.keys(I18N.en).sort();
	const zh = Object.keys(I18N.zh).sort();

	const missingInZh = en.filter((k) => !(k in I18N.zh));
	const missingInEn = zh.filter((k) => !(k in I18N.en));
	assert.deepEqual(missingInZh, [], `中文缺少这些 key：${missingInZh.join(", ")}`);
	assert.deepEqual(missingInEn, [], `英文缺少这些 key：${missingInEn.join(", ")}`);

	for (const locale of ["en", "zh"]) {
		for (const [key, value] of Object.entries(I18N[locale])) {
			assert.equal(typeof value, "string", `${locale}.${key} 应是字符串`);
			assert.ok(value.trim().length > 0, `${locale}.${key} 不应为空串`);
		}
	}

	// ============================================================
	// 2. 占位符必须两边对称
	//
	// 中文漏写占位符（或拼错名字）会导致信息丢失，且不会报错。
	// ============================================================
	const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

	for (const key of en) {
		assert.deepEqual(
			placeholders(I18N.zh[key]),
			placeholders(I18N.en[key]),
			`${key} 的占位符在两种语言里不一致`
		);
	}

	// ============================================================
	// 3. 语言识别
	// ============================================================
	assert.equal(detectLocale("zh"), "zh");
	assert.equal(detectLocale("zh-CN"), "zh");
	assert.equal(detectLocale("zh-TW"), "zh");
	assert.equal(detectLocale("en"), "en");
	assert.equal(detectLocale("de"), "en");
	assert.equal(detectLocale(undefined), "en", "识别不到语言时应回落英文而不是抛错");

	// ============================================================
	// 4. 替换行为
	// ============================================================
	// ⚠️ 夹具要用**真的在用的键**：原先这里用的是 `uploadFailed`，
	// 而那个键从第一个提交起就**从未在 src 里接线过**（只有这条测试引用它）——
	// 于是"文案键被使用"这件事被一个死键假装满足了。现在换成真正在用的那条
	//（`core/transfer.ts` 上传失败时提示用户"已改为保留本地文件"）。
	assert.equal(
		translate("en", "hookUploadFailedKeptLocal", { error: "boom" }),
		"Upload failed, so the file was kept locally instead: boom",
		"应替换占位符"
	);
	assert.equal(
		translate("zh", "hookUploadFailedKeptLocal", { error: "boom" }),
		"上传失败，已改为保留本地文件：boom"
	);

	// 未知 key → 返回 key 本身（一眼看出漏了哪条），而不是空串
	assert.equal(translate("en", "noSuchKey"), "noSuchKey", "未知 key 应返回 key 本身以便定位");

	// ⚠️ 关键：非标量参数不替换，保持 {name} 原样
	//
	// 直接 String(value) 会得到 "[object Object]" 并被塞进用户可见提示，
	// 既没信息量、又掩盖了调用方传错参数这件事。
	// `params` 是 Record<string, unknown>，类型系统保护不了 —— 必须在此断言钉住。
	assert.equal(
		translate("en", "hookUploadFailedKeptLocal", { error: {} }),
		"Upload failed, so the file was kept locally instead: {error}",
		"对象参数应保持占位符原样，而不是渲染成 [object Object]"
	);
	assert.equal(
		translate("en", "hookUploadFailedKeptLocal", { error: [1, 2] }),
		"Upload failed, so the file was kept locally instead: {error}",
		"数组参数同理"
	);
	assert.equal(
		translate("en", "hookUploadFailedKeptLocal", { error: null }),
		"Upload failed, so the file was kept locally instead: {error}",
		"null 参数应保持占位符原样"
	);
	assert.equal(
		translate("en", "hookUploadFailedKeptLocal", { other: "x" }),
		"Upload failed, so the file was kept locally instead: {error}",
		"未提供的占位符应保持原样（看得见），而不是变空"
	);
	// 标量都要能正常替换
	assert.equal(translate("en", "hookUploadFailedKeptLocal", { error: 0 }), "Upload failed, so the file was kept locally instead: 0");
	assert.equal(translate("en", "hookUploadFailedKeptLocal", { error: false }), "Upload failed, so the file was kept locally instead: false");

	// 未知语言 → 回落英文而不是崩溃
	assert.equal(
		translate("de", "hookUploadFailedKeptLocal", { error: "t" }),
		"Upload failed, so the file was kept locally instead: t",
		"未知语言应回落英文"
	);

	console.log(
		`i18n tests passed (${en.length} keys, en/zh parity, placeholder symmetry, ` +
			"non-scalar params keep the placeholder instead of rendering [object Object])."
	);
});
