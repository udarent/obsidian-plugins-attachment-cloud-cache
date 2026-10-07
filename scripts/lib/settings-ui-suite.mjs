/**
 * 设置界面支撑模块的断言套件（与变异验证共用）。
 *
 * 覆盖三个模块：
 * - `src/ui/settings-logic.ts`   —— 扩展名解析、条件显示、选项生成、失败归类
 * - `src/ui/settings-bindings.ts` —— 声明式设置项 ↔ 设置对象的绑定
 * - `src/s3/credentials.ts`      —— 具名密钥的状态判定与连通性前置检查
 *
 * ⚠️ 断言顺序是**刻意的**：`settings-bindings` 依赖 `settings-logic` 的
 * 扩展名转换函数，所以先把 logic 的断言放在前面。否则变异 `settings-logic` 时，
 * 会先炸在 bindings 的断言上，报出来的原因与变异点不符 ——
 * 那会让"每个变异因自己的原因失败"这条纪律失效。
 */

import assert from "node:assert/strict";

export function runSettingsUiSuite(mod) {
	const {
		// settings-logic
		parseExtensionList,
		formatExtensionList,
		shouldShowCacheFolder,
		localCopyOptions,
		deleteModeOptions,
		classifyConnectionFailure,
		connectionFailureKey,
		describeRememberedSites,
		// settings-bindings
		splitKey,
		readByKey,
		writeByKey,
		toControlValue,
		fromControlValue,
		isWritableValue,
		// credentials
		credentialStatus,
		connectionReadiness,
	} = mod;

	// ============================================================
	// 1. 扩展名解析：用户会怎么敲是不确定的
	// ============================================================
	assert.deepEqual(parseExtensionList("png, jpg"), ["png", "jpg"], "逗号分隔");
	assert.deepEqual(parseExtensionList("png jpg"), ["png", "jpg"], "空格分隔（手敲常见）");
	assert.deepEqual(parseExtensionList("png、jpg"), ["png", "jpg"], "顿号分隔（从中文文档粘来常见）");
	assert.deepEqual(parseExtensionList("png\njpg"), ["png", "jpg"], "换行分隔（从列表粘来常见）");
	assert.deepEqual(parseExtensionList(".PNG, jpg"), ["png", "jpg"], "带前导点与大写都要归一");
	assert.deepEqual(parseExtensionList("png,,  ,png"), ["png"], "空段丢弃、重复去重");
	assert.deepEqual(parseExtensionList(""), [], "空串得到空列表");
	assert.deepEqual(parseExtensionList(null), [], "非字符串不抛错");
	assert.deepEqual(parseExtensionList(42), [], "数字不抛错");

	// 往返：解析再格式化再解析，结果必须一致（否则用户编辑一次就会变形）
	const roundTripList = ["png", "webp", "avif"];
	assert.deepEqual(
		parseExtensionList(formatExtensionList(roundTripList)),
		roundTripList,
		"解析与格式化必须互为可往返 —— 否则用户改一次设置就会丢项或变形"
	);
	assert.equal(formatExtensionList(null), "", "非数组格式化为空串");
	assert.equal(formatExtensionList(["png", 42, "", "webp"]), "png, webp", "格式化要过滤脏元素");

	// ============================================================
	// 2. 条件显示：一个看不见的字段不会和别的字段产生矛盾
	// ============================================================
	assert.equal(shouldShowCacheFolder("cache"), true, "移入缓存时才有缓存目录可配");
	assert.equal(shouldShowCacheFolder("keep"), false, "★ 原地保留时缓存目录必须隐藏（否则用户以为改它有用）");
	assert.equal(shouldShowCacheFolder("trash"), false, "★ 不留副本时同理");
	assert.equal(shouldShowCacheFolder("nonsense"), false, "非法值也隐藏（宁可少显示，不可误导）");
	assert.equal(shouldShowCacheFolder(undefined), false, "缺值时隐藏");

	// ============================================================
	// 3. 下拉选项必须与类型清单同源
	// ============================================================
	const options = localCopyOptions((value) => `label:${value}`);
	assert.deepEqual(
		Object.keys(options).sort(),
		["cache", "keep", "trash"],
		"选项集合必须与 LOCAL_COPY_ACTIONS 完全一致（不多不少）"
	);
	assert.equal(options.cache, "label:cache", "选项值对应文案");
	// 反向守护：`ask` 曾是合法取值但从未实现，不该再出现在界面上
	assert.equal("ask" in options, false, "★ 未实现的 ask 不该出现在选项里（假选项）");

	// ⭐ 缓存清理**没有**「删除方式」的下拉选项生成器 —— 那个备选已被去掉。
	// 这条与 `settings-suite` 里"没有 deleteMode 设置项"是同一件事的两端：
	// 设置项没了却留着选项生成器，等于给"把它接回来"留了方便。
	assert.equal(
		deleteModeOptions,
		undefined,
		"★ 不该再有「删除方式」的选项生成器（缓存清理只有一种方式：直接删除）"
	);

	// ============================================================
	// 4. 连通性失败归类
	// ============================================================
	assert.equal(classifyConnectionFailure({ kind: "auth" }), "auth");
	assert.equal(classifyConnectionFailure({ kind: "network" }), "network");
	assert.equal(classifyConnectionFailure({ kind: "notFound" }), "bucketMissing", "404 归为桶不存在");
	assert.equal(classifyConnectionFailure({ kind: "throttled" }), "throttled");
	assert.equal(classifyConnectionFailure({ kind: "server" }), "server");
	assert.equal(classifyConnectionFailure({ kind: "client" }), "other", "其它 4xx 归入 other");
	assert.equal(classifyConnectionFailure({ kind: "unknown" }), "other");
	assert.equal(classifyConnectionFailure(new Error("boom")), "other", "普通错误不能抛错，要归入 other");
	assert.equal(classifyConnectionFailure(null), "other", "null 也要安全");
	assert.equal(classifyConnectionFailure("字符串"), "other", "非对象也要安全");

	// 每类都必须有对应文案 key —— 否则界面上会显示成 key 本身
	for (const kind of ["auth", "bucketMissing", "network", "throttled", "server", "other"]) {
		assert.equal(connectionFailureKey(kind), `testFail_${kind}`, `每类失败都要有文案 key：${kind}`);
	}

	// ============================================================
	// 5. 键的解析
	// ============================================================
	assert.deepEqual(splitKey("s3.endpoint"), ["s3", "endpoint"], "点号键切段");
	assert.deepEqual(splitKey("autoUpload"), ["autoUpload"], "顶层键单段");
	assert.equal(splitKey(""), null, "空键非法");
	assert.equal(splitKey("a..b"), null, "空段非法");
	assert.equal(splitKey(".a"), null, "前导点产生空段，非法");
	assert.equal(splitKey("a."), null, "尾随点产生空段，非法");
	assert.equal(splitKey(null), null, "非字符串非法");

	// ============================================================
	// 6. 读 / 写
	// ============================================================
	const root = { autoUpload: true, s3: { endpoint: "https://x", bucket: "b" } };
	assert.equal(readByKey(root, "autoUpload"), true, "读顶层");
	assert.equal(readByKey(root, "s3.endpoint"), "https://x", "读嵌套");
	assert.equal(readByKey(root, "s3.missing"), undefined, "缺失字段返回 undefined 而不是抛错");
	assert.equal(readByKey(root, "nope.deep.path"), undefined, "路径中途不是对象也要安全");
	assert.equal(readByKey(root, "s3..x"), undefined, "非法键返回 undefined");

	assert.equal(writeByKey(root, "s3.bucket", "new-bucket"), true, "写嵌套应成功");
	assert.equal(root.s3.bucket, "new-bucket", "★ 写入必须真的落到设置对象上");
	assert.equal(writeByKey(root, "s3.nonexistent.deep", 1), false, "★ 中间路径缺失时**不创建**（避免把键写错固化进 data.json）");
	assert.equal(writeByKey(root, "s3", "string"), true, "替换整个子对象也算成功");
	assert.equal(readByKey(root, "s3"), "string", "刚才能读回来");
	// 复位，后面的用例还要用
	root.s3 = { endpoint: "https://x", bucket: "b" };

	// ============================================================
	// 7. 控件值 ↔ 设置值的转换
	// ============================================================
	assert.equal(toControlValue("autoUpload", true), true, "普通字段原样");
	assert.equal(
		toControlValue("enabledExtensions", ["png", "jpg"]),
		"png, jpg",
		"★ 数组字段要转成文本，否则文本框里会显示成 png,jpg 或 [object Object]"
	);
	assert.deepEqual(
		fromControlValue("enabledExtensions", "png, jpg"),
		["png", "jpg"],
		"★ 文本框的字符串必须转回数组 —— 否则下次加载时类型不符会被回落成默认值（表现为改了没用）"
	);
	assert.equal(fromControlValue("autoUpload", true), true, "普通字段原样");
	assert.equal(fromControlValue("s3.bucket", "b"), "b", "嵌套文本字段原样");

	// ============================================================
	// 8. 哪些值可以写进设置
	// ============================================================
	assert.equal(isWritableValue("cacheFolder", "attachments-cache"), true, "非空目录名可写");
	assert.equal(
		isWritableValue("cacheFolder", ""),
		false,
		"★ 空缓存目录不可写 —— 它会让缓存路径推不出来（缓存静默失效）"
	);
	assert.equal(isWritableValue("cacheFolder", "   "), false, "纯空白同样不可写");
	assert.equal(isWritableValue("s3.region", ""), false, "区域不能为空");
	assert.equal(isWritableValue("s3.objectKeyTemplate", ""), false, "key 模板不能为空（否则每次上传都失败）");
	assert.equal(
		isWritableValue("attachmentFolder", ""),
		true,
		"★ 反过来：附件目录**允许**为空（空 = 跟随宿主设置），不能一并拦掉"
	);
	assert.equal(
		isWritableValue("s3.accessKeyId", ""),
		true,
		"访问密钥 ID 允许为空（= 尚未填写）—— 它是普通文本框，空是有意义的状态"
	);
	assert.equal(isWritableValue("s3.secretAccessKeyRef", ""), true, "凭据名允许为空（= 尚未选择）");
	assert.equal(isWritableValue("autoUpload", false), true, "非字符串值不受空值规则影响");
	assert.equal(isWritableValue(null, "x"), false, "非法键不可写");

	// 枚举字段：只接受清单里的取值。下拉框本来只会给出合法值，所以这几条是
	// **防御性**的 —— 但"落进 `data.json` 的必须是合法值"不该依赖控件的自觉：
	// 写坏了要等下次加载时被回落成默认值才发现，而那时的症状是"改了没用"。
	assert.equal(isWritableValue("localCopy", "explode"), false, "★ 认不出的处置方式不可写（同一类字段同一套规则）");
	assert.equal(isWritableValue("localCopy", "keep"), true, "合法取值可写");
	// 那个「缓存删除方式」字段已不存在，因此不该再有任何针对它的特殊规则
	assert.equal(
		isWritableValue("deleteMode", "permanent"),
		true,
		"★ deleteMode 已不是设置项 —— 它应当走 default 分支（没有任何特例）"
	);

	// ============================================================
	// 9. 凭据状态：三种状态必须分清楚
	// ============================================================
	const readerWith = (map) => ({ getSecret: (id) => (id in map ? map[id] : null) });

	// ⭐ 访问密钥 ID 是**明文标识符**（存在设置里），不是钥匙串条目。
	//
	// 为什么它不是密钥：它是"是谁"（标识符），会出现在请求签名与服务端日志里；
	// 单独拿到它对签名毫无用处 —— 真正的秘密是 Secret Access Key。
	// 而且 **Obsidian 的密钥 ID 只能是小写字母数字加短横线**
	//（`SecretStorage.setSecret` 的 `@param id Lowercase alphanumeric ID`，非法直接抛错），
	// 而访问密钥 ID 常规就带大写（AWS 的 `AKIA…`、MinIO 生成的那种）——
	// 把它塞进密钥选择器，用户只会撞上"名字不能有大写"这堵墙。
	//
	// 所以它只有两种状态：**填了 / 没填**。"已丢失"那种状态不可能存在。
	const unset = credentialStatus(readerWith({}), { accessKeyId: "", secretAccessKeyRef: "" });
	assert.equal(unset.accessKeyIdPresent, false, "没填 = 未配置");
	assert.equal(unset.complete, false, "没填时不可能完整");

	const filled = credentialStatus(readerWith({ b: "SECRET" }), {
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKeyRef: "b",
	});
	assert.equal(filled.accessKeyIdPresent, true, "★ 带大写的访问密钥 ID 就是正常可用的（没有任何字符限制）");
	assert.equal(filled.complete, true, "两项齐了才算完整");

	// 纯空格不算填了 —— 判据与桶名那边一致。
	// 少了这条，一串空格会被当成"配好了"，然后拿它去签名、得到一个看不懂的 403。
	const blank = credentialStatus(readerWith({ b: "SECRET" }), {
		accessKeyId: "   ",
		secretAccessKeyRef: "b",
	});
	assert.equal(blank.accessKeyIdPresent, false, "★ 纯空白的访问密钥 ID 不算填了");

	// ⭐ 秘密访问密钥仍然分「没选」与「选了但已不存在」——**修法不同**，
	// 都报成"凭据未配置"会让已经配过的用户以为自己填的东西丢了。
	const secretMissing = credentialStatus(readerWith({}), {
		accessKeyId: "AKIA",
		secretAccessKeyRef: "gone",
	});
	assert.equal(
		secretMissing.secretAccessKey.state,
		"missing",
		"名字非空但取不到值 = 密钥已不存在（与 unset 是不同的状态）"
	);
	assert.equal(secretMissing.complete, false, "密钥取不到时不算完整");

	const secretUnset = credentialStatus(readerWith({}), { accessKeyId: "AKIA", secretAccessKeyRef: "" });
	assert.equal(secretUnset.secretAccessKey.state, "unset", "★ 没选秘密密钥就是 unset —— 不能报成 ok");
	assert.equal(secretUnset.complete, false, "没选秘密密钥时不可能完整");

	// 值为空串视为无效（被清空的密钥对签名同样不可用）
	const emptyValue = credentialStatus(readerWith({ b: "" }), { accessKeyId: "AKIA", secretAccessKeyRef: "b" });
	assert.equal(emptyValue.secretAccessKey.state, "missing", "空串值不算有效密钥");

	// 名字两端空白要归一（用户可能粘进带空格的）
	const padded = credentialStatus(readerWith({ b: "SECRET" }), {
		accessKeyId: "AKIA",
		secretAccessKeyRef: "  b  ",
	});
	assert.equal(padded.secretAccessKey.name, "b", "名字要去空白后再查");
	assert.equal(padded.secretAccessKey.state, "ok", "去空白后应能查到");

	// 钥匙串读取抛错不能让界面崩
	const throwing = credentialStatus(
		{
			getSecret: () => {
				throw new Error("keychain locked");
			},
		},
		{ accessKeyId: "AKIA", secretAccessKeyRef: "b" }
	);
	assert.equal(throwing.secretAccessKey.state, "missing", "读钥匙串抛错要当作取不到，而不是让设置页崩掉");

	// ============================================================
	// 10. 连通性前置检查
	// ============================================================
	const base = { autoUpload: true, enabledExtensions: ["png"], attachmentFolder: "", localCopy: "cache", cacheFolder: "c", fallbackDownload: true };
	const s3Base = { endpoint: "https://s3.example.com", region: "auto", bucket: "b", publicUrlBase: "", accessKeyId: "AKIA", secretAccessKeyRef: "s", forcePathStyle: true, objectKeyTemplate: "{hash}.{ext}" };
	const ready = connectionReadiness(readerWith({ s: "SECRET" }), { ...base, s3: s3Base });
	assert.equal(ready.ready, true, "配置齐全时应就绪");
	assert.equal(
		ready.config.accessKeyId,
		"AKIA",
		"★ 访问密钥 ID 直接来自设置（明文标识符），而不是去钥匙串换"
	);
	assert.equal(ready.config.secretAccessKey, "SECRET", "★ 秘密访问密钥必须从钥匙串换出**值**（设置里只有名字）");
	assert.equal(ready.config.bucket, "b");

	const noEndpoint = connectionReadiness(readerWith({ s: "SECRET" }), {
		...base,
		s3: { ...s3Base, endpoint: "" },
	});
	assert.equal(noEndpoint.ready, false, "缺服务地址时必须判定为未就绪（不能带着空地址去发请求）");
	assert.equal(noEndpoint.fixIn, "connection", "缺地址应指向「存储连接」");

	const noBucket = connectionReadiness(readerWith({ s: "SECRET" }), {
		...base,
		s3: { ...s3Base, bucket: "  " },
	});
	assert.equal(noBucket.ready, false, "纯空白的桶名也不算填了");
	assert.equal(noBucket.fixIn, "connection", "缺桶名同样指向「存储连接」");

	const notChosen = connectionReadiness(readerWith({}), { ...base, s3: { ...s3Base, accessKeyId: "" } });
	assert.equal(notChosen.ready, false, "没填访问密钥 ID 时必须判定为未就绪");
	assert.equal(notChosen.fixIn, "credentials", "没填访问密钥 ID → 去凭据那一栏填");

	const gone = connectionReadiness(readerWith({}), { ...base, s3: s3Base });
	assert.equal(gone.ready, false, "所选的秘密密钥已不存在时必须判定为未就绪（不能拿空凭据去请求）");
	assert.equal(gone.fixIn, "credentials", "所选密钥失效同样属于凭据问题");

	// ⭐ 秘密密钥**没选**（而不是"选了但失效"）—— 同样必须判未就绪，且提示要不同。
	//
	// ⚠️ 这条是**补出来的**：访问密钥 ID 改成明文之前，那个"访问密钥引用为空"的用例
	// 顺带覆盖了这条路径；改完之后"没选秘密密钥"一度**没有任何用例走到**，
	// 于是「把 unset 误报成 ok」这个变异会**漏过**（带着空秘密去请求 ⇒ 403）。
	// 是变异验证把这个缺口暴露出来的 —— 这也说明：改了模型之后要回头确认
	// "原来被顺带覆盖的路径，现在还有没有人走"。
	const secretNotPicked = connectionReadiness(readerWith({}), {
		...base,
		s3: { ...s3Base, secretAccessKeyRef: "" },
	});
	assert.equal(secretNotPicked.ready, false, "★ 秘密密钥没选时必须判定为未就绪（不能带着空秘密去请求）");
	assert.equal(secretNotPicked.fixIn, "credentials", "没选秘密密钥 → 去凭据那一栏选/建一条");

	// ⚠️ 这三条的**文案必须互不相同**：一个让人去填/选、一个说明所选的钥匙串密钥已不存在。
	// 都报成"凭据未配置"会让已经配过的用户以为自己填的东西丢了。
	assert.notEqual(
		gone.problem,
		notChosen.problem,
		"★ 「没填访问密钥 ID」与「所选密钥已不存在」必须是不同的提示（修法不同）"
	);
	assert.notEqual(
		secretNotPicked.problem,
		gone.problem,
		"★ 「没选秘密密钥」与「所选密钥已不存在」必须是不同的提示（修法不同）"
	);

	// ============================================================
	// 「已记住的站点」列表（`describeRememberedSites`）
	//
	// 这是用户**唯一**能撤销"此站点不再询问"的地方，所以它必须：
	// 空态说人话、两种决定显示成用户看得懂的字（而不是 `allow` / `deny`）。
	// ============================================================
	const labels = { allow: "缓存", deny: "不再询问", empty: "尚未记住任何站点。" };

	assert.equal(describeRememberedSites([], labels), "尚未记住任何站点。", "★ 空态要说人话（而不是空串）");
	assert.equal(
		describeRememberedSites([{ host: "a.example.net", decision: "allow" }], labels),
		"a.example.net — 缓存",
		"★ allow 要显示成用户看得懂的「缓存」，不能把 allow 原样给他看"
	);
	assert.equal(
		describeRememberedSites([{ host: "b.example.net", decision: "deny" }], labels),
		"b.example.net — 不再询问",
		"★ deny 要显示成「不再询问」"
	);
	assert.equal(
		describeRememberedSites(
			[
				{ host: "a.example.net", decision: "allow" },
				{ host: "b.example.net", decision: "deny" },
			],
			labels
		),
		"a.example.net — 缓存\nb.example.net — 不再询问",
		"多个站点要逐行列出（顺序沿用记忆自己的排序，落盘顺序由此稳定）"
	);
	// 不认识的决定值不能显示成"缓存"（宁可显示成否定的那个 —— 保守，用户会去检查）
	assert.equal(
		describeRememberedSites([{ host: "c.example.net", decision: "???" }], labels),
		"c.example.net — 不再询问",
		"★ 不认识的决定值要落到保守的一侧（显示成「缓存」会让用户以为它会被处理）"
	);
}
