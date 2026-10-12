/**
 * 站外文件判定（`src/render/external-decide.ts`）的断言套件。
 *
 * ## 这一层的判错方向不对称
 *
 * - **多问** → 打扰（可忍，且用户能一键关掉）；
 * - **少问** → 功能静默失效（用户以为开了，其实什么都没发生 —— 最难查的一种）；
 * - **错问** → 对着**自己的存储**或**内网地址**弹询问（前者荒谬，后者是安全问题）。
 *
 * 所以这里穷举的不是"能不能工作"，而是**每一种输入落在哪一档**，尤其是边界：
 * 自己的端点主机、局域网自建图床、回环地址、大小写、以及"主机相同但路径不同"。
 *
 * ## ⭐ 1.2.0 起多了"谁在问"这一维（`purpose`）
 *
 * 同一个地址，**自动**处理与**列候选**会得到不同答案：
 * - `auto`：受功能开关与站点名单约束；
 * - `manual`：两者都不管（勾选 / 点确认本身就是显式动作）。
 *
 * 所以下面每一组都点明"它在问哪一路"。少了这句话，"把开关（或名单）也套到
 * 显式工具上"这类改动不会被任何断言抓住 —— 而它的后果正是**入口消失**：
 * 关掉自动处理的人会连「挑选要缓存的文件」一起失去。
 */

import assert from "node:assert/strict";

export function runExternalDecideSuite(mod) {
	const {
		decideExternalCache,
		hostOf,
		ownHosts,
		isBlockedHost,
		normalizeSiteEntry,
		parseSiteList,
		matchesSiteList,
		siteListAllows,
	} = mod;

	const address = {
		endpoint: "https://s3.example.com",
		bucket: "my-bucket",
		publicUrlBase: "https://img.example.com",
		forcePathStyle: true,
	};

	/** 最简设置：判定读 `externalImageCache` / `externalSiteMode` / `externalSiteList` 与 `s3`。 */
	const settingsWith = (overrides = {}) => ({
		autoUpload: true,
		enabledExtensions: ["png"],
		localCopy: "keep",
		fallbackDownload: true,
		externalImageCache: true,
		externalSiteMode: "off",
		externalSiteList: [],
		s3: address,
		...overrides,
	});

	const decide = (src, options = {}) =>
		decideExternalCache({
			src,
			settings: settingsWith(options.settings),
			configured: options.configured ?? true,
			// 默认按**自动**那一路问；要问显式工具就显式传 `purpose: "manual"`。
			purpose: options.purpose ?? "auto",
			blockedHost: options.blockedHost,
		});

	// ============================================================
	// 1. ⭐ 功能关着 → **自动**那一路一律 ignore（默认关，绝不能打扰）
	// ============================================================
	for (const src of ["https://third-party.example.net/x.png", "https://other.com/a.png"]) {
		const d = decide(src, { settings: { externalImageCache: false } });
		assert.equal(d.action, "ignore", `★ 功能关着时必须 ignore（${src}）—— 默认关，不能打扰`);
	}

	// ⭐⭐ 但**显式工具不受开关约束**（1.2.0）：关掉自动处理的人照样能用
	// 「挑选要缓存的文件」手动挑。少了这条，"合并成一个开关"就会把那个入口一起关掉 ——
	// 而"只想手动挑几张"恰恰是最常见的用法之一。
	assert.equal(
		decide("https://third-party.example.net/x.png", {
			settings: { externalImageCache: false },
			purpose: "manual",
		}).action,
		"cache",
		"★★ 显式工具不受开关约束：关掉开关后「挑选要缓存的文件」仍要列得出候选"
	);

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
	// 3. ⭐ 自己的存储 → ignore（绝不当站外）
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
	// 对着自己的 S3 端点问"要不要缓存这张站外图"是荒谬的。
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
	// ⭐ 把回环地址写进**白名单**也不能放行：名单是"自动搬的准入"，`isBlockedHost` 才是安全边界。
	assert.equal(
		decide("http://127.0.0.1/x.png", {
			settings: { externalSiteMode: "allowlist", externalSiteList: ["127.0.0.1"] },
		}).action,
		"ignore",
		"★ 安全拦截优先于名单：回环地址写进白名单也**不是**可以下载的（名单越不过这道）"
	);

	// ⭐ 但**局域网**（RFC1918）不能拦 —— 家庭 NAS / 局域网自建图床是合法用法
	for (const [label, src] of [
		["192.168.x", "http://192.168.1.10/nas/x.png"],
		["10.x", "http://10.0.0.5/x.png"],
		["172.16-31.x", "http://172.20.3.4/x.png"],
	]) {
		assert.equal(decide(src).action, "cache", `★ 局域网地址照常算可搬的（${label}）—— 自建图床是合法用法`);
	}

	// ============================================================
	// 5. ⭐ 开关打开 + 不过滤 ⇒ **自动**那一路直接搬
	//
	// 1.2.0 之前这里还有一档「什么都不做」（`wait`）。那一档已并进开关：
	// 想让插件别自动动手，就把开关关掉（显式工具不受影响，见第 1 节）。
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png").action,
		"cache",
		"★ 开关打开 + 「所有站点」⇒ 自动处理直接搬，不再问任何问题"
	);

	// 两种用途的结果都要带主机名：命令的确认框要据此列出"即将访问哪些站点"（那就是它的披露）
	assert.equal(decide("https://third-party.example.net/x.png").host, "third-party.example.net", "要带主机名");
	assert.equal(
		decide("https://third-party.example.net/x.png", { purpose: "manual" }).host,
		"third-party.example.net",
		"显式工具那条路也要带主机名"
	);

	// 主机名照旧要归一（命令那份清单按它分组、按它披露）
	assert.equal(decide("https://THIRD-PARTY.Example.NET/x.png").host, "third-party.example.net", "主机名要归一大小写");
	assert.equal(
		decide("https://third-party.example.net:8443/x.png").host,
		"third-party.example.net:8443",
		"★ 带端口的主机与不带端口的是两个站点（披露与分组都按它分）"
	);

	// ============================================================
	// 6. ⭐⭐ 站点名单（1.2.0）：只约束**自动**那一路
	// ============================================================
	const withMode = (mode, list) => ({ settings: { externalSiteMode: mode, externalSiteList: list } });
	// ⚠️ 这些用例的主机**必须避开 `img.example.com` / `s3.example.com`** ——
	// 那两个是夹具里的自有存储主机，会被"本存储"那条判据先拦掉，
	// 于是名单根本没被问到（断言会以"本存储"的名义失败，找错方向）。
	const thirdParty = "cdn.example.com";

	// 黑名单：命中的站点不自动处理，其余照常
	assert.equal(
		decide(`https://${thirdParty}/a.png`, withMode("blocklist", ["example.com"])).action,
		"ignore",
		"★ 黑名单命中就不自动处理（写 example.com 会命中 cdn.example.com —— 按域名后缀匹配）"
	);
	assert.equal(
		decide("https://other.net/a.png", withMode("blocklist", ["example.com"])).action,
		"cache",
		"黑名单没命中 ⇒ 照常自动处理"
	);

	// 白名单：只处理名单内的
	assert.equal(
		decide(`https://${thirdParty}/a.png`, withMode("allowlist", ["example.com"])).action,
		"cache",
		"白名单命中 ⇒ 自动处理"
	);
	assert.equal(
		decide("https://other.net/a.png", withMode("allowlist", ["example.com"])).action,
		"ignore",
		"★ 白名单没命中就不自动处理"
	);
	// ⚠️ 白名单为空 = 一个站点都不自动处理（诚实的结果，不是坏值）
	assert.equal(
		decide("https://other.net/a.png", withMode("allowlist", [])).action,
		"ignore",
		"★ 白名单为空 ⇒ 什么都不自动处理"
	);
	// 「所有站点」= 不过滤（名单被忽略）
	assert.equal(
		decide("https://other.net/a.png", withMode("off", ["other.net"])).action,
		"cache",
		"「所有站点」不做过滤（名单即使填了也不生效）"
	);

	// ⭐⭐ 名单**不管**显式工具：勾选 / 点确认本身就是显式动作。
	// 少了这条，"关掉开关 + 用名单"会连手动挑选一起挡掉。
	assert.equal(
		decide(`https://${thirdParty}/a.png`, {
			...withMode("blocklist", ["example.com"]),
			purpose: "manual",
		}).action,
		"cache",
		"★★ 显式工具不受名单约束：黑名单里的站点，手动勾选照样能缓存"
	);
	assert.equal(
		decide("https://other.net/a.png", {
			...withMode("allowlist", ["example.com"]),
			purpose: "manual",
		}).action,
		"cache",
		"★★ 显式工具不受名单约束：白名单外的站点，手动勾选照样能缓存"
	);

	// ============================================================
	// 7. 未配置 → ignore（渲染路径上不能刷屏、也不该列进候选）
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png", { configured: false }).action,
		"ignore",
		"★ 未配置时不该动手（渲染路径上每张图都会走到这里）"
	);
	// ⭐ 显式工具也一样：没有客户端就拿不到文件，列进候选只会让用户勾完才发现做不成
	assert.equal(
		decide("https://third-party.example.net/x.png", { configured: false, purpose: "manual" }).action,
		"ignore",
		"★ 存储没配好时，显式工具也不该列候选（勾了也做不成）"
	);

	// ============================================================
	// 8. ⭐ 只认主机，不认文件名（清单与披露都按主机）
	// ============================================================
	const lookalike = decide("https://img.example.com.evil.com/k1.png");
	assert.equal(lookalike.action, "cache", "★ 只认主机不认文件名（`img.example.com.evil.com` 是另一个站点）");
	assert.equal(lookalike.host, "img.example.com.evil.com", "主机要如实取出");

	// ============================================================
	// 9. blockedHost 可被覆写（接缝）
	// ============================================================
	assert.equal(
		decide("https://third-party.example.net/x.png", { blockedHost: () => true }).action,
		"ignore",
		"blockedHost 接缝应能拦下任意主机"
	);

	// ============================================================
	// 10. ⭐ 名单纯函数本身（用户会怎么写、我们怎么读）
	// ============================================================
	// 归一化：整条 URL、通配前缀、大小写、末尾的点、路径与查询串
	assert.equal(normalizeSiteEntry("Example.COM"), "example.com", "归一大小写");
	assert.equal(normalizeSiteEntry("example.com."), "example.com", "去掉末尾的点（FQDN 的合法写法）");
	assert.equal(normalizeSiteEntry("  example.com  "), "example.com", "去掉首尾空白");
	assert.equal(normalizeSiteEntry("*.example.com"), "example.com", "去掉通配前缀（后缀匹配本来就覆盖）");
	assert.equal(normalizeSiteEntry(".example.com"), "example.com", "去掉前导点");
	assert.equal(normalizeSiteEntry("https://cdn.example.com/foo.png?x=1"), "cdn.example.com", "整条链接只取主机");
	assert.equal(normalizeSiteEntry("example.com:8080"), "example.com:8080", "★ 保留端口");
	assert.equal(normalizeSiteEntry("example.com/foo"), "example.com", "去掉路径");
	assert.equal(normalizeSiteEntry(""), "", "空条目归一成空串");
	assert.equal(normalizeSiteEntry(42), "", "非字符串归一成空串");

	// 解析：去重、分桶（带端口的精确匹配，其余后缀匹配）
	const parsed = parseSiteList(["Example.com", "example.com", "cdn.example.com:8080", "", "*.foo.net"]);
	assert.deepEqual(parsed.suffixes, ["example.com", "foo.net"], "去重 + 去空 + 归一后按后缀归桶");
	assert.deepEqual(parsed.exact, ["cdn.example.com:8080"], "★ 带端口的进精确桶");

	// 匹配：后缀命中、端口精确
	const list = parseSiteList(["example.com", "cdn.foo.net:8080"]);
	assert.equal(matchesSiteList(list, "example.com"), true, "同名命中");
	assert.equal(matchesSiteList(list, "img.example.com"), true, "★ 子域命中（这就是「写站点名」的意图）");
	assert.equal(matchesSiteList(list, "example.com:9000"), true, "★ 后缀条目不区分端口（同一个站点）");
	assert.equal(matchesSiteList(list, "notexample.com"), false, "★ 不做「包含」匹配（notexample.com 不是 example.com 的子域）");
	assert.equal(matchesSiteList(list, "cdn.foo.net:8080"), true, "带端口的条目要精确命中");
	assert.equal(matchesSiteList(list, "cdn.foo.net:9090"), false, "★ 端口不同即不同（条目写死了端口）");

	// siteListAllows：三档语义
	assert.equal(siteListAllows("off", ["example.com"], "img.example.com"), true, "off = 不过滤");
	assert.equal(siteListAllows("blocklist", ["example.com"], "img.example.com"), false, "黑名单命中 ⇒ 不允许");
	assert.equal(siteListAllows("blocklist", ["example.com"], "other.net"), true, "黑名单没命中 ⇒ 允许");
	assert.equal(siteListAllows("allowlist", ["example.com"], "other.net"), false, "白名单没命中 ⇒ 不允许");
	assert.equal(siteListAllows("allowlist", [], "other.net"), false, "★ 白名单为空 ⇒ 一个都不允许");
	assert.equal(siteListAllows("allowlist", ["example.com"], "example.com"), true, "白名单命中 ⇒ 允许");

	// ============================================================
	// 11. 三个辅助函数本身
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
