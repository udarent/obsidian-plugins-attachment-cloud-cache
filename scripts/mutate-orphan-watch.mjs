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
			// 后果：对**不是我们经手过的**对象也弹"要不要删云端" ⇒
			// 用户可能真的删掉一个他手写的、指向同一存储的对象（我们没有任何处置权）。
			name: "★ 不筛「是不是我们经手过的」（对别人的对象也弹删除询问）",
			from: "\t\tif (!context.isOurs(key)) {\n\t\t\tskipped.push({ key, reason: \"not-ours\" });\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tskipped.push({ key, reason: \"not-ours\" });\n\t\t\tcontinue;\n\t\t}",
			expect: "只留下我们经手过",
		},
		{
			// 后果：问过一次还问 ⇒ 用户整理笔记时被反复打扰，直到手滑点一次删除。
			name: "★ 去掉冷却（同一个对象反复弹框，直到用户手滑）",
			from: "\t\tif (context.hasAsked(key)) {\n\t\t\tskipped.push({ key, reason: \"already-asked\" });\n\t\t\tcontinue;\n\t\t}",
			to: "\t\tif (false) {\n\t\t\tskipped.push({ key, reason: \"already-asked\" });\n\t\t\tcontinue;\n\t\t}",
			expect: "没问过的",
		},
		{
			// ⚠️ 1.2.0（D-17）：这里原本有一条"本地副本一律当成缓存文件"的锚点
			//（打坏 `isUserFile` 的分类 ⇒ 用户的附件被永久删）。缓存目录取消后那个分类
			// 整块消失了，**删法只剩一种** ⇒ 那条锚点连同它在源码里的落点一起删掉，
			// 而"删法走不走回收站"由 `mutate-orphan-removal.mjs` 在同一条路径上钉住。
			// 死代码的锚点留着，只会让"全都抓住了"这句话变得不可信。
			//
			// 后果：只有空格的路径也交给宿主去解析 ⇒ 是在赌它怎么处理这种输入，
			// 而我们为这种输入冒的是"删错文件"的风险。
			// ⚠️ 变异只削 `trim()`（保留空串那一半）：两个判断都在守同一件事，
			// 削掉整行会先在"空串"那条断言上红 —— 那记的是另一个原因。
			name: "★ 只挡空串、不挡纯空白（把空白路径交给宿主）",
			from: "\t\tif (typeof raw !== \"string\" || raw.trim() === \"\") continue;",
			to: "\t\tif (typeof raw !== \"string\" || raw === \"\") continue;",
			expect: "纯空白",
		},
		{
			// 后果：同一次里重复的候选产出多份 ⇒ 提示语里的数量与实际删除数对不上，
			// 而这一层的数量是用户判断"删了什么"的唯一依据。
			name: "★ 不去重（同一份副本被算两次）",
			from: "\t\tif (seen.has(path)) continue;\n\t\tseen.add(path);",
			to: "\t\tseen.add(path);",
			expect: "同一路径只产出一次",
		},
	],
});
