import { runMutations } from "./lib/mutate.mjs";
import { runOrphanWatchSuite } from "./lib/orphan-watch-suite.mjs";

/**
 * 变异验证：孤儿监视（`src/maintenance/orphan-watch.ts`）。
 *
 * 这一层是"要不要弹出那个**不可恢复**的删除询问"的判据，所以两个方向都致命：
 * - 把"增加引用"当成"消失" ⇒ 一边整理笔记一边被弹框；
 * - 不看"别的笔记还引用着" ⇒ 删掉仍在用的对象；
 * - 把不属于我们的对象也拿去问 ⇒ 越权处置别人的东西；
 * - 问过一次还追着问 ⇒ 用户被反复打扰，直到手滑点一次删除。
 */
await runMutations({
	source: "src/maintenance/orphan-watch.ts",
	entries: ["src/maintenance/orphan-watch"],
	suite: runOrphanWatchSuite,
	mutations: [
		{
			// 后果：**新增引用**被当成"引用消失" ⇒ 用户每加一张图都可能被弹一次
			// "要不要连云端一起删"，而且他此刻正在做的事与删除毫无关系。
			name: "★ diff 方向写反（新增引用被当成孤儿）",
			from: "\t\tfor (const key of before) {\n\t\t\tif (next.has(key)) continue;\n\t\t\tif (dec(key)) orphans.push(key);\n\t\t}",
			to: "\t\tfor (const key of next) {\n\t\t\tif (before.has(key)) continue;\n\t\t\tif (dec(key)) orphans.push(key);\n\t\t}",
			// ⚠️ 方向写反的后果会先在"该报的没报"那一侧显形（套件是第一条失败断言决定报错）
			expect: "引用消失了",
		},
		{
			// 后果：**别的笔记还在引用**就被判成孤儿 ⇒ 删掉仍在使用的对象（不可恢复）。
			name: "★ 不看全局计数（别的笔记还在引用也报孤儿）",
			from: "\t\tif (current === 1) {\n\t\t\tcounts.delete(key);\n\t\t\treturn true;\n\t\t}",
			to: "\t\tif (current >= 1) {\n\t\t\tcounts.delete(key);\n\t\t\treturn true;\n\t\t}",
			expect: "绝不能报成孤儿",
		},
		{
			// 后果：对**不是我们上传的**对象也弹"要不要删云端" ⇒
			// 用户可能真的删掉一个他手写的、指向同一存储的对象（我们没有任何处置权）。
			name: "★ 不筛「是不是我们上传的」（对别人的对象也弹删除询问）",
			from: "\t\tif (!context.hasEntry(key)) {\n\t\t\tskipped.push({ key, reason: \"not-ours\" });\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tskipped.push({ key, reason: \"not-ours\" });\n\t\t\tcontinue;\n\t\t}",
			expect: "只留下我们上传过",
		},
		{
			// 后果：问过一次还问 ⇒ 用户整理笔记时被反复打扰，直到手滑点一次删除。
			name: "★ 去掉冷却（同一个对象反复弹框，直到用户手滑）",
			from: "\t\tif (context.hasAsked(key)) {\n\t\t\tskipped.push({ key, reason: \"already-asked\" });\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tskipped.push({ key, reason: \"already-asked\" });\n\t\t\tcontinue;\n\t\t}",
			expect: "没问过的",
		},
	],
});
