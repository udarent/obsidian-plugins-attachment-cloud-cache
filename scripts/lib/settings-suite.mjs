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
	const { SETTINGS_DEFAULTS, mergePluginSettings, isCacheLayout, isLocalFileAction } = mod;

	// ============================================================
	// 1. 默认值必须体现产品定位
	// ============================================================
	assert.equal(SETTINGS_DEFAULTS.enabled, true, "插件默认应启用");
	assert.equal(SETTINGS_DEFAULTS.cacheEnabled, true, "缓存默认应开启 —— 这是本插件的核心价值");

	assert.equal(
		SETTINGS_DEFAULTS.localFileAction,
		"cache",
		"上传后本地文件默认应**移入缓存**（不是删除）—— 「本地副本即缓存」是离线可用的前提"
	);

	assert.deepEqual(
		[...SETTINGS_DEFAULTS.enabledExtensions].sort(),
		["avif", "bmp", "gif", "heic", "jpeg", "jpg", "png", "svg", "tiff", "webp"],
		"默认应启用图片格式"
	);

	assert.equal(SETTINGS_DEFAULTS.s3.objectKeyTemplate, "{hash}.{ext}", "默认对象 key 为单段内容寻址");
	assert.equal(SETTINGS_DEFAULTS.cacheLayout, "mirror", "缓存默认镜像桶内结构（单一心智模型）");
	assert.equal(SETTINGS_DEFAULTS.pasteUpload, true, "粘贴即传默认开启");
	assert.equal(SETTINGS_DEFAULTS.dropUpload, true, "拖拽即传默认开启");
	assert.equal(SETTINGS_DEFAULTS.fallbackDownload, true, "回退下载默认开启（覆盖换设备场景）");

	// ============================================================
	// 2. ⭐ 凭据绝不进 settings（必须走 SecretStorage）
	// ============================================================
	const s3Keys = Object.keys(SETTINGS_DEFAULTS.s3);
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

	// ⚠️ 只检查 SETTINGS_DEFAULTS 是不够的 —— 真正会漏的是**合并后的输出**：
	// 用户旧版本留下的 data.json 里可能就有明文密钥，合并时必须把它丢掉，
	// 而不是保留下来。这条断言正是为"合并结果也不能带凭据"而设。
	const credentialFields = ["accessKeyId", "secretAccessKey", "accessKey", "secretKey", "password"];
	const mergedWithLegacyCreds = mergePluginSettings(SETTINGS_DEFAULTS, {
		...SETTINGS_DEFAULTS,
		s3: {
			...SETTINGS_DEFAULTS.s3,
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
	assert.equal(mergedWithLegacyCreds.s3.bucket, SETTINGS_DEFAULTS.s3.bucket, "丢弃凭据不应影响其它字段");

	// ============================================================
	// 3. ⭐ 动态往返：从 SETTINGS_DEFAULTS 推导，而不是手写清单
	//
	// 手写清单会随字段增加而漂移 —— 上一轮的缺陷正是从清单的缝隙里漏过去的。
	// ============================================================
	const roundTrip = (saved) => mergePluginSettings(SETTINGS_DEFAULTS, JSON.parse(JSON.stringify(saved)));

	const scalars = Object.entries(SETTINGS_DEFAULTS).filter(
		([, v]) => typeof v === "boolean" || typeof v === "number" || typeof v === "string"
	);
	assert.ok(
		scalars.length >= 8,
		`推导出 ${scalars.length} 个标量字段，数量异常 —— 疑似 SETTINGS_DEFAULTS 结构被改动`
	);

	// 取值受限的字段必须换成**另一个合法值**，否则会被校验回落成默认值，
	// 从而误报成"不能往返"。
	const ALTERNATIVES = { cacheLayout: "byExt", localFileAction: "trash" };
	for (const key of Object.keys(ALTERNATIVES)) {
		assert.ok(key in SETTINGS_DEFAULTS, `ALTERNATIVES 里的 ${key} 已不在 SETTINGS_DEFAULTS 中（死键）`);
	}

	for (const [key, def] of scalars) {
		let custom;
		if (key in ALTERNATIVES) custom = ALTERNATIVES[key];
		else if (typeof def === "boolean") custom = !def;
		else if (typeof def === "number") custom = def + 7;
		else custom = def === "changed" ? "changed-2" : "changed";

		const merged = roundTrip({ ...SETTINGS_DEFAULTS, [key]: custom });
		assert.deepEqual(merged[key], custom, `设置项 ${key} 必须能往返持久化，不能被重置为默认值`);
	}

	// 数组字段单独钉（上面只覆盖标量）
	assert.deepEqual(
		roundTrip({ ...SETTINGS_DEFAULTS, enabledExtensions: ["png", "webp"] }).enabledExtensions,
		["png", "webp"],
		"数组字段必须能往返"
	);

	// s3 子对象逐字段往返
	const s3Merged = roundTrip({
		...SETTINGS_DEFAULTS,
		s3: {
			...SETTINGS_DEFAULTS.s3,
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
	const s3Scalars = Object.entries(SETTINGS_DEFAULTS.s3).filter(
		([, v]) => typeof v === "boolean" || typeof v === "number" || typeof v === "string"
	);
	assert.ok(
		s3Scalars.length >= 6,
		`推导出 ${s3Scalars.length} 个 s3 标量字段，数量异常 —— 疑似 S3_DEFAULTS 结构被改动`
	);
	for (const [key, def] of s3Scalars) {
		let custom;
		if (typeof def === "boolean") custom = !def;
		else if (typeof def === "number") custom = def + 3;
		else custom = def === "changed" ? "changed-2" : "changed";

		const merged = roundTrip({ ...SETTINGS_DEFAULTS, s3: { ...SETTINGS_DEFAULTS.s3, [key]: custom } });
		assert.deepEqual(merged.s3[key], custom, `s3.${key} 必须能往返持久化，不能被重置为默认值`);
	}

	// 寻址方式默认必须是 path-style：R2 的 S3 端点不支持 virtual-host，
	// 默认成 virtual-host 会让"按文档填完 R2 配置"直接不可用。
	assert.equal(
		SETTINGS_DEFAULTS.s3.forcePathStyle,
		true,
		"默认应为 path-style —— R2/MinIO/B2/Wasabi/AWS 都接受它，反过来则 R2 不可用"
	);

	// s3 里坏类型同样要回落
	const s3Wrong = mergePluginSettings(SETTINGS_DEFAULTS, {
		s3: { forcePathStyle: "yes", objectKeyTemplate: 42 },
	});
	assert.equal(s3Wrong.s3.forcePathStyle, true, "s3.forcePathStyle 非布尔应回落默认");
	assert.equal(
		s3Wrong.s3.objectKeyTemplate,
		SETTINGS_DEFAULTS.s3.objectKeyTemplate,
		"s3.objectKeyTemplate 非字符串应回落默认"
	);

	// ============================================================
	// 4. 坏输入必须安全降级（不抛错、不产生畸形状态）
	// ============================================================
	for (const bad of [null, undefined, 42, "nope", [], true]) {
		const merged = mergePluginSettings(SETTINGS_DEFAULTS, bad);
		assert.equal(merged.enabled, SETTINGS_DEFAULTS.enabled, `输入 ${JSON.stringify(bad)} 应回落到默认值`);
		assert.equal(
			merged.s3.objectKeyTemplate,
			SETTINGS_DEFAULTS.s3.objectKeyTemplate,
			"坏输入下 s3 子对象也应完整回落到默认值"
		);
	}

	const wrong = mergePluginSettings(SETTINGS_DEFAULTS, {
		enabled: "yes",
		cacheDelaySeconds: "soon",
		cacheLayout: "nonsense",
		localFileAction: "explode",
		enabledExtensions: "png",
	});
	assert.equal(wrong.enabled, true, "非布尔值应回落默认");
	assert.equal(wrong.cacheDelaySeconds, SETTINGS_DEFAULTS.cacheDelaySeconds, "非数字应回落默认");
	assert.equal(wrong.cacheLayout, SETTINGS_DEFAULTS.cacheLayout, "非法枚举应回落默认");
	assert.equal(wrong.localFileAction, SETTINGS_DEFAULTS.localFileAction, "非法枚举应回落默认");
	assert.deepEqual(wrong.enabledExtensions, SETTINGS_DEFAULTS.enabledExtensions, "非数组应回落默认");

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
	const withJunk = mergePluginSettings(SETTINGS_DEFAULTS, {
		...SETTINGS_DEFAULTS,
		someRemovedField: "legacy",
		s3: { ...SETTINGS_DEFAULTS.s3, oldProviderKey: "x" },
	});
	assert.ok(!("someRemovedField" in withJunk), "未知的顶层字段不应被保留");
	assert.ok(!("oldProviderKey" in withJunk.s3), "s3 里未知的字段不应被保留");

	// ============================================================
	// 7. ⭐ 合并结果必须是**完整**的：每个键都在、且类型正确
	//
	// 逐个字段测"能不能往返"是不够的 —— 那测不到"某个字段的读取函数把坏值
	// 或 `undefined` 透传出去"。必须在**最坏输入**下检查整体形状。
	//
	// 为什么这条要紧：`settings.s3.bucket === undefined` 这种"类型谎言"会一路
	// 传进 URL 组装与缓存路径推导，而那里未必每处都有 `?? ""` 兜底。
	// 它不会报错，只会在某个更远的地方变成一个莫名其妙的失败。
	// ============================================================
	for (const garbage of [null, undefined, 42, "nope", [], { s3: "not-an-object" }, { s3: null }]) {
		const merged = mergePluginSettings(SETTINGS_DEFAULTS, garbage);
		const label = JSON.stringify(garbage);

		for (const [key, expected] of Object.entries(SETTINGS_DEFAULTS)) {
			assert.ok(key in merged, `${label} 输入下 ${key} 必须存在（不能缺失）`);
			assert.equal(typeof merged[key], typeof expected, `${label} 输入下 ${key} 的类型应与默认值一致`);
		}
		for (const [key, expected] of Object.entries(SETTINGS_DEFAULTS.s3)) {
			assert.ok(key in merged.s3, `${label} 输入下 s3.${key} 必须存在（不能缺失）`);
			assert.equal(typeof merged.s3[key], typeof expected, `${label} 输入下 s3.${key} 的类型应与默认值一致`);
		}
	}

	// ============================================================
	// 8. ⭐ 不允许为空的字段：空串 / 纯空白必须回落默认
	//
	// 清空 `cacheFolder` 会让缓存路径推导直接返回 null ⇒ 缓存**静默失效**，
	// 而"离线可用"正是这个插件的核心价值。空值必须回落，不能当合法值收下。
	// 引用名同理：空的引用名会让凭据永远取不到，症状是"一直 403"。
	// ============================================================
	for (const emptyish of ["", "   ", "\t\n"]) {
		const label = JSON.stringify(emptyish);
		const merged = mergePluginSettings(SETTINGS_DEFAULTS, {
			cacheFolder: emptyish,
			s3: {
				region: emptyish,
				objectKeyTemplate: emptyish,
				accessKeyIdRef: emptyish,
				secretAccessKeyRef: emptyish,
			},
		});

		assert.equal(merged.cacheFolder, SETTINGS_DEFAULTS.cacheFolder, `cacheFolder 为 ${label} 时应回落默认`);
		assert.equal(merged.s3.region, SETTINGS_DEFAULTS.s3.region, `s3.region 为 ${label} 时应回落默认`);
		assert.equal(
			merged.s3.objectKeyTemplate,
			SETTINGS_DEFAULTS.s3.objectKeyTemplate,
			`s3.objectKeyTemplate 为 ${label} 时应回落默认`
		);
		assert.equal(
			merged.s3.accessKeyIdRef,
			SETTINGS_DEFAULTS.s3.accessKeyIdRef,
			`s3.accessKeyIdRef 为 ${label} 时应回落默认（空引用名会让凭据永远取不到）`
		);
		assert.equal(
			merged.s3.secretAccessKeyRef,
			SETTINGS_DEFAULTS.s3.secretAccessKeyRef,
			`s3.secretAccessKeyRef 为 ${label} 时应回落默认`
		);
	}

	// ⭐ 反向守护：`attachmentFolder` **允许**为空串 —— 它表示"跟随宿主的附件设置"，
	// 把它一并回落成默认值会让"跟随宿主"这个选项失效（而且默认值恰好也是空串，
	// 所以这条断言真正的价值在于：如果哪天有人把它改成 `requiredText`，
	// 这里会立刻红，而不是等用户在真机上发现附件都堆到根目录）。
	assert.equal(
		mergePluginSettings(SETTINGS_DEFAULTS, { attachmentFolder: "" }).attachmentFolder,
		"",
		"attachmentFolder 允许为空串（空串 = 跟随宿主的附件设置），不应被回落"
	);

	// ============================================================
	// 9. ⭐ 逐个字段喂"类型肯定不对"的值 → 必须回落
	//
	// 这一条是"逐字段播种"，与第 7 节的"整体形状"互补：
	// 第 7 节保证结果完整，这里保证**每个字段自己**会拒绝坏类型。
	//
	// 之所以要逐个来：一个组合式的坏输入用例（如前面的 `wrong`）只能覆盖它恰好
	// 写到的字段，而漏掉的那些字段一旦坏掉不会有任何症状。
	// 变异验证正是这样抓出来的 —— "字符串读取把非字符串透传"当初**一条断言都没惊动**，
	// 因为所有用例里没有一个"给文本字段喂数字"的情形。
	// ============================================================
	/** 造一个与默认值类型肯定不同的值（且不是 undefined，避免走"缺失"那条分支）。 */
	const wrongTypeFor = (value) => {
		if (typeof value === "boolean") return "yes";
		if (typeof value === "number") return "soon";
		if (typeof value === "string") return 42;
		if (Array.isArray(value)) return "not-an-array";
		return null;
	};

	for (const [key, expected] of Object.entries(SETTINGS_DEFAULTS)) {
		// `s3` 是嵌套对象，单独在后面测
		if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) continue;
		const merged = mergePluginSettings(SETTINGS_DEFAULTS, { [key]: wrongTypeFor(expected) });
		assert.deepEqual(
			merged[key],
			expected,
			`${key} 收到类型不对的值（${JSON.stringify(wrongTypeFor(expected))}）时应回落默认`
		);
	}

	for (const [key, expected] of Object.entries(SETTINGS_DEFAULTS.s3)) {
		const merged = mergePluginSettings(SETTINGS_DEFAULTS, { s3: { [key]: wrongTypeFor(expected) } });
		assert.deepEqual(
			merged.s3[key],
			expected,
			`s3.${key} 收到类型不对的值（${JSON.stringify(wrongTypeFor(expected))}）时应回落默认`
		);
	}

	// ============================================================
	// 10. ⭐ 扩展名列表的清洗细节
	//
	// 列表里的**元素**也是用户手改 data.json 时会写坏的地方，
	// 而它比"整个字段类型不对"隐蔽：一条 `42` 混在数组里不会让类型检查报错，
	// 却会一路流到 `isExtensionEnabled` 的比较里（或让 `trim()` 直接抛错）。
	// ============================================================
	// ⚠️ 自己 try/catch 并喊出规则：若实现不去过滤，`item.trim()` 会直接抛
	// `item.trim is not a function`，测试以那个类型错误收场 —— 那句话没有说清
	// "它本该把脏元素滤掉"。捕获后自己断言，失败信息才指名道姓。
	let filteredExtensions;
	try {
		filteredExtensions = mergePluginSettings(SETTINGS_DEFAULTS, {
			enabledExtensions: ["png", 42, null, "", "  ", "PNG", "webp", "png"],
		}).enabledExtensions;
	} catch (error) {
		assert.fail(
			"⭐ 扩展名列表里的脏元素必须被**过滤掉**，而不是让它们流下去或直接抛错 —— " +
				`列表元素是用户手改 data.json 时会写坏的地方。实际抛出：${error?.message ?? error}`
		);
	}
	assert.deepEqual(
		filteredExtensions,
		["png", "webp"],
		"扩展名列表应过滤非字符串与空串、统一小写，并按出现顺序去重"
	);
	assert.deepEqual(
		mergePluginSettings(SETTINGS_DEFAULTS, { enabledExtensions: [] }).enabledExtensions,
		SETTINGS_DEFAULTS.enabledExtensions,
		"⭐ 空数组等于『一个都没勾』，应回落默认 —— 否则插件看起来开着却什么都不处理"
	);
	assert.deepEqual(
		mergePluginSettings(SETTINGS_DEFAULTS, { enabledExtensions: [42, null, "   "] }).enabledExtensions,
		SETTINGS_DEFAULTS.enabledExtensions,
		"全是脏值时也应回落默认（清洗后为空 = 没填）"
	);

	return { scalars: scalars.length };
}
