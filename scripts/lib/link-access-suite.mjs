/**
 * 「链接走公开读取还是内部访问」判定（`src/link-access.ts`）的断言套件。
 *
 * ## 这一层的断言为什么必须严
 *
 * 判错的两种后果**都不报错**，而且都发生在用户看不见的地方：
 *
 * - **该走内部却走了公开** ⇒ 私有桶的用户看到**一屏坏图**（`<img>` 拿到 403 不弹任何提示，
 *   只有控制台一条）。这正是 1.6.0 及以前的状态，也是这一版要修的病；
 * - **该走公开却走了内部** ⇒ 每张图都要先下载一遍才显示（移动端流量、桶的读请求都白花），
 *   而用户完全不知道可以省掉。
 *
 * 所以每条规则（每个探测结果 → 一条路径）都要能被单独打坏。
 *
 * ## 还钉住一条**结构性**承诺
 *
 * 笔记里那条链接的地址**与访问方式无关**（`publicUrlFor` 不读 `linkAccess`）。
 * 这条不是"顺手测一下"，它防止的是有人"顺手"把链接改成签名 URL —— 那种改动会让
 * 写进笔记的地址带上有效期，属于**不可逆**的破坏。
 */

import assert from "node:assert/strict";

export async function runLinkAccessSuite(mod) {
	const {
		UNKNOWN_ACCESS_PROBE,
		classifyPublicReach,
		probeAccess,
		probeUrlFor,
		displayPathFor,
		requiresLocalCopy,
		resolveAccess,
		usesSignedUrls,
	} = mod;
	// `publicUrlFor` 只用于"链接地址不受模式影响"那条断言（需要一起进 bundle）
	const { publicUrlFor } = mod;

	const probeOf = (kind, status = null) => ({ kind, status, at: 1_700_000_000_000 });

	// ============================================================
	// 1. 每个探测结果 → 一条确定的路径（降级方向只能有一个）
	// ============================================================
	{
		const table = [
			// [探测结果, 期望路径, 期望理由]
			["ok", "public", "probePublic"],
			["forbidden", "private", "probeForbidden"],
			["missing", "private", "probeMissing"],
			["unreachable", "private", "probeUnreachable"],
			["other", "private", "probeUnreachable"],
			["unknown", "private", "probeUnknown"],
		];

		for (const [kind, access, reason] of table) {
			const probe = kind === "unknown" ? UNKNOWN_ACCESS_PROBE : probeOf(kind);
			const resolved = resolveAccess("auto", probe);
			assert.equal(resolved.access, access, `auto 档下探测结果 ${kind} 应走 ${access}`);
			assert.equal(resolved.reason, reason, `auto 档下探测结果 ${kind} 的理由应是 ${reason}`);
		}
	}

	// ============================================================
	// 2. 显式档位压过探测结果（用户说了算）
	//
	// ⚠️ 这两条是"用户声明优先"的唯一凭据：桶其实是公开的、用户选了「仅内部访问」，
	// 我们也不许偷偷按公开处理（那等于替他决定"链接可以给外人看"）。
	// ============================================================
	{
		const forbidden = probeOf("forbidden");
		const ok = probeOf("ok");

		assert.equal(resolveAccess("public", forbidden).access, "public", "★ 用户选公开时，探测说 403 也按公开");
		assert.equal(resolveAccess("public", forbidden).reason, "explicitPublic", "理由要指向用户的声明");
		assert.equal(resolveAccess("private", ok).access, "private", "★ 用户选内部时，探测说可匿名读也按内部");
		assert.equal(resolveAccess("private", ok).reason, "explicitPrivate", "理由要指向用户的声明");

		// 坏值（手改过 data.json）：按 auto 处理，**不许**落成"假定公开"
		assert.equal(
			resolveAccess("nonsense", UNKNOWN_ACCESS_PROBE).access,
			"private",
			"★ 认不出来的档位按 auto 处理（安全方向），不许当成公开"
		);
		assert.equal(resolveAccess(undefined, null).access, "private", "缺参数时也要落到安全方向");
	}

	// ============================================================
	// 3. 「缺副本的图靠什么显示」—— 三个调用方共用的那一条判据
	//
	// 三档互斥：远端地址（公开）／本地副本（私有 + 保留）／预签名地址（私有 + 不留）。
	// ⭐ 第三档是用户 2026-10-17 追问出来的：「仅内部就必须下载吗？不能像图床那样只存在 S3？」
	// ============================================================
	{
		// 公开：直接用远端地址（要不要顺手存副本是另一个开关的事）
		assert.equal(
			displayPathFor({ linkAccess: "public", localCopy: "keep" }, UNKNOWN_ACCESS_PROBE),
			"remote-url",
			"公开读取下就是远端地址"
		);
		assert.equal(
			displayPathFor({ linkAccess: "public", localCopy: "trash" }, UNKNOWN_ACCESS_PROBE),
			"remote-url",
			"公开读取 + 不留副本：同样是远端地址（图床式，且不用签名）"
		);

		// 私有 + 保留副本：取回 → app://（离线可用）
		assert.equal(
			displayPathFor({ linkAccess: "private", localCopy: "keep" }, UNKNOWN_ACCESS_PROBE),
			"local-copy",
			"★ 私有 + 保留副本 ⇒ 本地副本"
		);

		// ⭐ 私有 + 不留副本：预签名（图床式，磁盘不落文件）
		assert.equal(
			displayPathFor({ linkAccess: "private", localCopy: "trash" }, UNKNOWN_ACCESS_PROBE),
			"signed-url",
			"★ 私有 + 不留副本 ⇒ 预签名地址（这正是用户要的「图床效果」）"
		);
		assert.equal(
			displayPathFor({ linkAccess: "auto", localCopy: "trash" }, probeOf("forbidden")),
			"signed-url",
			"★ auto + 探测到私有 + 不留副本 ⇒ 同样走预签名"
		);
		assert.equal(
			displayPathFor({ linkAccess: "auto", localCopy: "keep" }, probeOf("forbidden")),
			"local-copy",
			"auto + 探测到私有 + 保留副本 ⇒ 取回本地"
		);
		assert.equal(
			displayPathFor({ linkAccess: "auto", localCopy: "keep" }, probeOf("ok")),
			"remote-url",
			"auto + 探测到公开 ⇒ 远端地址"
		);

		// 「缺副本是否必须取回」= 只有 local-copy 那一档为真
		assert.equal(
			requiresLocalCopy({ linkAccess: "public", localCopy: "keep" }, UNKNOWN_ACCESS_PROBE),
			false,
			"公开访问下不强制取回"
		);
		assert.equal(
			requiresLocalCopy({ linkAccess: "private", localCopy: "keep" }, UNKNOWN_ACCESS_PROBE),
			true,
			"★ 私有访问下必须取回（那个开关管的是省流量，不是宁可不看图）"
		);
		assert.equal(
			requiresLocalCopy({ linkAccess: "auto", localCopy: "keep" }, probeOf("forbidden")),
			true,
			"★ auto + 探测到 403 时必须强制取回，否则就是一屏坏图"
		);
		assert.equal(
			requiresLocalCopy({ linkAccess: "private", localCopy: "trash" }, probeOf("forbidden")),
			false,
			"★ 「不留副本」档不写文件 —— 它改走预签名，不是「放弃显示」"
		);

		// 两个快捷判据必须与 displayPathFor **同源**（它们就是从它算出来的）
		assert.equal(
			usesSignedUrls({ linkAccess: "private", localCopy: "trash" }, UNKNOWN_ACCESS_PROBE),
			true,
			"私有 + 不留副本 ⇒ 该签"
		);
		assert.equal(
			usesSignedUrls({ linkAccess: "public", localCopy: "trash" }, UNKNOWN_ACCESS_PROBE),
			false,
			"★ 公开读取时**不签**：桶自己就能给，签名是多余的一层（还多一个过期窗口）"
		);
		assert.equal(
			usesSignedUrls({ linkAccess: "private", localCopy: "keep" }, UNKNOWN_ACCESS_PROBE),
			false,
			"私有 + 保留副本时不签（本地副本更省事，而且离线可用）"
		);
	}

	// ============================================================
	// 4. ⭐ 链接地址与访问方式**无关**（结构性承诺）
	//
	// 三种模式、两种寻址方式、有无公开前缀，写出来的地址必须完全一样。
	// 这条防的是"顺手把链接改成签名 URL"—— 那会给笔记埋一批会过期的死链。
	// ============================================================
	{
		const address = {
			endpoint: "https://s3.example.com",
			bucket: "my-bucket",
			publicUrlBase: "https://img.example.com",
			forcePathStyle: true,
		};
		const key = "报告-<hash>.png";
		// `publicUrlFor` 的签名里根本没有访问方式这个参数 —— 这条断言把这件事钉死：
		// 谁要是给它加一个 mode 参数并据此改地址，这里就会红。
		assert.equal(publicUrlFor.length, 2, "★ publicUrlFor 只接受地址与 key（不许把访问方式塞进来）");
		const urls = ["auto", "public", "private"].map((mode) => {
			// 三种档位只是**设置里的一个值**，它不参与地址推导
			void mode;
			return publicUrlFor(address, key);
		});
		assert.equal(urls[1], urls[0], "★ 公开模式写出的地址必须与自动模式逐字相同");
		assert.equal(urls[2], urls[0], "★ 内部模式写出的地址也必须逐字相同（切换模式不改写链接）");
		assert.ok(urls[0].startsWith("https://img.example.com/"), "地址仍由公开前缀拼出来");

		// 探测地址与写进笔记的地址**同源**（否则"测试说公开、链接却是另一个地址"）
		assert.equal(probeUrlFor(address, key), urls[0], "★ 探测的必须是真写进笔记的那条地址");
		assert.equal(probeUrlFor(address, ""), null, "没有 key 时不该凭空造一个地址");
		assert.equal(probeUrlFor(address, null), null, "没有 key 时不该凭空造一个地址");
		assert.equal(
			probeUrlFor({ endpoint: "", bucket: "", publicUrlBase: "" }, key),
			null,
			"端点/桶没配全时返回 null（而不是抛错或半截地址）"
		);
	}

	// ============================================================
	// 5. 归类：每种状态码只有一种解释（设置页的文案与判定共用这一份）
	// ============================================================
	{
		assert.equal(classifyPublicReach(200), "ok", "2xx = 匿名可读");
		assert.equal(classifyPublicReach(204), "ok", "204 也算可读");
		assert.equal(classifyPublicReach(403), "forbidden", "403 = 拒绝匿名");
		assert.equal(classifyPublicReach(401), "forbidden", "401 同理");
		assert.equal(classifyPublicReach(404), "missing", "404 = 对象不在");
		assert.equal(classifyPublicReach(null), "unreachable", "网络层失败");
		assert.equal(classifyPublicReach(500), "other", "服务端错误不属于上面任何一类");
	}

	// ============================================================
	// 6. 探测本身：**绝不抛错**、超时要能放弃、超时与连不上要分得开
	// ============================================================
	{
		// ① 正常
		const okProbe = await probeAccess("https://img.example.com/a.png", {
			probe: async () => ({ status: 200 }),
			now: () => 42,
		});
		assert.deepEqual(okProbe, { kind: "ok", status: 200, at: 42 }, "探测结果要原样带上状态码与时刻");

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

	// 空串地址不该被当成"能探测的东西"：如实落成 unreachable（判定层于是走内部路径）
	{
		const blank = await probeAccess("", { probe: async () => ({ status: null }) });
		assert.equal(blank.kind, "unreachable", "没有状态码 = 到不了");
	}
}
