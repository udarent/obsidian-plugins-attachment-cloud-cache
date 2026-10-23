import { runMutations } from "./lib/mutate.mjs";
import { runGalleryEnumerateSuite } from "./lib/gallery-enumerate-suite.mjs";

/**
 * 变异验证：附件列表的枚举与四态（`src/gallery/enumerate.ts`，R24）。
 *
 * 每条锚点都对应一个**不会报错的真错误**：
 * 笔记混进列表、同一对象两行、状态证据被抹平、引用只问一半。
 */
await runMutations({
	source: "src/gallery/enumerate.ts",
	entries: ["src/gallery/enumerate", "src/vault-files", "src/object-key"],
	suite: runGalleryEnumerateSuite,
	mutations: [
		{
			// 后果：**笔记 / 画布 / 数据库进列表** ⇒ 用户勾上、点删除，删的是自己的笔记。
			name: "★★★ 笔记类不再被剔除（把笔记当成附件列出来）",
			from: '\t\tif (isNoteLikeExtension(file.extension)) continue;',
			to: "\t\tif (false) continue;",
			expect: "笔记 / 画布 / 数据库不进列表（它们不是附件）",
		},
		{
			// 后果：**同一个附件出现两行**（一行本地、一行云端）⇒ 两行各删一次，
			// 或用户以为有两份。
			name: "★★ 已在本地的条目又出一条“云端”行（同一对象两行）",
			from: "\t\tif (!key || !uploaded.has(key)) continue;\n\t\tif (knownKeys.has(key)) continue;",
			to: "\t\tif (!key || !uploaded.has(key)) continue;\n\t\tif (false) continue;",
			expect: "已在本地的条目不许再出一条“云端”行",
		},
		{
			// 后果：**“有没有人引用”只问路径那一半** ⇒ 已经迁到云端、链接改成远端地址的
			// 附件全被判成“没人引用”，清理时会被误删。
			name: "★★★ 引用只问本地路径（远端 URL 那一半丢了）",
			from: "\tif (key !== null && input.referencedKeys.has(key)) return true;",
			to: "\tif (false) return true;",
			expect: "只在笔记里写着远端 URL（没人再指着路径）⇒ 仍然算有引用",
		},
		{
			// 后果：**“没核过”与“确实没传过”被抹平** ⇒ 界面上都显示“未上传”，
			// 用户以为可以传，实际云端可能早就有；也让“待上传 ≠ 未上传”失去依据。
			name: "★★ 证据被写死成 index（未核过的本地文件看起来像核过了）",
			from: '\t\t\tevidence: entry ? "index" : "none",',
			to: '\t\t\tevidence: "index",',
			expect: "没有条目 ⇒ 证据是 none（“未上传”不等于“核过了”）",
		},
	],
});
