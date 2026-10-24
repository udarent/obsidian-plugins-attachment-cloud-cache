/**
 * 维护功能的纯判定层套件：本地副本审计、引用扫描、链接改写、批量候选。
 *
 * ## 为什么这些必须穷举
 *
 * 它们决定的是**删用户的文件**与**改用户的笔记** —— 本项目里唯二不可逆的操作。
 * 判错的症状还特别安静：多删一个缓存文件没人会立刻发现（下次联网会重新下载），
 * 但改坏一条链接会立刻显示成"图没了"；而"少删"只会让磁盘慢慢变大。
 * 所以每类边界都要单独设断言，尤其是"哪些**不该**被删/被改"。
 */

import assert from "node:assert/strict";

export async function runMaintenanceSuite(mod) {
	const {
		findLinkSpans,
		planLinkRewrites,
		planCanvasRewrites,
		canvasTextTargets,
		resolveVaultTargets,
		keysInCanvasText,
		keysInText,
		stillMentionsPath,
	} = mod;
	const { selectUploadCandidates } = mod;

	const entry = (key, cachePath, size = 100) => ({
		key,
		cachePath,
		remoteUrl: `https://img.example.com/${key}`,
		size,
		contentType: "image/png",
		etag: "",
		uploadedAt: "2026-10-06T00:00:00.000Z",
		sourceName: key,
	});

	// ============================================================
	// 1.（已删除）本地副本审计 `auditCache`
	//
	// 2026-10-22（D-75，用户：「取消掉那条单独的查看附件状态的命令」）：「查看本地副本占用」
	// 那条命令退役 ⇒ `maintenance/audit.ts` 只服务它，随它一起删掉（连同 §1 / §1b 两组用例）。
	//
	// ⚠️ 这里**只留说明、不留用例**（同下面 §2 的写法）：死主题的断言永远绿，
	// 还会让人以为那条命令还在。
	// ⚠️ 它守的两件事没有跟着消失：
	// · 「索引外的文件一个都不碰」—— 仍由 `release-space` / `eviction` 的套件钉着（同一份口径）；
	// · 「引用是两半（云端地址 / 库内路径）」—— 由 `release-space-suite` 与 `eviction` 的
	//   `referencedPaths` 否决规则钉着，说明写在 `release-space.ts` 的 `referencedPaths`。
	// ============================================================

	// ============================================================
	// 2.（已删除）清理计划 `planCleanup`
	//
	// 1.2.0（D-17）取消了「清理未使用的缓存文件」这条命令（设计 §20.16 #5）⇒ `planCleanup`
	// 与它一起删掉。它的两个职责都有了新家：**自愈**已经自动化（§16），
	// 而**删未引用副本**由 R17 的询问与 `cleanup-cloud` 的对话框承担。
	//
	// ⚠️ 这里刻意**只留一句说明、不留用例**：死主题的断言永远绿，还会让人以为那条命令还在。
	// ============================================================

	// ============================================================
	// 3. 链接定位：五种写法都要找对路径段
	// ============================================================
	const spanText = [
		"![[photo.png]]",
		"![[photo2.png|600]]",
		"![[photo3.png#page=2]]",
		"![alt](attachments/photo4.png)",
		'![alt](attachments/photo5.png "标题")',
		"![](<attachments/photo 6.png>)",
		"[[note]]",
	].join("\n");
	const spans = findLinkSpans(spanText).map((span) => span.raw);
	assert.deepEqual(
		spans,
		[
			"photo.png",
			"photo2.png",
			"photo3.png",
			"attachments/photo4.png",
			"attachments/photo5.png",
			"attachments/photo 6.png",
			"note",
		],
		"五种链接写法的路径段都要取对（`|别名`、`#子路径`、标题、尖括号形式都不能被吞进去）"
	);

	// ============================================================

	// ============================================================
	// 4. 链接改写：只换路径，别名/尺寸/子路径/标题原样保留
	// ============================================================
	const RULES = [{ from: "photo2.png", to: "https://img.example.com/abc.png" }];

	// ⭐⭐ wikilink 遇上**远端 URL** 必须整条换成 Markdown。
	//
	// `![[https://…]]` 在宿主里**根本不显示**（真机实测；wiki 语法只解析库内文件），
	// 所以"只替换路径那一段"这条路对远端目标是不成立的。
	const alias = planLinkRewrites("![[photo2.png|600]]", RULES);
	assert.equal(
		alias.text,
		"![600](https://img.example.com/abc.png)",
		"★ 别名/尺寸必须保留：wikilink 装不下 URL ⇒ 整条换成 Markdown，`600` 落在 alt 位"
	);
	assert.equal(alias.count, 1);

	const subpath = planLinkRewrites("![[photo2.png#page=2]]", RULES);
	assert.equal(
		subpath.text,
		"![photo2.png](https://img.example.com/abc.png#page=2)",
		"★ 子路径必须保留（拼成 URL 片段）"
	);

	// 没有 `!` 的 wikilink 是**链接**不是嵌入，不许被升成图片
	const plainWiki = planLinkRewrites("[[photo2.png]]", RULES);
	assert.equal(
		plainWiki.text,
		"[photo2.png](https://img.example.com/abc.png)",
		"★ 原文没有 `!` 就不是嵌入，改写后也不能带 `!`"
	);

	// 没有别名时 alt 取路径最后一段（别把 `attachments/` 带进去 —— 那是路径不是名字）
	const noAlias = planLinkRewrites("![[attachments/photo2.png]]", RULES);
	assert.equal(
		noAlias.text,
		"![photo2.png](https://img.example.com/abc.png)",
		"★ 无别名时 alt 取文件名"
	);

	// ⭐ `RewriteRule.display` ⇒ 整条换形态时，alt 用**规则给的名字**（= 链接目标里的名字）。
	//
	// 用户 2026-10-14 在 Android 上报的第五件事：重复插图时宿主另落的那一份叫
	// `照片 1.png`，而我们算 key 用的是**主干名字** ⇒ 链接成了
	// `![照片 1.png](…/照片-<哈希>.png)` —— 同一个链接里两个名字不一样，
	// 而那个 ` 1` 是宿主的去重序号、根本不是用户的东西。
	const displayRule = [{ from: "照片 1.png", to: "https://img.example.com/照片-abc.png", display: "照片.png" }];
	const named = planLinkRewrites("![[照片 1.png]]", displayRule);
	assert.equal(
		named.text,
		"![照片.png](https://img.example.com/照片-abc.png)",
		"★ 显示位必须与**链接目标**一致，不能用原文件名（它带着宿主的序号）"
	);

	// ⚠️ 反向：原文本来就是 Markdown 形态时，`[]` 里那串是**用户自己写的**显示文字 ——
	// 这条路径只换"路径那一段"，显示文字一个字都不许动（也许他写的就是想显示的东西）。
	const userAlt = planLinkRewrites("![我的照片](attachments/照片 1.png)", displayRule);
	assert.equal(
		userAlt.text,
		"![我的照片](https://img.example.com/照片-abc.png)",
		"★ 用户自己写的显示文字不许被改"
	);

	// 规则没给 `display` ⇒ 退回原行为（原路径最后一段）：不关心名字的调用方一字不变。
	const noDisplay = planLinkRewrites("![[照片 1.png]]", [
		{ from: "照片 1.png", to: "https://img.example.com/x.png" },
	]);
	assert.equal(
		noDisplay.text,
		"![照片 1.png](https://img.example.com/x.png)",
		"★ 没给名字就用原文件名（老行为，不许因为新增字段而变）"
	);

	// ⭐ 同一个 `from` 上挂两条目标相同、显示名不同的规则（"主干"与"重复副本"指向同一地址）：
	// 这**不是**同名歧义 —— 歧义判据只看目标（把显示名也算进去会让链接整条改写失败）。
	const twinRules = [
		{ from: "attachments/照片.png", to: "https://img.example.com/照片-abc.png", display: "照片.png" },
		{ from: "attachments/照片 1.png", to: "https://img.example.com/照片-abc.png", display: "照片.png" },
	];
	const twinShort = planLinkRewrites("![[照片 1.png]]", twinRules);
	assert.equal(
		twinShort.text,
		"![照片.png](https://img.example.com/照片-abc.png)",
		"★ 短名匹配到两条同目标规则仍要改写（显示名不同不算歧义）"
	);

	// ⚠️⚠️ **含空格的目标没加尖括号**（Obsidian 容忍这种写法，用户手写或从别处复制很常见）
	// ⇒ 整段都算目标。用"第一个空白"当分界会把目标截成 `attachments/照片`：
	// 既不会改写它，也会让"这份文件还有人引用吗"判成**没人引用**（那会删掉仍被引用的文件）。
	const spaceyRule = [{ from: "照片 1.png", to: "https://img.example.com/照片-abc.png", display: "照片.png" }];
	const spaceyMd = planLinkRewrites("![](attachments/照片 1.png)", spaceyRule);
	assert.equal(
		spaceyMd.text,
		"![](https://img.example.com/照片-abc.png)",
		"★ 含空格的 Markdown 目标必须整段认出来（不能截成 `attachments/照片`）"
	);
	assert.equal(spaceyMd.count, 1, "★ 而且必须真的改写它");

	// 同类：含空格的目标**加标题** —— 分界只能是"引号前那个空白"，title 照样要留住。
	const spaceyTitle = planLinkRewrites('![](attachments/照片 1.png "标题")', spaceyRule);
	assert.equal(
		spaceyTitle.text,
		'![](https://img.example.com/照片-abc.png "标题")',
		"★ 含空格的目标 + 标题：只换目标那一段，标题原样留着"
	);

	// 含空格的路径 + 尖括号（Markdown 规范写法）也必须认。
	// ⚠️ 改写后**尖括号照留**：这条路径只换"目标那一段"，而尖括号是原文的写法
	//（含空格的 URL 正需要它）—— 顺手去掉它等于替用户改了他没要求改的东西。
	const angle = planLinkRewrites("![](<attachments/照片 1.png>)", spaceyRule);
	assert.equal(
		angle.text,
		"![](<https://img.example.com/照片-abc.png>)",
		"★ 尖括号形式的含空格目标：只换路径、尖括号留着"
	);

	// ⭐ 同一个解析器还管着"这份文件还有人引用吗"（`stillMentionsPath`）——
	// 上面那条截断要是发生了，这里的答案就会从 `true` 变成 `false`（文件被误删）。
	assert.equal(
		stillMentionsPath("![](attachments/照片 1.png)", "attachments/照片 1.png"),
		true,
		"★ 含空格的 Markdown 引用要算“还指着它”（判错会删掉仍被引用的文件）"
	);
	assert.equal(
		stillMentionsPath("![](attachments/照片 1.png)", "attachments/别的.png"),
		false,
		"★ 反向：不是它就不算（别把判据放宽成“看着像就算”）"
	);

	// ⭐ 反向：目标是**库内路径**时形态一个字都不动（只换路径那一段）。
	// 形态是用户或宿主选的，把别人的 wikilink 改成 Markdown 属于越权。
	const localTarget = planLinkRewrites("![[photo2.png|600]]", [
		{ from: "photo2.png", to: "attachments/photo2.png" },
	]);
	assert.equal(
		localTarget.text,
		"![[attachments/photo2.png|600]]",
		"★ 库内路径不换形态（别把用户的 wikilink 改成 Markdown）"
	);

	const titled = planLinkRewrites(
		'![alt](photo2.png "标题")',
		RULES
	);
	assert.equal(titled.text, '![alt](https://img.example.com/abc.png "标题")', "★ 标题必须保留");

	// ⭐ wikilink 的短名与 Markdown 的完整路径指向同一文件 —— 两种写法都要能换
	const both = planLinkRewrites(
		"![[photo2.png]]\n![alt](photo2)\n![x](attachments/photo2.png)",
		RULES
	);
	assert.equal(both.count, 3, "★ 短名（含不带扩展名的）与完整路径都应改到（否则老图只搬一半）");
	// ⚠️ 不能再用"文本里还有没有 photo2"来判：换成 Markdown 之后 **alt 位就是文件名**，
	// 那是给人看的名字、不是路径（宿主自己生成链接也是这么写的）。
	// 要判的是"还有没有指向本地的**目标**" ⇒ 把三条链接的目标读回来比。
	assert.deepEqual(
		findLinkSpans(both.text).map((span) => span.raw),
		[
			"https://img.example.com/abc.png",
			"https://img.example.com/abc.png",
			"https://img.example.com/abc.png",
		],
		"★ 改完之后三条链接的**目标**都必须已经在远端上"
	);

	// ⭐ 短名歧义：两个目录下有同名文件（都在候选里）→ 一条 `![[dup.png]]` 无法判断指哪个，
	// **宁可不改**（改成错的那张图比不改更糟：笔记会静默指向别的图）。
	const ambiguousRewrite = planLinkRewrites(["![[dup.png]]", "![x](a/dup.png)"].join("\n"), [
		{ from: "a/dup.png", to: "https://img.example.com/a.png" },
		{ from: "b/dup.png", to: "https://img.example.com/b.png" },
	]);
	assert.equal(ambiguousRewrite.count, 1, "★ 歧义短名不该被改（只改完整路径那一条）");
	assert.equal(
		ambiguousRewrite.text,
		["![[dup.png]]", "![x](https://img.example.com/a.png)"].join("\n"),
		"★ 歧义的短名链接要原样保留"
	);

	// 无关链接一个字都不动
	const untouched = planLinkRewrites("![[other.png]]\n[链接](https://example.com)", RULES);
	assert.equal(untouched.count, 0, "规则外的链接不该被改");
	assert.equal(untouched.text, "![[other.png]]\n[链接](https://example.com)", "未命中的文本必须逐字不变");

	// 路径写法差异（`./` 前缀、反斜杠）也要能匹配上 —— 用户手写的链接里很常见
	const sloppyPath = planLinkRewrites(
		["![a](./attachments/sloppy.png)", "![b](attachments\\\\sloppy.png)"].join("\n"),
		[{ from: "attachments/sloppy.png", to: "https://img.example.com/sloppy.png" }]
	);
	assert.equal(sloppyPath.count, 2, "★ `./` 前缀与反斜杠写法都应匹配（否则那几处会被漏掉）");
	assert.equal(
		sloppyPath.text,
		[
			"![a](https://img.example.com/sloppy.png)",
			"![b](https://img.example.com/sloppy.png)",
		].join("\n"),
		"两种写法的链接都该被换掉"
	);

	// ⭐⭐ 百分号编码与相对前缀 —— 用户 2026-10-15 实测报的那一条
	// （`../assets/Pasted%20image%2020260930162541.png` **传上去了、而笔记一处都没改**，
	// 在他那里的症状是"能识别出来、实际上没有上传"）。
	// 两侧（改写 / "还有人引用吗"）现在共用同一份归一 `linkTargetForms`：
	// 原样那一形 + 百分号解码那一形；相对前缀那一形由**短名**兜（前缀要笔记的位置才解得开）。
	{
		const encodedRule = [
			{ from: "assets/Pasted image 20260930162541.png", to: "https://img.example.com/hash.png" },
		];
		// ① 相对前缀 + 编码（用户报的那一条）
		const userCase = planLinkRewrites("![x](../assets/Pasted%20image%2020260930162541.png)", encodedRule);
		assert.equal(userCase.count, 1, "★ `%20` 编码 + `../` 相对前缀的目标必须能改写（否则就是「传上去了、笔记没变」）");
		assert.equal(userCase.text, "![x](https://img.example.com/hash.png)", "改写后是远端链接（形态与别的写法一致）");
		// ② 库内绝对路径 + 编码：走的是「完整路径」那一档（比短名可信）
		const encodedAbsolute = planLinkRewrites("![x](assets/Pasted%20image%2020260930162541.png)", encodedRule);
		assert.equal(encodedAbsolute.count, 1, "★ 编码写法在「完整路径」那一档也要对得上");
		// ③ 反向：解码之后仍不是它 ⇒ 一个字都不许动
		const encodedOther = planLinkRewrites("![x](assets/Pasted%20image%2099999999999999.png)", encodedRule);
		assert.equal(encodedOther.count, 0, "★ 解码之后仍不是它 ⇒ 不许改（判据不能放宽成「看着像就改」）");
		// ④ 文件名里**真的**带 `%20`（合法、少见）：原样那一形优先 ——
		// 否则这条链接会被指到「名字里是空格」的另一份文件上（笔记静默指向别的图）。
		const literalPercent = planLinkRewrites("![x](attachments/a%20b.png)", [
			{ from: "attachments/a%20b.png", to: "https://img.example.com/a%20b.png" },
			{ from: "attachments/a b.png", to: "https://img.example.com/a-b.png" },
		]);
		assert.equal(
			literalPercent.text,
			"![x](https://img.example.com/a%20b.png)",
			"★ 原样那一形优先（真的叫 `a%20b.png` 时不许被解码那一形抢走）"
		);
	}
	// ⚠️ 判据（"这份文件还有人引用吗"）与改写器共用归一，但**刻意更宽**：
	// 相对前缀在这里必须算「还指着它」—— 判错的代价不对称（漏认 ⇒ 删掉仍被引用的文件）。
	assert.equal(
		stillMentionsPath("![x](../assets/Pasted%20image%2020260930162541.png)", "assets/Pasted image 20260930162541.png"),
		true,
		"★ 编码 + 相对前缀也要算「还指着它」（判错会在链接还指着它的时候把文件删掉）"
	);
	assert.equal(stillMentionsPath("![x](../assets/照片 1.png)", "assets/照片 1.png"), true, "★ 带相对前缀的引用也要算");
	assert.equal(
		stillMentionsPath("![x](../assets/照片 1.png)", "assets/别的.png"),
		false,
		"★ 反向：短名比对不能宽到「凡带这个目录名都算」"
	);
	// ⭐ 歧义短名：改写器**宁可不改**，而判据必须**当成还指着它** —— 这是两侧刻意保留的差异
	assert.equal(
		stillMentionsPath("![[dup.png]]", "a/dup.png"),
		true,
		"★ 歧义短名也要算「还指着它」（保守侧：宁可不删一份）"
	);

	// 空文本/空规则
	// ⭐ 1.1.0：笔记里写 `[报告](attachments/report)`（**没写扩展名**）也要匹配上
	// `attachments/report.pdf` 那条规则 —— 否则"支持所有格式"之后，非图片附件的链接
	// 永远改不到（它一直是本地路径），而命令会报告成功。
	{
		const noExt = planLinkRewrites("[报告](attachments/report)", [
			{ from: "attachments/report.pdf", to: "https://img.example.com/hash.pdf" },
		]);
		assert.equal(noExt.count, 1, "★ 目标没写扩展名时也要匹配（归一化剥的是任意像扩展名的后缀）");
		assert.equal(noExt.text, "[报告](https://img.example.com/hash.pdf)", "改写后是远端链接");
		// 反向：无关的文件不能被牵连
		const unrelated = planLinkRewrites("[报告](attachments/other.pdf)", [
			{ from: "attachments/report.pdf", to: "https://img.example.com/hash.pdf" },
		]);
		assert.equal(unrelated.count, 0, "无关目标不该被改");
		// ⚠️ 文件名里带点、但最后一段**不是扩展名**（`report.2026-final`）时，
		// 不能把 `2026-final` 当扩展名剥掉 —— 剥了就会与规则给的真实路径对不上，
		// 于是那个附件的链接**永远不会被改写**（一直是本地路径），而命令报告成功。
		const dotted = planLinkRewrites("[x](attachments/report.2026-final)", [
			{ from: "attachments/report.2026-final.pdf", to: "https://img.example.com/h.pdf" },
		]);
		assert.equal(dotted.count, 1, "只有'像扩展名'的后缀才该被剥掉");
		assert.equal(dotted.text, "[x](https://img.example.com/h.pdf)", "改写后是远端链接");

		// 目录名里的点**不是**扩展名：`notes.v2/photo` 必须在两边都保持完整
		const dirDot = planLinkRewrites("![[notes.v2/photo.png]]", [
			{ from: "notes.v2/photo.png", to: "https://img.example.com/photo.png" },
		]);
		assert.equal(dirDot.count, 1, "目录名里的点不该影响匹配（只在最后一段剥扩展名）");
	}

	assert.deepEqual(planLinkRewrites("", RULES), { text: "", count: 0 });
	assert.deepEqual(planLinkRewrites("![[photo2.png]]", []), { text: "![[photo2.png]]", count: 0 });

	// ============================================================
	// 5. 引用扫描：只认本存储的 key
	// ============================================================
	const keyOf = (url) =>
		url.startsWith("https://img.example.com/") ? url.slice("https://img.example.com/".length).split("?")[0] : null;

	const keys = keysInText(
		"![a](https://img.example.com/one.png)\n![b](https://other.example.net/two.png)\n![[local.png]]\n" +
			"<https://img.example.com/three.png>\n文本里提到 https://img.example.com/four.png 也算",
		keyOf
	);
	assert.deepEqual(
		[...keys].sort(),
		["four.png", "one.png", "three.png"],
		"★ 只收本存储的 key（站外链接不是我们的 key，本地链接更不是）"
	);
	assert.equal(keysInText("", keyOf).size, 0, "空文本 → 空集合");
	assert.equal(keysInText("没有任何链接", keyOf).size, 0, "没有链接 → 空集合");

	// 带查询串的链接（签名 URL）也要能认出 key
	assert.deepEqual(
		[...keysInText("![a](https://img.example.com/signed.png?X-Amz-Signature=abc)", keyOf)],
		["signed.png"],
		"查询串不该影响 key 识别"
	);

	// ⭐⭐ 2026-10-22（D-63）：**惰性区域里的地址不算"仍被引用"**。
	// 这条与 `findLinkSpans` 是同一个语义（宿主不渲染 ⇒ 不是引用），但它是**另一条扫描**
	// （`keysInText` 直接扫裸 URL），所以必须各自钉住：少钉这一条，"我们生成的地址长这样"
	// 的样例就会把那个对象永久钉成"仍被引用"，云端清理永远不问它。
	{
		const URL = "https://img.example.com/stale.png";
		for (const [label, text] of [
			["围栏代码块", "```md\n![](https://img.example.com/stale.png)\n```\n"],
			["行内代码", `返回的地址是 \`${URL}\` 这样\n`],
			["HTML 注释", "<!-- ![](https://img.example.com/stale.png) -->\n"],
			["行内数学", "$https://img.example.com/stale.png$\n"],
		]) {
			assert.deepEqual(
				[...keysInText(text, keyOf)],
				[],
				`★★ 惰性区域里的地址不算引用（宿主不渲染）：${label}`
			);
		}
		// ⚠️ 反向：正常正文里的照旧算
		assert.deepEqual(
			[...keysInText(`![](https://img.example.com/stale.png)\n`, keyOf)],
			["stale.png"],
			"★ 正文里的地址照旧算（别把整篇都当成代码）"
		);
		// ⚠️ 反向：代码块**之外**的同一份地址照旧算（区间不许吃掉后面的正文）
		assert.deepEqual(
			[...keysInText("```\n![](https://img.example.com/old.png)\n```\n\n![](https://img.example.com/stale.png)\n", keyOf)].sort(),
			["stale.png"],
			"★★ 代码块之后的内容照旧算引用"
		);
	}

	// ============================================================
	// 5b. ⭐ 画布（.canvas）改写 —— 两类节点、两套规则（需求 R16）
	//
	// 画布是 JSON，但它与笔记**同等算数**。两处约束决定了这里的形状：
	// ① `file` 字段只能指向库内文件（宿主按库内路径取文件渲染）⇒ 改指搬移后的缓存路径；
	// ② `text` 节点里是 Markdown 文本（`![]()` / `![[]]`）⇒ 与笔记**完全同规则**改写。
	// 又因为画布文件是用户数据、宿主自己也写它，所以只做**文本级精确替换**。
	// ============================================================
	const canvasFileRules = [{ from: "attachments/a.png", to: "_attachment-cache/hash.png" }];
	const canvasLinkRules = [{ from: "attachments/a.png", to: "https://img.example.com/hash.png" }];

	// 5b-1. file 节点 → 新本地路径（**不能**是远端 URL）
	{
		const source = [
			"{",
			'\t"nodes": [',
			'\t\t{ "id": "1", "type": "file", "file": "attachments/a.png", "x": 0, "y": 0 },',
			'\t\t{ "id": "2", "type": "text", "text": "无关的文本", "x": 10, "y": 10 }',
			"\t],",
			'\t"edges": []',
			"}",
		].join("\n");
		const plan = planCanvasRewrites(source, { linkRules: [], fileRules: canvasFileRules });
		assert.equal(plan.count, 1, "只该有一处被改（file 节点）");
		assert.equal(plan.skipped, 0, "正常 JSON 不该有跳过的值");
		assert.ok(
			plan.text.includes('"file": "_attachment-cache/hash.png"'),
			`file 字段应改指**库内**的新路径（画布不能指向远端 URL）：${plan.text}`
		);
		// ⚠️ 只动那一个值：缩进、键顺序、其它节点必须逐字节原样
		assert.equal(
			plan.text,
			source.replace('"attachments/a.png"', '"_attachment-cache/hash.png"'),
			"★ 只该替换那一个值 —— 重新序列化会顺手改掉缩进与键顺序（用户的数据）"
		);
	}

	// 5b-2. text 节点 → 远端 URL（与笔记同一套规则）
	{
		const source = '{"nodes":[{"type":"text","text":"看图：![[a.png]] 与 ![x](attachments/a.png)"}]}';
		const plan = planCanvasRewrites(source, { linkRules: canvasLinkRules, fileRules: [] });
		assert.equal(plan.count, 1, "text 节点的内容算**一处**改写（里面两条链接一起换）");
		assert.ok(
			plan.text.includes("![a.png](https://img.example.com/hash.png)"),
			`⭐ wikilink 要整条换成 Markdown（URL 装不进 wikilink）：${plan.text}`
		);
		assert.ok(
			plan.text.includes("![x](https://img.example.com/hash.png)"),
			`⭐ 已有的 Markdown 写法也要换：${plan.text}`
		);
		assert.ok(!plan.text.includes("attachments/a.png"), "旧路径不该残留");
		// JSON 仍可解析（我们改的是**值内部**，引号/转义不能坏）
		assert.doesNotThrow(() => JSON.parse(plan.text), "改写后必须仍是合法 JSON");
	}

	// 5b-3. ⭐ 同一个附件被两类节点同时引用 → 两套规则都要生效（不互斥）
	{
		const source =
			'{"nodes":[{"type":"file","file":"attachments/a.png"},{"type":"text","text":"![[a.png]]"}]}';
		const plan = planCanvasRewrites(source, {
			linkRules: canvasLinkRules,
			fileRules: canvasFileRules,
		});
		assert.equal(plan.count, 2, "★ file 节点与 text 节点各算一处（两类规则不互斥）");
		const parsed = JSON.parse(plan.text);
		assert.equal(parsed.nodes[0].file, "_attachment-cache/hash.png", "file 节点指向新路径");
		assert.equal(
			parsed.nodes[1].text,
			"![a.png](https://img.example.com/hash.png)",
			"text 节点里的链接指向远端"
		);
	}

	// 5b-4. 含转义字符的路径：按 JSON 规则解码/编码，不写坏文件
	{
		const source = '{"nodes":[{"type":"text","text":"![[attachments/a.png]]\\n第二行"}]}';
		const plan = planCanvasRewrites(source, { linkRules: canvasLinkRules, fileRules: [] });
		assert.ok(plan.text.includes("\\n"), "⭐ 换行必须仍是转义形态（写坏了整个画布就废了）");
		assert.doesNotThrow(() => JSON.parse(plan.text), "转义处理要正确");
		assert.equal(
			JSON.parse(plan.text).nodes[0].text,
			"![a.png](https://img.example.com/hash.png)\n第二行",
			"解码后再改写，换行仍然是换行"
		);
	}

	// 5b-5. 解不开的转义 → **跳过并报出**，绝不猜（原则④）
	{
		// `\q` 不是合法 JSON 转义 ⇒ JSON.parse 会抛
		const source = '{"nodes":[{"type":"file","file":"attachments/a\\q.png"}]}';
		const plan = planCanvasRewrites(source, { linkRules: [], fileRules: canvasFileRules });
		assert.equal(plan.count, 0, "解不开就不能改（宁可不动）");
		assert.equal(plan.skipped, 1, "★ 跳过要**计数**：调用方据此如实告诉用户'有一处没改'");
		assert.equal(plan.text, source, "★ 原文本必须逐字节不变");
	}

	// 5b-6. 无规则 / 无匹配 / 空文本 ⇒ 原样返回
	{
		assert.deepEqual(
			planCanvasRewrites("{}", { linkRules: [], fileRules: [] }),
			{ text: "{}", count: 0, skipped: 0 },
			"没有规则时不做任何扫描"
		);
		assert.deepEqual(
			planCanvasRewrites("", { linkRules: canvasLinkRules, fileRules: canvasFileRules }),
			{ text: "", count: 0, skipped: 0 },
			"空文本安全返回"
		);
		const noMatch = '{"nodes":[{"type":"file","file":"attachments/other.png"}]}';
		const plan = planCanvasRewrites(noMatch, { linkRules: canvasLinkRules, fileRules: canvasFileRules });
		assert.equal(plan.count, 0, "没有匹配的引用不该改");
		assert.equal(plan.text, noMatch, "没有匹配时原文本必须逐字节不变");
	}

	// 5b-7. 同名歧义 → 宁可不改（与笔记改写同一条纪律）
	{
		const source = '{"nodes":[{"type":"file","file":"dup.png"}]}';
		const plan = planCanvasRewrites(source, {
			linkRules: [],
			fileRules: [
				{ from: "a/dup.png", to: "new/a.png" },
				{ from: "b/dup.png", to: "new/b.png" },
			],
		});
		assert.equal(plan.count, 0, "★ 同名歧义时按短名匹配会把链接改到**别的文件**上 —— 宁可不改");
	}

	// ============================================================
	// 5c. 画布文本里的引用目标 —— 用来**补齐**"引用集合"（需求 R16）
	//
	// `referencedPathsFrom` 只读宿主索引，而画布 `text` 节点里的链接是**文本内容**，
	// 宿主会不会索引它没有保证（取证点 E-1c）。少了这一路，"只被画布文本引用的附件"
	// 会被判成"没人引用"而永远不被处理 —— 与 R16 冲突，且不报错。
	// ============================================================
	{
		const canvas = [
			'{"nodes":[',
			'{"type":"text","text":"![[photo.png]] 与 [报告](attachments/report.pdf)"},',
			'{"type":"file","file":"img/a.png"}',
			']}',
		].join("");
		assert.deepEqual(
			canvasTextTargets(canvas),
			["photo.png", "attachments/report.pdf"],
			"只从 **text 节点**里取目标（file 节点那条路宿主的索引自己会认）"
		);
		assert.deepEqual(canvasTextTargets("{}"), [], "没有 text 节点 ⇒ 空");
		assert.deepEqual(
			canvasTextTargets('{"nodes":[{"type":"text","text":"这段文字里没有链接"}]}'),
			[],
			"文本里没有链接 ⇒ 空"
		);
		assert.deepEqual(canvasTextTargets(""), [], "空文本安全返回");
		assert.deepEqual(canvasTextTargets(null), [], "非字符串安全返回");
		// 解不开的转义 ⇒ 跳过（与改写器同一条纪律，绝不猜）
		assert.deepEqual(
		// ⚠️ 用 `String.raw`：普通字符串里的 `\q` 会被 JS 吃掉那个反斜杠，
		// 于是 JSON 里就变成合法内容 —— 这条断言会变成「测了个不存在的情况」。
			canvasTextTargets(String.raw`{"nodes":[{"type":"text","text":"![[a\q.png]]"}]}`),
			[],
			"解不开的 JSON 字符串要跳过，而不是猜一个目标出来"
		);
	}

	// 5d. 把目标解析成库里**真实存在**的路径（短名、缺扩展名、同名歧义）
	{
		const vault = ["attachments/photo.png", "notes/a.md", "img/logo.svg"];
		assert.deepEqual(
			[...resolveVaultTargets(["photo.png"], vault)],
			["attachments/photo.png"],
			"短名在唯一时要能对上"
		);
		assert.deepEqual(
			[...resolveVaultTargets(["attachments/photo"], vault)],
			["attachments/photo.png"],
			"没写扩展名也要能对上（与改写器同一套归一）"
		);
		assert.deepEqual([...resolveVaultTargets(["img/logo.svg"], vault)], ["img/logo.svg"], "完整路径");
		assert.deepEqual([...resolveVaultTargets(["missing.png"], vault)], [], "库里没有的不能凭空造出来");

		// ⚠️ 同名歧义 ⇒ **一个都不收**：收了就会把文件搬走，而改写器在歧义时拒绝改写
		// ⇒ 笔记/画布里那条链接一处都改不掉 ⇒ 死链。宁可少处理。
		const ambiguous = ["a/dup.png", "b/dup.png"];
		assert.deepEqual(
			[...resolveVaultTargets(["dup.png"], ambiguous)],
			[],
			"★ 同名歧义一个都不收（搬得走却改不掉 = 死链）"
		);
		assert.deepEqual(
			[...resolveVaultTargets(["a/dup.png"], ambiguous)],
			["a/dup.png"],
			"写全路径时就不存在歧义"
		);

		// ⭐ 编码写法（与正文里同一种来源）也要解析到真实文件 —— 少认一形 =
		// "只被画布文本引用的附件永远不被处理"（与需求 R16 冲突，且不报错）。
		assert.deepEqual(
			[...resolveVaultTargets(["attachments/dup%201.png"], ["attachments/dup 1.png"])],
			["attachments/dup 1.png"],
			"★ 画布文本里的编码写法也要解析到真实文件（与改写器同一份归一）"
		);
	}

	// ============================================================
	// 6. 批量上传候选：宁少不多
	// ============================================================
	const { CacheIndex } = mod;
	const settings = {
		autoUpload: true,
		localCopy: "cache",
		fallbackDownload: true,
		s3: {
			endpoint: "https://s3.example.com",
			region: "auto",
			bucket: "b",
			publicUrlBase: "https://img.example.com",
			accessKeyId: "",
			secretAccessKeyRef: "",
			forcePathStyle: true,
		},
	};
	const index = new CacheIndex([entry("cached.png", "attachments/cached.png")]);

	// ⭐ 命令跑完会把原文件**移进**缓存目录，所以候选只收**被笔记引用着**的那些
	//（收集放这里一份，下面几条用例共用；集合外的文件一律不碰）
	const referencedInUse = new Set([
		"attachments/a.png",
		"attachments/b.jpg",
		"attachments/empty.png",
		"attachments/cached.png",
	]);

	const selection = selectUploadCandidates(
		[
			{ path: "attachments/a.png", extension: "png", stat: { size: 100 } },
			{ path: "attachments/b.jpg", extension: "jpg", stat: { size: 200 } },
			{ path: "attachments/notes.md", extension: "md", stat: { size: 10 } },
			{ path: "attachments/empty.png", extension: "png", stat: { size: 0 } },
			{ path: "attachments/cached.png", extension: "png", stat: { size: 50 } },
			{ path: "", extension: "png", stat: { size: 5 } },
		],
		{ settings, index, referencedPaths: referencedInUse, repairablePaths: new Set() }
	);

	// ⭐ 1.1.0 起候选是**排除制**（需求 R15）：除了"笔记/画布/数据库"这三种宿主自己的
	// 文本文件之外，任何类型都可以上传 —— 所以 `notes.md` 仍然被跳过（它不是附件），
	// 而 PDF / 音频 / 视频 / 压缩包全都该进来。
	//
	// ⚠️ 顺序有意：**先让点名规则的那几条说话**（`reasons[...]` 的中文文案就是规则名），
	// 再整表比对候选 —— 反过来的话，任何一条规则坏掉都只会报成
	// "非空、未处理过、且被引用的附件才进候选"，变异验证就答不出"它因自己的原因失败"。
	const reasons = Object.fromEntries(selection.skipped.map((s) => [s.reason, s.count]));
	assert.equal(reasons["是笔记/画布/数据库文件，不是附件"], 1, "笔记文件不是附件，要跳过并计数");
	assert.equal(reasons["文件为空（可能是同步中的占位）"], 1, "空文件应被跳过（传上去会得到坏对象）");
	assert.equal(reasons["已经在缓存索引里"], 1, "已处理过的应被跳过");
	assert.equal(reasons["路径为空"], 1, "坏输入应被跳过而不是让整批失败");
	assert.deepEqual(
		selection.paths,
		["attachments/a.png", "attachments/b.jpg"],
		"非空、未处理过、且被引用的附件才进候选"
	);

	// ⭐⭐ 2026-10-22（D-68，用户明确要求）：**没有被任何引用的附件也要进候选**。
	//
	// 原来的口径是"只动被引用的那些"（`skipped` 里记一条"没有被任何笔记引用"）。
	// 用户推翻了它：他要一条命令把库里该传的都传了，包括那些暂时没人引用的。
	// ⚠️ 但三件事必须同时做到，否则这个改动会坑人：
	// ① 单独标出来（`unreferencedPaths`）—— 清单据此**默认不勾**；
	// ② 仍然如实计数（`unreferenced`）—— 确认框要说清"这些不会出现在任何笔记里"；
	// ③ 它**不再是跳过原因** —— 留在 `skipped` 里会让诊断说反话（"跳过了"但其实传了）。
	const unreferenced = selectUploadCandidates(
		[
			{ path: "attachments/used.png", extension: "png", stat: { size: 10 } },
			{ path: "attachments/orphan.png", extension: "png", stat: { size: 10 } },
		],
		{
			settings,
			index,
			referencedPaths: new Set(["attachments/used.png"]),
			repairablePaths: new Set(),
			// ⭐ 只有**显式开口**的调用方（「上传附件」命令）才收未引用的
			includeUnreferenced: true,
		}
	);
	assert.deepEqual(
		unreferenced.paths,
		["attachments/used.png", "attachments/orphan.png"],
		"★★ 显式开口时，没有被引用的附件也要进候选（D-68）"
	);

	// ⚠️⚠️ **反向**：不开口时（默认）照旧不收 —— 自动接管那条路处理的是"链接还没写进笔记"
	// 的文件，收它就会抢在链接之前搬走，留下死链（`attach-watch` 的套件里也钉着）。
	{
		const strict = selectUploadCandidates(
			[
				{ path: "attachments/used.png", extension: "png", stat: { size: 10 } },
				{ path: "attachments/orphan.png", extension: "png", stat: { size: 10 } },
			],
			{ settings, index, referencedPaths: new Set(["attachments/used.png"]), repairablePaths: new Set() }
		);
		assert.deepEqual(strict.paths, ["attachments/used.png"], "★★ 默认**不**收未引用的（自动接管那条路靠它防死链）");
		assert.deepEqual(strict.unreferencedPaths, [], "★ 默认也不会标出任何「未引用」（它根本没进候选）");
		assert.equal(
			Object.fromEntries(strict.skipped.map((row) => [row.reason, row.count]))["没有被任何笔记引用"],
			1,
			"★ 默认行为下它仍然是「跳过原因」（这条诊断不能丢）"
		);
	}
	assert.deepEqual(
		unreferenced.unreferencedPaths,
		["attachments/orphan.png"],
		"★★ 但要单独标出来（清单默认不勾、执行层不为它生成改写规则）"
	);
	const unrefReasons = Object.fromEntries(unreferenced.skipped.map((s) => [s.reason, s.count]));
	assert.equal(
		unrefReasons["没有被任何笔记引用"],
		undefined,
		"★★ 它不再是「跳过原因」（已经进候选了；留在 skipped 里会让诊断说反话）"
	);
	assert.equal(unreferenced.unreferenced, 1, "★ 未引用的个数仍要单独给出来（确认框按它如实交代）");
	assert.equal(selection.unreferenced, 0, "这一批每个都有人引用 ⇒ 未引用数应为 0");

	// ⭐⭐ 2026-10-22 审计：「**已经迁移好的**文件不许被说成『没有被任何笔记引用』」（D-59）。
	//
	// 现场：迁移完成的文件，正文里的引用已经被改写成**远端 URL** ⇒ 它当然不在
	// `referencedPaths`（那只装本地路径）里。旧顺序先问"有没有被引用"，于是它撞上
	// 「没有被任何笔记引用」，而**同一批文件**在「查看缓存占用」里是"在用"、
	// 在「检查未引用的云端附件」里也不问 —— 三条命令对同一件事说了三种话
	//（探针在演示库上实测：2 个文件被这么说反了）。
	const migrated = selectUploadCandidates(
		[
			{ path: "attachments/migrated.png", extension: "png", stat: { size: 40 } },
			{ path: "attachments/never-uploaded.png", extension: "png", stat: { size: 40 } },
		],
		{
			settings,
			index: new CacheIndex([entry("migrated.png", "attachments/migrated.png")]),
			// 两个都**没有本地引用**（迁移好的那个只剩远端 URL）
			referencedPaths: new Set(),
			repairablePaths: new Set(),
			includeUnreferenced: true,
		}
	);
	// ⚠️ D-68 之后这两条**不再都是"不是候选"**：
	// - `migrated.png` 已处理过 ⇒ 仍然跳过（这一条是 D-59 的核心，不能变）；
	// - `never-uploaded.png` 真没人引用 ⇒ **进候选**（用户要求"没引用的也传"），只是被标出来。
	assert.deepEqual(
		migrated.paths,
		["attachments/never-uploaded.png"],
		"★★ 已迁移的仍跳过；真没人引用的那个**进候选**（D-68）"
	);
	assert.deepEqual(
		migrated.unreferencedPaths,
		["attachments/never-uploaded.png"],
		"★★ 它要单独标出来（清单默认不勾）"
	);
	assert.equal(
		Object.fromEntries(migrated.skipped.map((s) => [s.reason, s.count]))["已经在缓存索引里"],
		1,
		"★★ 已迁移的文件要说「已经在缓存索引里」，不许说「没有被任何笔记引用」（后者与占用报告矛盾）"
	);
	assert.equal(
		migrated.unreferenced,
		1,
		"★ 而真正没人引用的那个照旧计数（确认框那句「另有 N 个…」现在只数真的算数的那一类）"
	);

	// ⭐⭐ 2026-10-21（D-56 的后续）：「**已经传过、而正文里那条链接还是本地的**」必须
	// 重新进候选 —— 否则「重新上传附件」永远修不好它，用户唯一的出路是手工改笔记。
	//
	// 现场：对象早传上去了，而笔记里那条 `[…](assets/…4年(1).pdf)` 还是本地路径
	//（改写没认出来）。用户的第一反应就是"再传一次"，而旧判据按"已在索引里"跳过它。
	const repairable = selectUploadCandidates(
		[
			{ path: "attachments/stale.png", extension: "png", stat: { size: 30 } },
			{ path: "attachments/done.png", extension: "png", stat: { size: 30 } },
		],
		{
			settings,
			index: new CacheIndex([
				entry("stale.png", "attachments/stale.png"),
				entry("done.png", "attachments/done.png"),
			]),
			referencedPaths: new Set(["attachments/stale.png", "attachments/done.png"]),
			// 只有 stale 那一条"正文里还写着本地路径"
			repairablePaths: new Set(["attachments/stale.png"]),
		}
	);
	assert.deepEqual(
		repairable.paths,
		["attachments/stale.png"],
		"★★ 已传过、但正文里还指着本地文件的必须重新进候选（否则重跑永远修不好它）"
	);
	assert.deepEqual(
		repairable.repairPaths,
		["attachments/stale.png"],
		"★★ 其中「只差改链接」的那几份要**按路径**给出来（清单要在那一行标「只改链接」；D-71 之前只有一个数）"
	);
	assert.equal(
		Object.fromEntries(repairable.skipped.map((s) => [s.reason, s.count]))["已经在缓存索引里"],
		1,
		"★ 反向：链接已经改好的那一个照旧跳过（稳态下不该每轮都被列出来）"
	);


	const noStat = selectUploadCandidates([{ path: "attachments/no-stat.png", extension: "png" }], {
		settings,
		index,
		referencedPaths: new Set(["attachments/no-stat.png"]),
		repairablePaths: new Set(),
	});
	assert.deepEqual(noStat.paths, ["attachments/no-stat.png"], "拿不到 size 时不该误判成空文件");

	// ⭐ 「被引用」这个集合的取法：把宿主的链接索引换算成"目标路径"集合。
	// 形状与"画布也会进索引"这两条都来自真机取证
	//（2026-10-09 的真机探针原始输出）。
	const { referencedPathsFrom } = mod;
	const linked = referencedPathsFrom({
		"notes/a.md": { "attachments/used.png": 2, "notes/b.md": 1 },
		// ⭐ 1.1.0（需求 R16）：画布**同等算数** —— 真机上画布本来就进索引，
		// 而改写器现在也认画布（file 节点改指缓存路径、text 节点按 Markdown 规则改写）。
		// 所以这里必须**收下**它：不收的话，"只被画布引用的附件"永远进不了候选，
		// 而用户把图摆在画布里是最常见的用法之一。
		"board.canvas": { "attachments/in-canvas.png": 1 },
		"notes/broken.md": null,
	});
	// ⚠️ 顺序有讲究：**先把"画布也算来源"这条具体的判据点出来**，再给整体集合的说法 ——
	// 反过来的话，"来源筛错了"这类变异会先撞上那条更宽的断言，报错原因就不再指向画布。
	assert.ok(linked.has("attachments/in-canvas.png"), "★★ 画布里的引用**算数**（需求 R16：画布也是笔记的一种）");
	assert.deepEqual(
		[...linked].sort(),
		["attachments/in-canvas.png", "attachments/used.png", "notes/b.md"],
		"收下所有目标路径：来源是笔记还是画布不影响结论（互链的目标也进来，由候选那一关过滤）"
	);
	assert.equal(referencedPathsFrom(null).size, 0, "拿不到索引时为空 ⇒ 这轮**不处理**任何文件（保守方向）");
	assert.equal(referencedPathsFrom("不是对象").size, 0, "形状不对时当成没有引用，而不是抛错或全收");
	assert.equal(referencedPathsFrom(["notes/a.md"]).size, 0, "数组不是链接索引的形状");
	assert.ok(referencedPathsFrom({ "NOTE.md": { "a.png": 1 } }).has("a.png"), "Markdown 来源照旧要收");
	assert.ok(referencedPathsFrom({ "BOARD.CANVAS": { "b.png": 1 } }).has("b.png"), "画布来源大小写不敏感");

	// ============================================================
	// ⭐ 外链候选：批量上传命令也要看到"还没进你自己存储"的图
	//
	// 那些图在**别人的服务器**上，但用户跑这条命令的意图就是"把还没搬走的搬走"。
	// 判定刻意复用按需缓存那一条（`decideExternalCache`），所以下面这些性质
	// 与"看笔记时问不问"永远一致 —— 不另立一套标准。
	// ============================================================
	const { externalFileUrlsIn, selectExternalUploadCandidates } = mod;

	// ── 1. 只认**图片**写法 ──
	assert.deepEqual(externalFileUrlsIn("![a](https://x.test/a.png)"), ["https://x.test/a.png"], "Markdown 图片要认");
	// ⭐ 1.1.0（需求 R15）：普通链接**也要收** —— `[报告](https://…/report.pdf)` 是
	// PDF / 音频 / 压缩包最常见的写法，不收它"支持所有格式"就只覆盖了 `![]` 那一半。
	// ⚠️ 采集这一层**只判"是不是 http(s) 地址"** ⇒ 网页链接也会被收进来。它们**不会变成候选**：
	// 判定层按形状把没有扩展名的挡掉（2026-10-16 用户实测报的，见下面那一段）；
	// 而 `.txt` 这类"像文件的文本"仍会进候选，靠下载那一步的 `text/*` 判据如实拒收。
	assert.deepEqual(
		externalFileUrlsIn("[a](https://x.test/page)"),
		["https://x.test/page"],
		"★ 采集只认地址形态（「像不像文件」是判定层的事）；网页那一类不会变成候选"
	);
	assert.deepEqual(
		externalFileUrlsIn('<a href="https://x.test/doc.pdf">报告</a>'),
		["https://x.test/doc.pdf"],
		"行内 HTML 的 <a href> 同样要认"
	);
	assert.deepEqual(externalFileUrlsIn('<img src="https://x.test/b.jpg">'), ["https://x.test/b.jpg"], "行内 HTML 的 img 也要认");
	assert.deepEqual(externalFileUrlsIn("![a](<https://x.test/c d.png>)"), ["https://x.test/c d.png"], "尖括号包住的地址要认得出来");
	assert.deepEqual(externalFileUrlsIn('![a](https://x.test/d.png "标题")'), ["https://x.test/d.png"], "标题不该混进地址");

	assert.deepEqual(externalFileUrlsIn("![](attachments/x.png)"), [], "库内相对路径不是外链");
	assert.deepEqual(externalFileUrlsIn("[笔记](notes/other.md)"), [], "库内互链不是外链（相对路径）");
	assert.deepEqual(externalFileUrlsIn('<a href="attachments/x.pdf">本地</a>'), [], "库内锚点也不是外链");
	assert.deepEqual(externalFileUrlsIn("![[photo.png]]"), [], "wikilink 指的是库内路径，不可能是外链");
	assert.deepEqual(
		externalFileUrlsIn("![](https://x.test/a.png)\n![](https://x.test/a.png)"),
		["https://x.test/a.png"],
		"同一篇笔记里写两遍只算一次（改写时那两处会被一起换掉）"
	);
	assert.deepEqual(externalFileUrlsIn(""), [], "空文本安全返回空");

	// ⭐⭐ 2026-10-22（D-62）：**代码块 / 行内代码 / `%%注释%%` 里的地址不是候选**。
	// ⚠️ 这一侧尤其要紧：候选收进来就会**下载 + 上传**，而改写那一趟根本看不到这条
	// （`findLinkSpans` 已经把它剔掉了）⇒ 笔记里那条链接永远改不掉，下一轮又收一次。
	assert.deepEqual(
		externalFileUrlsIn("```md\n![](https://x.test/a.png)\n```\n"),
		[],
		"★★ 围栏代码块里的地址不算候选（否则会传上去、而链接永远改不掉）"
	);
	assert.deepEqual(
		externalFileUrlsIn("写法是 `![](https://x.test/a.png)` 这样\n"),
		[],
		"★★ 行内代码里的地址不算候选"
	);
	assert.deepEqual(
		externalFileUrlsIn("%%![](https://x.test/a.png)%%\n"),
		[],
		"★★ `%%注释%%` 里的地址不算候选"
	);
	assert.deepEqual(
		externalFileUrlsIn("![本机](file:///D:/a/x.png)\n```\n![本机](file:///D:/a/y.png)\n```\n"),
		["file:///D:/a/x.png"],
		"★★ 同一篇里代码块之外的那条照旧要收（别把整篇都当代码）"
	);

	// ── 2. 挑选：候选的判据是"能不能搬"，与功能开关和站点名单**都**无关 ──
	{
		// ⚠️ 刻意把开关**关掉**、并设一份"谁都拦得住"的白名单：命令与选择器是**显式动作**，
		// 候选必须照旧列出来 —— 否则"只想手动挑几张"的用户打开命令只会看到空清单
		//（那个入口等于不存在）。1.2.0 把开关与名单都归进**自动**那一路，这就是它的判据。
		const externalSettings = {
			...settings,
			externalImageCache: false,
			externalSiteMode: "allowlist",
			externalSiteList: [],
		};
		const notes = [
			{
				path: "notes/one.md",
				// ⚠️ 第三行是**同一张图写第二遍**：它必须只算一个候选（改写时两处一起换）
				text: "![x](https://offsite.test/a.png)\n![](https://offsite.test/b.png)\n![dup](https://offsite.test/a.png)",
			},
			{ path: "notes/two.md", text: "![](https://other.test/c.png)\n![](https://third.test/d.png)" },
			{ path: "notes/three.md", text: "![](https://img.example.com/cached.png)" },
		];
		// ⚠️ `purpose` / `includeLocalFiles` 在 TS 里是**必填**（漏传会让开关静默失效）。
		// 这一段测的是**旧语义**——"显式工具不受开关与名单约束"，所以是 manual + 收本机文件。
		// 「上传全部附件」那一路走 `purpose: "auto"` ＋ 设置里那个开关（另有用例，见下面 5c / 5d）。
		const options = { settings: externalSettings, configured: true, purpose: "manual", includeLocalFiles: true };

		const picked = selectExternalUploadCandidates(notes, options);
		assert.deepEqual(
			picked.candidates.map((c) => `${c.notePath} ${c.url}`),
			[
				"notes/one.md https://offsite.test/a.png",
				"notes/one.md https://offsite.test/b.png",
				"notes/two.md https://other.test/c.png",
				"notes/two.md https://third.test/d.png",
			],
			"★ 候选要带上「它出现在哪篇笔记里」—— 改写链接时必须指名道姓，且同一篇里写两遍只算一次"
		);
		assert.deepEqual(
			picked.sites.map((s) => `${s.host}:${s.count}`),
			["offsite.test:2", "other.test:1", "third.test:1"],
			"站点汇总要按主机名排序（确认框据此列出即将访问哪些站点）"
		);
		assert.equal(
			picked.candidates.some((c) => c.url.includes("img.example.com")),
			false,
			"★ 自己存储的地址不该被当外链处理（判定层认得出，命令不另立标准）"
		);

		// ⭐⭐ 指向**宿主自己的文本文件**（笔记 / 画布 / 数据库）的远程地址**不算候选**
		// （2026-10-16 用户实测报的：笔记里链接的远程 `.md` 出现在了
		// 「上传附件」的清单里）。判据落在**判定层**
		// （`decideExternalCache` 里的 `isNoteLikeExtension`），所以"打开笔记就搬"
		// 那一路同样被拦住 —— 这里钉的是**候选清单**这一侧。
		const noteLike = selectExternalUploadCandidates(
			[
				{
					path: "notes/links.md",
					text:
						"![a](https://offsite.test/notes/intro.md)\n" +
						"![b](https://offsite.test/boards/talk.canvas)\n" +
						"![c](https://offsite.test/db/table.base)\n" +
						"![ok](https://offsite.test/doc.pdf)",
				},
			],
			options
		);
		assert.deepEqual(
			noteLike.candidates.map((c) => c.url),
			["https://offsite.test/doc.pdf"],
			"★★ 指向笔记/画布/数据库的远程地址不算候选（搬下来会在库里凭空多出一篇笔记），而 PDF 照旧"
		);
		assert.deepEqual(
			noteLike.sites,
			[{ host: "offsite.test", count: 1 }],
			"站点汇总也不能把它们算进去（确认框会据此列站点）"
		);

		// ⭐⭐ 从正文文本里读出来的地址**必须看起来像个文件**（2026-10-16 用户实测报的
		// 第二件事）：笔记里那个**企业 wiki 页链接**（`…/wiki/资料归档管理规定?wfw…`，
		// 没有扩展名）压根不该进清单 —— 用户原话「那个文件不应该进入列表选项」。
		// 判据同样落在**判定层**（`decideExternalCache` 只对 `manual` 那一路），
		// 这里钉的是**候选清单**这一侧。
		const notFiles = selectExternalUploadCandidates(
			[
				{
					path: "notes/links.md",
					text:
						"[wiki](https://offsite.test/projects/m23003/wiki/%E8%B5%84%E6%96%99?cfm=1)\n" +
						"[页](https://offsite.test/some/page)\n" +
						"[点在前面的目录里](https://offsite.test/2024.10/notes)\n" +
						// ⭐ 网页类型（`.html`）**也不许**进来 —— 它尾巴有点、能过"像个文件名"那条，
						// 但 R18「绝不抓网页」与下载端那一条（`text/html` 拒收）是同源的判据。
						// 2026-10-16 用户第二次实测报的正是这个：B站播放器 `<iframe src="…/player.html">`。
						'<iframe src="https://player.bilibili.com/player.html?aid=1&bvid=BV1"></iframe>\n' +
						"[播放器](https://offsite.test/player.html)\n" +
						// ⭐⭐ 第三次实测报的那一条：**后缀是页面程序**（`.jsp`）的地址同样是网页 ——
						// 它尾巴也有点、后缀也不是 `text/html`，但内容是现算出来的一张页面
						//（用户原话：「实际上这是一个网页地址」）。判据是 `isWebPageExtension`。
						"[原文链接](https://offsite.test/pd.jsp?id=172#:~:text=HyperWire)\n" +
						// ⭐⭐ 第五次实测报的那一条：**尾巴有点像、但后缀不是文件类型** ——
						// GitHub 的分支名 `5.1-translation_terms`（点在 `5` 与 `1` 之间，取不出扩展名）。
						// 判据是 `urlHasFileTypeSuffix`（**只对"只被指向"的地址施加**）。
						"[分支](https://offsite.test/repo/tree/5.1-translation_terms)\n" +
						"[版本](https://offsite.test/repo/tree/v1.2.3)\n" +
						"[pdf](https://offsite.test/report.pdf)\n",
				},
			],
			options
		);
		assert.deepEqual(
			notFiles.candidates.map((c) => c.url),
			["https://offsite.test/report.pdf"],
			"★★ 没有扩展名的网页地址、网页类型（.html）、页面程序（.jsp）与「后缀不像文件类型」的地址（分支名 / 版本号）**都不算候选**，而 PDF —— 同样是普通链接 —— 照旧"
		);
		assert.deepEqual(
			notFiles.sites,
			[{ host: "offsite.test", count: 1 }],
			"站点汇总也不能算进那些网页地址（确认框会据此列出即将访问哪些站点）"
		);
		assert.equal(
			notFiles.skipped.some((s) => s.reason.includes("不是文件")),
			true,
			"★ 跳过的原因要照实记下来（诊断用）"
		);
		assert.equal(
			notFiles.skipped.some((s) => s.reason.includes("后缀不像文件类型")),
			true,
			"★ 「后缀不像文件类型」（分支名 / 版本号那种）要能与「尾部没有后缀」分开说，诊断才用得上"
		);
		assert.equal(
			notFiles.skipped.some((s) => s.reason.includes("网页")),
			true,
			"★ 页面程序（`…/pd.jsp?id=172`）那一条的原因要说得清是「网页」，不是笼统的「不是文件」"
		);

		// ⭐⭐ 本机文件候选：**列清单之前先问一句"还在不在"**（2026-10-16 用户实测报的：
		// 一行连缩略图都没有的 `file:///C:/…/Temp/ksohtml/wpsDD.tmp.jpg` —— 文件其实已经不在了，
		// 他的原话「没有缩略图的文件实际上已经不存在了，不应该上传，即便上传也会失败」）。
		// ⚠️ "读得到吗"是 **I/O**（由 `LocalFileProbe` 注入）⇒ 这里用替身穷举**分流**那一半。
		{
			const asked = [];
			const probe = async (path) => {
				asked.push(path);
				return path !== "C:/gone/wpsDD.tmp.jpg";
			};
			const { kept, missing } = await mod.dropMissingLocalCandidates(
				[
					{ url: "file:///C:/gone/wpsDD.tmp.jpg", notePath: "notes/a.md", host: "", local: true },
					{ url: "file:///C:/kept/ok.png", notePath: "notes/a.md", host: "", local: true },
					{ url: "https://offsite.test/a.png", notePath: "notes/a.md", host: "offsite.test", local: false },
				],
				probe
			);
			// ⚠️ **承重的那条先说话**：先钉"已经不在的必须被摘掉"（这是用户报的那件事），
			// 再钉"其余照原样留着"。反过来的话，变异会以"另一件事"的理由失败（本项目踩过）。
			assert.deepEqual(
				missing.map((c) => c.url),
				["file:///C:/gone/wpsDD.tmp.jpg"],
				"★★ 已经不在的本机文件必须摘掉（列出来就是「点了一定失败」）"
			);
			assert.deepEqual(
				kept.map((c) => c.url),
				["file:///C:/kept/ok.png", "https://offsite.test/a.png"],
				"★ 还在的本机文件与站外候选都要留下（顺序也照原样）"
			);
			assert.equal(
				asked.length,
				2,
				"★ 只对**本机**文件问在不在；站外候选的「在不在」要联网才知道（那是执行层的事）"
			);
			assert.deepEqual(
				asked,
				["C:/gone/wpsDD.tmp.jpg", "C:/kept/ok.png"],
				"★ 问的是**去掉 file:// 之后的本机路径**（探测函数只认路径）"
			);
		}

		// 站点排序固定：输出稳定，展示与断言都不会因为扫库顺序而变
		const again = selectExternalUploadCandidates([...notes].reverse(), options);
		assert.deepEqual(
			again.sites.map((s) => s.host),
			picked.sites.map((s) => s.host),
			"站点顺序与笔记的读取顺序无关"
		);

		// ── 2b. ⭐ 范围过滤（「只看当前笔记」，2026-10-22）──
		//
		// ⚠️ 过滤必须**在判定层做**（`notePaths`），不能让调用方筛结果：`sites` 与跳过统计
		// 也得按同一批笔记重算 —— 否则清单只有 2 行、摘要却说"来自 5 个站点"。
		const scoped = selectExternalUploadCandidates(notes, { ...options, notePaths: new Set(["notes/two.md"]) });
		assert.deepEqual(
			scoped.candidates.map((c) => `${c.notePath} ${c.url}`),
			["notes/two.md https://other.test/c.png", "notes/two.md https://third.test/d.png"],
			"★★ 只看当前笔记时，只列这一篇里的地址（别的笔记那些不许出现）"
		);
		assert.deepEqual(
			scoped.sites.map((s) => `${s.host}×${s.count}`),
			["other.test×1", "third.test×1"],
			"★★ 站点汇总必须按**同一批笔记**重算（否则摘要写着全库的站点数，与清单对不上）"
		);
		// 空集合 = 什么都不看（不是"看全部"）—— 反方向的默认值必须钉住。
		assert.deepEqual(
			selectExternalUploadCandidates(notes, { ...options, notePaths: new Set() }).candidates,
			[],
			"★ 显式给空集合时一个都不列（缺省 `undefined` 才是「全部」）"
		);

		// ── 3. ⭐ 反过来：把开关打开 —— 候选**一模一样**（它只约束自动那一路） ──
		const open = selectExternalUploadCandidates(notes, {
			...options,
			settings: { ...externalSettings, externalImageCache: true },
		});
		assert.deepEqual(
			open.candidates.map((c) => c.url),
			picked.candidates.map((c) => c.url),
			"★ 功能开关不该影响这条命令的候选（它只管自动那一路）"
		);

		// ── 4. 存储没就绪：不该出现在候选清单里 ──
		//
		// 没有客户端就搬不了，列出来只会让用户勾完才发现做不成。
		const unconfigured = selectExternalUploadCandidates(notes, { ...options, configured: false });
		assert.deepEqual(unconfigured.candidates, [], "★ 存储没就绪时不该产生任何候选");
		assert.equal(
			unconfigured.skipped.some((s) => s.reason.includes("未就绪")),
			true,
			"跳过的原因应当说明是「存储未就绪」"
		);

		// ── 5. 回环 / 链路本地地址：无条件不碰 ──
		const loopback = selectExternalUploadCandidates(
			[{ path: "notes/x.md", text: "![](http://127.0.0.1/secret.png)\n![](http://169.254.169.254/meta.png)" }],
			options
		);
		assert.deepEqual(loopback.candidates, [], "★ 回环与链路本地地址永远不是候选（安全优先于任何偏好）");
		assert.equal(
			loopback.skipped.some((s) => s.reason.includes("本地")),
			true,
			"跳过的原因应当指出是本地/链路本地地址（诊断要能一眼看出是安全拦截）"
		);

		// ── 5b. ⭐ 把候选里**所有**站点都拉黑，候选还是一个不少 ──
		//
		// 这是"名单只约束自动那一路"最直接的一条判据。少了它，
		// "名单被误用到候选上"会静默地让手动挑选整个消失。
		const blacklisted = selectExternalUploadCandidates(notes, {
			...options,
			settings: {
				...externalSettings,
				externalSiteMode: "blocklist",
				externalSiteList: ["offsite.test", "other.test", "third.test"],
			},
		});
		assert.deepEqual(
			blacklisted.candidates.map((c) => c.url),
			picked.candidates.map((c) => c.url),
			"★ 候选清单与站点名单无关（名单说的是「自动处理哪些站点」，不是「能不能手动挑」）"
		);

		// ── 5b. ⭐ 本机文件（`file:///D:/…`）：同一套候选层，另一类判定 ──
		//
		// 用户 2026-10-15 要的：企业微信截图那种链接按**与站外同一套**业务逻辑处理。
		// ⚠️ 候选层只负责**分流**（判定本身在 `local-file` 与 `external-decide` 两处），这里钉的是：
		// 本机文件算进 `localFiles`、**不进 `sites`**（它没有主机）、且**只收桌面端**。
		const desktopOptions = { ...options, isDesktop: true };
		const localNotes = [
			{
				path: "notes/local.md",
				// ① 普通写法；② **带空格**的路径（http 那条规则 `[^)\s\n]+` 会在空格处截断 ——
				// 与 D-25「含空格的 Markdown 目标被截断」同一类坑）；③ Markdown 标题尾巴；
				// ④ 尖括号写法（路径里含空格时最规范的写法）
				text:
					"![](file:///D:/企业微信文件/图.png)\n" +
					"![](file:///D:/My Documents/截图 2026.png)\n" +
					'![](file:///D:/a/图.png "标题")\n' +
					"![](<file:///D:/b/Another Shot.png>)\n",
			},
		];
		const locals = selectExternalUploadCandidates(localNotes, desktopOptions);
		assert.deepEqual(
			locals.candidates.map((c) => c.url),
			[
				"file:///D:/企业微信文件/图.png",
				"file:///D:/My Documents/截图 2026.png",
				"file:///D:/a/图.png",
				"file:///D:/b/Another Shot.png",
			],
			"★★ 四条都要收全 —— 尤其带空格那条（截断出来的路径会指向另一样东西）"
		);
		assert.ok(
			locals.candidates.every((c) => c.local === true),
			"★ 本机文件要标出来（界面据此说话：列表里显示的必须是**那条绝对路径**）"
		);
		assert.equal(locals.localFiles, 4, "★ 本机文件单独计数");
		assert.deepEqual(
			locals.sites,
			[],
			"★★ 本机路径**没有主机** ⇒ 不进站点汇总（否则「来自 N 个站点」就成了假话）"
		);

		// ⚠️ 平台：手机端一条都不该有（那个路径在移动端不存在）
		const localOnMobile = selectExternalUploadCandidates(localNotes, { ...options, isDesktop: false });
		assert.deepEqual(localOnMobile.candidates, [], "★ 手机端不列本机文件（读不到）");
		assert.equal(localOnMobile.localFiles, 0, "★ 也不该计入");

		// ⭐⭐ 2026-10-22（D-60）：本机这一档**与库内同一条判据** —— 除笔记类之外全收。
		// 早先这里只收"能嵌进笔记的四类"，于是 `docx` / `zip` / `txt` 从磁盘拖进来永远进不了清单。
		assert.deepEqual(
			selectExternalUploadCandidates(
				[
					{
						path: "notes/x.md",
						text:
							"![](file:///D:/a/方案.docx)\n" +
							"![](file:///D:/a/包.zip)\n" +
							"![](file:///D:/a/照片.heic)\n" +
							// 笔记类仍然不是附件（与库内同一份排除名单）
							"![](file:///D:/a/笔记.md)\n" +
							"![](file:///D:/a/板.canvas)\n",
					},
				],
				desktopOptions
			).candidates.map((candidate) => candidate.url),
			["file:///D:/a/方案.docx", "file:///D:/a/包.zip", "file:///D:/a/照片.heic"],
			"★★ 本机文件与库内同一条判据：除笔记类全收（docx/zip/heic 都要进候选）"
		);

		// ── 6. 坏输入不该让整批失败 ──
		assert.deepEqual(
			selectExternalUploadCandidates([{ path: "", text: "![](https://x.test/a.png)" }, { path: "n.md" }], options)
				.candidates,
			[],
			"没有路径的笔记、没有正文的笔记都应安全跳过"
		);

		// ── 7. ⭐⭐ 安装包 / 镜像**不是笔记资料**（D-58，2026-10-21 用户实测报的）──
		// 现场：他笔记里写着 `1. [下载地址](https://alist…/Cherry-Studio-0.9.19-setup.exe)`，
		// 清单把这条 **84.6 MB** 的安装包列了出来（真机 HEAD：`application/octet-stream`）。
		// ⚠️ 与上面那条**互为边界**：同一篇里的 `.pdf` 照旧是候选 —— 拦的只是程序分发。
		const installers = selectExternalUploadCandidates(
			[
				{
					path: "notes/软件.md",
					text:
						"1. [下载地址](https://alist.test/d/netdisk/cherry%20studio/Cherry-Studio-0.9.19-setup.exe)\n\n" +
						"[资料](https://alist.test/d/资料.pdf)\n",
				},
			],
			desktopOptions
		);
		assert.deepEqual(
			installers.candidates.map((candidate) => candidate.url),
			["https://alist.test/d/资料.pdf"],
			"★★ 安装包不进「上传附件」的清单，同一篇笔记里的 pdf 照旧进（D-58：程序分发不是资料）"
		);
		assert.ok(
			installers.skipped.some((entry) => entry.reason.includes("安装包")),
			"★ 跳过的原因要能说出来（诊断里得有「安装包」这一档，否则用户无从解释）"
		);

		// ── 8. ⭐⭐ 2026-10-24：`purpose: "auto"` 时**按设置走**（「上传全部附件」用的就是这一档）──
		//
		// 那条链**没有清单**了（一次确认），所以"要不要碰站外"只能由事前设置表达
		// （用户原话：站外图可以用设置里的「站外文件是否上传云端」来确定）。
		// ⚠️ 判据必须钉在这里：把它接成 manual 的后果是"用户关掉了站外开关，插件照样去
		// 别人的服务器拉图"—— 而这件事在界面上**完全静默**。
		{
			const autoBase = { ...options, purpose: "auto" };
			const offCandidates = selectExternalUploadCandidates(notes, autoBase);
			assert.deepEqual(
				offCandidates.candidates,
				[],
				"★★ 开关关着 ⇒ 站外一个候选都不收（「用设置决定」就落在这条上）"
			);
			assert.ok(
				offCandidates.skipped.some((entry) => entry.reason.includes("关闭")),
				"★ 跳过原因要说「功能已关闭」（诊断要能回答「为什么一个都没有」）"
			);

			const onCandidates = selectExternalUploadCandidates(notes, {
				...autoBase,
				settings: { ...externalSettings, externalImageCache: true, externalSiteMode: "off" },
			});
			assert.deepEqual(
				onCandidates.candidates.map((candidate) => candidate.url),
				picked.candidates.map((candidate) => candidate.url),
				"★ 开关打开 ⇒ 候选与显式工具那条**一模一样**（判定只有一份，不因为谁在问而分叉）"
			);

			// ⭐ 名单在 auto 档生效：白名单只留 other.test（两种档位对名单的态度必须不一样）
			const allowed = selectExternalUploadCandidates(notes, {
				...autoBase,
				settings: {
					...externalSettings,
					externalImageCache: true,
					externalSiteMode: "allowlist",
					externalSiteList: ["other.test"],
				},
			});
			assert.deepEqual(
				allowed.candidates.map((candidate) => candidate.url),
				["https://other.test/c.png"],
				"★★ 白名单在 auto 档必须生效（否则用户以为排除了的站点照样被访问）"
			);
			assert.ok(
				allowed.skipped.some((entry) => entry.reason.includes("名单")),
				"★ 被名单挡住也要说得出原因"
			);
		}

		// ── 9. ⭐⭐ 本机文件是**另一个**开关（`includeLocalFiles`，2026-10-24）──
		//
		// 与站外分开的理由：站外是"别人的服务器"，本机是"这台电脑上的绝对路径"。
		// 风险形状不同，用户会想分别决定 ⇒ 两个开关、两条判据。
		{
			const localNotesForSwitch = [{ path: "notes/local.md", text: "![](file:///D:/a/x.png)" }];
			const allowed = selectExternalUploadCandidates(localNotesForSwitch, desktopOptions);
			assert.deepEqual(
				allowed.candidates.map((candidate) => candidate.url),
				["file:///D:/a/x.png"],
				"前提：开关允许时它是候选"
			);

			const denied = selectExternalUploadCandidates(localNotesForSwitch, {
				...desktopOptions,
				includeLocalFiles: false,
			});
			assert.deepEqual(denied.candidates, [], "★★ 设置里没允许 ⇒ 本机文件一个都不收");
			assert.equal(denied.localFiles, 0, "★ 也不该计入条数");
			assert.ok(
				denied.skipped.some((entry) => entry.reason.includes("本机")),
				"★ 跳过原因要指出是设置没允许（与「手机读不到」那条平台判据分开）"
			);
		}
	}
	// 3b. ⭐⭐ 2026-10-15（D-32）：**所有引用写法**都要认（判据 + 改写一起）
	//
	// 现场：用户要求「外部链接 / 内部文件链接 / 相对地址 / 绝对地址等所有方式都应该能用」。
	// 这里用一个矩阵逐条钉住 —— `stillMentionsPath`（"还有人指着它吗"，删文件前的判据）
	// 与 `planLinkRewrites`（改写）在每一种写法上都必须**同时**成立。
	// ⚠️ 少认一形**不报错**：命令报告成功而笔记里那条还是本地路径，或者那份文件被判成没人引用。
	// ============================================================
	{
		const PATH = "attachments/图 1.png";
		const RULE = [{ from: PATH, to: "https://cdn.example.com/x.png", name: "图 1.png" }];

		/** 每一种写法：正文 → 期望的路径段 → 改写之后应当长什么样。 */
		const MATRIX = [
			["![[attachments/图 1.png]]", "attachments/图 1.png", "![图 1.png](https://cdn.example.com/x.png)"],
			["![[图 1.png\\|600]]", "图 1.png", "![600](https://cdn.example.com/x.png)"],
			["![[图 1.png#page=2]]", "图 1.png", "![图 1.png](https://cdn.example.com/x.png#page=2)"],
			['<img src="attachments/图 1.png">', "attachments/图 1.png", '<img src="https://cdn.example.com/x.png">'],
			["<img src='attachments/图 1.png'>", "attachments/图 1.png", "<img src='https://cdn.example.com/x.png'>"],
			[
				'<a href="attachments/图 1.png">下载</a>',
				"attachments/图 1.png",
				'<a href="https://cdn.example.com/x.png">下载</a>',
			],
			[
				'<video src="attachments/图 1.png"></video>',
				"attachments/图 1.png",
				'<video src="https://cdn.example.com/x.png"></video>',
			],
			["[ref]: attachments/图 1.png", "attachments/图 1.png", "[ref]: https://cdn.example.com/x.png"],
			['[ref]: attachments/图 1.png "标题"', "attachments/图 1.png", '[ref]: https://cdn.example.com/x.png "标题"'],
		];
		for (const [text, expectedRaw, expectedRewritten] of MATRIX) {
			assert.deepEqual(findLinkSpans(text).map((span) => span.raw), [expectedRaw], `★ 这种写法要取对路径段：${text}`);
			assert.equal(stillMentionsPath(text, PATH), true, `★★ 这种写法必须算「还有人指着它」：${text}`);
			assert.equal(planLinkRewrites(text, RULE).text, expectedRewritten, `★★ 这种写法必须改得掉：${text}`);
		}

		// ⚠️⚠️ 目标里带**成对括号**：`… 4年(1).pdf` 这种名字是**下载来的文件**的常态
		//（浏览器给重名文件加 `(1)`），而 Markdown 规范允许目标里出现成对括号。
		// 「遇到第一个 `)` 就停」会截成 `… 4年(1` ⇒ ① 判据说没人指着它 ② 改写一处不改。
		// 2026-10-21 用户实测报的就是这一条：文件**传上去了**、笔记里那条还是本地路径，
		// 他看到的现象是「没有被上传」。
		const PAREN = "assets/【FPGA工程师_长沙 11-19K】游立强 4年(1).pdf";
		const PAREN_RULE = [{ from: PAREN, to: "https://cdn.example.com/x.pdf" }];
		const PAREN_MATRIX = [
			// 用户原样的那一行：相对前缀 + `%20` 编码 + `【】` + `(1)`
			[
				"[说明](../assets/【FPGA工程师_长沙%2011-19K】游立强%204年(1).pdf)",
				"../assets/【FPGA工程师_长沙%2011-19K】游立强%204年(1).pdf",
			],
			// 未编码 + 库内路径
			[`![x](${PAREN})`, PAREN],
			// 尖括号形式：边界由 `>` 给，里面的括号不参与
			[`![x](<${PAREN}>)`, PAREN],
		];
		for (const [text, expectedRaw] of PAREN_MATRIX) {
			assert.deepEqual(findLinkSpans(text).map((span) => span.raw), [expectedRaw], `★ 目标里的成对括号不许截断路径段：${text}`);
			assert.equal(stillMentionsPath(text, PAREN), true, `★★ 带括号的目标必须算「还指着它」：${text}`);
			const parenPlan = planLinkRewrites(text, PAREN_RULE);
			assert.equal(parenPlan.count, 1, `★★ 带括号的目标必须改得掉（文件传上去了、笔记里那条不能还是本地路径）：${text}`);
			assert.equal(
				parenPlan.text.includes("游立强%204年(1.pdf"),
				false,
				`★★ 改写后不许留下半截路径（那是截断的直接证据）：${text}`
			);
		}

		// ⚠️ 显示文字里也带括号：路径段必须从 `](` 之后开始 ——
		// 用 `body.indexOf("(")` 定起点会落进**标签**里那个括号（`[图 (1)](…)`），
		// 后果与截断一样：判据与改写一起静默失效。
		const parenLabel = `[图 (1)](${PAREN})`;
		assert.deepEqual(
			findLinkSpans(parenLabel).map((span) => span.raw),
			[PAREN],
			"★ 显示文字里的括号不许把路径段的起点带偏"
		);
		assert.equal(planLinkRewrites(parenLabel, PAREN_RULE).count, 1, "★ 同上：这条链接必须改得掉");

		// ⚠️ 同一份位置判据（`markdownLinks`）还管着**站外 / 本机候选采集**那一侧：
		// 那里只是切法不同（http 按空白切、本机允许空格），**边界**必须一致。
		// 截断的后果比改写那侧更隐蔽：http 会拿半截地址去下载（404 或下到别的对象），
		// 本机路径则被判成"文件不在了"，由 `dropMissingLocalCandidates` **静默摘掉**。
		// ⚠️ 断言**放在这里**（3b 之后）是有意的：位置判据坏掉时两边会一起红，
		// 而负责它的那条变异（`mutate-references`）必须"因自己的原因失败" ——
		// 所以路径段那条断言要**先**说话，这几条排后面。
		assert.deepEqual(
			externalFileUrlsIn("[a](https://x.test/Foo_(bar).pdf)"),
			["https://x.test/Foo_(bar).pdf"],
			"★★ 站外地址里的成对括号不许截断（否则会拿半截地址去下载）"
		);
		assert.deepEqual(
			externalFileUrlsIn("![a](file:///D:/tmp/报告(1).pdf)"),
			["file:///D:/tmp/报告(1).pdf"],
			"★★ 本机路径里的成对括号不许截断（否则被判成「文件不在了」而静默摘掉）"
		);
		assert.deepEqual(
			externalFileUrlsIn('![](<https://x.test/Foo_(bar).pdf> "标题")'),
			["https://x.test/Foo_(bar).pdf"],
			"★ 尖括号 + 括号 + 标题：只被 `>` 与引号切，括号不参与"
		);

		// ⭐⭐ 2026-10-22（D-62，用户明确要求）：**代码块 / 行内代码 / `%%注释%%` 里的目标
		// 不算引用** —— 连"认出来"都不该有。
		//
		// 依据不是口味，是**宿主的口径**：Obsidian 不渲染这些位置里的链接，
		// `metadataCache.resolvedLinks` 里也没有它们。我们额外扫正文是为了补宿主的盲区
		// （属性链接 / 行内 HTML / 引用式链接），而**代码块不是盲区** —— 多扫这一半
		// 只会让"只在代码块里被提到"的文件进「上传附件」白传一次，并在清理流程里保它一命。
		// ⚠️ 同一件事在四处都有后果（候选 / 报告 / 云端清理 / 删除前复核），所以
		// 剔除做在**产出处**（`findLinkSpans`）；这里逐条钉住它。
		for (const [label, text] of [
			["围栏代码块", "```md\n![](attachments/图 1.png)\n```\n"],
			["波浪号围栏", "~~~\n![](attachments/图 1.png)\n~~~\n"],
			["未闭合围栏（宿主也把后面全当代码）", "```\n![](attachments/图 1.png)\n"],
			["行内代码", "写法是 `![](attachments/图 1.png)` 这样\n"],
			["Obsidian 注释", "%%![](attachments/图 1.png)%%\n"],
			// ⚠️ 后三种走的是**另一条**产出路径（wikilink / 行内 HTML / 引用式定义），
			// 它们不经过 `markdownLinks`，靠收尾那一次过滤 —— 少钉一条就会漏掉半个判据。
			["围栏里的 wikilink", "```\n![[attachments/图 1.png]]\n```\n"],
			["围栏里的行内 HTML", '```html\n<img src="attachments/图 1.png">\n```\n'],
			["围栏里的引用式定义", "```\n[x]: attachments/图 1.png\n```\n"],
			// ⭐⭐ 2026-10-22（D-63，用户原话「除了代码块,行内代码也不应该有引用附件,这和语义不符」）：
			// 判据从"代码"扩成**所有不会被渲染的位置**。逐条列在这里，因为每一条都是
			// 独立的一类写法，少一条就少一类证据。
			["行内代码（双反引号）", "写法 ``![](attachments/图 1.png)`` 这样\n"],
			["行内代码（内容里带单个反引号）", "``a ` ![](attachments/图 1.png) ``\n"],
			["HTML 注释", "<!-- ![](attachments/图 1.png) -->\n"],
			["行内数学 $…$", "$![](attachments/图 1.png)$\n"],
			["块级数学 $$…$$", "$$\n![](attachments/图 1.png)\n$$\n"],
			["转义的 Markdown 图片", "\\![](attachments/图 1.png)\n"],
			["转义的 wikilink", "\\![[attachments/图 1.png]]\n"],
			["行内 <code>", "<code>![](attachments/图 1.png)</code>\n"],
			["<pre> 块", "<pre>\n![](attachments/图 1.png)\n</pre>\n"],
		]) {
			assert.deepEqual(
				findLinkSpans(text).map((span) => span.raw),
				[],
				`★★ 这些位置里的目标**一条都不产出**（它们不是引用）：${label}`
			);
			assert.equal(
				stillMentionsPath(text, PATH),
				false,
				`★★ 同上：不算「有人指着它」（否则只在代码块里被提到的文件会被白传一次）：${label}`
			);
			const frozen = planLinkRewrites(text, RULE);
			assert.equal(frozen.count, 0, `★★ 当然也不改写：${label}`);
			assert.equal(frozen.text, text, `★★ 原文要逐字节不变（那是用户的样例文本）：${label}`);
		}
		// ⚠️ 反向：**同一行里**代码之外的那条照旧要认、要改（别把整行都扔掉）
		const mixedLine = "`![](attachments/图 1.png)` 与 ![](attachments/图 1.png)\n";
		assert.equal(
			planLinkRewrites(mixedLine, RULE).count,
			1,
			"★★ 行内代码只吃掉它自己那一段，同一行外面的链接照旧要改"
		);
		assert.ok(
			planLinkRewrites(mixedLine, RULE).text.startsWith("`![](attachments/图 1.png)` 与 ![](https://"),
			"★ 代码里那段原样、外面那段换成远端"
		);
		// ⚠️ 反向：正常正文里的照旧要认（别把整篇都当成代码）
		assert.deepEqual(
			findLinkSpans("![x](attachments/图 1.png)\n").map((span) => span.raw),
			["attachments/图 1.png"],
			"★ 普通正文里的引用不受影响"
		);
		// ⚠️⚠️ 反向的三条**误伤防线**（惰性区域最容易在这三处吃得过头）：
		// ① 4 空格缩进的**列表续行**是正常正文（与缩进代码块在文本上无法区分 ⇒ 宁可算）
		assert.deepEqual(
			findLinkSpans("- 项目\n    ![](attachments/图 1.png)\n").map((span) => span.raw),
			["attachments/图 1.png"],
			"★★ 列表里的 4 空格续行必须算引用（别拿缩进当代码）"
		);
		// ② 两个金额之间的正文（`$` 不是公式定界符）
		assert.deepEqual(
			findLinkSpans("花费 $5，见图 ![](attachments/图 1.png)，共 $10\n").map((span) => span.raw),
			["attachments/图 1.png"],
			"★★ 两个 `$` 之间的正文照旧算引用（否则价格里的图全丢）"
		);
		// ③ 长得像标签的普通文字（`<premium>` 不是 `<pre>`）—— 放宽会把后面整段划进惰性区间
		assert.deepEqual(
			findLinkSpans("<premium>![](attachments/图 1.png)</premium>\n").map((span) => span.raw),
			["attachments/图 1.png"],
			"★★ `<premium>` 不许被当成 `<pre>`（标签名要卡边界）"
		);
		// ④ 块级公式**之后**的正文（`$$x$$` 的闭合符不许当成下一段的开头）
		assert.deepEqual(
			findLinkSpans("$$x$$\n\n![](attachments/图 1.png)\n").map((span) => span.raw),
			["attachments/图 1.png"],
			"★★ `$$…$$` 之后的内容照旧算引用（闭合符不许把后面整篇并进区间）"
		);

		// ⚠️ 反向：标题里那个括号**不配平**时，不许把整条链接吞掉（括号数不过来 ⇒
		// 退回"第一个 `)`"的老行为，整条照旧能改）。这条不配平也是**常见写法**：
		// 用户手写的标题里出现半个括号，比路径里出现半个括号常见得多。
		const unbalancedTitle = '![a](attachments/图 1.png "见(注")';
		assert.deepEqual(
			findLinkSpans(unbalancedTitle).map((span) => span.raw),
			["attachments/图 1.png"],
			"★ 标题里的括号不配平时要退回「第一个 `)`」（否则整条链接从「能改」退化成「不认」）"
		);
		assert.equal(planLinkRewrites(unbalancedTitle, RULE).count, 1, "★ 同上：这种写法必须照旧改得掉");

		// ⚠️ 属性区（frontmatter）里的一律**不碰**（理由见 `LinkSpan.inFrontmatter`）：

		// 属性是结构化数据 —— 换成 Markdown 图片会把值写坏，只换路径又得到宿主不解析的 `[[https://…]]`。
		// 而"不改"没有损失：文件仍在库里，那一处引用照常工作。
		const front = '---\ncover: "[[图 1.png]]"\n---\n\n正文\n';
		assert.equal(
			stillMentionsPath(front, PATH),
			true,
			"属性里的引用也要算「还有人指着它」（否则那份文件可能被判成没人引用）"
		);
		assert.equal(planLinkRewrites(front, RULE).count, 0, "★ 属性区里的一律不碰（改坏属性值比不改糟得多）");
		assert.equal(
			planLinkRewrites("正文\n\n![[图 1.png]]\n", RULE).count,
			1,
			"★ 只跳过属性区 —— 同一篇笔记的正文照旧要改（别写成「跳过整篇」）"
		);
	}


	// ⭐⭐ 2026-10-22 审计：**画布文本里的远端地址也算"被引用"**（`keysInCanvasText`）。
	//
	// 现场：占用报告（`scanReferences`）原来只扫笔记，而云端清理扫"笔记 ＋ 画布文本"
	// ⇒ 一张只被画布卡片引用着的图，报告说"没有人引用 / 可回收"、清理命令却根本不会问它。
	// 判据现在只有一份，两侧共用。
	{
		const canvas = JSON.stringify({
			nodes: [
				{ id: "1", type: "text", text: "![](https://img.example.com/abc.png)" },
				{ id: "2", type: "file", file: "attachments/本地.png" },
			],
		});
		const keys = keysInCanvasText(canvas, (url) => (url.includes("/abc.png") ? "abc.png" : null));
		assert.deepEqual([...keys], ["abc.png"], "★ 画布**文本节点**里的远端地址要算进「仍被引用」");
		assert.deepEqual([...keysInCanvasText("", () => "x")], [], "空文本不产出");
		assert.deepEqual([...keysInCanvasText("{坏 JSON", () => "x")], [], "解不开的画布不该让整条命令失败");
	}
}
