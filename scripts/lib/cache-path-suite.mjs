/**
 * 缓存路径模块的断言套件（与变异验证共用）。
 *
 * 这一层最要紧的两条：
 * - `cachePathFor` 的**单射性**：不同 key 撞同一路径会让两张图互相覆盖，且是静默的。
 * - `isUnderCacheFolder` 是**清理命令删文件的安全闸门** —— 判宽了会删掉用户的笔记。
 */

import assert from "node:assert/strict";

export function runCachePathSuite(mod) {
	const { cachePathFor, isUnderCacheFolder, flattenKeyForLayout, CACHE_LAYOUTS } = mod;
	const root = "_attachment-cache";

	// ---------- 1. mirror：与桶内结构一一对应 ----------
	assert.equal(cachePathFor("a1b2.png", root, "mirror"), `${root}/a1b2.png`, "单段 key → 直接对应");
	assert.equal(
		cachePathFor("attachments/2026/a1b2.png", root, "mirror"),
		`${root}/attachments/2026/a1b2.png`,
		"多段 key → 保持结构"
	);
	assert.equal(
		cachePathFor("x/y/z.png", root, "mirror").slice(root.length + 1),
		"x/y/z.png",
		"mirror 下「缓存相对路径 === 对象 key」必须严格成立"
	);

	// ---------- 2. flat：平铺但不得撞名 ----------
	assert.equal(cachePathFor("a1b2c3.png", root, "flat"), `${root}/a1b2c3.png`);

	const flatA = cachePathFor("a/photo.png", root, "flat");
	const flatB = cachePathFor("b/photo.png", root, "flat");
	assert.notEqual(flatA, flatB, "★ flat 下不同 key 的相同文件名不得撞同一路径");
	assert.ok(flatA.startsWith(`${root}/`), "仍应在缓存目录内");
	assert.ok(!flatA.slice(root.length + 1).includes("/"), "flat 不应产生子目录");
	assert.ok(flatA.endsWith(".png"), "flat 仍应保留扩展名");
	assert.equal(cachePathFor("a/photo.png", root, "flat"), flatA, "flat 展开必须确定性");

	// ---------- 3. byExt：按扩展名分目录 ----------
	assert.equal(cachePathFor("a1b2.png", root, "byExt"), `${root}/png/a1b2.png`, "按扩展名分目录");

	const upper = cachePathFor("x/y/a1b2.PNG", root, "byExt");
	assert.ok(upper.startsWith(`${root}/png/`), `扩展名目录应小写：${upper}`);
	assert.ok(upper.endsWith(".PNG"), `文件名不应被改名：${upper}`);
	assert.ok(upper.includes("a1b2"), `应保留可读的文件名部分：${upper}`);

	const singleSegName = cachePathFor("a1b2c3.png", root, "byExt").split("/").pop();
	assert.equal(singleSegName, "a1b2c3.png", "单段 key 不应产生撞名摘要");

	const byExtA = cachePathFor("a/photo.png", root, "byExt");
	const byExtB = cachePathFor("b/photo.png", root, "byExt");
	assert.notEqual(byExtA, byExtB, "★ byExt 下不同 key 的相同文件名不得撞同一路径");

	const noExt = cachePathFor("a/noext", root, "byExt");
	assert.ok(noExt !== null, "缺扩展名的 key 也应能推出路径");
	assert.ok(!noExt.includes("//"), `byExt 不应因缺扩展名产生空段：${noExt}`);

	// ---------- 4. 敌意 key 分两类处理 ----------
	const normalizableKeys = ["/absolute/path.png", "a//b.png", "a/./b.png"];
	const traversalKeys = ["../../etc/passwd", "a/../../../b.png", "..\\..\\win.png"];

	for (const layout of CACHE_LAYOUTS) {
		for (const key of normalizableKeys) {
			const path = cachePathFor(key, root, layout);
			assert.ok(path !== null, `[${layout}] 可归一的 key 应能推出路径：${key}`);
			assert.ok(path.startsWith(`${root}/`), `[${layout}] 必须在缓存目录内：${key} → ${path}`);
			assert.ok(!path.includes(".."), `[${layout}] 不得含穿越：${key} → ${path}`);
			assert.ok(!path.includes("//"), `[${layout}] 不得有空段：${key} → ${path}`);
			assert.ok(!path.includes("\\"), `[${layout}] 不得含反斜杠：${key} → ${path}`);
		}

		for (const key of traversalKeys) {
			assert.equal(
				cachePathFor(key, root, layout),
				null,
				`[${layout}] ★ 含穿越的 key 必须直接拒绝：${key}`
			);
		}
	}

	assert.equal(cachePathFor("a.png", "../outside", "mirror"), null, "缓存目录含穿越应拒绝");
	assert.ok(
		cachePathFor("deep/a/b/c/d.png", root, "mirror").startsWith(`${root}/`),
		"多层 key 仍在缓存目录内"
	);

	// ---------- 5. 无法推导的情形 → null ----------
	assert.equal(cachePathFor("", root, "mirror"), null, "空 key 应返回 null");
	assert.equal(cachePathFor("///", root, "mirror"), null, "只有斜杠的 key 应返回 null");
	assert.equal(cachePathFor(null, root, "mirror"), null, "null key 应返回 null");
	assert.equal(cachePathFor("a.png", "", "mirror"), null, "空缓存目录应返回 null");
	assert.equal(
		cachePathFor("a.png", root, "nonsense"),
		cachePathFor("a.png", root, "mirror"),
		"未知布局应回落到 mirror"
	);

	// ---------- 6. isUnderCacheFolder：安全闸门 ----------
	assert.equal(isUnderCacheFolder(`${root}/a.png`, root), true, "缓存目录内的文件");
	assert.equal(isUnderCacheFolder(`${root}/sub/a.png`, root), true, "子目录内的文件");
	assert.equal(isUnderCacheFolder("notes/note.md", root), false, "★ 笔记绝不能被判为缓存");
	assert.equal(
		isUnderCacheFolder("_attachment-cache-other/a.png", root),
		false,
		"★ 前缀相似但不同目录不算在内（必须按路径段判断）"
	);
	assert.equal(isUnderCacheFolder(root, root), false, "缓存根目录本身不算文件");
	assert.equal(isUnderCacheFolder("../outside/a.png", root), false, "★ 穿越路径不算在内");

	// ⚠️ 下面这条才是穿越检查的**真正**用例。
	// 只有它同时满足"以缓存目录开头"和"实际在缓存之外"：
	//   `_attachment-cache/../notes/note.md` 去掉穿越检查后会被判为 true（错的），
	//   而 `../outside/a.png` 即使不检查穿越也会因前缀不匹配而返回 false ——
	//   也就是说只测后者的话，穿越检查整个删掉都测不出来。
	assert.equal(
		isUnderCacheFolder(`${root}/../notes/note.md`, root),
		false,
		"★ 以缓存目录开头但跳出缓存的路径必须被拒绝（否则清理命令会删到笔记）"
	);
	assert.equal(isUnderCacheFolder(`${root}/sub/../../notes/n.md`, root), false, "深层穿越同样拒绝");

	assert.equal(isUnderCacheFolder("/_attachment-cache/a.png", root), true, "绝对式写法应能归一后判定");
	assert.equal(isUnderCacheFolder("", root), false, "空路径不算在内");

	// ---------- 7. flattenKeyForLayout ----------
	assert.equal(flattenKeyForLayout("a1b2.png"), "a1b2.png", "单段 key 应保持原样");
	const flattened = flattenKeyForLayout("a/photo.png");
	assert.notEqual(flattened, "photo.png", "多段 key 不应只留 basename（会撞名）");
	assert.ok(flattened.includes("photo"), "应保留可读的文件名部分");
	assert.ok(flattened.length < 60, `展开后不应过长，实际 ${flattened.length}`);
	assert.equal(flattenKeyForLayout("a/photo.png"), flattened, "同一输入必须得到同一结果");
}
