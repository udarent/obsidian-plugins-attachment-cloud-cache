/**
 * 「统一对象名」的纯逻辑套件（`src/maintenance/migrate-keys.ts`）。
 *
 * 这一层是**第一次批量改用户笔记**的地方，所以每条断言都按"错了会怎样"命名：
 * 把 `drop` 判成 `copy` ⇒ 桶里多出一批没人用的新对象；
 * 把 `copy` 判成 `relink` ⇒ 链接改到一个不存在的对象上（图直接裂）；
 * 复核漏看裸 key ⇒ 删掉还在被引用的旧对象（不可逆）。
 */

import assert from "node:assert/strict";

/** 造一个合法哈希（64 位小写十六进制）。 */
const hash = (n) => n.toString(16).padStart(64, "0");

/**
 * 一个"带名字"的旧 key（1.2.0 起的形状：`<名字去扩展名>-<完整哈希>.<扩展名>`）。
 *
 * ⚠️ 参数是**主干名**（不含扩展名）：`named("a")` ⇒ `a-<hash>.png`。
 * 写成 `named("a.png")` 会得到 `a.png-<hash>.png`，扩展名解析出来是 `png-<hash>` ——
 * 那样测的就不是真实形状了（第一版套件正是这么写错的，被自己的断言抓住）。
 */
const named = (stem, n, ext = "png") => `${stem}-${hash(n)}.${ext}`;

const urlFor = (key) => `https://cdn.example.com/bucket/${key}`;

const noUrls = () => null;

export async function runMigrateKeysSuite(mod) {
	const { planMigration, migrationRules, leftoverOldKeys, canDeleteOldKeys, blocksRename, extensionOfKey, isContentAddressedKey } =
		mod;

	// ============================================================
	// 1. 四档分档：copy / relink / drop / unknown 各一条
	// ============================================================
	{
		const referenced = new Set([named("a", 1), named("b", 2)]);
		const plan = planMigration({
			ledgerKeys: [
				named("a", 1), // 有引用、桶里没有新 key ⇒ copy
				named("b", 2), // 有引用、桶里已有新 key ⇒ relink
				named("c", 3), // 没人引用 ⇒ drop
				"legacy-object.png", // 算不出哈希 ⇒ unknown
			],
			cloudKeys: new Set([`${hash(2)}.png`]),
			referencedKeys: referenced,
		});

		assert.deepEqual(plan.counts, { copy: 1, relink: 1, drop: 1, unknown: 1 }, "四个数各一（界面要照这四个数报）");
		const byOld = new Map(plan.candidates.map((c) => [c.oldKey, c]));
		assert.equal(byOld.get(named("a", 1)).bucket, "copy", "★ 有引用且桶里没有新 key ⇒ 要复制");
		assert.equal(byOld.get(named("a", 1)).newKey, `${hash(1)}.png`, "新 key 由 hash＋扩展名拼出（与上传链同一规则）");
		assert.equal(byOld.get(named("b", 2)).bucket, "relink", "★ 新 key 已在桶里 ⇒ 只改链接（不重复复制）");
		assert.equal(byOld.get(named("c", 3)).bucket, "drop", "★ 没人引用 ⇒ 直接删旧的（复制了也没人指过去）");
		assert.equal(byOld.get("legacy-object.png").bucket, "unknown", "★ 算不出哈希 ⇒ 如实归到 unknown，不谎报完成");
		assert.equal(byOld.get("legacy-object.png").newKey, "", "unknown 档没有新 key（下游不许拿它去 COPY）");
	}

	// ============================================================
	// 2. 已经统一过的 key ⇒ 完全不进候选（"连跑两次第二次四项为 0"）
	// ============================================================
	{
		const plan = planMigration({
			ledgerKeys: [`${hash(1)}.png`, `${hash(2)}.pdf`],
			cloudKeys: null,
			referencedKeys: new Set([`${hash(1)}.png`]),
		});
		assert.deepEqual(plan.candidates, [], "★ 纯哈希 key 不重复处理（否则第二次跑会把它当成旧 key 再搬一遍）");
		assert.deepEqual(plan.counts, { copy: 0, relink: 0, drop: 0, unknown: 0 }, "四项全 0");
	}

	// ============================================================
	// 3. 同内容多份旧 key ⇒ 只让第一条复制，其余 relink
	// ============================================================
	{
		const first = named("照片", 7);
		const second = named("照片 1", 7);
		const plan = planMigration({
			ledgerKeys: [first, second],
			cloudKeys: new Set(),
			referencedKeys: new Set([first, second]),
		});
		const byOld = new Map(plan.candidates.map((c) => [c.oldKey, c]));
		assert.equal(byOld.get(first).bucket, "copy", "第一条负责复制");
		assert.equal(byOld.get(second).bucket, "relink", "★ 第二条只改链接（同内容并发写同一个新 key 没有意义）");
		assert.equal(byOld.get(first).newKey, byOld.get(second).newKey, "两条指向同一个新 key（内容相同）");
		assert.equal(plan.counts.copy, 1, "只复制一次");
	}

	// ============================================================
	// 4. 没人引用 + 桶里已有新 key ⇒ 仍是 drop（不是 relink）
	// ============================================================
	{
		const plan = planMigration({
			ledgerKeys: [named("old", 4)],
			cloudKeys: new Set([`${hash(4)}.png`]),
			referencedKeys: new Set(),
		});
		assert.equal(plan.candidates[0].bucket, "drop", "★ 没人引用的旧对象直接删（改链接是无处可改）");
	}

	// ============================================================
	// 5. 桶没列举（cloudKeys = null）⇒ 全部按 copy
	// ============================================================
	{
		const plan = planMigration({
			ledgerKeys: [named("a", 5)],
			cloudKeys: null,
			referencedKeys: new Set([named("a", 5)]),
		});
		assert.equal(plan.candidates[0].bucket, "copy", "★ 没列举就拿不到\"新 key 已在\"，只能先复制（COPY 本身幂等）");
	}

	// ============================================================
	// 6. 改写规则：只给 copy / relink，且地址推不出就跳过
	// ============================================================
	{
		// `a` 有引用（copy）、`c` 没人引用（drop）、`legacy.png` 算不出哈希（unknown）
		const referenced = new Set([named("a", 1)]);
		const plan = planMigration({
			ledgerKeys: [named("a", 1), named("c", 3), "legacy.png"],
			cloudKeys: new Set(),
			referencedKeys: referenced,
		});
		const rules = migrationRules(plan, urlFor);
		assert.equal(rules.length, 1, "★ 只有那条需要改链接的进规则（drop / unknown 不产规则）");
		assert.equal(rules[0].from, `https://cdn.example.com/bucket/${named("a", 1)}`, "from 是旧地址");
		assert.equal(rules[0].to, `https://cdn.example.com/bucket/${hash(1)}.png`, "to 是新地址");
		assert.equal(rules[0].display, "a.png", "显示名用原名（新 key 里没有名字）");

		const none = migrationRules(plan, noUrls);
		assert.deepEqual(none, [], "★ 端点推不出地址 ⇒ 一条规则都不给（半个地址必然 404）");
	}

	// ============================================================
	// 7. 复核：URL 形态与裸 key 形态都要抓
	// ============================================================
	{
		const oldKey = named("a", 1);
		assert.deepEqual(leftoverOldKeys({ texts: [`![x](${urlFor(oldKey)})`], oldKeys: [oldKey], urlFor }), [oldKey], "URL 形态要抓");
		assert.deepEqual(leftoverOldKeys({ texts: [`裸地址：${oldKey}`], oldKeys: [oldKey], urlFor }), [oldKey], "★ 裸 key 形态也要抓（只比 URL 会漏）");
		assert.deepEqual(leftoverOldKeys({ texts: ["已经有新链接了"], oldKeys: [oldKey], urlFor }), [], "没有残留 ⇒ 空");
		assert.deepEqual(leftoverOldKeys({ texts: [""], oldKeys: [oldKey], urlFor }), [], "空正文不算残留");
	}

	// ============================================================
	// 8. 删除闸门：残留优先，其次新 key 缺；两条都不许放行
	// ============================================================
	{
		const blocked = canDeleteOldKeys({
			leftovers: ["old.png"],
			newKeys: [{ key: "new.png", ok: true }],
		});
		assert.equal(blocked.ok, false, "★ 正文里还有旧 key ⇒ 一个都不删");
		assert.equal(blocked.reason, "leftover", "原因要说清是\"链接还没改干净\"（不是\"新对象没到\"）");

		const missing = canDeleteOldKeys({
			leftovers: [],
			newKeys: [
				{ key: "a.png", ok: true },
				{ key: "b.png", ok: false },
			],
		});
		assert.equal(missing.ok, false, "★ 新 key 缺一个 ⇒ 也不删（删了那条链接就是死链）");
		assert.equal(missing.reason, "new-missing", "原因分开报");

		const blind = canDeleteOldKeys({
			leftovers: [],
			newKeys: [{ key: "a.png", ok: true }],
			unreadable: 1,
		});
		assert.equal(blind.ok, false, "★ 有篇读不到 ⇒ 也不知道它有没有旧链接 ⇒ 一样不许删");
		assert.equal(blind.reason, "unreadable", "原因要能与「链接没清干净」分开（修法不同）");

		assert.equal(canDeleteOldKeys({ leftovers: [], newKeys: [{ key: "a.png", ok: true }] }).ok, true, "全绿才放行");
	}

	// ============================================================
	// 9. 改名的执行层闸门：非 idle 一律拦
	// ============================================================
	{
		assert.equal(blocksRename("idle"), false, "空闲时允许改名");
		assert.equal(blocksRename("running"), true, "★ 迁移进行中：改名会打乱\"新 key 由旧名推出来\"的链路");
		assert.equal(blocksRename("interrupted"), true, "★ 中断未收口同样要拦（否则续跑时名字对不上）");
	}

	// ============================================================
	// 10. 形状判据：前缀点、目录里的点、认不出的 key
	// ============================================================
	{
		assert.equal(extensionOfKey("a/b/c.PNG"), "png", "扩展名转小写");
		assert.equal(extensionOfKey("v1.2/photo"), "", "目录里的点不参与扩展名判断");
		assert.equal(extensionOfKey(".hidden"), "", "点开头不是扩展名");
		assert.equal(extensionOfKey("noext"), "", "没有点 ⇒ 空串");

		assert.equal(isContentAddressedKey(`${hash(1)}.png`), true, "纯哈希 ⇒ 已统一");
		assert.equal(isContentAddressedKey(named("a", 1)), false, "带名字 ⇒ 还没统一");
		assert.equal(
			isContentAddressedKey("notes/readme.md"),
			false,
			"★ 彻底认不出的 key 不能当成\"已统一\"（否则它永远不进 unknown 报告）"
		);
	}

	return { cases: 10 };
}
