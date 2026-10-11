/**
 * 回退下载落点（`src/download-target.ts`）的断言套件。
 *
 * ## 为什么这一层值得单独穷举
 *
 * 它决定**两件不可逆的事**：文件叫什么名字、以及会不会碰到一个已经存在的文件。
 * 判错的两种后果都不对称：
 * - **覆盖**别人的文件 → 不可恢复（用户的附件可能没有别的副本）；
 * - **多堆一个序号文件** → 可恢复（用户能在「释放本地空间」里收掉）。
 * 所以每一条"出错时怎么办"的断言都朝着"不动已有的"那一侧写。
 *
 * ## 为什么是纯函数 + 两个注入探针
 *
 * `planDownloadTarget` 本身不发网络请求，只问"这个路径占用了吗"与"它的内容是什么"。
 * 注入让这里可以穷举**敌意输入**（探针抛错、哈希读不出来、序号撞到上界），
 * 而真实 I/O 里的 if 很难穷举。
 */

import assert from "node:assert/strict";

const HASH = "d472a4c9f0b8e1a2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef00123"; // 恰好 64 位

/** 记下探针被问了哪些路径（用来钉住"不覆盖"这类行为）。 */
function makeProbes(options = {}) {
	const asked = [];
	const hashes = options.hashes ?? new Map();
	const occupied = options.occupied ?? new Set();
	return {
		asked,
		exists: async (path) => {
			asked.push(path);
			if (options.existsThrows) throw new Error("适配器不可用");
			return occupied.has(path);
		},
		hashOf: async (path) => {
			if (options.hashThrows) throw new Error("读不出来");
			return hashes.get(path) ?? null;
		},
	};
}

export async function runDownloadTargetSuite(mod) {
	const { localNameForKey, planDownloadTarget } = mod;
	for (const [name, value] of Object.entries({ localNameForKey, planDownloadTarget })) {
		assert.equal(typeof value, "function", `入口必须导出 ${name}`);
	}

	const cases = { naming: 0, placement: 0, safety: 0 };

	// ============================================================
	// 1. 命名三级兜底
	// ============================================================

	// ① 索引条目的原始文件名最优先（保真度最高）
	assert.equal(
		localNameForKey(`别的名字-${HASH}.png`, "原始 扫描.png"),
		"原始 扫描.png",
		"有条目的原名时应原样用它（连名字里的空格都要保住）"
	);
	cases.naming += 1;

	// ② 没有条目 ⇒ 从 C2 key 反推
	assert.equal(localNameForKey(`报告 扫描-${HASH}.pdf`), "报告 扫描.pdf", "C2 key 应能反推出原始文件名");
	cases.naming += 1;

	// ③ C2 之前的老 key（纯哈希）⇒ 如实用 key 当名字（**绝不硬猜**）
	assert.equal(localNameForKey(`${HASH}.png`), `${HASH}.png`, "老 key 没有名字可反推时如实用它，不编造");
	cases.naming += 1;

	// ④ 脏 sourceName 不参与（全是空白/点/下划线 ⇒ 退回第二级）
	assert.equal(
		localNameForKey(`报告-${HASH}.pdf`, "   "),
		"报告.pdf",
		"空白文件名不算名字 ⇒ 应退回 key 反推"
	);
	assert.equal(localNameForKey(`报告-${HASH}.pdf`, 42), "报告.pdf", "非字符串文件名同样退回 key 反推");
	cases.naming += 1;

	// ⑤ 结果永远是可安全落地的单个文件名（消毒由 sanitizeFilename 承担）
	assert.equal(
		localNameForKey(`x-${HASH}.png`, "../../逃逸/名字.png"),
		"____逃逸_名字.png",
		"落点名字里绝不允许出现路径分隔符或 ..（那会把副本写到别处）"
	);
	cases.naming += 1;

	// ============================================================
	// 2. 落点与撞名
	// ============================================================

	// ① 目标空闲 ⇒ 直接用原名
	{
		const probes = makeProbes();
		const plan = await planDownloadTarget({
			key: `照片-${HASH}.png`,
			folder: "attachments",
			...probes,
		});
		assert.deepEqual(plan, { kind: "new", path: "attachments/照片.png" }, "空位时应落在原名上");
		cases.placement += 1;
	}

	// ② 目标已占用但**内容相同** ⇒ 复用（零网络、零新文件）
	{
		const probes = makeProbes({ occupied: new Set(["a/照片.png"]), hashes: new Map([["a/照片.png", HASH]]) });
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "a", ...probes });
		assert.deepEqual(plan, { kind: "reuse", path: "a/照片.png" }, "内容相同的那一份应被复用，而不是再下一份");
		cases.placement += 1;
	}

	// ③ 目标已占用且**内容不同** ⇒ 另取序号，且序号写在原名之后、扩展名之前
	{
		const probes = makeProbes({ occupied: new Set(["a/照片.png"]), hashes: new Map([["a/照片.png", "f".repeat(64)]]) });
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "a", ...probes });
		assert.deepEqual(plan, { kind: "new", path: "a/照片 1.png" }, "撞名要按 `名字 1.ext` 取序号（与粘贴同款约定）");
		cases.placement += 1;
	}

	// ④ 序号也被占（同内容仍要复用）—— 候选也要过同一套判据
	{
		const probes = makeProbes({
			occupied: new Set(["a/照片.png", "a/照片 1.png"]),
			hashes: new Map([
				["a/照片.png", "f".repeat(64)],
				["a/照片 1.png", HASH],
			]),
		});
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "a", ...probes });
		assert.deepEqual(
			plan,
			{ kind: "reuse", path: "a/照片 1.png" },
			"序号候选同样要按内容复用 —— 只找空位会在同内容已存在时白写一份"
		);
		cases.placement += 1;
	}

	// ⑤ 号码一直撞 ⇒ 继续加号（不回头复用、也不覆盖）
	{
		const probes = makeProbes({
			occupied: new Set(["照片.png", "照片 1.png", "照片 2.png"]),
			hashes: new Map([["照片.png", "f".repeat(64)], ["照片 1.png", "e".repeat(64)], ["照片 2.png", "d".repeat(64)]]),
		});
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "", ...probes });
		assert.deepEqual(plan, { kind: "new", path: "照片 3.png" }, "连号被占就继续加号");
		cases.placement += 1;
	}

	// ⑥ 落点目录：空 = vault 根；反斜杠与首尾斜杠都要归一
	assert.deepEqual(
		await planDownloadTarget({ key: `a-${HASH}.png`, folder: "", exists: async () => false, hashOf: async () => null }),
		{ kind: "new", path: "a.png" },
		"目录为空时应落在 vault 根（而不是拼出 `/a.png`）"
	);
	assert.deepEqual(
		await planDownloadTarget({
			key: `a-${HASH}.png`,
			folder: "\\\\notes\\\\子目录\\\\",
			exists: async () => false,
			hashOf: async () => null,
		}),
		{ kind: "new", path: "notes/子目录/a.png" },
		"反斜杠与首尾斜杠要归一（Windows 上写出来的路径不能带反斜杠）"
	);
	cases.placement += 1;

	// ⑦ 点开头的文件（无扩展名可剥）：序号加在**整体**之后
	{
		const probes = makeProbes({ occupied: new Set([".gitignore"]), hashes: new Map([[".gitignore", "f".repeat(64)]]) });
		const plan = await planDownloadTarget({ key: `.gitignore-${HASH}`, folder: "", ...probes });
		assert.deepEqual(plan, { kind: "new", path: ".gitignore 1" }, "点开头不算扩展名（`.gitignore` 整体是名字）");
		cases.placement += 1;
	}

	// ============================================================
	// 3. 出错方向：一律倒向"不动已有的"
	// ============================================================

	// ① `exists` 抛错 ⇒ 当作"占用"（于是走序号，绝不写到那个路径上）
	{
		const probes = makeProbes({ existsThrows: true });
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "", ...probes });
		assert.equal(plan.kind, "new", "探针出错时仍要给出一个可写的落点（不能让整条下载路径卡住）");
		assert.notEqual(plan.path, "照片.png", "探针出错一律当作 `占用`（原因：探针出错时不敢覆盖已有的文件）");
		cases.safety += 1;
	}

	// ② `hashOf` 抛错/读不出来 ⇒ 当作"内容不同"（同样走序号）
	{
		const probes = makeProbes({ occupied: new Set(["照片.png"]), hashThrows: true });
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "", ...probes });
		assert.deepEqual(plan, { kind: "new", path: "照片 1.png" }, "哈希读不出来时按内容不同处理（宁多一个序号，不认错文件）");
		cases.safety += 1;
	}

	// ③ key 里没有哈希（用户自定义成 `{filename}.{ext}`）⇒ 无法比内容 ⇒ 只能走序号
	{
		const probes = makeProbes({ occupied: new Set(["报告.pdf"]) });
		const plan = await planDownloadTarget({ key: "报告.pdf", folder: "", ...probes });
		assert.deepEqual(plan, { kind: "new", path: "报告 1.pdf" }, "取不到哈希时不许猜内容（宁多一份，不覆盖）");
		cases.safety += 1;
	}

	// ④ 序号撞到上界（病态目录）⇒ 时间戳兜底，绝不无限循环
	{
		let calls = 0;
		const plan = await planDownloadTarget({
			key: `照片-${HASH}.png`,
			folder: "",
			exists: async () => {
				calls += 1;
				return true;
			},
			hashOf: async () => null,
		});
		assert.match(plan.path, /^照片 \d{10,}\.png$/, "试到上界后要用时间戳兜底（不能死循环）");
		assert.ok(calls < 200, `探针调用次数必须有上界，实际 ${calls} 次`);
		cases.safety += 1;
	}

	// ⑤ 绝不返回一个已占用的路径（这是整层的第一条纪律）
	{
		const occupied = new Set(["照片.png", "照片 1.png"]);
		const probes = makeProbes({ occupied, hashes: new Map([["照片.png", "f".repeat(64)], ["照片 1.png", "e".repeat(64)]]) });
		const plan = await planDownloadTarget({ key: `照片-${HASH}.png`, folder: "", ...probes });
		assert.equal(
			occupied.has(plan.path),
			false,
			"返回的落点绝不能是已占用的路径（否则调用方写下去就是覆盖）"
		);
		cases.safety += 1;
	}

	return cases;
}
