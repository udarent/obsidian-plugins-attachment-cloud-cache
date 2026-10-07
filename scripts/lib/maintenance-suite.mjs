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
	const { findLinkSpans, planLinkRewrites, keysInText } = mod;
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

	const alias = planLinkRewrites("![[photo2.png|600]]", RULES);
	assert.equal(alias.text, "![[https://img.example.com/abc.png|600]]", "★ 别名/尺寸必须保留");
	assert.equal(alias.count, 1);

	const subpath = planLinkRewrites("![[photo2.png#page=2]]", RULES);
	assert.equal(subpath.text, "![[https://img.example.com/abc.png#page=2]]", "★ 子路径必须保留");

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
	assert.ok(
		!both.text.includes("photo2"),
		`改完之后不该还提到本地路径：${both.text}`
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
	// 6. 批量上传候选：宁少不多
	// ============================================================
	const { CacheIndex } = mod;
	const settings = {
		autoUpload: true,
		enabledExtensions: ["png", "jpg"],
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

	const selection = selectUploadCandidates(
		[
			{ path: "attachments/a.png", extension: "png", stat: { size: 100 } },
			{ path: "attachments/b.jpg", extension: "jpg", stat: { size: 200 } },
			{ path: "attachments/notes.md", extension: "md", stat: { size: 10 } },
			{ path: "attachments/empty.png", extension: "png", stat: { size: 0 } },
			{ path: "attachments/cached.png", extension: "png", stat: { size: 50 } },
			{ path: "", extension: "png", stat: { size: 5 } },
		],
		{ settings, index }
	);

	assert.deepEqual(selection.paths, ["attachments/a.png", "attachments/b.jpg"], "只挑启用清单里的、非空、未处理过的");
	const reasons = Object.fromEntries(selection.skipped.map((s) => [s.reason, s.count]));
	assert.equal(reasons["扩展名不在启用清单里"], 1, "非图片应被跳过并计数");
	assert.equal(reasons["文件为空（可能是同步中的占位）"], 1, "空文件应被跳过（传上去会得到坏对象）");
	assert.equal(reasons["已经在缓存索引里"], 1, "已处理过的应被跳过");
	assert.equal(reasons["路径为空"], 1, "坏输入应被跳过而不是让整批失败");

	// 没有 stat 的文件（宿主可能不给）不该被当成空文件
	const noStat = selectUploadCandidates([{ path: "attachments/no-stat.png", extension: "png" }], {
		settings,
		index,
	});
	assert.deepEqual(noStat.paths, ["attachments/no-stat.png"], "拿不到 size 时不该误判成空文件");

}
