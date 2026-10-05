/**
 * 设置模块的断言套件。
 *
 * ## 为什么断言要抽成独立文件，而不是直接写在 test-settings.mjs 里
 *
 * 因为**变异验证**要用它：变异验证的流程是
 * 「改坏源码 → 重新加载 → 断言必须变红 → 还原」。
 * 若断言只存在于测试文件里，变异脚本就得自己再写一遍 ——
 * 两套断言必然漂移，最后"变异被抓住"只证明变异脚本的断言有效，
 * 而不是正式测试有效。
 *
 * 同一个套件被两处使用后，变异验证就有了确定含义：
 * **它检验的正是你日常跑的那批断言**。
 */

import assert from "node:assert/strict";

/**
 * @param {object} mod  从 `src/settings.ts` 加载的模块
 * @returns {{ scalars: number }}  供日志汇报用的统计
 */
export function runSettingsSuite(mod) {
	const { DEFAULT_SETTINGS, mergeSettings, isCacheLayout, isLocalFileAction } = mod;

	// ============================================================
	// 1. 默认值必须体现产品定位
	// ============================================================
	assert.equal(DEFAULT_SETTINGS.enabled, true, "插件默认应启用");
	assert.equal(DEFAULT_SETTINGS.cacheEnabled, true, "缓存默认应开启 —— 这是本插件的核心价值");

	assert.equal(
		DEFAULT_SETTINGS.localFileAction,
		"cache",
		"上传后本地文件默认应**移入缓存**（不是删除）—— 「本地副本即缓存」是离线可用的前提"
	);

	assert.deepEqual(
		[...DEFAULT_SETTINGS.enabledExtensions].sort(),
		["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tiff", "webp"],
		"默认应启用图片格式"
	);

	assert.equal(DEFAULT_SETTINGS.s3.objectKeyTemplate, "{hash}.{ext}", "默认对象 key 为单段内容寻址");
	assert.equal(DEFAULT_SETTINGS.cacheLayout, "mirror", "缓存默认镜像桶内结构（单一心智模型）");
	assert.equal(DEFAULT_SETTINGS.pasteUpload, true, "粘贴即传默认开启");
	assert.equal(DEFAULT_SETTINGS.dropUpload, true, "拖拽即传默认开启");
	assert.equal(DEFAULT_SETTINGS.fallbackDownload, true, "回退下载默认开启（覆盖换设备场景）");

	// ============================================================
	// 2. ⭐ 凭据绝不进 settings（必须走 SecretStorage）
	// ============================================================
	const s3Keys = Object.keys(DEFAULT_SETTINGS.s3);
	for (const forbidden of ["accessKeyId", "secretAccessKey", "accessKey", "secretKey", "password"]) {
		assert.ok(
			!s3Keys.includes(forbidden),
			`s3 配置里不得出现明文凭据字段 "${forbidden}" —— 凭据必须存 SecretStorage`
		);
	}
	assert.ok(
		s3Keys.includes("accessKeyIdRef") && s3Keys.includes("secretAccessKeyRef"),
		"s3 配置应只保存指向 SecretStorage 的**引用**（*Ref）"
	);

	// ⚠️ 只检查 DEFAULT_SETTINGS 是不够的 —— 真正会漏的是**合并后的输出**：
	// 用户旧版本留下的 data.json 里可能就有明文密钥，合并时必须把它丢掉，
	// 而不是保留下来。这条断言正是为"合并结果也不能带凭据"而设。
	const credentialFields = ["accessKeyId", "secretAccessKey", "accessKey", "secretKey", "password"];
	const mergedWithLegacyCreds = mergeSettings(DEFAULT_SETTINGS, {
		...DEFAULT_SETTINGS,
		s3: {
			...DEFAULT_SETTINGS.s3,
			accessKeyId: "AKIA-LEAKED",
			secretAccessKey: "leaked-secret",
			password: "hunter2",
		},
	});
	for (const forbidden of credentialFields) {
		assert.ok(
			!(forbidden in mergedWithLegacyCreds.s3),
			`合并结果不得保留凭据字段 "${forbidden}" —— 旧 data.json 里的明文密钥必须被丢弃`
		);
	}
	// 也不能因为丢弃凭据而把整个 s3 配置弄坏
	assert.equal(mergedWithLegacyCreds.s3.bucket, DEFAULT_SETTINGS.s3.bucket, "丢弃凭据不应影响其它字段");

	// ============================================================
	// 3. ⭐ 动态往返：从 DEFAULT_SETTINGS 推导，而不是手写清单
	//
	// 手写清单会随字段增加而漂移 —— 上一轮的缺陷正是从清单的缝隙里漏过去的。
	// ============================================================
	const roundTrip = (saved) => mergeSettings(DEFAULT_SETTINGS, JSON.parse(JSON.stringify(saved)));

	const scalars = Object.entries(DEFAULT_SETTINGS).filter(
		([, v]) => typeof v === "boolean" || typeof v === "number" || typeof v === "string"
	);
	assert.ok(
		scalars.length >= 8,
		`推导出 ${scalars.length} 个标量字段，数量异常 —— 疑似 DEFAULT_SETTINGS 结构被改动`
	);

	// 取值受限的字段必须换成**另一个合法值**，否则会被校验回落成默认值，
	// 从而误报成"不能往返"。
	const ALTERNATIVES = { cacheLayout: "byExt", localFileAction: "trash" };
	for (const key of Object.keys(ALTERNATIVES)) {
		assert.ok(key in DEFAULT_SETTINGS, `ALTERNATIVES 里的 ${key} 已不在 DEFAULT_SETTINGS 中（死键）`);
	}

	for (const [key, def] of scalars) {
		let custom;
		if (key in ALTERNATIVES) custom = ALTERNATIVES[key];
		else if (typeof def === "boolean") custom = !def;
		else if (typeof def === "number") custom = def + 7;
		else custom = def === "changed" ? "changed-2" : "changed";

		const merged = roundTrip({ ...DEFAULT_SETTINGS, [key]: custom });
		assert.deepEqual(merged[key], custom, `设置项 ${key} 必须能往返持久化，不能被重置为默认值`);
	}

	// 数组字段单独钉（上面只覆盖标量）
	assert.deepEqual(
		roundTrip({ ...DEFAULT_SETTINGS, enabledExtensions: ["png", "webp"] }).enabledExtensions,
		["png", "webp"],
		"数组字段必须能往返"
	);

	// s3 子对象逐字段往返
	const s3Merged = roundTrip({
		...DEFAULT_SETTINGS,
		s3: {
			...DEFAULT_SETTINGS.s3,
			bucket: "my-bucket",
			endpoint: "https://s3.example.com",
			region: "us-west-2",
		},
	});
	assert.equal(s3Merged.s3.bucket, "my-bucket", "s3.bucket 必须能往返");
	assert.equal(s3Merged.s3.endpoint, "https://s3.example.com", "s3.endpoint 必须能往返");
	assert.equal(s3Merged.s3.region, "us-west-2", "s3.region 必须能往返");

	// ⚠️ 嵌套对象也要**动态推导**，不能只硬写上面那三个字段。
	// 手写清单的缝隙正是上一轮缺陷的来源：新增字段没人记得加进清单，
	// 于是"存得进、读不出"能一路绿灯。
	const s3Scalars = Object.entries(DEFAULT_SETTINGS.s3).filter(
		([, v]) => typeof v === "boolean" || typeof v === "number" || typeof v === "string"
	);
	assert.ok(
		s3Scalars.length >= 6,
		`推导出 ${s3Scalars.length} 个 s3 标量字段，数量异常 —— 疑似 DEFAULT_S3 结构被改动`
	);
	for (const [key, def] of s3Scalars) {
		let custom;
		if (typeof def === "boolean") custom = !def;
		else if (typeof def === "number") custom = def + 3;
		else custom = def === "changed" ? "changed-2" : "changed";

		const merged = roundTrip({ ...DEFAULT_SETTINGS, s3: { ...DEFAULT_SETTINGS.s3, [key]: custom } });
		assert.deepEqual(merged.s3[key], custom, `s3.${key} 必须能往返持久化，不能被重置为默认值`);
	}

	// 寻址方式默认必须是 path-style：R2 的 S3 端点不支持 virtual-host，
	// 默认成 virtual-host 会让"按文档填完 R2 配置"直接不可用。
	assert.equal(
		DEFAULT_SETTINGS.s3.forcePathStyle,
		true,
		"默认应为 path-style —— R2/MinIO/B2/Wasabi/AWS 都接受它，反过来则 R2 不可用"
	);

	// s3 里坏类型同样要回落
	const s3Wrong = mergeSettings(DEFAULT_SETTINGS, {
		s3: { forcePathStyle: "yes", objectKeyTemplate: 42 },
	});
	assert.equal(s3Wrong.s3.forcePathStyle, true, "s3.forcePathStyle 非布尔应回落默认");
	assert.equal(
		s3Wrong.s3.objectKeyTemplate,
		DEFAULT_SETTINGS.s3.objectKeyTemplate,
		"s3.objectKeyTemplate 非字符串应回落默认"
	);

	// ============================================================
	// 4. 坏输入必须安全降级（不抛错、不产生畸形状态）
	// ============================================================
	for (const bad of [null, undefined, 42, "nope", [], true]) {
		const merged = mergeSettings(DEFAULT_SETTINGS, bad);
		assert.equal(merged.enabled, DEFAULT_SETTINGS.enabled, `输入 ${JSON.stringify(bad)} 应回落到默认值`);
		assert.equal(
			merged.s3.objectKeyTemplate,
			DEFAULT_SETTINGS.s3.objectKeyTemplate,
			"坏输入下 s3 子对象也应完整回落到默认值"
		);
	}

	const wrong = mergeSettings(DEFAULT_SETTINGS, {
		enabled: "yes",
		cacheDelaySeconds: "soon",
		cacheLayout: "nonsense",
		localFileAction: "explode",
		enabledExtensions: "png",
	});
	assert.equal(wrong.enabled, true, "非布尔值应回落默认");
	assert.equal(wrong.cacheDelaySeconds, DEFAULT_SETTINGS.cacheDelaySeconds, "非数字应回落默认");
	assert.equal(wrong.cacheLayout, DEFAULT_SETTINGS.cacheLayout, "非法枚举应回落默认");
	assert.equal(wrong.localFileAction, DEFAULT_SETTINGS.localFileAction, "非法枚举应回落默认");
	assert.deepEqual(wrong.enabledExtensions, DEFAULT_SETTINGS.enabledExtensions, "非数组应回落默认");

	// ============================================================
	// 5. 枚举守卫本身要能用（供 UI 与合并共用）
	// ============================================================
	for (const good of ["flat", "byExt", "mirror"]) assert.equal(isCacheLayout(good), true, good);
	assert.equal(isCacheLayout("deep"), false);
	assert.equal(isCacheLayout(null), false);

	for (const good of ["cache", "keep", "trash", "ask"]) assert.equal(isLocalFileAction(good), true, good);
	assert.equal(isLocalFileAction("delete"), false);

	// ============================================================
	// 6. 未知字段不该被带进来（避免脏数据在 data.json 里累积）
	// ============================================================
	const withJunk = mergeSettings(DEFAULT_SETTINGS, {
		...DEFAULT_SETTINGS,
		someRemovedField: "legacy",
		s3: { ...DEFAULT_SETTINGS.s3, oldProviderKey: "x" },
	});
	assert.ok(!("someRemovedField" in withJunk), "未知的顶层字段不应被保留");
	assert.ok(!("oldProviderKey" in withJunk.s3), "s3 里未知的字段不应被保留");

	return { scalars: scalars.length };
}
