import { runMutations } from "./lib/mutate.mjs";
import { runDeleteLogSuite } from "./lib/delete-log-suite.mjs";

/**
 * 变异验证：删除留痕（`src/maintenance/delete-log.ts`）。
 *
 * 这一层守的是"**事后查得到**"。它错了不会有任何报错 ——
 * 只会让人在很久之后发现"我说不清当时删了什么"。
 *
 * ⚠️ 最要紧的一条是**写失败不许抛错**：删云端对象是用户已经确认过、**不可恢复**的
 * 主流程；留痕只是加强项。让"日志写不进去"（磁盘满、权限、文件被同步占用）
 * 把那条主流程炸断，代价与收益完全不成比例 —— 而症状是"删到一半报了个莫名其妙的错"。
 */
await runMutations({
	source: "src/maintenance/delete-log.ts",
	entries: ["src/maintenance/delete-log"],
	suite: runDeleteLogSuite,
	mutations: [
		{
			// 后果：写日志失败把异常抛出去 ⇒ 一次**已经确认过的**删除变成失败，
			// 而用户看到的只是一句"删除失败"，删了什么、删到哪一步全不知道。
			name: "★★ 写日志失败抛出异常（把一次已确认的删除炸成失败）",
			from: "\t\tdeps.onError?.(error);\n\t\treturn 0;",
			to: "\t\tthrow error;",
			expect: "写日志失败**绝不能抛错**",
		},
		{
			// 后果：写失败按"写了"上报 ⇒ 事后排查时以为"日志里没有 = 当时没删"，
			// 而那批删除其实发生了 —— 留痕这条链在最需要它的时候谎报成功。
			name: "★ 写失败也报成功（留痕在最需要它的时候撒谎）",
			from: "\t\tdeps.onError?.(error);\n\t\treturn 0;",
			to: "\t\tdeps.onError?.(error);\n\t\treturn lines.length;",
			expect: "写失败时如实返回 0 行",
		},
		{
			// 后果：每写一条记录追加一次 ⇒ 一次删除在日志里散成 N 次写入
			//（文件句柄与同步噪音成倍，且"一批"这个边界在日志里消失了）。
			name: "★ 每个对象写一次（一次删除散成 N 次写入）",
			from: "\t\tawait deps.append(lines.join(\"\"));",
			to: "\t\tfor (const line of lines) await deps.append(line);",
			expect: "一批只写一次",
		},
		{
			// 后果：空 key 也写进去 ⇒ 日志里出现一批谁也认不出指哪个对象的行，
			// 事后排查时反而更难看清"到底删了什么"。
			name: "★ 空 key 也写进日志（留下认不出来的行）",
			from: "\t\tif (!key) continue;",
			to: "\t\tif (false) continue;",
			expect: "只留下 key 合法的那一条",
		},
		{
			// 后果：404 被写成"已删除" ⇒ 事后看到的是"删掉了 N 个"，
			// 而其中一些本来就不在（也许正是别人已经删过）—— 日志的说法与事实不符。
			name: "★ 404 被记成「已删除」（日志与事实不符）",
			from: '\t\t\t\t\toutcome: raw?.outcome === "alreadyGone" ? "alreadyGone" : "deleted",',
			to: '\t\t\t\t\toutcome: "deleted",',
			expect: "本来就不在",
		},
	],
});
