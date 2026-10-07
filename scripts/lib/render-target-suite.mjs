/**
 * 渲染目标判定（`src/render/render-target.ts`）的断言套件。
 *
 * ## 这一层的断言为什么必须严
 *
 * 它的输出决定浏览器**会不会联网**：`src` 保持远端 → 一定发请求。
 * 而"离线可用"的全部意义就是断网时图片还能解码。判错的两类后果都不报错：
 * - 该换本地却没换 → 断网时图是破的（用户以为插件坏了）
 * - 认错了站外图 → 把别人的图拉进 vault（越过了「站外图永不下载」这条红线）
 */

import assert from "node:assert/strict";

export function runRenderTargetSuite(mod) {
	const { decideRenderTarget, keyFromUrl, urlPrefixes } = mod;
	const { CacheIndex, publicUrlFor } = mod;

	const BUCKET = "my-bucket";
	const baseAddress = {
		endpoint: "https://s3.example.com",
		bucket: BUCKET,
		publicUrlBase: "https://img.example.com",
		forcePathStyle: true,
	};
	/** 没配 publicUrlBase：链接退回对象地址。 */
	const noBaseAddress = { ...baseAddress, publicUrlBase: "" };
	/** virtual-host 寻址。 */
	const vhostAddress = { ...baseAddress, publicUrlBase: "", forcePathStyle: false };

	const settingsWith = (s3) => ({
		autoUpload: true,
		enabledExtensions: ["png"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		s3,
	});

	const entryFor = (key, remoteUrl, cachePath) => ({
		key,
		cachePath,
		remoteUrl,
		size: 3,
		contentType: "image/png",
		etag: "e",
		uploadedAt: "2026-10-06T00:00:00.000Z",
		sourceName: "a.png",
	});

	// ============================================================
	// 1. 不属于我们的图一律 ignore（含"站外图永不下载"这条红线）
	// ============================================================
	const index = new CacheIndex([entryFor("k1.png", `${baseAddress.publicUrlBase}/k1.png`, "_attachment-cache/k1.png")]);
	const settings = settingsWith(baseAddress);

	for (const [label, src] of [
		["空串", ""],
		["空白", "   "],
		["非字符串", null],
		["本地资源", "app://local/abc.png"],
		["data URI", "data:image/png;base64,iVBORw0KGgo="],
		["blob", "blob:https://example.com/uuid"],
		["相对路径", "attachments/a.png"],
		["站外 http", "https://example.com/a.png"],
		["站外 https（同域不同路径）", "https://img.example.com.evil.com/k1.png"],
	]) {
		const decision = decideRenderTarget({ src, settings, index });
		assert.equal(decision.action, "ignore", `${label} 不该被处理`);
	}

	// 站外图即使目标 key 与索引里某条相同也必须 ignore —— 认的是 URL 前缀，不是文件名
	assert.equal(
		decideRenderTarget({ src: "https://evil.example.net/my-bucket/k1.png", settings, index }).action,
		"ignore",
		"★ 站外图永不接管（前缀不匹配就是不匹配）"
	);

	// ⭐ 索引是**不可信输入**（`data.json` 可以被手改、也可能被旧版本写坏）：
	// 若里面有非 http 的 `remoteUrl`（例如 `"attachments/rel.png"`），
	// 而笔记里恰好有一张**相对路径**的同名图 —— 不做 http 过滤就会把那张图
	// 劫持成缓存副本，而用户原本的相对路径是能正常显示的。
	// 这条是"先过滤协议"那道守卫存在的**真正理由**（去掉它这条会红）。
	const poisoned = new CacheIndex([entryFor("rel.png", "attachments/rel.png", "_attachment-cache/rel.png")]);
	assert.equal(
		decideRenderTarget({ src: "attachments/rel.png", settings, index: poisoned }).action,
		"ignore",
		"★ 索引里存着非 http 的 remoteUrl 时，也不该劫持相对路径的图（索引是不可信输入）"
	);

	// ============================================================
	// 2. 索引命中 → local（离线可用的来源）
	// ============================================================
	const hit = decideRenderTarget({ src: `${baseAddress.publicUrlBase}/k1.png`, settings, index });
	assert.equal(hit.action, "local", "索引里有本地副本时应改用本地");
	assert.equal(hit.localPath, "_attachment-cache/k1.png");
	assert.equal(hit.key, "k1.png");
	assert.equal(hit.remoteUrl, `${baseAddress.publicUrlBase}/k1.png`, "要带回远端地址，供本地文件失效时退回");

	// 归一化比较：域名大小写、重复斜杠、尾斜杠都该命中
	for (const variant of [
		`${baseAddress.publicUrlBase}/k1.png`,
		`${baseAddress.publicUrlBase}//k1.png`,
		`${baseAddress.publicUrlBase}/k1.png/`,
		"https://IMG.example.com/k1.png",
	]) {
		assert.equal(
			decideRenderTarget({ src: variant, settings, index }).action,
			"local",
			`归一化后应命中：${variant}`
		);
	}

	// ⚠️ 但**路径的大小写必须区分** —— 对象 key 在 S3 里是大小写敏感的，
	// `K1.PNG` 与 `k1.png` 是**两个不同的对象**。把它们当成同一张，
	// 后果是"显示的是另一张图的本地副本"，比不显示更糟（静默显示错内容）。
	//
	// 我第一版测试恰好写反了（期望它命中），是这条用例自己纠正的。
	assert.equal(
		decideRenderTarget({ src: `${baseAddress.publicUrlBase}/K1.PNG`, settings, index }).action,
		"fetch",
		"★ 路径大小写不同 = 不同对象，宁可当成本地没有（去下载/回退），也不能显示成另一张图"
	);

	// ============================================================
	// 3. 属于本存储但本地没有 → fetch（交给回退下载）
	// ============================================================
	const miss = decideRenderTarget({ src: `${baseAddress.publicUrlBase}/other.png`, settings, index });
	assert.equal(miss.action, "fetch", "属于本存储但索引里没有 → 回退下载");
	assert.equal(miss.key, "other.png");

	// 没配 publicUrlBase 时，对象地址形式的链接也要认出来
	const viaObjectUrl = decideRenderTarget({
		src: publicUrlFor(noBaseAddress, "x.png"),
		settings: settingsWith(noBaseAddress),
		index: new CacheIndex(),
	});
	assert.equal(viaObjectUrl.action, "fetch", "没配 publicUrlBase 时，对象地址形式的链接也要认得出");

	// virtual-host 形式同理
	const viaVhost = decideRenderTarget({
		src: publicUrlFor(vhostAddress, "y.png"),
		settings: settingsWith(vhostAddress),
		index: new CacheIndex(),
	});
	assert.equal(viaVhost.action, "fetch", "virtual-host 形式的链接也要认得出");

	// ============================================================
	// 4. ⭐ 改了 publicUrlBase 之后，**旧链接仍要认得出来**
	//
	// 否则症状是"改完设置，之前离线能看的图全看不了了"，且不报错。
	// ============================================================
	const oldLink = publicUrlFor(noBaseAddress, "legacy.png"); // 用对象地址写的链接
	const afterAddingBase = decideRenderTarget({
		src: oldLink,
		settings: settingsWith(baseAddress), // 用户后来补上了 publicUrlBase
		index: new CacheIndex(),
	});
	assert.equal(afterAddingBase.action, "fetch", "★ 补上 publicUrlBase 后，旧的（对象地址形式）链接仍要认得出来");

	// 反向：以前配了 publicUrlBase 写的链接，用户清空该设置后 ——
	// **索引记得**（条目里存着当初写出去的 remoteUrl），所以认得出来。
	//
	// ⚠️ 但这条**只对索引里有的图成立**。索引没覆盖到的旧链接（换设备、索引被删）
	// 清空 publicUrlBase 之后就认不出来了 —— 这是**已知限制**：
	// 判定唯一的信息来源是"当前设置 + 索引"，而设置里没有"曾经用过哪些前缀"的记录。
	// 记下来是因为它属于"承诺的边界"，不是可以含糊过去的地方。
	const newLink = publicUrlFor(baseAddress, "legacy2.png");
	const indexedOldLink = decideRenderTarget({
		src: newLink,
		settings: settingsWith(noBaseAddress),
		index: new CacheIndex([entryFor("legacy2.png", newLink, "_attachment-cache/legacy2.png")]),
	});
	assert.equal(indexedOldLink.action, "local", "★ 改了/清空前缀后，索引里记得的图仍要走本地副本");

	assert.equal(
		decideRenderTarget({
			src: newLink,
			settings: settingsWith(noBaseAddress),
			index: new CacheIndex(), // 索引里没有（换设备、索引被删）
		}).action,
		"ignore",
		"⚠️ 已知限制：旧前缀的链接若连索引都没有，就无法认出（设置里没有前缀历史）—— 见模块注释"
	);

	// ============================================================
	// 5. ⭐ 往返性质：`publicUrlFor` 写出的链接必须能被 `keyFromUrl` 反推出同一个 key
	//
	// 这条覆盖了多段 key、非 ASCII、空格、`+`、`%` 这些"编码只做一次"的细节。
	// 用性质而不是逐个用例，是因为它同时守住了"写"与"读"两侧的一致性 ——
	// 任一侧改了编码方式，这条就会红。
	// ============================================================
	const trickyKeys = [
		"abc123.png",
		"dir/sub/abc.png",
		"中文 名字.png",
		"a+b.png",
		"100%.png",
		"a b+c/中文%20.png",
		"deep/a/b/c/d.png",
		"üñî.png",
		"a(1).png",
	];
	for (const address of [baseAddress, noBaseAddress, vhostAddress]) {
		for (const key of trickyKeys) {
			const url = publicUrlFor(address, key);
			assert.equal(
				keyFromUrl(url, address),
				key,
				`往返失败（publicUrlBase=${address.publicUrlBase || "(空)"}, pathStyle=${address.forcePathStyle}）：${url}`
			);
		}
	}

	// 带查询串的链接（签名 URL / 加了缓存参数）也要能反推
	assert.equal(
		keyFromUrl(`${baseAddress.publicUrlBase}/dir/abc.png?X-Amz-Signature=abc#frag`, baseAddress),
		"dir/abc.png",
		"查询串与锚点不属于 key"
	);

	// ============================================================
	// 6. 畸形与敌意输入：一律返回 null，绝不抛错
	//
	// 渲染路径上抛错会让整块笔记渲染失败 —— 为了一个认不出的链接不值得。
	// ============================================================
	for (const [label, url] of [
		["畸形百分号编码", `${baseAddress.publicUrlBase}/%zz.png`],
		["截断的编码", `${baseAddress.publicUrlBase}/%E4%B8`],
		["非字符串", 12345],
		["null", null],
		["只有前缀", `${baseAddress.publicUrlBase}/`],
		["空串", ""],
	]) {
		let thrown = null;
		let result;
		try {
			result = keyFromUrl(url, baseAddress);
		} catch (error) {
			thrown = error;
		}
		assert.equal(thrown, null, `${label} 不该抛错（渲染路径抛错会让整块笔记渲染失败）`);
		assert.equal(result, null, `${label} 应返回 null`);
	}

	// ============================================================
	// 7. 存储没配全 → 认不出任何图，但也不该抛错
	// ============================================================
	const unconfigured = { endpoint: "", bucket: "", publicUrlBase: "", forcePathStyle: true };
	assert.deepEqual(
		urlPrefixes(unconfigured),
		[],
		"什么都没配时不该凭空造出前缀（否则会把别人的图当我们自己的）"
	);
	assert.equal(
		decideRenderTarget({
			src: "https://img.example.com/k1.png",
			settings: settingsWith(unconfigured),
			index: new CacheIndex(),
		}).action,
		"ignore",
		"存储没配时不该动任何图"
	);

	// 配了 publicUrlBase 但没配端点/桶：仍能凭前缀认出自己的图（端点未填不应该让这一步也失效）
	const baseOnly = { ...unconfigured, publicUrlBase: "https://img.example.com" };
	assert.equal(
		decideRenderTarget({
			src: "https://img.example.com/some.png",
			settings: settingsWith(baseOnly),
			index: new CacheIndex(),
		}).action,
		"fetch",
		"只配了公网前缀时也要能认出自己的图（端点可以后填）"
	);

	console.log(
		"Render-target decisions passed (index hit → local; own storage without a copy → fetch; " +
			"everything else ignored including third-party images; key round-trips through publicUrlFor for " +
			"multi-segment and non-ASCII keys; malformed input never throws)."
	);
}
