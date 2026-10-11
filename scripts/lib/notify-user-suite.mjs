import assert from "node:assert/strict";

/**
 * 「用户可见提示」的统一出口（`src/notify-user.ts`）的断言。
 *
 * ## 为什么这么薄的一层也要有套件
 *
 * 它守的**不是一段逻辑，而是一条跨三个模块的约定**：
 * 「**键在这一层选，文字由接线层给**」。写反了不会有任何报错 ——
 * 只会让英文用户在某一次提示里看到中文（2026-10-11 实测到 `core/ingest.ts`
 * 与 `core/download.ts` 里各有几条中文兜底），或者让所有人看到一串键名。
 * 两种都不是崩溃，都是"只有用户看得见、测试看不见"的那一类。
 *
 * ## ⚠️ 结构是**一节一件事**，不是"一次调用三条断言"
 *
 * 套件是"**第一条失败断言决定报错**"，而变异脚本要求"每条变异因**自己的原因**失败"
 * （见 `lib/mutate.mjs` 第 2 条纪律）。若一条规则坏掉时另一条断言先红，
 * 变异脚本会如实报 `原因不符` —— 那条信号等于丢掉了。
 * 所以每一节只依赖一条规则，且**互不掩盖**：
 *
 * | 节 | 只断言 | 被哪条变异打中 |
 * |---|---|---|
 * | ① | 说的是**解析后**的文字（用 `includes`，对"说几遍"不敏感） | 跳过解析 |
 * | ② | 只说**一句** | 说两遍 |
 * | ③ | 参数**原样**转交 | 丢参数 |
 * | ④ | 没有出口 ⇒ **安静**返回（不抛错） | 没出口也去调 |
 * | ⑤ | 没有解析 ⇒ 退回**键名**，绝不退回中文 | —— |
 */
export function runNotifyUserSuite(mod) {
	const { notifyUser } = mod;
	assert.ok(typeof notifyUser === "function", "应当导出 notifyUser");

	// ── ① 说的是解析后的文字 ──────────────────────────────
	{
		const said = [];
		notifyUser({ notify: (message) => said.push(message), t: (key) => `T:${key}` }, "sampleKey");
		assert.ok(
			said.includes("T:sampleKey"),
			`★ 说的必须是**解析后**的文字，不是键名（实际 ${JSON.stringify(said)}）`
		);
	}

	// ── ② 只说一句 ───────────────────────────────────────
	{
		const said = [];
		notifyUser({ notify: (message) => said.push(message), t: (key) => `T:${key}` }, "sampleKey");
		assert.equal(said.length, 1, "★ 一次调用只说一句（降级提示重复就会变成刷屏）");
	}

	// ── ③ 参数原样转交 ───────────────────────────────────
	{
		const seen = [];
		notifyUser(
			{
				notify: () => {},
				t: (key, params) => {
					seen.push([key, params]);
					return "x";
				},
			},
			"sampleKey",
			{ error: "boom" }
		);
		assert.deepEqual(
			seen,
			[["sampleKey", { error: "boom" }]],
			"★ 参数要原样转交 —— 丢了它，提示里就没有「哪个文件、什么错」"
		);
	}

	// ── ④ 没有出口 ⇒ 安静返回，不许抛错 ───────────────────
	//
	// 用 try/catch 显式接住而不是 `assert.doesNotThrow`：后者失败时打印的是
	// 原始异常（"not a function"），看不出这条规则在守什么。
	{
		let thrown = null;
		try {
			notifyUser({ t: () => "x" }, "sampleKey");
			notifyUser({ notify: undefined, t: undefined }, "sampleKey", { a: 1 });
			notifyUser({}, "sampleKey");
		} catch (error) {
			thrown = error;
		}
		assert.equal(
			thrown,
			null,
			"★ 没有 notify 时必须安静返回（不许抛错）—— 它会跑在渲染与删除路径上"
		);
	}

	// ── ⑤ 有出口、没有解析 ⇒ 退回**键名** ─────────────────
	//
	// ⚠️ 退回中文是**错的**：那会让"接线层忘了注入 t"变成一个只有英文界面
	// 才看得见的缺陷（不报错、不抛异常）。退回键名则一眼看得出没接线。
	{
		const said = [];
		notifyUser({ notify: (message) => said.push(message) }, "sampleKey", { error: "boom" });
		assert.deepEqual(said, ["sampleKey"], "★ 没有 t 时退回键名；绝不退回一句硬编码中文");
	}

	return { cases: 6 };
}
