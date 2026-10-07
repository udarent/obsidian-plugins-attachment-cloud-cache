/**
 * 缓存索引的断言套件（正式测试与变异验证共用）。
 *
 * ## 为什么索引的**容错加载**值得单独一整套断言
 *
 * 索引是"可以重建的派生数据"，而它读失败的时刻恰好是**插件启动**。
 * 若在这里抛错，用户看到的是"插件加载失败、连设置页都进不去" ——
 * 为了一份缓存索引付出这个代价毫无道理。所以"坏输入必须降级"是本模块的第一性质，
 * 而且它的输入**真的**可能是任何东西：手改过的 JSON、旧版本格式、被同步工具截断的文件。
 *
 * 第二性质是**沉默的错配**：索引记的是"哪个 URL 对应哪个本地文件"。
 * 记错了不会有任何报错，只会表现为"离线时图不显示"或"该回退下载时以为本地已有"。
 * 所以查表（按 key / 按路径 / 按 URL）的归一化行为必须穷举。
 */

import assert from "node:assert/strict";

const SAMPLE = {
	key: "a1b2.png",
	cachePath: "_attachment-cache/a1b2.png",
	remoteUrl: "https://img.example.com/a1b2.png",
	size: 1234,
	contentType: "image/png",
	etag: "deadbeef",
	uploadedAt: "2026-10-06T05:06:58.000Z",
	// "最近被用到"的时间（epoch ms）—— 缓存上限的轮换靠它排序
	lastUsedAt: Date.parse("2026-10-06T07:00:00.000Z"),
	sourceName: "photo.png",
};

export function runCacheIndexSuite(mod) {
	const { CacheIndex, CACHE_INDEX_VERSION, normalizeEntry, normalizeUrl } = mod;

	// ============================================================
	// 1. normalizeEntry —— 逐字段校验
	// ============================================================
	assert.deepEqual(normalizeEntry(SAMPLE), SAMPLE, "完整记录应原样通过");

	// 只有 `key` 与 `cachePath` 是必不可少的：没有 key 就无法与远端对应，
	// 没有 cachePath 就找不到本地副本 —— 缺任一条，这条记录就没有用途。
	assert.equal(normalizeEntry({ cachePath: "c/a.png" }), null, "缺 key 的记录无法使用");
	assert.equal(normalizeEntry({ key: "a.png" }), null, "缺 cachePath 的记录无法使用");
	assert.equal(normalizeEntry({ key: "   ", cachePath: "c/a.png" }), null, "纯空白的 key 等同缺失");
	assert.equal(normalizeEntry({ key: "a.png", cachePath: "   " }), null, "纯空白的 cachePath 等同缺失");
	assert.equal(normalizeEntry(null), null, "null 不是记录");
	assert.equal(normalizeEntry("a.png"), null, "字符串不是记录");
	assert.equal(normalizeEntry(42), null, "数字不是记录");
	assert.equal(normalizeEntry([]), null, "数组不是记录");

	// 其余字段缺失时给安全默认值：显示不准可以接受，正确性不能打折
	const minimal = normalizeEntry({ key: "a.png", cachePath: "c/a.png" });
	assert.deepEqual(
		minimal,
		{
			key: "a.png",
			cachePath: "c/a.png",
			remoteUrl: "",
			size: 0,
			contentType: "",
			etag: "",
			uploadedAt: "",
			lastUsedAt: 0,
			sourceName: "",
		},
		"缺失字段应补安全默认值"
	);

	// 数值字段要挡住脏数据（`NaN` / 负数 / 字符串都会让"占用统计"显示成乱码）
	assert.equal(normalizeEntry({ ...SAMPLE, size: -1 }).size, 0, "负数大小应归 0");
	assert.equal(normalizeEntry({ ...SAMPLE, size: Number.NaN }).size, 0, "NaN 应归 0");
	assert.equal(normalizeEntry({ ...SAMPLE, size: "1234" }).size, 0, "字符串大小应归 0（不做隐式转换，免得把脏数据带进统计）");
	assert.equal(normalizeEntry({ ...SAMPLE, size: Number.POSITIVE_INFINITY }).size, 0, "Infinity 应归 0");
	assert.equal(normalizeEntry({ ...SAMPLE, size: 0 }).size, 0, "0 是合法值");
	// 字符串字段的类型错了要归空串，而不是让对象/数组流下去
	assert.equal(normalizeEntry({ ...SAMPLE, remoteUrl: { href: "x" } }).remoteUrl, "", "非字符串 URL 应归空串");
	assert.equal(normalizeEntry({ ...SAMPLE, etag: ["x"] }).etag, "", "非字符串 ETag 应归空串");
	// 前导/尾随空白要去掉（否则按路径查表会因为一个空格而查不到）
	assert.equal(normalizeEntry({ key: " a.png ", cachePath: " c/a.png " }).key, "a.png", "key 应 trim");
	assert.equal(normalizeEntry({ key: " a.png ", cachePath: " c/a.png " }).cachePath, "c/a.png", "cachePath 应 trim");

	// ============================================================
	// 2. 基本操作
	// ============================================================
	const index = new CacheIndex();
	assert.equal(index.size, 0, "空索引大小为 0");
	assert.equal(index.get("a.png"), undefined);
	assert.equal(index.has("a.png"), false);

	index.set(SAMPLE);
	assert.equal(index.size, 1);
	assert.equal(index.has(SAMPLE.key), true);
	assert.deepEqual(index.get(SAMPLE.key), SAMPLE);

	// 同 key 覆盖：后写的生效（与 Map 一致）
	const updated = { ...SAMPLE, etag: "newetag", cachePath: "_attachment-cache/moved.png" };
	index.set(updated);
	assert.equal(index.size, 1, "同 key 覆盖不应让条目数增加");
	assert.equal(index.get(SAMPLE.key).etag, "newetag", "同 key 应后写覆盖");
	assert.equal(index.get(SAMPLE.key).cachePath, "_attachment-cache/moved.png", "路径也应更新");

	assert.equal(index.remove(SAMPLE.key), true, "删除存在的条目应返回 true");
	assert.equal(index.remove(SAMPLE.key), false, "重复删除应返回 false（供汇报用）");
	assert.equal(index.size, 0);

	// 构造时也去重（后写覆盖），否则行为会取决于遍历顺序
	const deduped = new CacheIndex([SAMPLE, { ...SAMPLE, etag: "second" }]);
	assert.equal(deduped.size, 1, "构造时同 key 应去重");
	assert.equal(deduped.get(SAMPLE.key).etag, "second", "构造时后写应覆盖先写");

	// ============================================================
	// 3. toArray 必须**稳定排序**（落盘与测试都依赖它）
	// ============================================================
	const unsorted = new CacheIndex();
	for (const key of ["zebra.png", "alpha.png", "mango.png"]) {
		unsorted.set({ ...SAMPLE, key, cachePath: `c/${key}` });
	}
	assert.deepEqual(
		unsorted.toArray().map((entry) => entry.key),
		["alpha.png", "mango.png", "zebra.png"],
		"⭐ 必须按 key 排序：Map 的顺序取决于插入顺序，那会让同一份数据产出不同的文件内容"
	);
	assert.deepEqual(
		unsorted.keys().sort(),
		["alpha.png", "mango.png", "zebra.png"],
		"keys() 应给出全部 key"
	);

	// ============================================================
	// 4. 按本地路径反查
	// ============================================================
	const byPath = new CacheIndex([SAMPLE]);
	assert.equal(byPath.findByCachePath(SAMPLE.cachePath)?.key, SAMPLE.key, "应能按本地路径反查到条目");
	assert.equal(byPath.findByCachePath("_attachment-cache/nope.png"), undefined, "查不到应返回 undefined");

	// ============================================================
	// 5. ⭐ 按 URL 反查 —— 渲染钩子的入口
	//
	// 笔记里写的可能是当初那串文本的任意变体（用户改过域名、从旧配置迁移、
	// 或同步时被工具规整过），所以比较必须**归一化**，而不能逐字相等。
	// ============================================================
	const byUrl = new CacheIndex([SAMPLE]);
	assert.equal(byUrl.findByRemoteUrl(SAMPLE.remoteUrl)?.key, SAMPLE.key, "完全一致的 URL 应能查到");
	assert.equal(
		byUrl.findByRemoteUrl(`${SAMPLE.remoteUrl}/`)?.key,
		SAMPLE.key,
		"尾斜杠差异不应影响命中"
	);
	assert.equal(
		byUrl.findByRemoteUrl(SAMPLE.remoteUrl.replace("img.", "IMG."))?.key,
		SAMPLE.key,
		"域名大小写不应影响命中（域名本来就不区分大小写）"
	);
	assert.equal(
		byUrl.findByRemoteUrl(SAMPLE.remoteUrl.replace("https://", "HTTPS://"))?.key,
		SAMPLE.key,
		"协议大小写不应影响命中"
	);
	assert.equal(
		byUrl.findByRemoteUrl("https://img.example.com/other.png"),
		undefined,
		"不同路径不应命中"
	);
	assert.equal(
		byUrl.findByRemoteUrl("https://cdn.example.com/a1b2.png"),
		undefined,
		"⭐ 不同主机不应命中 —— 否则会把别人的图当成自己的缓存"
	);
	assert.equal(byUrl.findByRemoteUrl(""), undefined, "空 URL 不该命中任何东西");
	assert.equal(byUrl.findByRemoteUrl(null), undefined, "非字符串不该抛错");
	assert.equal(byUrl.findByRemoteUrl(undefined), undefined);
	// 大小写敏感的部分（路径）不该被"顺手小写"掉
	assert.equal(
		byUrl.findByRemoteUrl(SAMPLE.remoteUrl.toUpperCase())?.key,
		undefined,
		"路径大小写**是**敏感的，不该被归一化掉（那会把两个不同的对象当成同一个）"
	);

	// ============================================================
	// 6. pruneMissing —— 自愈（只改索引，不碰文件）
	// ============================================================
	const stale = new CacheIndex([
		{ ...SAMPLE, key: "present.png", cachePath: "c/present.png" },
		{ ...SAMPLE, key: "gone.png", cachePath: "c/gone.png" },
	]);
	const removed = stale.pruneMissing((path) => path === "c/present.png");
	assert.deepEqual(removed, ["gone.png"], "应只丢弃本地副本不存在的条目，并返回被丢弃的 key");
	assert.equal(stale.size, 1, "留下的应是本地确实存在的那条");
	assert.ok(stale.get("present.png"), "存在的条目应保留");
	assert.equal(stale.get("gone.png"), undefined, "不存在的条目应被清掉");

	// 全部存在时不该误删
	const healthy = new CacheIndex([SAMPLE]);
	assert.deepEqual(healthy.pruneMissing(() => true), [], "全部存在时不该丢弃任何条目");
	// 全部不存在时清空（缓存目录被用户删掉的情形）
	const emptied = new CacheIndex([SAMPLE]);
	assert.equal(emptied.pruneMissing(() => false).length, 1, "全部不存在时应全部丢弃");

	// ============================================================
	// 7. 落盘结构
	// ============================================================
	const serialized = new CacheIndex([SAMPLE]).toJSON();
	assert.equal(serialized.version, CACHE_INDEX_VERSION, "落盘结构应带版本号（将来迁移要用）");
	assert.deepEqual(serialized.entries, [SAMPLE], "entries 应是排序后的数组，且内容不变");
	assert.equal(CACHE_INDEX_VERSION, 1, "结构版本变了就该在这里改，并想清楚迁移");

	// ============================================================
	// 8. ⭐ 容错加载
	// ============================================================
	// 8a. 首次运行（没有索引文件）——正常状态，不是错误
	for (const nothing of [null, undefined]) {
		const result = CacheIndex.fromJSON(nothing);
		assert.equal(result.index.size, 0, `${nothing} 应得到空索引`);
		assert.deepEqual(result.skipped, [], `${nothing} 不该被记成"丢弃了条目"（首次运行是正常的）`);
	}

	// 8b. 两种形状都接受：裸数组（便于手工修复）与带 entries 的对象
	for (const [label, value] of [
		["裸数组", [SAMPLE]],
		["带 entries 的对象", { version: 1, entries: [SAMPLE] }],
	]) {
		const result = CacheIndex.fromJSON(value);
		assert.equal(result.index.size, 1, `${label} 形状应被接受`);
		assert.deepEqual(result.index.get(SAMPLE.key), SAMPLE, `${label} 形状的条目应完整读回`);
	}

	// 8c. 顶层结构完全不对 → 空索引 + 记一条，绝不抛错
	//
	// ⚠️ 这里**必须自己 try/catch 并断言**，不能让异常直接冒出去：
	// 若只是"调用它"，实现一旦抛错，测试会以那个错误失败，
	// 报出来的是一句"坏的索引结构"，完全没说清"它本该降级"——
	// 而要检验的恰恰是"它不该抛错"。捕获后自己喊出来，失败信息才指名道姓。
	for (const wrong of [42, "nope", true, { foo: "bar" }, { entries: "not-an-array" }]) {
		let result;
		try {
			result = CacheIndex.fromJSON(wrong);
		} catch (error) {
			assert.fail(
				`⭐ 坏的顶层结构（${JSON.stringify(wrong)}）必须**降级为空索引**，而不是抛错 —— ` +
					`索引会在插件启动时读取，抛错会让用户连设置页都进不去。实际抛出：${error?.message ?? error}`
			);
		}
		assert.equal(result.index.size, 0, `顶层结构为 ${JSON.stringify(wrong)} 时应降级为空索引`);
		assert.equal(result.skipped.length, 1, "应记下「这条输入没被接受」，让人看得见");
		assert.ok(result.skipped[0].reason.length > 0, "被丢弃的记录必须带原因");
	}

	// 8d. 逐条校验：坏条目丢弃并计数，好条目保留
	const mixed = CacheIndex.fromJSON({
		version: 1,
		entries: [
			SAMPLE,
			{ cachePath: "c/no-key.png" },
			{ key: "no-path.png" },
			"不是对象",
			null,
			{ ...SAMPLE, key: "ok2.png", cachePath: "c/ok2.png" },
		],
	});
	assert.equal(mixed.index.size, 2, "只应保留两条完整记录");
	assert.ok(mixed.index.get(SAMPLE.key), "第一条完整记录应保留");
	assert.ok(mixed.index.get("ok2.png"), "后面的完整记录也应保留");
	assert.equal(mixed.skipped.length, 4, `应记录 4 条被丢弃的条目，实际 ${mixed.skipped.length}`);
	assert.ok(
		mixed.skipped.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0),
		"每条被丢弃的记录都要给出原因（沉默丢弃等于把问题藏起来）"
	);
	assert.ok(
		mixed.skipped.every((entry) => "raw" in entry),
		"应保留原始内容，便于排查与手工修复"
	);

	// 8e. 重复 key：保留**先出现**的那条并记账，而不是静默覆盖
	const duplicated = CacheIndex.fromJSON({
		entries: [
			{ key: "dup.png", cachePath: "c/first.png" },
			{ key: "dup.png", cachePath: "c/second.png" },
		],
	});
	assert.equal(duplicated.index.size, 1, "重复 key 只应保留一条");
	assert.equal(
		duplicated.index.get("dup.png").cachePath,
		"c/first.png",
		"⭐ 应保留**先出现**的那条 —— 否则「哪条是真的」取决于文件里的顺序，不可预测"
	);
	assert.equal(duplicated.skipped.length, 1, "被跳过的重复项应记账");

	// 8f. 往返：写出去再读回来必须完全一致
	const original = new CacheIndex([
		{ ...SAMPLE, key: "b.png", cachePath: "c/b.png" },
		{ ...SAMPLE, key: "a.png", cachePath: "c/a.png" },
	]);
	const roundTripped = CacheIndex.fromJSON(JSON.parse(JSON.stringify(original.toJSON())));
	assert.equal(roundTripped.skipped.length, 0, "自己写出的索引不该有被丢弃的条目");
	assert.deepEqual(roundTripped.index.toArray(), original.toArray(), "往返后应逐条一致（含顺序）");

	// ============================================================
	// 9. normalizeUrl
	// ============================================================
	assert.equal(normalizeUrl("https://IMG.Example.com/a/b.png"), "https://img.example.com/a/b.png", "协议与主机小写");
	assert.equal(normalizeUrl("https://img.example.com/a/b.png/"), "https://img.example.com/a/b.png", "去尾斜杠");
	assert.equal(normalizeUrl("https://img.example.com//a//b.png"), "https://img.example.com/a/b.png", "收敛重复斜杠");
	assert.equal(normalizeUrl("  https://img.example.com/a.png  "), "https://img.example.com/a.png", "去首尾空白");
	assert.equal(
		normalizeUrl("https://img.example.com/a%20b.png"),
		"https://img.example.com/a%20b.png",
		"⭐ 百分号编码**不得**被动 —— 那会破坏「只编码一次」的约定"
	);
	assert.equal(normalizeUrl("relative/path.png"), "relative/path.png", "没有协议时按相对路径处理（不抛错）");
	assert.equal(normalizeUrl(""), "", "空串归一化为空串");
	assert.equal(normalizeUrl(null), "", "非字符串返回空串");
	assert.equal(normalizeUrl(42), "");

	// ============================================================
	// 10. ⭐ "最近被用到"的时间（缓存上限轮换的排序依据）
	//
	// 它坏掉不会有任何报错：只是轮换会挑错人 —— 把用户天天在看的图淘汰掉，
	// 而几个月没打开过的那份留着。所以要单独钉住。
	// ============================================================
	const touch = (index, key, at, intervalMs) => index.touch(key, at, intervalMs);

	// --- normalizeEntry：坏时间戳不能让整条记录作废 ---
	{
		// 它是**可选元数据**：缺失/坏掉只影响轮换排序，不该让"这条副本存在"这件事丢掉。
		for (const [label, raw] of [
			["字符串", "昨天"],
			["负数", -1],
			["NaN", Number.NaN],
			["Infinity", Number.POSITIVE_INFINITY],
			["对象", {}],
			["null", null],
		]) {
			const normalized = normalizeEntry({ key: "k.png", cachePath: "c/k.png", lastUsedAt: raw });
			assert.ok(normalized, `★ lastUsedAt 是${label}时不该丢掉整条记录（它只是可选元数据）`);
			assert.equal(normalized.lastUsedAt, 0, `★ lastUsedAt 是${label}时应归 0（= 不确知）`);
			assert.equal(normalized.key, "k.png", "其它字段照常保留");
		}
		assert.equal(
			normalizeEntry({ key: "k.png", cachePath: "c/k.png", lastUsedAt: 12345 }).lastUsedAt,
			12345,
			"合法的时间戳要原样保留"
		);
		assert.equal(
			normalizeEntry({ key: "k.png", cachePath: "c/k.png" }).lastUsedAt,
			0,
			"★ 没有这个字段（旧版本索引）时归 0，而不是 undefined（那会让排序算出 NaN）"
		);
	}

	// --- touch：只改内存、有节流、不凭空造记录 ---
	{
		// ⚠️ 必须传**拷贝**，不能直接用共享样板 `SAMPLE`：
		// `CacheIndex` 按**引用**持有条目（`write()` 里存的就是传进来的那个对象），
		// 而 `touch()` 会就地改 `lastUsedAt` —— 用共享样板就等于把这个模块级常量改脏了。
		// 后果很隐蔽：套件**单独跑一次**完全正常，而**同一个进程里跑第二次**时才红
		//（变异运行器恰恰是这么跑的：基线 + 每条变异 + 还原后各跑一遍）。
		// 症状是"还原后仍失败"，看起来像源码没还原，其实是测试自己有状态。
		const index = new CacheIndex([{ ...SAMPLE }]);
		const HOUR = 60 * 60 * 1000;

		assert.equal(
			touch(index, "不存在.png", Date.parse("2026-10-07T00:00:00Z"), HOUR),
			false,
			"★ 记录不存在时**不创建**（凭空造一条会让轮换去管它不该管的文件）"
		);
		assert.equal(index.size, 1, "大小不该变");

		// 第一次：从 0（= 不确知）更新到"现在"
		const first = Date.parse("2026-10-07T00:00:00Z");
		assert.equal(touch(index, "a1b2.png", first, HOUR), true, "第一次应更新");
		assert.equal(index.get("a1b2.png").lastUsedAt, first, "值要写进去");

		// 节流：一小时内再来不更新（否则渲染热路径会把索引反复标脏）
		assert.equal(
			touch(index, "a1b2.png", first + 30 * 60 * 1000, HOUR),
			false,
			"★ 同一小时内不该重复更新（渲染路径会对每张图都调它）"
		);
		assert.equal(index.get("a1b2.png").lastUsedAt, first, "被节流时值不变");

		// 过了间隔就更新
		const later = first + HOUR;
		assert.equal(touch(index, "a1b2.png", later, HOUR), true, "过了间隔应更新");
		assert.equal(index.get("a1b2.png").lastUsedAt, later, "值要变成新的");

		// 坏时间不许写进去
		for (const bad of [Number.NaN, 0, -5, "昨天", null, undefined]) {
			assert.equal(
				touch(index, "a1b2.png", bad, 0),
				false,
				`★ at 是 ${JSON.stringify(bad)} 时不该写（写进去会让排序结果不可预测）`
			);
		}
		assert.equal(index.get("a1b2.png").lastUsedAt, later, "坏值不该改变已有的值");

		// ⭐ 就地更新不能破坏派生映射（按 URL 反查仍要命中）
		assert.equal(
			index.findByRemoteUrl(SAMPLE.remoteUrl)?.key,
			"a1b2.png",
			"★ touch 只改 `lastUsedAt`，不该影响按 URL 反查（那会静默破坏渲染路径）"
		);

		// 落盘往返要带上这个字段
		const reloaded = CacheIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON()))).index;
		assert.equal(reloaded.get("a1b2.png").lastUsedAt, later, "★ lastUsedAt 必须能被写出去、读回来（否则每次重启都退化成按上传时间排）");
	}

	// 同一 key 的时间戳变化不影响"顺序稳定"那条性质
	{
		const a = new CacheIndex([{ ...SAMPLE, key: "a.png", remoteUrl: "https://x/a.png" }]);
		const b = new CacheIndex([{ ...SAMPLE, key: "b.png", remoteUrl: "https://x/b.png" }]);
		touch(a, "a.png", Date.parse("2026-10-07T09:00:00Z"), 0);
		touch(b, "b.png", Date.parse("2026-10-07T08:00:00Z"), 0);
		assert.deepEqual(
			a.toArray().map((e) => e.key),
			["a.png"],
			"toArray 仍按 key 排序（不受时间戳影响）"
		);
	}

	return { urlCases: 12, entryCases: 20 };
}
