/**
 * 站外缓存判定（`src/render/external-decide.ts`）的断言套件。
 *
 * ## 这一层的判错方向不对称
 *
 * - **多问** → 打扰（可忍，且用户能一键关掉）；
 * - **少问** → 功能静默失效（用户以为开了，其实什么都没发生 —— 最难查的一种）；
 * - **错问** → 对着**自己的存储**或**内网地址**弹询问（前者荒谬，后者是安全问题）。
 *
 * 所以这里穷举的不是"能不能工作"，而是**每一种输入落在哪一档**，尤其是边界：
 * 自己的端点主机、局域网自建图床、回环地址、大小写、以及"主机相同但路径不同"。
 */

import assert from "node:assert/strict";

export function runExternalDecideSuite(mod) {
	const { decideExternalCache, hostOf, ownHosts, isBlockedHost } = mod;
	const { SiteDecisions } = mod;

	const address = {
		endpoint: "https://s3.example.com",
		bucket: "my-bucket",
		publicUrlBase: "https://img.example.com",
		forcePathStyle: true,
	};

	/** 最简设置：判定只读 `externalImageCache` 与 `s3`。 */
	const settingsWith = (overrides = {}) => ({
		autoUpload: true,
		enabledExtensions: ["png"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		externalImageCache: true,
		s3: address,
		...overrides,
	});

	const withMemory = (entries) => new SiteDecisions(entries.map(([host, decision]) => ({ host, decision })));

	const decide = (src, options = {}) =>
		decideExternalCache({
			src,
			settings: settingsWith(options.settings),
			decisions: options.decisions ?? new SiteDecisions(),
			configured: options.configured ?? true,
			blockedHost: options.blockedHost,
		});

	// ============================================================
	// 1. ⭐ 功能关着 → 一律 ignore（默认关，绝不能打扰）
	// ============================================================
	const offSettings = settingsWith({ externalImageCache: false });
	for (const src of ["https://third-party.example.net/x.png", "https://other.com/a.png"]) {
		const d = decideExternalCache({
			src,
			settings: offSettings,
			decisions: new SiteDecisions(),
			configured: true,
		});
		assert.equal(d.action, "ignore", `★ 功能关着时必须 ignore（${src}）—— 默认关，不能打扰`);
	}
	// 关着时**即使记忆里是 allow** 也不该动（用户关掉的是整个功能）
	const offWithAllow = decideExternalCache({
		src: "https://third-party.example.net/x.png",
		settings: offSettings,
		decisions: withMemory([["third-party.example.net", "allow"]]),
		configured: true,
	});
	assert.equal(offWithAllow.action, "ignore", "★ 开关优先于记忆：关掉功能后，记住的站点也不该再处理");

	// ============================================================
	// 2. 不是可处理的地址 → ignore
	// ============================================================
	for (const [label, src] of [
		["空串", ""],
		["空白", "   "],
		["非字符串", 42],
		["undefined", undefined],
		["本地资源", "app://abc123/attachments/a.png"],
		["data URI", "data:image/png;base64,iVBORw0KGgo="],
		["blob", "blob:app://abc/123"],
		["相对路径", "attachments/a.png"],
		["file 协议", "file:///C:/x/a.png"],
	]) {
		assert.equal(decide(src).action, "ignore", `（${label}）不是可处理的 http(s) 地址，应 ignore`);
	}

	// 解析不出主机名的 http(s) 地址也 ignore
	assert.equal(decide("https://").action, "ignore", "（无主机名）应 ignore");
	assert.equal(decide("not a url").action, "ignore", "（不是 URL）应 ignore");

	// ============================================================
	// 3. ⭐ 自己的存储 → ignore（绝不问、绝不当站外）
	// ============================================================
	// publicUrlBase 形式
	assert.equal(decide("https://img.example.com/k1.png").action, "ignore", "★ 自己存储的链接（公网前缀）不该被当站外");
	// 对象地址形式
	assert.equal(
		decide("https://s3.example.com/my-bucket/k1.png").action,
		"ignore",
		"★ 自己存储的链接（端点+桶）不该被当站外"
	);
	// ⭐ 主机相同但路径不匹配（换个桶）：keyFromUrl 认不出，必须靠**主机**拦住 ——
	// 对着自己的 S3 端点弹"要不要缓存这张站外图"是荒谬的。
	assert.equal(
		decide("https://s3.example.com/some-other-bucket/k.png").action,
		"ignore",
		"★ 主机匹配即视为本存储（防改过前缀/换过桶的旧链接被误当站外）"
	);
	// 主机大小写
	assert.equal(decide("https://IMG.Example.COM/k1.png").action, "ignore", "★ 主机匹配要归一大小写（IMG.Example.COM 也是本存储）");

	// ============================================================
	// 4. ⭐ 回环与链路本地 → ignore（安全）
	// ============================================================
	for (const [label, src] of [
		["localhost", "https://localhost/x.png"],
		["127.0.0.1", "http://127.0.0.1/x.png"],
		["127.x 段", "http://127.9.9.9/x.png"],
		["0.0.0.0", "http://0.0.0.0/x.png"],
		["IPv6 回环", "http://[::1]:9000/x.png"],
		["云元数据端点", "http://169.254.169.254/latest/meta-data/x.png"],
	]) {
		assert.equal(decide(src).action, "ignore", `★ 回环/链路本地地址必须 ignore（${label}）—— 不能把内网探测发出去`);
	}
	// 回环地址即使被记忆标成 allow 也必须拦（安全优先于用户设置）
	assert.equal(
		decide("http://127.0.0.1/x.png", { decisions: withMemory([["127.0.0.1", "allow"]]) }).action,
		"ignore",
		"★ 安全拦截优先于记忆：回环地址不该因为记过 allow 就被下载"
	);

	// ⭐ 但**局域网**（RFC1918）不能拦 —— 家庭 NAS / 局域网自建图床是合法用法
	for (const [label, src] of [
		["192.168.x", "http://192.168.1.10/nas/x.png"],
		["10.x", "http://10.0.0.5/x.png"],
		["172.16-31.x", "http://172.20.3.4/x.png"],
	]) {
		assert.equal(decide(src).action, "ask", `★ 局域网地址要照常询问（${label}）—— 自建图床是合法用法`);
	}

	// ============================================================
	// 5. 站点记忆
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png", {
			decisions: withMemory([["third-party.example.net", "deny"]]),
		}).action,
		"ignore",
		"★ 标记「不再询问」的站点必须 ignore"
	);
	assert.equal(
		decide("https://third-party.example.net/x.png", {
			decisions: withMemory([["third-party.example.net", "allow"]]),
		}).action,
		"cache",
		"★ 已记住的站点（allow）应直接 cache，不再弹询问"
	);
	// 大小写：记忆是小写，URL 是大写
	assert.equal(
		decide("https://THIRD-PARTY.Example.NET/x.png", {
			decisions: withMemory([["third-party.example.net", "allow"]]),
		}).action,
		"cache",
		"★ 记忆查询要归一化大小写（用户答过一次就该一直生效）"
	);
	// 端口与主机要区分
	assert.equal(
		decide("https://third-party.example.net:8443/x.png", {
			decisions: withMemory([["third-party.example.net", "deny"]]),
		}).action,
		"ask",
		"★ 带端口的主机与不带端口的是两个站点（合并会让本地测试的决定作用到生产）"
	);

	// ============================================================
	// 6. 未配置 → ignore（渲染路径上不能刷屏）
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png", { configured: false }).action,
		"ignore",
		"★ 未配置时不该询问（渲染路径上每张图都会走到这里）"
	);
	// 未配置也**不能**落到 cache（那会去下载+上传，而根本没有客户端）
	assert.equal(
		decide("https://third-party.example.net/x.png", {
			configured: false,
			decisions: withMemory([["third-party.example.net", "allow"]]),
		}).action,
		"cache",
		"（记忆为 allow 时判定层给 cache —— 执行层会自己复核「未配置」并静默退出）"
	);

	// ============================================================
	// 7. 首次遇到 → ask
	// ============================================================
	const first = decide("https://third-party.example.net/x.png");
	assert.equal(first.action, "ask", "★ 首次遇到的站外图应询问");
	assert.equal(first.host, "third-party.example.net", "ask 必须带上主机名（询问文案要显示它）");

	// ⭐ 认主机，不认文件名：长得像但不是同一台主机
	const lookalike = decide("https://img.example.com.evil.com/k1.png");
	assert.equal(lookalike.action, "ask", "★ 只认主机不认文件名（`img.example.com.evil.com` 是另一个站点）");
	assert.equal(lookalike.host, "img.example.com.evil.com", "主机要如实取出");

	// ============================================================
	// 8. blockedHost 可被覆写（接缝）
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png", { blockedHost: () => true }).action,
		"ignore",
		"blockedHost 接缝应能拦下任意主机"
	);

	// ============================================================
	// 9. 三个辅助函数本身
	// ============================================================
	assert.deepEqual(
		[...ownHosts(address)].sort(),
		["img.example.com", "s3.example.com"],
		"ownHosts 要同时包含 publicUrlBase 与端点两种主机"
	);
	assert.deepEqual([...ownHosts({ ...address, publicUrlBase: "" })], ["s3.example.com"], "只配端点时应只有端点主机");

	assert.equal(hostOf("https://img.example.com/k1.png"), "img.example.com", "hostOf 取主机");
	assert.equal(hostOf("https://img.example.com:8443/k1.png"), "img.example.com:8443", "hostOf 保留端口");
	assert.equal(hostOf("https://"), "", "hostOf 对无主机返回空串");
	assert.equal(hostOf("nonsense"), "", "hostOf 对非 URL 返回空串");
	assert.equal(hostOf(null), "", "hostOf 对非字符串返回空串");

	for (const blocked of ["127.0.0.1", "127.1.2.3", "localhost", "localhost:8080", "0.0.0.0", "[::1]", "[::1]:9000", "169.254.1.1"]) {
		assert.equal(isBlockedHost(blocked), true, `isBlockedHost 应拦住 ${blocked}`);
	}
	for (const allowed of ["example.com", "192.168.1.10", "10.0.0.5", "172.20.3.4", "169.253.1.1", "[::2]", ""]) {
		assert.equal(isBlockedHost(allowed), false, `isBlockedHost 不该拦 ${allowed}（局域网自建图床是合法用法）`);
	}
}
