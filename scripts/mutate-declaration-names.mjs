import { runMutations } from "./lib/mutate.mjs";
import { runDeclarationNamesSuite } from "./lib/declaration-names-suite.mjs";

/**
 * 变异验证：改名待补队列（`src/maintenance/declaration-names.ts`，CR-16）。
 *
 * 这一层的失败都是**静默**的（没人报错，只是别设备的名字慢慢变旧、队列慢慢变大），
 * 所以六条各自对着一种真实后果：垃圾入队（挤掉真待补）、不淘汰（无限膨胀）、
 * 结清时连没补的一起丢、顺序反了（先补最新的，救不了最早的）。
 */
await runMutations({
	source: "src/maintenance/declaration-names.ts",
	suite: runDeclarationNamesSuite,
	mutations: [
		{
			// 后果：随便什么键都能入队 ⇒ 队列被垃圾填满，**真正要补的**（旧名字）被上限挤掉。
			name: "★★ 非法 hash 也入队（挤掉真待补）",
			from: "\tif (!HASH_SHAPE.test(key)) return backlog;",
			to: "\tif (false) return backlog;",
			expect: "非法 hash 不入队",
		},
		{
			// 后果：空名字入队 ⇒ 补写时把声明里的名字**清成空串**，别设备那边显示名直接没了。
			name: "★★ 空名字也入队（会把声明里的名字清空）",
			from: '\tif (cleanName === "") return backlog;',
			to: "\tif (false) return backlog;",
			expect: "空名字不入队",
		},
		{
			// 后果：不淘汰 ⇒ 队列无限膨胀，而且写坏一次就永久背着这一大坨。
			name: "★ 不淘汰最旧的（队列无限膨胀）",
			from: "\tif (keys.length <= BACKLOG_LIMIT) return next;",
			to: "\tif (true) return next;",
			// 先红的其实是"不超过上限"（队列已经 201 条）—— 它比"淘汰了哪一条"更早说话
			expect: "不超过上限",
		},
		{
			// 后果：结清时把没补成功的也删掉 ⇒ 那条名字**永远**补不上了（声明里一直是旧名）。
			name: "★★ 结清时连没补的一起丢（名字永远旧）",
			from: "\t\tif (!drop.has(key)) next[key] = backlog[key];",
			to: "\t\tif (true) next[key] = backlog[key];",
			expect: "只结清点名的那些",
		},
		{
			// 后果：先补最新的 ⇒ 只能补一部分时，用户**最早**改的那个名字一直排在队尾。
			name: "★ 摊平顺序反了（先补最新的）",
			from: "\t\t.sort((a, b) => (backlog[a].at < backlog[b].at ? -1 : backlog[a].at > backlog[b].at ? 1 : 0))",
			to: "\t\t.sort((a, b) => (backlog[a].at < backlog[b].at ? 1 : backlog[a].at > backlog[b].at ? -1 : 0))",
			expect: "最旧的先补",
		},
		{
			// 后果：扩展名保留大小写 ⇒ 声明里记下 `PNG`，而 key / 索引那边都是小写，
			// 比"显示名"更糟的是它让"这条待补"看起来与对象对不上。
			name: "★ 扩展名不转小写",
			from: '\tconst ext = dot > 0 ? segment.slice(dot + 1).toLowerCase() : "";',
			to: '\tconst ext = dot > 0 ? segment.slice(dot + 1) : "";',
			expect: "取最后一段，扩展名转小写",
		},
	],
});
