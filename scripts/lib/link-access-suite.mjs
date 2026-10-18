/**
 * 「连接状态」判定（`src/link-access.ts`）的断言套件。
 *
 * ## 这一层的断言为什么必须严
 *
 * 判错的两种后果**都不报错**，而且都发生在用户看不见的地方：
 *
 * - 该按私有却按公开 ⇒ 私有桶的用户看到**一屏坏图**（`<img>` 拿到 403 不弹任何提示，
 *   只有控制台一条）。这正是 1.6.0 及以前的状态。
 * - 该按公开却按私有 ⇒ 每张图都要先下载一遍才显示（移动端流量、桶的读请求都白花），
 *   而用户完全不知道可以省掉。
 *
 * ## 2026-10-18 起：状态是**探测出来的事实**，不是用户选的档
 *
 * 所以这里不再有"显式档压过探测"那一节 —— 那个设置项已经删掉（用户的决定）。
 * 留下的是三条判据：显示路径、自动探测 ⇒ 状态、回路实测 ⇒ 状态。
 *
 * ## 还钉住一条**结构性**承诺
 *
 * 笔记里那条链接的地址**与状态无关**（`publicUrlFor` 不读它）。这条不是"顺手测一下"，
 * 它防止的是有人"顺手"把链接改成签名 URL —— 那种改动会让写进笔记的地址带上有效期，
 * 属于**不可逆**的破坏。
 */

import assert from "node:assert/strict";

export async function runLinkAccessSuite(mod) {
	const {
		INITIAL_CONNECTION_STATE,
		classifyPublicReach,
		probeAccess,
		probeUrlFor,
		displayPathFor,
		requiresLocalCopy,
		stateAfterProbe,
		stateAfterRoundTrip,
		usesSignedUrls,
	} = mod;
	// `publicUrlFor` 只用于"链接地址不受状态影响"那条断言（需要一起进 bundle）
	const { publicUrlFor } = mod;

	const probe = (kind, status = null) => ({ kind, status, at: 1_700_000_000_000 });

	// ============================================================
	// 1. 状态 × 本地副本档 ⇒ 一条确定的显示路径
	// ============================================================
	{
		const table = [
			// [状态, 本地副本档, 期望路径]
			["public", "keep", "remote-url"],
			["public", "trash", "remote-url"],
			["private", "keep", "local-copy"],
			["private", "trash", "signed-url"],
			["checking", "keep", "local-copy"],
			["checking", "trash", "signed-url"],
			["unreachable", "keep", "local-copy"],
			["unreachable", "trash", "signed-url"],
		];
		for (const [state, localCopy, expected] of table) {
			assert.equal(
				displayPathFor({ localCopy }, state),
				expected,
				`状态 ${state} + 本地副本 ${localCopy} ⇒ ${expected}`
			);
		}
		// 初值必须是"不知道"，于是缺副本的图走安全那条（多下一次，而不是留坏图）
		assert.equal(INITIAL_CONNECTION_STATE, "checking", "★ 加载初值必须是 checking（不沿用上次的结论）");
		assert.equal(
			displayPathFor({ localCopy: "keep" }, INITIAL_CONNECTION_STATE),
			"local-copy",
			"★ 还没问出来时按私有处理（安全方向）"
		);
	}

	// ============================================================
	// 2. 三个入口回答同一件事（判据只有一处）
	// ============================================================
	{
		for (const state of ["public", "private", "checking", "unreachable"]) {
			const path = displayPathFor({ localCopy: "keep" }, state);
			assert.equal(
				requiresLocalCopy({ localCopy: "keep" }, state),
				path === "local-copy",
				`requiresLocalCopy 必须与 displayPathFor 一致（${state}）`
			);
		}
		assert.equal(usesSignedUrls({ localCopy: "trash" }, "private"), true, "私有 + 不留副本 ⇒ 预签名地址");
		assert.equal(usesSignedUrls({ localCopy: "keep" }, "private"), false, "私有 + 保留副本 ⇒ 取副本，不签名");
		assert.equal(usesSignedUrls({ localCopy: "trash" }, "public"), false, "公开 ⇒ 用远端地址，不签名");
	}

	// ============================================================
	// 3. 自动探测（匿名 HEAD）⇒ 状态
	// ============================================================
	{
		assert.equal(stateAfterProbe("checking", probe("ok", 200)), "public", "匿名读得到 ⇒ 公开");
		assert.equal(stateAfterProbe("public", probe("forbidden", 403)), "private", "拒绝匿名 ⇒ 私有");
		assert.equal(stateAfterProbe("public", probe("unreachable", null)), "unreachable", "网络失败 ⇒ 无法访问");

		// ⚠️ 404 / 其它状态码**不改判**：它们既证明不了公开，也证明不了私有
		assert.equal(stateAfterProbe("public", probe("missing", 404)), "public", "404 不改判（沿用上一次）");
		assert.equal(stateAfterProbe("private", probe("missing", 404)), "private", "404 不改判（沿用上一次）");
		assert.equal(stateAfterProbe("public", probe("other", 500)), "public", "没预料的状态码不改判");
		assert.equal(stateAfterProbe("public", { kind: "unknown", status: null, at: 0 }), "public", "没探测过不改判");
	}

	// ============================================================
	// 4. 「测试连接」回路 ⇒ 状态（用户点按钮时唯一的那一处判定）
	// ============================================================
	{
		// 匿名读得到 ⇒ 公开（哪怕签名读那边出了问题，链接对别人是打得开的）
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("ok", 200), signedReadOk: true }),
			"public",
			"★ 匿名读得到 ⇒ 公开"
		);
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("ok", 200), signedReadOk: false }),
			"public",
			"★ 匿名读得到就是公开 —— 别人打得开这件事与我们的密钥无关"
		);
		// 拒绝匿名 + 签名读得到 ⇒ 私有（这就是"切私有试一次，成功就切状态"）
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("forbidden", 403), signedReadOk: true }),
			"private",
			"★ 拒绝匿名、签名取得到 ⇒ 私有"
		);
		// 两个都不通 ⇒ 无法访问
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("forbidden", 403), signedReadOk: false }),
			"unreachable",
			"★ 匿名与签名都取不到 ⇒ 无法访问"
		);
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("unreachable", null), signedReadOk: false }),
			"unreachable",
			"★ 连不上且签名也失败 ⇒ 无法访问"
		);
		// 404：公开前缀可能写错了 ⇒ **不改判**（界面单独提示），而不是猜一个
		assert.equal(
			stateAfterRoundTrip({ anonymous: probe("missing", 404), signedReadOk: true }),
			null,
			"★ 404 不改判（证明不了公开，也证明不了私有）"
		);
	}

	// ============================================================
	// 5. ⭐ 链接地址与状态**无关**（硬约束）
	// ============================================================
	{
		const address = {
			endpoint: "https://s3.example.com",
			bucket: "my-bucket",
			publicUrlBase: "https://img.example.com",
			forcePathStyle: true,
		};
		const key = "报告-<hash>.png";
		// `publicUrlFor` 的签名里根本没有"状态"这个参数 —— 这条断言把这件事钉死：
		// 谁要是给它加一个 state 参数并据此改地址，这里就会红。
		assert.equal(publicUrlFor.length, 2, "★ publicUrlFor 只接受地址与 key（不许把状态塞进来）");
		const url = publicUrlFor(address, key);
		assert.ok(url.startsWith("https://img.example.com/"), "地址仍由公开前缀拼出来");

		// 探测地址与写进笔记的地址**同源**（否则"测试说公开、链接却是另一个地址"）
		assert.equal(probeUrlFor(address, key), url, "★ 探测的必须是真写进笔记的那条地址");
		assert.equal(probeUrlFor(address, ""), null, "没有 key 时不该凭空造一个地址");
		assert.equal(probeUrlFor(address, null), null, "没有 key 时不该凭空造一个地址");
		assert.equal(
			probeUrlFor({ endpoint: "", bucket: "", publicUrlBase: "" }, key),
			null,
			"端点/桶没配全时返回 null（而不是抛错或半截地址）"
		);
	}

	// ============================================================
	// 6. 归类：每种状态码只有一种解释（设置页的文案与判定共用这一份）
	// ============================================================
	{
		assert.equal(classifyPublicReach(200), "ok", "2xx = 匿名可读");
		assert.equal(classifyPublicReach(204), "ok", "204 也算可读");
		assert.equal(classifyPublicReach(403), "forbidden", "403 = 拒绝匿名");
		assert.equal(classifyPublicReach(401), "forbidden", "401 同理");
		assert.equal(classifyPublicReach(404), "missing", "404 = 对象不在");
		assert.equal(classifyPublicReach(null), "unreachable", "网络层失败");
		assert.equal(classifyPublicReach(500), "other", "服务端错误不属于上面任何一类");

		// ★ 2026-10-18 的误判：**2xx 不等于「打开的是你的对象」**。
		// 网关 / WAF / 登录页 / 反代兜底页会回一个 200 的网页 —— 只看状态码就会报「公开访问」，
		// 而笔记里那条链接照样打不开（用户还会因此把私有桶当成可以对外分享）。
		assert.equal(
			classifyPublicReach(200, "text/html; charset=utf-8"),
			"webpage",
			"★ 200 但是网页 ⇒ 不是「公开可读」，是「这个地址上有个东西」"
		);
		assert.equal(classifyPublicReach(200, "application/xhtml+xml"), "webpage", "XHTML 也算网页");
		assert.equal(
			classifyPublicReach(200, "image/png"),
			"ok",
			"真对象（image/png）仍然是公开可读 —— 这一条别改坏"
		);
		assert.equal(
			classifyPublicReach(200, "application/xml"),
			"ok",
			"⚠️ XML 不算网页：S3 的错误页是 XML，但用户也可能真的传了一个 .xml 附件"
		);
		assert.equal(classifyPublicReach(403, "text/html"), "forbidden", "非 2xx 不参与「网页」判定");

		// ★ 两次结论不一致（真机实测：5 轮里 1 轮读得到、4 轮 403）⇒ `unstable`，**不改判**。
		// 它的含义不是「桶私有」，而是「服务端侧不稳定，去查网关 / 反代」。
		assert.equal(
			stateAfterRoundTrip({ anonymous: { kind: "unstable", status: 200, at: 1 }, signedReadOk: true }),
			null,
			"★ 响应不稳定时不许翻转状态（一次偶然不是事实）"
		);
		assert.equal(
			stateAfterProbe("private", { kind: "unstable", status: 200, at: 1 }),
			"private",
			"自动探测拿到 unstable 也不改判"
		);

		// ★★ 最强的一条：**取回来的字节不对 ⇒ 不是公开**（2026-10-18 真机复现：
		// 同一个桶、同一时刻，固定 key 的匿名 HEAD 回 200，而内容哈希 key 回 403）。
		// 此时类型可能完全正常（application/xml / image/png），只有内容能说明问题。
		assert.equal(
			classifyPublicReach(200, "application/xml", false),
			"webpage",
			"★ 2xx 但字节对不上 ⇒ 这个地址上放的不是我们的对象，不许判公开"
		);
		assert.equal(classifyPublicReach(200, "image/png", false), "webpage", "类型正常也不行，看内容");
		assert.equal(classifyPublicReach(200, "image/png", true), "ok", "字节一致才是真的公开");
		assert.equal(
			classifyPublicReach(200, "image/png", undefined),
			"ok",
			"自动探测没有内容证据（只发 HEAD）⇒ 保持原判据"
		);
	}

	// ============================================================
	// 7. 探测本身：**绝不抛错**、超时要能放弃、超时与连不上要分得开
	// ============================================================
	{
		// ① 正常
		const okProbe = await probeAccess("https://img.example.com/a.png", {
			probe: async () => ({ status: 200, contentType: "image/png" }),
			now: () => 42,
		});
		assert.deepEqual(
			okProbe,
			{ kind: "ok", status: 200, at: 42, contentType: "image/png" },
			"探测结果要原样带上状态码、时刻与 content-type"
		);

		// ② 探测实现自己抛错（传输层炸了）→ unreachable，而不是让异常冒到界面上
		//
		// ⚠️ 必须**显式接住**再断言：不接的话变异会让断言根本执行不到，
		// 失败信息变成 `boom` —— 那是"原因不符"，门禁报出来也没法读（实测踩过）。
		let threw = null;
		let thrownProbe = null;
		try {
			thrownProbe = await probeAccess("https://img.example.com/a.png", {
				probe: async () => {
					throw new Error("boom");
				},
				now: () => 43,
			});
		} catch (error) {
			threw = error instanceof Error ? error.message : String(error);
		}
		assert.equal(threw, null, "★ 探测实现抛错必须收敛成 unreachable（设置页那行反馈不许被异常吞掉）");
		assert.equal(thrownProbe.kind, "unreachable", "★ 抛错一律当「到不了」");
		assert.equal(thrownProbe.status, null, "抛错时没有状态码");
		assert.equal(thrownProbe.timedOut, undefined, "抛错不是超时（两者修法不同）");

		// ③ 超时：`requestUrl` 没有超时参数，只能在这里放弃等待
		const hung = await probeAccess("https://img.example.com/a.png", {
			probe: () => new Promise(() => {}),
			timeoutMs: 5,
			now: () => 44,
		});
		assert.equal(hung.kind, "unreachable", "★ 超时按「到不了」处理（因此也证明不了桶公开）");
		assert.equal(hung.timedOut, true, "★ 超时要能标出来：界面要把它和「连不上」分开说");
		assert.equal(hung.at, 44, "超时也要记下时刻");
	}

	// 空串地址不该被当成"能探测的东西"：如实落成 unreachable（于是按私有处理）
	{
		const blank = await probeAccess("", { probe: async () => ({ status: null }) });
		assert.equal(blank.kind, "unreachable", "没有状态码 = 到不了");
	}
}
