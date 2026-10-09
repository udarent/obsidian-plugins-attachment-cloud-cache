/**
 * 维护功能的纯判定层套件：缓存审计、清理计划、引用扫描、链接改写、批量候选。
 *
 * ## 为什么这些必须穷举
 *
 * 它们决定的是**删用户的文件**与**改用户的笔记** —— 本项目里唯二不可逆的操作。
 * 判错的症状还特别安静：多删一个缓存文件没人会立刻发现（下次联网会重新下载），
 * 但改坏一条链接会立刻显示成"图没了"；而"少删"只会让磁盘慢慢变大。
 * 所以每类边界都要单独设断言，尤其是"哪些**不该**被删/被改"。
 */

import assert from "node:assert/strict";

export function runMaintenanceSuite(mod) {
	const { auditCache, planCleanup } = mod;
	const {
		findLinkSpans,
		planLinkRewrites,
		planCanvasRewrites,
		canvasTextTargets,
		resolveCanvasTargets,
		keysInText,
	} = mod;
	const { selectUploadCandidates } = mod;

	const CACHE = "_attachment-cache";
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
	// 1. 审计的四类对象
	// ============================================================
	const audit = auditCache({
		entries: [
			entry("healthy.png", `${CACHE}/healthy.png`, 10),
			entry("missing.png", `${CACHE}/missing.png`, 20),
			entry("unused.png", `${CACHE}/unused.png`, 30),
			// `localCopy: keep` 时副本在附件目录里 —— 那不是缓存文件
			entry("kept.png", "attachments/kept.png", 40),
		],
		files: [
			{ path: `${CACHE}/healthy.png`, bytes: 10 },
			{ path: `${CACHE}/unused.png`, bytes: 30 },
			{ path: `${CACHE}/orphan.png`, bytes: 50 },
			// 附件目录里的文件**不在**缓存目录下，不该被当成候选
			{ path: "attachments/kept.png", bytes: 40 },
			{ path: "attachments/user-photo.png", bytes: 60 },
		],
		referencedKeys: new Set(["healthy.png"]),
		cacheFolder: CACHE,
	});

	assert.deepEqual(
		audit.healthy.map((e) => e.key),
		["healthy.png"],
		"索引与磁盘一致、且仍被引用的才是健康副本"
	);
	assert.deepEqual(
		audit.missingCopies.map((e) => e.key),
		["missing.png"],
		"索引有、磁盘没有 → 应判为失效条目（自愈只改索引，不碰文件）"
	);
	assert.deepEqual(
		audit.unused.map((e) => e.key),
		["unused.png"],
		"索引与磁盘都有、但没有笔记引用 → 未引用副本"
	);
	assert.deepEqual(
		audit.orphans.map((f) => f.path),
		[`${CACHE}/orphan.png`],
		"★ 磁盘有、索引没有 → 孤儿。附件目录里的文件**绝不能**算孤儿"
	);
	assert.deepEqual(
		audit.outsideCache.map((e) => e.key),
		["kept.png"],
		"★ 副本不在缓存目录内的条目要单独归一类：既不自愈也不清理（那是用户的正常附件）"
	);
	assert.equal(audit.bytes.total, 90, "总字节只算缓存目录内的（10+30+50）");
	assert.equal(audit.bytes.reclaimable, 80, "可回收 = 孤儿 50 + 未引用 30");

	// ⭐ 没提供引用集合时**不产生**"未引用" —— 否则"只看占用"会把每一份都报成可删
	const withoutRefs = auditCache({
		entries: [entry("a.png", `${CACHE}/a.png`), entry("b.png", `${CACHE}/b.png`)],
		files: [
			{ path: `${CACHE}/a.png`, bytes: 1 },
			{ path: `${CACHE}/b.png`, bytes: 1 },
		],
		cacheFolder: CACHE,
	});
	assert.deepEqual(withoutRefs.unused, [], "★ 没扫描引用时不该产生\"未引用副本\"（那是把全部判成可删）");
	assert.deepEqual(
		withoutRefs.healthy.map((e) => e.key),
		["a.png", "b.png"],
		"没扫描引用时应按\"一致即健康\"处理"
	);

	// `localCopy: keep` 的副本路径不在缓存目录内：即使索引记着、文件也在，也不参与回收
	assert.equal(
		audit.bytes.reclaimable,
		80,
		"附件目录里的文件不计入可回收字节（那是用户的正常附件）"
	);

	// 路径写法差异不该造成误判（前导斜杠 / 反斜杠）
	const sloppy = auditCache({
		entries: [entry("x.png", `/${CACHE}/x.png`)],
		files: [{ path: `${CACHE}/x.png`, bytes: 5 }],
		cacheFolder: CACHE,
	});
	assert.equal(sloppy.missingCopies.length, 0, "路径写法差异不该被判成\"磁盘上没有\"");

	// ============================================================
	// 2. 清理计划：展示可截断、执行不可
	// ============================================================
	const many = auditCache({
		entries: [],
		files: Array.from({ length: 25 }, (_, i) => ({ path: `${CACHE}/o${i}.png`, bytes: 2 })),
		cacheFolder: CACHE,
	});
	const plan = planCleanup({ audit: many, previewLimit: 10 });

	assert.equal(plan.all.length, 25, "★ 执行清单必须**全量**（用截断清单去删会静默漏掉后面的对象）");
	assert.equal(plan.preview.length, 10, "展示清单按上限截断");
	assert.equal(plan.hidden, 15, "★ 被省略的数量要如实给出（否则用户以为只有 10 个）");
	assert.equal(plan.bytes, 50, "回收字节按全量算（25 × 2），不是按展示的那 10 个");

	// 自愈与清理**同批**下发：调用方先自愈（不动文件）再清理，避免"先清后修"白丢
	const healPlan = planCleanup({
		audit: auditCache({
			entries: [entry("gone.png", `${CACHE}/gone.png`)],
			files: [{ path: `${CACHE}/orphan.png`, bytes: 7 }],
			cacheFolder: CACHE,
		}),
	});
	assert.deepEqual(healPlan.healKeys, ["gone.png"], "自愈清单要一并给出");
	assert.deepEqual(healPlan.all, [`${CACHE}/orphan.png`], "清理清单照旧");

	// 空审计 → 空计划（不该产生"删 0 个"之外的任何东西）
	const empty = planCleanup({
		audit: auditCache({ entries: [], files: [], cacheFolder: CACHE }),
	});
	assert.deepEqual(empty.all, [], "没有可清理对象时清单应为空");
	assert.equal(empty.hidden, 0);
	assert.equal(empty.bytes, 0);

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
			[...resolveCanvasTargets(["photo.png"], vault)],
			["attachments/photo.png"],
			"短名在唯一时要能对上"
		);
		assert.deepEqual(
			[...resolveCanvasTargets(["attachments/photo"], vault)],
			["attachments/photo.png"],
			"没写扩展名也要能对上（与改写器同一套归一）"
		);
		assert.deepEqual([...resolveCanvasTargets(["img/logo.svg"], vault)], ["img/logo.svg"], "完整路径");
		assert.deepEqual([...resolveCanvasTargets(["missing.png"], vault)], [], "库里没有的不能凭空造出来");

		// ⚠️ 同名歧义 ⇒ **一个都不收**：收了就会把文件搬走，而改写器在歧义时拒绝改写
		// ⇒ 笔记/画布里那条链接一处都改不掉 ⇒ 死链。宁可少处理。
		const ambiguous = ["a/dup.png", "b/dup.png"];
		assert.deepEqual(
			[...resolveCanvasTargets(["dup.png"], ambiguous)],
			[],
			"★ 同名歧义一个都不收（搬得走却改不掉 = 死链）"
		);
		assert.deepEqual(
			[...resolveCanvasTargets(["a/dup.png"], ambiguous)],
			["a/dup.png"],
			"写全路径时就不存在歧义"
		);
	}

	// ============================================================
	// 6. 批量上传候选：宁少不多
	// ============================================================
	const { CacheIndex } = mod;
	const settings = {
		autoUpload: true,
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: CACHE,
		fallbackDownload: true,
		s3: {
			endpoint: "https://s3.example.com",
			region: "auto",
			bucket: "b",
			publicUrlBase: "https://img.example.com",
			accessKeyId: "",
			secretAccessKeyRef: "",
			forcePathStyle: true,
			objectKeyTemplate: "{hash}.{ext}",
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
		{ settings, index, referencedPaths: referencedInUse }
	);

	// ⭐ 1.1.0 起候选是**排除制**（需求 R15）：除了"笔记/画布/数据库"这三种宿主自己的
	// 文本文件之外，任何类型都可以上传 —— 所以 `notes.md` 仍然被跳过（它不是附件），
	// 而 PDF / 音频 / 视频 / 压缩包全都该进来。
	assert.deepEqual(
		selection.paths,
		["attachments/a.png", "attachments/b.jpg"],
		"非空、未处理过、且被引用的附件才进候选"
	);
	const reasons = Object.fromEntries(selection.skipped.map((s) => [s.reason, s.count]));
	assert.equal(reasons["是笔记/画布/数据库文件，不是附件"], 1, "笔记文件不是附件，要跳过并计数");
	assert.equal(reasons["文件为空（可能是同步中的占位）"], 1, "空文件应被跳过（传上去会得到坏对象）");
	assert.equal(reasons["已经在缓存索引里"], 1, "已处理过的应被跳过");
	assert.equal(reasons["路径为空"], 1, "坏输入应被跳过而不是让整批失败");

	// ⭐ 只处理**被笔记引用着**的文件：命令成功后会把它移进缓存目录，
	// 而没有任何引用的文件搬走之后没有任何东西会把用户引到它的新位置。
	const unreferenced = selectUploadCandidates(
		[
			{ path: "attachments/used.png", extension: "png", stat: { size: 10 } },
			{ path: "attachments/orphan.png", extension: "png", stat: { size: 10 } },
		],
		{ settings, index, referencedPaths: new Set(["attachments/used.png"]) }
	);
	assert.deepEqual(unreferenced.paths, ["attachments/used.png"], "★ 只有被笔记引用的才处理");
	const unrefReasons = Object.fromEntries(unreferenced.skipped.map((s) => [s.reason, s.count]));
	assert.equal(
		unrefReasons["没有被任何笔记引用"],
		1,
		"★ 没有被引用的文件要跳过**并如实计数**（否则用户看到的只是「传得少」）"
	);
	// ⭐ 结构化字段：确认框按它说「另有 N 个不会被处理」—— 不让界面去认那串中文文案
	assert.equal(unreferenced.unreferenced, 1, "★ 未引用的个数要单独给出来（供确认框如实交代）");
	assert.equal(selection.unreferenced, 0, "这一批每个都有人引用 ⇒ 未引用数应为 0");

	// 没有 stat 的文件（宿主可能不给）不该被当成空文件
	const noStat = selectUploadCandidates([{ path: "attachments/no-stat.png", extension: "png" }], {
		settings,
		index,
		referencedPaths: new Set(["attachments/no-stat.png"]),
	});
	assert.deepEqual(noStat.paths, ["attachments/no-stat.png"], "拿不到 size 时不该误判成空文件");

	// ⭐ 「被引用」这个集合的取法：把宿主的链接索引换算成"目标路径"集合。
	// 形状与"画布也会进索引"这两条都来自真机取证
	//（`dev-notes/_archive/.probe-referenced-links.mjs`）。
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
	const { SiteDecisions } = mod;

	// ── 1. 只认**图片**写法 ──
	assert.deepEqual(externalFileUrlsIn("![a](https://x.test/a.png)"), ["https://x.test/a.png"], "Markdown 图片要认");
	// ⭐ 1.1.0（需求 R15）：普通链接**也要收** —— `[报告](https://…/report.pdf)` 是
	// PDF / 音频 / 压缩包最常见的写法，不收它"支持所有格式"就只覆盖了 `![]` 那一半。
	// ⚠️ 于是候选里会混进**网页**链接：它们在下载那一步被 `text/html` 判据挡掉，
	// 用户看到一句如实的"该地址返回的是网页或纯文本"（原则⑥），而不是静默无事发生。
	assert.deepEqual(
		externalFileUrlsIn("[a](https://x.test/page)"),
		["https://x.test/page"],
		"★ 普通链接也要收（它可能是 PDF/音频/压缩包）；网页那一类由下载判定拒收"
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

	// ── 2. 挑选：候选的判据是"能不能搬"，与默认行为无关 ──
	{
		// ⚠️ 刻意把默认设成「什么都不做」：命令与选择器是**显式动作**，
		// 它们的候选必须照旧列出来 —— 否则用户把默认调成「什么都不做」之后，
		// 这两个入口会列出一份空清单（等于功能不存在）。
		const externalSettings = { ...settings, externalImageCache: true, externalImageDefault: "skip" };
		const notes = [
			{
				path: "notes/one.md",
				// ⚠️ 第三行是**同一张图写第二遍**：它必须只算一个候选（改写时两处一起换）
				text: "![x](https://offsite.test/a.png)\n![](https://offsite.test/b.png)\n![dup](https://offsite.test/a.png)",
			},
			{ path: "notes/two.md", text: "![](https://other.test/c.png)\n![](https://third.test/d.png)" },
			{ path: "notes/three.md", text: "![](https://img.example.com/cached.png)" },
		];
		const options = { settings: externalSettings, configured: true };

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

		// 站点排序固定：输出稳定，展示与断言都不会因为扫库顺序而变
		const again = selectExternalUploadCandidates([...notes].reverse(), options);
		assert.deepEqual(
			again.sites.map((s) => s.host),
			picked.sites.map((s) => s.host),
			"站点顺序与笔记的读取顺序无关"
		);

		// ── 3. 「缓存站外图片」关着时，命令**不得**越过这个开关 ──
		const off = selectExternalUploadCandidates(notes, {
			...options,
			settings: { ...externalSettings, externalImageCache: false },
		});
		assert.deepEqual(off.candidates, [], "★ 功能关着时命令不得去碰任何站外图（那是用户对外的隐私立场）");
		assert.equal(
			off.skipped.some((s) => s.reason.includes("功能")),
			true,
			"跳过的原因要如实来自判定层（这里是「功能已关闭」）"
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

		// ── 5b. ⭐ 默认设成「直接缓存」时，候选一模一样 ──
		const cached = selectExternalUploadCandidates(notes, {
			...options,
			settings: { ...externalSettings, externalImageDefault: "cache" },
		});
		assert.deepEqual(
			cached.candidates.map((c) => c.url),
			picked.candidates.map((c) => c.url),
			"★ 候选清单与默认行为无关（那一档说的是「现在动不动手」，不是「能不能搬」）"
		);

		// ── 6. 坏输入不该让整批失败 ──
		assert.deepEqual(
			selectExternalUploadCandidates([{ path: "", text: "![](https://x.test/a.png)" }, { path: "n.md" }], options)
				.candidates,
			[],
			"没有路径的笔记、没有正文的笔记都应安全跳过"
		);
	}
}
