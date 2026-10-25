import { runMutations } from "./lib/mutate.mjs";
import { runMigrateKeysSuite } from "./lib/migrate-keys-suite.mjs";

/**
 * 变异验证：统一对象名的纯逻辑（`src/maintenance/migrate-keys.ts`，CR-15）。
 *
 * 这一层决定"复制哪些、改哪些链接、什么时候才允许删旧对象"，而最后一步**不可逆**。
 * 八条各自对应一种真实失效：分档错（多传 / 链接指空）、幂等失效（连跑两次还在搬）、
 * 同内容并发复制、规则给了半个地址、复核漏一种形态、闸门放行、改名闸门失效。
 */
await runMutations({
	source: "src/maintenance/migrate-keys.ts",
	suite: runMigrateKeysSuite,
	mutations: [
		{
			// 后果：已经统一过的纯哈希 key 又被当成"旧 key"处理一遍 ⇒ 新 key 算出来等于自己，
			// 第二次跑四项不全为 0（用户看到"永远有一批待迁移"，而且每次都会 COPY 一次自己）。
			name: "★★ 已统一的 key 仍然进候选（连跑不收敛）",
			from: "\t\tif (isContentAddressedKey(oldKey)) continue;",
			to: "\t\tif (false) continue;",
			expect: "纯哈希 key 不重复处理",
		},
		{
			// 后果：没人引用的旧对象被复制成新对象 ⇒ 桶里多出一批**没有任何链接指向**的对象，
			// 用户下次清理时会在"待清理"里看到一堆自己没传过的东西。
			name: "★★ 没人引用的也复制（桶里多出一批孤儿）",
			from: "\t\tif (!input.referencedKeys.has(oldKey)) {",
			to: "\t\tif (false) {",
			expect: "四个数各一",
		},
		{
			// 后果：新 key 已经在桶里／本批前一条要复制它，却仍然记成 `copy` ⇒
			// 同内容的两份旧 key 并发写同一个新 key（流量翻倍，失败判定变成随机）。
			name: "★ 新 key 已在却仍要复制（同内容并发写）",
			from: "\t\tif (alreadyThere || willCopy.has(newKey)) {",
			to: "\t\tif (false) {",
			expect: "四个数各一",
		},
		{
			// 后果：端点没配好时仍然产出规则，`from`/`to` 里是 null ⇒
			// 笔记里被写进一个必然 404 的链接（而且复核时旧 key 已消失，看起来"改成功了"）。
			name: "★★ 地址推不出来也给规则（写进死链）",
			from: "\t\tif (!from || !to || from === to) continue;",
			to: "\t\tif (false) continue;",
			expect: "端点推不出地址",
		},
		{
			// 后果：复核只比 URL 形态 ⇒ 裸 key 形态（用户手贴、或 URL 被转义过）看不见 ⇒
			// 删掉一个还在被引用的对象。这是整个功能唯一不可逆的后果。
			name: "★★ 复核只比 URL（漏掉裸 key，删掉还在用的对象）",
			from: "\t\t\t(text) => typeof text === \"string\" && text !== \"\" && (text.includes(oldKey) || (url !== null && text.includes(url)))",
			to: "\t\t\t(text) => typeof text === \"string\" && text !== \"\" && url !== null && text.includes(url)",
			expect: "裸 key 形态也要抓",
		},
		{
			// 后果：正文里还有旧 key 也放行 ⇒ 旧对象被删、链接留着 ⇒ 那些笔记直接裂图。
			name: "★★ 删除闸门放行（旧链接还在就删）",
			from: '\tif (input.leftovers.length > 0) return { ok: false, reason: "leftover" };',
			to: '\tif (false) return { ok: false, reason: "leftover" };',
			expect: "正文里还有旧 key ⇒ 一个都不删",
		},
		{
			// 后果：有篇读不到也放行 ⇒ "这篇里有没有旧链接"没人回答过，而它决定"哪些可以直接删"。
			name: "★★ 读不到的篇不算数（放行不可逆的一步）",
			from: '	if ((input.unreadable ?? 0) > 0) return { ok: false, reason: "unreadable" };',
			to: "	if (false) return { ok: false, reason: \"unreadable\" };",
			expect: "有篇读不到",
		},
		{
			// 后果：迁移进行中仍然允许改名 ⇒ 新 key 是按"改之前的名字"算出来的，
			// 而声明里的名字被改成新的 ⇒ 显示名与对象名对不上，续跑时又会算出一个新 key。
			name: "★★ 改名闸门失效（迁移中也能改名）",
			from: '\treturn state !== "idle";',
			to: "\treturn false;",
			expect: "迁移进行中",
		},
	],
});
