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
			// ⭐ 默认按"**笔记在显示它**"（`![]()` / `<img>` —— 渲染路径那一路的语义）。
			// 要问"**只被指向**"的地址（正文里的普通链接 `[]()` / `<a>`）就显式传 `embedded: false`
			// —— 那两道形状判据只对后者施加（见 `decideExternalCache` 里 `embedded` 的说明）。
			embedded: options.embedded ?? true,
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
	// 2b. ⭐⭐ 指向**宿主自己的文本文件**（笔记 / 画布 / 数据库）的地址 → ignore
	// ============================================================
	// 判据与库里那条（`selectUploadCandidates` 的「是笔记/画布/数据库文件，不是附件」）
	// **是同一份** `isNoteLikeExtension`，理由也一样：搬下来的那份会落进库，
	// 而宿主按后缀把它当笔记索引 ⇒ 用户的库里凭空多出一篇笔记。
	// ⚠️ **两路都要拦**：`auto`（打开笔记就搬）与 `manual`（列进候选清单）。
	// 用户 2026-10-16 报的正是后者：笔记里链接的远程 `.md` 出现在了
	// 「上传附件」的清单里。
	for (const [label, src] of [
		["笔记", "https://third-party.example.net/notes/intro.md"],
		["带查询串的笔记", "https://third-party.example.net/notes/intro.md?raw=1"],
		["带锚点的笔记", "https://third-party.example.net/notes/intro.md#%E6%A0%87%E9%A2%98"],
		["大写后缀", "https://third-party.example.net/NOTES/INTRO.MD"],
		["画布", "https://third-party.example.net/boards/talk.canvas"],
		["数据库", "https://third-party.example.net/db/table.base"],
	]) {
		for (const purpose of ["auto", "manual"]) {
			assert.equal(
				decide(src, { settings: { externalImageCache: true }, purpose }).action,
				"ignore",
				`★ 指向${label}的地址不该被搬走（purpose=${purpose}）：${src}`
			);
		}
	}

	// ⚠️ 反向断言：**不许**顺手把"凡文档皆拦掉"。R15 明确要 PDF / 压缩包 / 音频进来，
	// 而 `.txt` 这类不在宿主笔记的三种后缀里，仍按原样进候选（下载时由 `text/*` 拒收）。
	for (const src of [
		"https://third-party.example.net/doc.pdf",
		"https://third-party.example.net/pack.zip",
		"https://third-party.example.net/a.mp3",
		"https://third-party.example.net/readme.txt",
	]) {
		assert.equal(decide(src).action, "cache", `★ 这些仍要能进候选（不许过度拦截）：${src}`);
	}

	// ============================================================
	// 2c. ⭐⭐ "**只被指向**"的地址必须看起来像个**文件**（闸门是 `embedded`，不是 `purpose`）
	// ============================================================
	// R15 起「普通链接一律收」（动机是 `[报告](…/report.pdf)` 这种最常见的写法），
	// 代价是候选里会混进**网页**。以前靠"下载那一步的 `text/html` 判据"兜底 ——
	// 用户 2026-10-16 实测报的正是这个代价：「上传附件」的清单里出现了笔记里的
	// **企业 wiki 页链接**（`…/wiki/资料归档管理规定?wfw…`，没有扩展名）。
	// 用户的原话：**那个文件压根就不该进列表选项** —— 它不是"搬下来失败"，而是根本不该出现。
	// ⇒ 两道判据（见下面两组），**闸门是"笔记在显示它还是只指向它"**。
	// ⚠️ **`auto` 那一路不受约束**：它处理的元素是宿主**已经渲染出来的资源**
	//（img / audio / video —— 天然全是"被显示的"），地址有没有扩展名与"它是不是图"毫无关系
	//（`/photo?id=5`、`/p/2024/10/1` 这类很常见）—— 把这条也套上去，
	// 等于让那类图**永远不被缓存**（而且不报错）。§2e 有**反向**断言守着这个边界。
	//
	// 第一道：**尾巴得有点**（没有点的尾巴是页面 / 目录 / 接口的形状）
	for (const [label, src] of [
		[
			"知识库页面（没有扩展名）",
			"https://third-party.example.net/projects/m23003/wiki/%E8%B5%84%E6%96%99%E5%BD%92%E6%A1%A3%E7%AE%A1%E7%90%86%E8%A7%84%E5%AE%9A?wework_cfm_code=x",
		],
		["没有扩展名的路径", "https://third-party.example.net/some/page"],
		["只有结尾斜杠", "https://third-party.example.net/download/"],
		["点在前面的目录里（文件名没有后缀）", "https://third-party.example.net/2024.10/notes"],
	]) {
		const d = decide(src, { purpose: "manual", embedded: false });
		assert.equal(
			d.action,
			"ignore",
			`★★ 只被指向的地址必须看起来像个文件，否则不该进清单（${label}）：${src}`
		);
		assert.ok(String(d.reason).includes("不是文件"), `★ 跳过的原因要说得出为什么（${label}）：${d.reason}`);
	}

	// ⭐⭐ 第二道：**那个后缀得像文件类型** —— `…/tree/5.1-translation_terms`（用户**第五次**实测报的：
	// GitHub 的分支名，点在 `5` 与 `1` 之间，取不出扩展名）、`…/tree/v1.2.3` 与 `…/releases/1.0`
	//（点后面是**纯数字** —— 版本号 / 编号的形状；真实文件类型不会只由数字组成：`.7z`/`.3gp` 都带字母）。
	// ⚠️⚠️ 这一道**绝不能**写成"后缀得是我们认识的类型"（白名单）：那会把类型表里没有的**真实文件**
	//（`.exe` / `.iso`）**静默**拦在清单外。用户的原话：「**如果是外部网站的文件下载链接，
	// 应该看做是附件才对**」—— §2d 那组就是它的反向断言。
	for (const [label, src] of [
		[
			"GitHub 分支名（点后面是分支名，取不出扩展名）",
			"https://github.com/maxrossello/redmine_translation_terms/tree/5.1-translation_terms",
		],
		["版本号分支（点后面是纯数字）", "https://third-party.example.net/tree/v1.2.3"],
		["版本号目录（点后面是纯数字）", "https://third-party.example.net/releases/1.0"],
		// ⚠️ 刻意**不**收"点后面是一串十六进制"那种（`…/x/ab.1f2e3d`）：它的形状与令牌形状的
		// 真实文件**无法区分**（见下面那一组），判据按"像不像文件类型"判 ⇒ 它会进候选。
	]) {
		const d = decide(src, { purpose: "manual", embedded: false });
		assert.equal(
			d.action,
			"ignore",
			`★★ 后缀不像文件类型的地址不该进清单（${label}）：${src}`
		);
		assert.ok(
			String(d.reason).includes("不是文件"),
			`★ 跳过的原因要说得出为什么（${label}）：${d.reason}`
		);
		// ⚠️ 而**同一条地址在"笔记显示它"时照旧进候选** —— 形状判据问的是"这条地址像不像文件"，
		// 只有"指向"它的时候才可判（笔记在显示一个资源时，地址长什么样与"它是不是文件"无关）。
		assert.equal(
			decide(src, { purpose: "manual", embedded: true }).action,
			"cache",
			`★ 同一条地址被**显示**时不受形状约束（${label}）`
		);
	}

	// ⭐⭐ 网页地址**一律不是候选**（R18「绝不抓网页」）——
	// 判据是 `vault-files.ts::isWebPageExtension`，它回答"这个后缀指向的是页面还是文件"：
	// **静态页面**（`html` / `htm`，即类型表里的 `text/html`，与下载端拒收网页那句**同源**）
	// 与**服务端页面**（`php` / `asp` / `jsp` / `do` / `action` … 后缀只是脚本语言的名字）。
	// ⚠️ 这一节是**用户连着三次实测**报出来的同一件事的三次收窄：
	// ① 第一次：没有扩展名的 wiki 页地址（→ 形状判据，上面那一组）；
	// ② 第二次：`…/player.html`（B站播放器的 `<iframe src>`）—— 尾巴有点、能过形状判据，
	//    但他新写的那篇 `.md` 笔记里整行都出现在「上传附件」的清单里；
	// ③ 第三次：`…/pd.jsp?id=172` —— 同样尾巴有点、后缀也不是 `text/html`，
	//    可它是**企业系统现算出来的一张页面**。用户的原话：「实际上这是一个网页地址」。
	// ⚠️ **两路都拦**：网页在 `auto` 上也搬不成（下载端必拒），列出来只是让人白勾一次。
	for (const [label, src] of [
		[
			"B站播放器页（iframe）",
			"https://player.bilibili.com/player.html?isOutside=true&aid=1055609428&bvid=BV1Zn4y19743&p=1",
		],
		["html", "https://third-party.example.net/a.html"],
		["htm", "https://third-party.example.net/a.htm"],
		["大写 + 查询串", "https://third-party.example.net/A.HTML?x=1"],
		// ⭐ 第三次实测报的那一条（连锚点里的 `#:~:text=` 碎片也照原样带上）
		[
			"服务端页面（企业系统的 pd.jsp）",
			"https://www.pmbj.com.cn/pd.jsp?id=172#:~:text=HyperWire%20%E5%8D%8F%E8%AE%AE",
		],
		["php 页面", "https://third-party.example.net/index.php?s=1"],
		["Struts 的 .do", "https://third-party.example.net/product.do?id=7"],
		["Struts2 的 .action", "https://third-party.example.net/list.action"],
		["aspx 页面", "https://third-party.example.net/show.aspx?id=9"],
	]) {
		for (const purpose of ["auto", "manual"]) {
			const d = decide(src, { settings: { externalImageCache: true }, purpose });
			assert.equal(
				d.action,
				"ignore",
				`★★ 网页地址不许进候选（R18「绝不抓网页」）：${label} · ${src} · purpose=${purpose}`
			);
			assert.ok(String(d.reason).includes("网页"), `★ 原因要说得出是网页（${label}）：${d.reason}`);
		}
	}

	// ⚠️ 反向之一：**不许顺手把"凡文本皆拦掉"** —— `.txt` / `.csv` / `.json` / `.xml` 那类
	// 后缀写的就是**一个文件**（能不能缓存由服务端的真实 Content-Type 说了算），
	// 而不是"页面"（`php` / `jsp` 那种后缀只是脚本语言的名字，内容现算）。
	// 这条与上面那条互为边界，两个方向各有一条锚点守着。
	for (const src of [
		"https://third-party.example.net/readme.txt",
		"https://third-party.example.net/data.csv",
		"https://third-party.example.net/config.json",
		"https://third-party.example.net/feed.xml",
	]) {
		assert.equal(
			decide(src, { purpose: "manual", embedded: false }).action,
			"cache",
			`★ 真实文件后缀不该被顺手拦掉（它不一定是网页）：${src}`
		);
	}

	// ⚠️ 反向之二：**脚本文件 ≠ 页面程序**。`py` / `rb` / `pl` 不在"页面"那一批里 ——
	// `…/train.py` 是可以下载的源码文件，而 `…/pd.jsp?id=172` 是现算出来的一张页面。
	// 这一条钉住的是"页面后缀集合别扩成'凡代码后缀皆拦'"。
	for (const src of [
		"https://third-party.example.net/scripts/train.py",
		"https://third-party.example.net/src/main.rb",
	]) {
		assert.equal(
			decide(src, { purpose: "manual", embedded: false }).action,
			"cache",
			`★ 脚本文件（可下载的源码）不是页面，别一起拦掉：${src}`
		);
	}

	// ⭐⭐ 而**外部网站的文件下载链接照旧是附件候选**（用户 2026-10-16 的原话：
	// 「如果是外部网站的文件下载链接，应该看做是附件才对」）——
	// 那些闸门**绝不许**扩成"普通链接一律不收"：`[下载](…/setup.zip)` 这种写法
	// 正是 R15 要覆盖的最常见场景（PDF / 压缩包 / 音频）。
	// ⚠️ 这一组全按"**只被指向**"问（`embedded: false`），也就是最严的那一档。
	// ⚠️ 2026-10-21（D-58）：`exe` / `iso` **已经从这里移走**（程序分发，见下一组）——
	// 但"类型表外的真实资料照旧算候选"这条边界没变，由下一组的反向断言守着。
	for (const [label, src] of [
		["PDF", "https://third-party.example.net/report.pdf"],
		["压缩包", "https://third-party.example.net/files/setup.zip"],
		["音频", "https://third-party.example.net/track.mp3"],
		["表格", "https://third-party.example.net/data.xlsx"],
		// `7z` 也是"点后面带字母"的写法（防"后缀不许是数字开头"之类的顺手收严把它误伤）
		["7z 压缩包", "https://third-party.example.net/backup.7z"],
		// ⭐ 类型表里**没有**、但确实是一份资料的（D-58 的反向：黑名单不是白名单）
		["PSD 工程文件（类型表外）", "https://third-party.example.net/design/封面.psd"],
		["CAD 图纸（类型表外）", "https://third-party.example.net/drawings/bracket.dwg"],
		// ⚠️ `.bin` **刻意不在黑名单里**：它同时是固件 / 裸数据（这个插件的作者就在做 FPGA），
		// 拦掉会让真实资料静默消失 —— 而"多列一条"至少用户看得见、勾得掉。
		["固件 / 裸数据（类型表外，且不是安装包）", "https://third-party.example.net/fw/bitstream.bin"],
	]) {
		assert.equal(
			decide(src, { purpose: "manual", embedded: false }).action,
			"cache",
			`★★ 外部站点的文件下载链接**照旧算候选**（别把闸门扩成"普通链接一律不收"）：${label} · ${src}`
		);
	}

	// ⭐⭐ 2026-10-21（D-58）**安装包 / 可执行程序 / 系统镜像不是笔记资料** —— 两路都拦。
	//
	// 现场：用户笔记里写着 `[下载地址](https://…/Cherry-Studio-0.9.19-setup.exe)`，
	// 「上传附件」的清单把这条 **84.6 MB** 的安装包列了出来（真机 HEAD 实测：
	// `application/octet-stream` + `Content-Disposition: attachment`）。确认后会下载 84 MB、
	// 传进桶、库里留一份 84 MB 副本，并把「下载地址」改成桶地址。
	// ⚠️ 判据是**黑名单**（`vault-files.ts::isProgramExtension`），只管程序分发 ——
	// 上面那一组里 `.psd` / `.dwg` / `.bin` 照旧算候选，两边互为边界。
	// ⚠️ **两路都拦**：笔记"显示"一个 `.exe` 同样没有意义（`![]` 渲染不出来），
	// 所以这条判据不挂在 `embedded` 上（与那两道**形状**判据的区别就在这里：一个问"是不是资料"，
	// 一个问"像不像文件"）。
	for (const [label, src] of [
		["Windows 安装包（括号里带编码的中文路径，就是用户那条的等价物）", "https://third-party.example.net/d/netdisk/04(%E8%BD%AF%E4%BB%B6)/setup.exe"],
		["MSI 安装包", "https://third-party.example.net/tools/app.msi"],
		["msix 安装包", "https://third-party.example.net/tools/app.msix"],
		["macOS 磁盘映像", "https://third-party.example.net/tools/app.dmg"],
		["macOS 安装包", "https://third-party.example.net/tools/app.pkg"],
		["deb 包", "https://third-party.example.net/deb/app.deb"],
		["rpm 包", "https://third-party.example.net/rpm/app.rpm"],
		["Android 安装包", "https://third-party.example.net/android/app.apk"],
		["AppImage", "https://third-party.example.net/linux/app.AppImage"],
		["光盘映像", "https://third-party.example.net/os/ubuntu.iso"],
		["磁盘映像", "https://third-party.example.net/img/disk.vhdx"],
	]) {
		for (const embedded of [false, true]) {
			const d = decide(src, { purpose: "manual", embedded });
			assert.equal(
				d.action,
				"ignore",
				`★★ 安装包/镜像不许进候选（它不是笔记资料）：${label} · embedded=${embedded}`
			);
			assert.ok(
				String(d.reason).includes("安装包"),
				`★ 原因要说得出是安装包/镜像（${label}）：${d.reason}`
			);
		}
	}
	// ⚠️ 反向：**别把"可执行"这一条扩成"凡不认识的后缀皆拦"** —— 资料类照旧放行（见上面那一组），
	// 而 `.bin`（固件/裸数据）与 `.jar` 刻意留在黑名单外。这条断言是那一侧的守门人。
	for (const src of ["https://third-party.example.net/fw/bitstream.bin", "https://third-party.example.net/lib/app.jar"]) {
		assert.equal(
			decide(src, { purpose: "manual", embedded: false }).action,
			"cache",
			`★ 黑名单只收程序分发：固件 / 库文件照旧算候选（拦掉会让真实资料静默消失）：${src}`
		);
	}


	// `…/th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208&h=169`）**取不出扩展名**，
	// 但它**确实是个文件**（而且是有专门落盘命名判据的一类：缓存副本必须仍叫 `…png`）。
	//
	// ⭐⭐ 它凭什么还能进候选 —— **因为笔记在显示它**（`![z](…)` / `<img src>`）：
	// 那两道形状判据问的是"这条地址像不像文件"，而这个问题**只对"只被指向"的地址才可判**。
	// 笔记在**显示**一个资源时，地址长什么样与"它是不是文件"无关（这里就是活例子）。
	// ⇒ 下面这一组刻意传 `embedded: true`；**同一批地址在 `embedded: false` 下会被拦**
	//（那是正确的：一条指向 CDN 图片的**普通链接**，从地址上确实看不出是文件）。
	for (const src of [
		"https://third-party.example.net/th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208&h=169",
		"https://third-party.example.net/a.b",
		"https://third-party.example.net/2024.10/photo.jpg",
	]) {
		assert.equal(
			decide(src, { purpose: "manual", embedded: true }).action,
			"cache",
			`★ 笔记在**显示**它时不受形状约束（后缀不可信不等于不是文件），仍要进候选：${src}`
		);
	}
	assert.equal(
		decide("https://third-party.example.net/th/id/OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA?w=208", {
			purpose: "manual",
			embedded: false,
		}).action,
		"ignore",
		"★ 同一串令牌地址**只被指向**时不算候选（从地址上看不出它是文件）"
	);

	// ⭐⭐ 而**自动**那一路不许要求扩展名 —— 它遍历的是宿主**已经渲染出来的元素**
	//（`external-hook.ts` 传 `embedded: true`），所以形状判据天然不施加。
	// 这条反向断言是"闸门别放错层"的守门人。
	for (const src of [
		"https://third-party.example.net/photo?id=5",
		"https://third-party.example.net/p/2024/10/1",
	]) {
		assert.equal(
			decide(src, { settings: { externalImageCache: true } }).action,
			"cache",
			`★★ 自动那一路不许要求扩展名（元素是宿主渲染出来的真实资源）：${src}`
		);
	}

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
