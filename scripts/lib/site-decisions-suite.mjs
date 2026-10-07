/**
 * 站点决定记忆（`src/render/site-decisions.ts`）的断言套件。
 *
 * ## 这一层判错的后果
 *
 * 记忆是**用户表达过的意图**的载体。判错方向有两种，代价都不对称：
 * - 归一化没做全 → 同一站点被记成两条 → 用户选了「不再询问」却**仍然被问**（骚扰，可忍）；
 * - 读坏数据抛错 → 插件在启动时挂掉（不可忍：为一份记忆付出这个代价毫无道理）。
 *
 * 所以这里既钉"归一化"也钉"降级"。
 */

import assert from "node:assert/strict";

export function runSiteDecisionsSuite(mod) {
	const { SiteDecisions, normalizeHost, SITE_DECISIONS_VERSION } = mod;

	// ============================================================
	// 1. 主机归一化
	// ============================================================
	assert.equal(normalizeHost("Example.COM"), "example.com", "★ 主机大小写必须归一（Example.com 与 example.com 是同一条）");
	// 末尾的点是 FQDN 的合法写法（`example.com.` ≡ `example.com`）
	assert.equal(normalizeHost("example.com."), "example.com", "★ 末尾的点要归一（`example.com.` 与 `example.com` 必须同一条）");
	assert.equal(normalizeHost("  example.com  "), "example.com", "首尾空白要归一");
	assert.equal(normalizeHost("example.com:8080"), "example.com:8080", "端口是站点的一部分，要保留");
	assert.equal(normalizeHost(null), "", "非字符串 → 空串");
	assert.equal(normalizeHost({}), "", "对象 → 空串（不能变成 `[object Object]`）");

	// ============================================================
	// 2. 读写的往返
	// ============================================================
	const decisions = new SiteDecisions();
	assert.equal(decisions.size, 0, "新建的记忆必须是空的");
	assert.equal(decisions.get("example.com"), undefined, "没记过的站点应查不到");

	assert.equal(decisions.set("example.com", "allow"), true, "写入合法站点应成功");
	assert.equal(decisions.get("example.com"), "allow", "写入后应能读回");
	assert.equal(decisions.size, 1, "写入一条后大小应为 1");

	// ⭐ 归一化要贯穿读写两侧：用另一种写法读同一条
	assert.equal(decisions.get("EXAMPLE.com"), "allow", "★ 换一种写法读到的必须是同一条（大小写归一）");
	decisions.set("EXAMPLE.com", "deny");
	assert.equal(decisions.size, 1, "★ 大写写法不该新建一条（否则「不再询问」会失效）");
	assert.equal(decisions.get("example.com"), "deny", "后写的应覆盖先写的");

	// 覆盖
	decisions.set("example.com", "allow");
	assert.equal(decisions.get("example.com"), "allow", "应能覆盖为 allow");

	// 非法输入不得写入
	assert.equal(decisions.set("", "allow"), false, "空主机名不能写入");
	assert.equal(decisions.set("   ", "allow"), false, "空白主机名不能写入");
	assert.equal(decisions.set("x.com", "maybe"), false, "非法的决定值不能写入");
	assert.equal(decisions.size, 1, "非法写入不该改变大小");

	// ============================================================
	// 3. 删除
	// ============================================================
	assert.equal(decisions.remove("nope.com"), false, "★ 删不存在的站点必须返回 false（调用方据此如实汇报）");
	assert.equal(decisions.remove("example.com"), true, "删存在的应返回 true");
	assert.equal(decisions.size, 0, "删掉后应为空");
	assert.equal(decisions.remove("example.com"), false, "重复删除应返回 false");

	// 删除也要走归一化
	decisions.set("a.com", "allow");
	assert.equal(decisions.remove("A.COM"), true, "★ 删除也要归一化（用大写写法删得掉小写记的）");
	assert.equal(decisions.size, 0, "归一化删除后应为空");

	// ============================================================
	// 4. clear 要汇报条数
	// ============================================================
	const many = new SiteDecisions();
	many.set("a.com", "allow");
	many.set("b.com", "deny");
	assert.equal(many.clear(), 2, "clear 应返回被清掉的条数（供用户看到「清了几个」）");
	assert.equal(many.size, 0, "clear 后应为空");
	assert.equal(many.clear(), 0, "空记忆再 clear 应返回 0");

	// ============================================================
	// 5. 落盘顺序必须稳定
	// ============================================================
	const unsorted = new SiteDecisions();
	unsorted.set("zeta.com", "allow");
	unsorted.set("alpha.com", "deny");
	unsorted.set("mid.com", "allow");
	assert.deepEqual(
		unsorted.toArray().map((entry) => entry.host),
		["alpha.com", "mid.com", "zeta.com"],
		"★ toArray 必须按 host 排序（落盘顺序稳定，否则每次 diff 都在变）"
	);

	const json = unsorted.toJSON();
	assert.equal(json.version, SITE_DECISIONS_VERSION, "落盘要带版本号（将来才改得动格式）");
	assert.deepEqual(json.decisions, unsorted.toArray(), "toJSON 的条目应与 toArray 一致");

	// ============================================================
	// 6. ⭐ 读坏数据必须降级，绝不抛错
	// ============================================================
	// 记忆文件是**可被用户手改**的：改坏一个字符就让插件起不来，代价与收益完全不成比例。
	for (const [label, value] of [
		["null", null],
		["undefined", undefined],
		["数字", 42],
		["字符串", "not json"],
		["空对象", {}],
		["decisions 不是数组", { decisions: "x" }],
		["decisions 是对象", { decisions: { host: "a.com" } }],
	]) {
		let recovered;
		try {
			recovered = SiteDecisions.fromJSON(value);
		} catch (error) {
			recovered = error;
		}
		assert.ok(
			recovered instanceof SiteDecisions,
			`★ 读坏数据不该抛错，必须降级为空记忆（输入：${label}）`
		);
		assert.equal(recovered.size, 0, `${label} 应降级为空记忆`);
	}

	// 数组里混着垃圾：好的留下，坏的跳过（不能因为一条坏记录丢掉整份记忆）
	const mixed = SiteDecisions.fromJSON({
		version: 1,
		decisions: [
			{ host: "good.com", decision: "allow" },
			null,
			"junk",
			{ host: "", decision: "allow" },
			{ host: "bad-decision.com", decision: "maybe" },
			{ decision: "allow" },
			{ host: "good2.com", decision: "deny" },
		],
	});
	assert.equal(mixed.size, 2, "★ 逐条校验：坏条目跳过，好条目必须留下（一条坏记录不该毁掉整份记忆）");
	assert.equal(mixed.get("good.com"), "allow", "好条目要恢复");
	assert.equal(mixed.get("good2.com"), "deny", "好条目要恢复");

	// 往返一致
	const roundTrip = SiteDecisions.fromJSON(JSON.parse(JSON.stringify(unsorted.toJSON())));
	assert.deepEqual(roundTrip.toArray(), unsorted.toArray(), "toJSON → fromJSON 应无损往返");

	// 构造器也要容错（它走的是同一条校验）
	const fromCtor = new SiteDecisions([
		{ host: "ok.com", decision: "allow" },
		{ host: null, decision: "allow" },
		{ host: "x.com", decision: "nope" },
	]);
	assert.equal(fromCtor.size, 1, "构造器也要跳过坏条目");
}
