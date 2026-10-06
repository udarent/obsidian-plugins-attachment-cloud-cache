/**
 * 缓存路径模块的断言套件（与变异验证共用）。
 *
 * 这一层最要紧的两条：
 * - `cachePathFor` 的**单射性**：不同 key 撞同一路径会让两张图互相覆盖，且是静默的。
 * - `isUnderCacheFolder` 是**清理命令删文件的安全闸门** —— 判宽了会删掉用户的笔记。
 *
 * ⚠️ 这里原先逐条测三种布局（mirror / flat / byExt）。那三种布局已被删除：
 * 前两种在默认的单段 key 模板下结果**完全相同**（提供一个不产生差异的开关比不提供更糟），
 * 而非默认那两条分支需要消解撞名、却没有任何调用方 ——
 * 在一个会喂给"删文件"命令的路径推导里留不可达分支是纯粹的负债。
 * 所以现在只测唯一存在的那条语义，但**单射性与穿越拒绝的力度没有降低**。
 */

import assert from "node:assert/strict";

export function runCachePathSuite(mod) {
	const { cachePathFor, isUnderCacheFolder } = mod;
	const root = "_attachment-cache";

	// ---------- 1. 「缓存相对路径 === 对象 key」必须严格成立 ----------
	assert.equal(cachePathFor("a1b2.png", root), `${root}/a1b2.png`, "单段 key → 直接对应");
	assert.equal(
		cachePathFor("attachments/2026/a1b2.png", root),
		`${root}/attachments/2026/a1b2.png`,
		"多段 key → 保持结构"
	);
	assert.equal(
		cachePathFor("x/y/z.png", root).slice(root.length + 1),
		"x/y/z.png",
		"缓存相对路径必须与对象 key 逐字相同（缓存目录就是桶内结构的一面镜子）"
	);

	// ---------- 2. 确定性 ----------
	for (const key of ["a1b2.png", "x/y/z.png", "a//b.png", "/absolute/path.png"]) {
		const first = cachePathFor(key, root);
		assert.equal(cachePathFor(key, root), first, `同一输入必须得到同一结果：${key}`);
	}

	// ---------- 3. 缓存目录本身也要清洗 ----------
	//
	// ⚠️ 这一段是被变异验证**逼出来**的：有一条变异把 `cleanVaultPath(cacheFolder)`
	// 换成 `String(cacheFolder)`，结果全绿 —— 因为原有断言用的缓存目录
	// 全都是已经干净的 `_attachment-cache`，**没有任何一条测过脏输入**。
	// 而用户完全可能填 `/attachments/cache/` 或 `a//b` 这种写法。
	assert.equal(
		cachePathFor("a.png", "/_attachment-cache/"),
		"_attachment-cache/a.png",
		"缓存目录的首尾斜杠要归一，否则会拼出 // 这种畸形路径（且与索引里记的路径对不上）"
	);
	assert.equal(cachePathFor("a.png", "a//b"), "a/b/a.png", "缓存目录里的空段要收敛");
	assert.equal(cachePathFor("a.png", "a/./b"), "a/b/a.png", "缓存目录里的 `.` 段要丢掉");
	assert.equal(cachePathFor("a.png", "a\\b"), "a/b/a.png", "反斜杠要当分隔符归一");

	// ---------- 4. ★ 单射性：不同 key 不得推出同一路径 ----------
	//
	// 覆盖是静默的（图能显示，只是内容错了），所以这条比"路径好看"重要得多。
	// 恒等映射天然单射，但断言仍要留着 —— 若哪天有人为了"更好浏览"改成按 basename
	// 落地，这里会立刻发现两张同名图撞在一起。
	const injectivitySamples = [
		["a/photo.png", "b/photo.png"],
		["photo.png", "sub/photo.png"],
		["x/y/z.png", "x/yz.png"],
		["a.png", "b.png"],
		// 大小写：内容寻址的 key 是十六进制，但用户完全可能用 `{filename}` 模板，
		// 那里 `A.png` 与 `a.png` 是两个不同的对象。若有人给路径加一道"统一小写"的
		// 归一化，这两张图就会**静默互相覆盖**。
		["A.png", "a.png"],
	];
	for (const [left, right] of injectivitySamples) {
		assert.notEqual(
			cachePathFor(left, root),
			cachePathFor(right, root),
			`★ 不同 key 不得撞同一路径：${left} vs ${right}`
		);
	}

	// ---------- 5. 敌意 key 分两类处理 ----------
	const normalizableKeys = ["/absolute/path.png", "a//b.png", "a/./b.png"];
	const traversalKeys = ["../../etc/passwd", "a/../../../b.png", "..\\..\\win.png"];

	for (const key of normalizableKeys) {
		const path = cachePathFor(key, root);
		assert.ok(path !== null, `可归一的 key 应能推出路径：${key}`);
		assert.ok(path.startsWith(`${root}/`), `必须在缓存目录内：${key} → ${path}`);
		assert.ok(!path.includes(".."), `不得含穿越：${key} → ${path}`);
		assert.ok(!path.includes("//"), `不得有空段：${key} → ${path}`);
		assert.ok(!path.includes("\\"), `不得含反斜杠：${key} → ${path}`);
	}

	for (const key of traversalKeys) {
		assert.equal(cachePathFor(key, root), null, `★ 含穿越的 key 必须直接拒绝：${key}`);
	}

	assert.equal(cachePathFor("a.png", "../outside"), null, "缓存目录含穿越应拒绝");
	assert.ok(cachePathFor("deep/a/b/c/d.png", root).startsWith(`${root}/`), "多层 key 仍在缓存目录内");

	// ---------- 6. 无法推导的情形 → null ----------
	assert.equal(cachePathFor("", root), null, "空 key 应返回 null");
	assert.equal(cachePathFor("///", root), null, "只有斜杠的 key 应返回 null");
	assert.equal(cachePathFor(null, root), null, "null key 应返回 null");
	assert.equal(cachePathFor(undefined, root), null, "undefined key 应返回 null");
	assert.equal(cachePathFor("a.png", ""), null, "空缓存目录应返回 null");
	assert.equal(cachePathFor("a.png", null), null, "null 缓存目录应返回 null");

	// ---------- 7. isUnderCacheFolder：安全闸门 ----------
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
	assert.equal(isUnderCacheFolder(null, root), false, "null 路径不算在内");
}
