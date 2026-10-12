import { runMutations } from "./lib/mutate.mjs";
import { runSelfHealSuite } from "./lib/self-heal-suite.mjs";

/**
 * 变异验证：索引自愈（`src/maintenance/self-heal.ts`）。
 *
 * 这一层的每条坏法**都不会报错**，只会让人在很久之后发现"离线时某些图不显示了"或
 * "占用统计对不上"。所以两个方向都要钉：该摘的不摘（记录越积越多）与**不该摘的摘了**
 * （把仍在的副本从账本里抹掉 = 悄悄拿掉离线可用）。
 */
await runMutations({
	source: "src/maintenance/self-heal.ts",
	entries: ["src/maintenance/self-heal"],
	suite: runSelfHealSuite,
	mutations: [
		{
			// 后果：**单轮就摘** —— 文件只是"还在路上"（换设备、同步工具正在拉）也被当成失效。
			// 新设备上这可能是**整份索引**：索引文件随 `.obsidian` 先到、附件还没到 ⇒ 全摘掉 ⇒
			// 文件随后到了也认不出，要等一次回退下载才恢复。
			name: "★★ 不等确认就摘（把「还在路上」的副本当成没了）",
			from: "\t\t\t\tif (deps.confirmAbsent(target.path, true)) {",
			to: "\t\t\t\tif (true) {",
			expect: "第 1 轮：文件不在也",
		},
		{
			// 后果：查询抛错被当成"文件不在" ⇒ 把仍在的副本从账本里抹掉 ——
			// 而那些图在离线时就不显示了，有网时还会重新下载一次。
			// 这正是"误摘"的方向，也是这一层最要紧的一条。
			name: "★★ 查询出错当成「文件不在」（把仍在的副本误摘掉）",
			from: "\t\t\t\tresult.failed += 1;\n\t\t\t\tdeps.onError?.(error);",
			to: "\t\t\t\tstale.push(...target.keys);\n\t\t\t\tdeps.onError?.(error);",
			expect: "出错按「存在」处理",
		},
		{
			// 后果：找不到文件时说"没事"⇒ 记录越积越多，占用统计一直虚高，
			// 而"渲染时以为本地已有"这条误判也不会被修掉。
			name: "★ 文件不在也不摘（记录越积越多、统计一直虚高）",
			from: "\t\t\t\t\tstale.push(...target.keys);",
			to: "\t\t\t\t\tvoid target;",
			// ⚠️ 实测先红的是**计数**那条（"如实计数"）—— 记录没被摘掉这件事，
			// 套件是从"摘了 0 条而预期 1 条"看出来的。按纪律如实写这一条。
			expect: "第 2 轮仍不在",
		},
		{
			// 后果：同一路径只摘第一条记录 ⇒ 下一轮又查出同名路径（另一条 key），
			// 一轮修不干净；而提示里的数字也小于实际情况。
			name: "★ 同一路径只摘一条记录（一轮修不干净）",
			from: "\t\t\t\t\tstale.push(...target.keys);",
			to: "\t\t\t\t\tstale.push(target.keys[0]);",
			expect: "只检查 1 条路径，但摘掉 2 条记录",
		},
		{
			// 后果：空白路径也交给适配器 ⇒ 是在赌宿主怎么处理这种输入，
			// 而我们为这种输入冒的是"把一条记录误判成失效"的风险。
			name: "★ 空白路径也去查（拿「文件在哪都答不出」的记录去赌宿主行为）",
			from: "\t\tif (!path) continue;",
			to: "\t\tif (false) continue;",
			expect: "空白路径直接跳过",
		},
		{
			// 后果：没修也通知 ⇒ 每次启动都弹一句"已自动修复 0 条"，用户很快学会无视它，
			// 而这类"永远存在的提示"会连真需要看的那条一起淹没。
			name: "★ 0 条也通知（噪音淹没真正的提示）",
			from: "\t\tif (stale.length === 0) return result;",
			to: "\t\tif (stale.length === 0) {\n\t\t\tdeps.notify(deps.t(\"selfHealRepaired\", { count: 0 }));\n\t\t\treturn result;\n\t\t}",
			expect: "0 条不通知",
		},
		{
			// 后果：改了却不落盘 ⇒ 下次启动一切照旧，用户永远等不到修好。
			name: "★ 改了不落盘（下次启动一切照旧）",
			from: "\t\t\tawait deps.persist();",
			to: "\t\t\tvoid deps.persist;",
			expect: "改了才落盘",
		},
		{
			// 后果：落盘失败也报"已修复"⇒ 用户以为好了，下次启动又回来 ——
			// 而这正是本项目"不假装成功"要挡的那种谎报。
			name: "★ 落盘失败也报「已修复」（谎报成功）",
			from: '\t\t\tdeps.notify(deps.t("maintainPersistFailed", { error: String(error) }));\n\t\t\treturn result;',
			to: "\t\t\tvoid error;",
			expect: "说的是失败，不是",
		},
		{
			// 后果：后台任务把异常抛给调用方 ⇒ 插件生命周期里冒出一个没人接的异常。
			name: "★ 后台任务把异常抛出去（插件生命周期里没人接）",
			from: "\t\tdeps.onError?.(error);\n\t\treturn result;\n\t}\n}",
			to: "\t\tthrow error;\n\t}\n}",
			expect: "自愈绝不能抛错",
		},
	],
});
