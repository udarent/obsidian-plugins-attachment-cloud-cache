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
		shouldShowCacheFolder,
		localCopyOptions,
		deleteModeOptions,
		classifyConnectionFailure,
		connectionFailureKey,
		classifyPublicLink,
		publicLinkKey,
		publicLinkTone,
		externalImageDefaultOptions,
		ensureSecretSlot,
		SECRET_SLOT_PREFIX,
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
		parseCredentialFile,
	} = mod;

	// ============================================================
	// 1.（已删除）扩展名解析
	//
	// 「参与的文件类型」这个设置项在 1.1.0 被删除（需求 R15：任何类型都上传），
	// 于是它的解析/格式化函数也不存在了。这一节随之移除 —— 留着一个测空函数的
	// 段落比没有测试更糟（它会让人以为那个字段还在）。
	// ============================================================

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
	// 4b. ⭐ 公开地址探测的归类（「测试连接」的第二步）
	// ============================================================
	//
	// 这一步回答的是另一个问题：「我笔记里那些链接，**别人**打得开吗？」
	// 每一类的**修法不同**，所以绝不能合并成"打不开"：
	// - 403/401：地址对、但桶私有 ⇒ 开公开读，或配一个公开访问前缀（CDN / 自定义域名）
	// - 404：地址通、对象不在 ⇒ 多半是前缀写错了（例如少了桶名）
	// - 连不上：地址本身不对 ⇒ 前缀写错了
	assert.equal(classifyPublicLink(200), "ok");
	assert.equal(classifyPublicLink(204), "ok", "2xx 都算可用");
	assert.equal(classifyPublicLink(403), "forbidden", "403 是「能连上但拒绝匿名访问」");
	assert.equal(classifyPublicLink(401), "forbidden", "401 同理（有的服务商这样表达）");
	assert.equal(classifyPublicLink(404), "missing", "404 是「地址通、对象不在」");
	assert.equal(classifyPublicLink(500), "other");
	assert.equal(classifyPublicLink(null), "unreachable", "★ 网络层失败（null）归为「连不上」");

	for (const kind of ["ok", "forbidden", "missing", "unreachable", "other"]) {
		assert.equal(publicLinkKey(kind), `testPublic_${kind}`, `每类都要有文案 key：${kind}`);
	}

	// 语气分三档：`forbidden` 只是"知道了就好"（桶私有是正当选择），
	// 而 `missing`/`unreachable` 是**地址配错了**，该去改前缀。
	// 都涂成红色会让用户以为"连接坏了"，从而去改根本没坏的东西。
	assert.equal(publicLinkTone("ok"), "ok");
	assert.equal(publicLinkTone("forbidden"), "warn", "桶私有 = 提示，不是错误");
	assert.equal(publicLinkTone("missing"), "error", "地址通则对象不在 = 前缀配错了");
	assert.equal(publicLinkTone("unreachable"), "error", "连不上 = 地址配错了");
	assert.equal(publicLinkTone("other"), "error");

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
	// ⭐ 数组型设置（`enabledExtensions`）已随 1.1.0 一起删除，所以"控件是文本框、
	// 设置是数组"这类转换只剩数字那一档（见下面的 cacheLimitMb）——
	// 那是**唯一**需要转换的字段了，它的往返由本文件后半部分的断言守着。
	assert.equal(fromControlValue("autoUpload", true), true, "普通字段原样");
	assert.equal(fromControlValue("s3.bucket", "b"), "b", "嵌套文本字段原样");

	// ⭐ 1.1.0 起**唯一**还需要转换的字段是缓存上限（设置里是数字、控件是文本框）。
	// 数组型的「参与的文件类型」已经删掉，所以这两条现在是那一整套转换机制的**唯一**牙齿 ——
	// 它坏掉时的症状最难查：界面照常显示、点了也存了，只是重开之后被打回默认值（"改了没用"）。
	assert.equal(toControlValue("cacheLimitMb", 512), "512", "★ 数字要转成文本");
	assert.equal(toControlValue("cacheLimitMb", 0), "0", "0 = 不限制，也要显示成 0");
	assert.equal(
		fromControlValue("cacheLimitMb", "512"),
		512,
		"★ 文本框的字符串必须转回数字 —— 否则下次加载时类型不符会被回落成默认值（表现为改了没用）"
	);
	assert.equal(fromControlValue("cacheLimitMb", "不是数字"), 0, "解析不出来时退回 0（不限制）");

	// ============================================================
	// 8. 哪些值可以写进设置
	// ============================================================
	assert.equal(isWritableValue("cacheFolder", "image-cache"), true, "非空目录名可写");
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
	const base = { autoUpload: true, attachmentFolder: "", localCopy: "cache", cacheFolder: "c", fallbackDownload: true };
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

	// ⭐⭐ 这个 config 是**三条构造路径唯一的来源**（入口、粘贴钩子、设置页的测试连接），
	// 所以它漏一个字段，那条功能就会**静默**失效 —— 类型系统看不出来（`S3ClientConfig`
	// 当时根本没有这个字段），端到端夹具又恰好把值设成了回退值。
	// 实际踩到：`publicUrlBase` 漏了，于是**用户配的公开前缀从未生效**，链接一直退回对象地址。
	assert.equal(
		connectionReadiness(readerWith({ s: "SECRET" }), {
			...base,
			s3: { ...s3Base, publicUrlBase: "https://cdn.example.com" },
		}).config.publicUrlBase,
		"https://cdn.example.com",
		"★ 就绪配置必须带上公开访问前缀 —— 漏掉它不会有任何报错，只会让链接悄悄退回对象地址"
	);
	assert.equal(ready.config.publicUrlBase, "", "没配前缀时应如实带空串（由 URL 组装层决定回退到对象地址）");

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
	// 3b. 「遇到外链图片时」那一档的选项（`externalImageDefaultOptions`）
	//
	// 与上面 `localCopyOptions` 同一个纪律：**由类型清单生成**，于是"界面能选的"
	// 与"类型允许的"只有一处定义。漏一个取值的后果很具体 ——
	// 用户在下拉里选不到它，而那个取值在代码里是支持的（功能静默地不可达）。
	// ============================================================
	{
		const externalOptions = externalImageDefaultOptions((value) => `label:${value}`);
		assert.deepEqual(
			Object.keys(externalOptions).sort(),
			["cache", "skip"],
			"选项集合必须与 EXTERNAL_IMAGE_DEFAULTS 完全一致（不多不少）"
		);
		assert.equal(externalOptions.skip, "label:skip", "每个取值都要有文案（少一个就是一个选不中的选项）");
		assert.equal(externalOptions.cache, "label:cache", "同上");
		// ⭐ 顺序也有意义：下拉里的第一项就是"用户第一眼看到的那个"，必须是出厂值。
		// 这里写死 `skip` 是刻意的 —— 它就是文档里写给用户的那个出厂值，
		// 改名要同时改文档、类型清单与 `settings.ts` 的出厂表（那三处由各自的断言把着）。
		assert.equal(
			Object.keys(externalImageDefaultOptions((value) => value))[0],
			"skip",
			"★ 下拉第一项必须是出厂值「什么都不做」"
		);
	}

	// ============================================================
	// 钥匙串槽位名（`ensureSecretSlot`）
	//
	// 秘密访问密钥与访问密钥 ID 是**成对**的，所以两者都在设置页同一处编辑：
	// 访问密钥 ID 是普通设置项，秘密则是**写穿**到钥匙串 ——
	// 槽位名由插件自动生成，用户看不到、也不用管（这正是不再需要 SecretComponent 的原因）。
	// ============================================================
	{
		// ⭐ 生成的名字**必须**符合 SecretStorage 的 ID 规则：小写字母、数字、短横线。
		// 这不是洁癖 —— `setSecret` 对非法 ID 会**抛错**，
		// 而"ID 不允许大写"正是把访问密钥 ID 挤出钥匙串的那个原因（见 types.ts 文件头）。
		const fresh = ensureSecretSlot("", "AB12cd34");
		assert.match(
			fresh,
			/^[a-z0-9-]+$/,
			"★ 生成的槽位名必须只含小写字母、数字、短横线（否则 setSecret 直接抛错）"
		);
		assert.ok(
			fresh.startsWith(SECRET_SLOT_PREFIX),
			"生成的槽位名要有固定前缀 —— 用户在系统的钥匙串里看到它时得能认出是谁建的"
		);
		assert.ok(fresh.includes("ab12cd34"), "随机部分要净化成小写后拼进去（传进来的是大写）");

		// 已经有槽位时**原样沿用、绝不重新生成**：换名字等于把已存的秘密丢了
		//（用户会看到"凭据被拒"，而设置页里那个框还是满的 —— 极难归因）。
		let generateCalls = 0;
		const kept = ensureSecretSlot("attachment-cloud-cache-s3-secret-abc123", () => {
			generateCalls += 1;
			return "should-not-be-used";
		});
		assert.equal(kept, "attachment-cloud-cache-s3-secret-abc123", "★ 已有槽位名要原样沿用");
		assert.equal(generateCalls, 0, "★ 已有槽位时**不该**再去生成一个（否则旧秘密被孤儿化）");

		// 纯空白视同没有（用户可能只敲了空格）
		assert.match(ensureSecretSlot("   ", "x1"), /^[a-z0-9-]+$/, "纯空白的槽位名视同没有");
		assert.notEqual(ensureSecretSlot("   ", "x1"), "   ", "纯空白不该被当成有效槽位名");

		// 随机部分里的非法字符要被清掉（不能指望传进来的东西干净）
		const dirty = ensureSecretSlot("", "a_B.C/d e");
		assert.match(dirty, /^[a-z0-9-]+$/, "★ 随机部分里的非法字符必须被清掉，而不是原样拼进去");

		// 两次生成必须不同（否则两个 vault 会共用同一条钥匙串密钥 —— 静默串味）
		assert.notEqual(ensureSecretSlot("", "aaa1"), ensureSecretSlot("", "bbb2"), "不同的随机部分要生成不同的槽位");
	}

	// ============================================================
	// 11. 外来凭据文件：认得出、且秘密**绝不**混进设置
	// ============================================================
	//
	// 这一段守两件不同的事：
	//
	// ① **认得出来** —— MinIO 控制台「下载凭据」给的是 `url`/`accessKey`/`secretKey`，
	//    而各家 SDK 用的是 `endpoint`/`accessKeyId`/`secretAccessKey`。认错一个字段名，
	//    用户看到的就是"我的文件明明是对的，插件却说认不出来"。
	//
	// ② ⭐ **秘密只走 `secret` 一个出口** —— 这是安全边界，不是风格：
	//    `patch` 里的字段会被写进 `data.json`，而那个文件随 vault 同步、备份、分享出去。

	// ── ① MinIO 控制台「下载凭据」的真实形状 ──
	const minio = parseCredentialFile(
		JSON.stringify({
			url: "https://minio.example.com:9000",
			accessKey: "MtUq3EXAMPLEKEY01",
			secretKey: "wGSmzEXAMPLEsecretKEY0000000000000",
			api: "s3v4",
			path: "auto",
		})
	);
	assert.equal(minio.ok, true, "MinIO 的凭据文件必须认得出来");
	assert.equal(minio.patch.endpoint, "https://minio.example.com:9000", "url → 服务地址");
	assert.equal(minio.patch.accessKeyId, "MtUq3EXAMPLEKEY01", "accessKey → 访问密钥 ID（可以含大写）");
	assert.equal(minio.secret, "wGSmzEXAMPLEsecretKEY0000000000000", "secretKey → 秘密（单独一个出口）");
	assert.equal(
		minio.patch.forcePathStyle,
		undefined,
		"★ path=auto（mc 的默认值）= 不覆盖 —— 当成 true 会**静默改写**用户刻意设成 false 的字段"
	);
	assert.deepEqual(minio.ignored, ["api"], "用不上的键如实回报（api 恒为 s3v4，本插件不读它）");

	// ⭐⭐ 安全边界：秘密的值**不得**出现在要给设置的那一半里。
	// 混进去不会有任何报错，只会让明文秘密落进 data.json —— 只能靠机器挡住。
	assert.ok(
		!JSON.stringify(minio.patch).includes("wGSmzEXAMPLEsecretKEY"),
		"★★ 秘密值绝不能出现在 patch 里（patch 会被写进明文的 data.json）"
	);
	for (const forbidden of ["secretAccessKey", "accessKey", "secretKey", "secret", "password"]) {
		assert.ok(!(forbidden in minio.patch), `patch 里不得有 "${forbidden}" 这个键（它属于钥匙串）`);
	}

	// ── ② 等价拼写：认得多一种，就少一次"我的文件明明是对的" ──
	const alt = parseCredentialFile(
		JSON.stringify({
			endpoint: "https://s3.example.org",
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "alt-secret",
		})
	);
	assert.equal(alt.ok, true, "SDK 风格的字段名也要认");
	assert.equal(alt.patch.endpoint, "https://s3.example.org", "endpoint 同样能当服务地址");
	assert.equal(alt.patch.accessKeyId, "AKIAIOSFODNN7EXAMPLE", "accessKeyId 同样能当访问密钥 ID");
	assert.equal(alt.secret, "alt-secret", "secretAccessKey 同样能当秘密");

	// ── ③ 寻址方式：给值才动，`auto` 不动 ──
	assert.equal(
		parseCredentialFile(JSON.stringify({ url: "https://x", path: "on" })).patch.forcePathStyle,
		true,
		"path=on → 强制 path-style"
	);
	assert.equal(
		parseCredentialFile(JSON.stringify({ url: "https://x", path: "off" })).patch.forcePathStyle,
		false,
		"path=off → 强制 virtual-host"
	);
	assert.equal(
		parseCredentialFile(JSON.stringify({ url: "https://x", path: "auto" })).patch.forcePathStyle,
		undefined,
		"path=auto 与 path=on 是**不同**的结论，不能混"
	);

	// ── ④ 值两端的空白要清掉（从浏览器里复制常见带上换行/空格）──
	const paddedValues = parseCredentialFile(JSON.stringify({ url: " https://x \n", secretKey: " s " }));
	assert.equal(paddedValues.patch.endpoint, "https://x", "★ 服务地址两端的空白要清掉");
	assert.equal(paddedValues.secret, "s", "秘密两端的空白也要清掉");

	// ── ⑤ 空串 / 纯空白 = **没填**，不是"填了个空的" ──
	const blankValues = parseCredentialFile(JSON.stringify({ url: "  ", accessKey: "  ", secretKey: "" }));
	assert.equal(blankValues.ok, false, "全是空白等于没有凭据");
	assert.equal(blankValues.problem, "noCredentials", "空白值不该被收下");

	// ── ⑥ 部分字段：文件里没有的那一项**不许**被顺手改掉 ──
	const secretOnly = parseCredentialFile(JSON.stringify({ secretKey: "only-the-secret" }));
	assert.equal(secretOnly.ok, true, "只有秘密也算一份有用的文件");
	assert.equal(secretOnly.secret, "only-the-secret", "只有秘密时也要把它交出来");
	assert.deepEqual(
		secretOnly.patch,
		{},
		"★ 只给了秘密时别的字段一个都不许动（否则会把用户已配好的地址清空）"
	);

	// ── ⑦ 三种认不出来的原因要分清（修法不同：换文件 / 换文件 / 换文件里的结构）──
	assert.equal(parseCredentialFile("not json at all").problem, "notJson", "不是 JSON");
	assert.equal(parseCredentialFile("").problem, "notJson", "空文件同样归到 notJson");
	assert.equal(parseCredentialFile(undefined).problem, "notJson", "非字符串不抛错");
	assert.equal(
		parseCredentialFile("[1, 2, 3]").problem,
		"notObject",
		"★ 数组是 JSON 但不是对象 —— 报 notObject 而不是 noCredentials（否则用户会去怀疑文件内容）"
	);
	assert.equal(parseCredentialFile('"just a string"').problem, "notObject", "标量同理");
	assert.equal(parseCredentialFile("123").problem, "notObject", "数字同理");
	assert.equal(
		parseCredentialFile(JSON.stringify({ hello: "world" })).problem,
		"noCredentials",
		"是对象但里面没有凭据字段 = 如实说没有"
	);

	// ── ⑧ 反向：不能因为"认出来了"就顺手把不相干的东西也吞掉 ──
	const extra = parseCredentialFile(
		JSON.stringify({ url: "https://x", secretKey: "s", region: "us-east-1", note: "hello" })
	);
	assert.deepEqual(extra.ignored, ["region", "note"], "认不出的键要如实列出来，而不是静默丢弃");
	assert.equal(
		extra.patch.region,
		undefined,
		"★ 不该去猜 region —— 猜错的表现是签名区域不符，而那个报错极难归因"
	);
}
