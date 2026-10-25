import { runMutations } from "./lib/mutate.mjs";
import { runGalleryActionsSuite } from "./lib/gallery-actions-suite.mjs";

/**
 * 变异验证：动作可用性（`src/gallery/actions.ts`，R24 / §5.5）。
 *
 * 这一层的每条判据都对应一个**用户按下去就会出事**的动作：
 * 删掉不可恢复的云端对象、对不存在的本地文件按“删除”、把不可传的算进按钮数字。
 */
await runMutations({
	source: "src/gallery/actions.ts",
	entries: ["src/gallery/actions", "src/gallery/enumerate"],
	suite: runGalleryActionsSuite,
	mutations: [
		{
			// 后果：**删掉仍被笔记引用的云端对象** ⇒ 笔记里立刻是死链，且**不可恢复**。
			name: "★★★ 删云端不再要求“没人引用”（删掉仍被引用的对象）",
			from: '\t\t\tif (item.referenced) return unavailable("still-referenced");',
			to: '\t\t\tif (false) return unavailable("still-referenced");',
			expect: "被引用的对象不许删云端（CR-05：永不放开）",
		},
		{
			// 后果：对“云端有本地无”的行也放行「删本地」⇒ 用户点了没反应，
			// 而批量执行时会把这一行算进“处理了几件”。
			name: "★★ 删本地不检查本地文件（对云端独有的行也放行）",
			from:
				'\t\tcase "delete-local":\n' +
				"\t\t\t// 本地没有文件就没有可删的（云端那份由「删云端」管）。\n" +
				'\t\t\tif (item.path === null) return unavailable("no-local-file");\n' +
				"\t\t\treturn AVAILABLE;",
			to:
				'\t\tcase "delete-local":\n' +
				"\t\t\t// 本地没有文件就没有可删的（云端那份由「删云端」管）。\n" +
				"\t\t\tif (false) return unavailable(\"no-local-file\");\n" +
				"\t\t\treturn AVAILABLE;",
			expect: "云端有本地无的行没有本地文件，删不了本地",
		},
		{
			// 后果：**“未上传”被当成“待上传”** ⇒ 安装包、算不出 key 的文件也进了上传动作，
			// 按钮数字虚高，按下只处理一部分。
			name: "★★ 上传不检查候选（未上传 ≠ 待上传）",
			from: '\t\t\tif (!context.isUploadCandidate) return unavailable("not-a-candidate");',
			to: '\t\t\tif (false) return unavailable("not-a-candidate");',
			expect: "不在上传候选里的文件不能传（未上传 ≠ 待上传）",
		},
		{
			// 后果：**按钮数字变成勾选数** ⇒ 勾 10 个显示 10，实际只处理 7 个，
			// 而用户是按这个数字确认的（D-47 同族：数字不能说谎）。
			name: "★★★ 按钮数字不再过滤（变成“勾选数”）",
			from: "\t\tif (actionAvailability(item, action, context).available) count += 1;",
			to: "\t\tcount += 1;",
			expect: "按钮数字 = 能作用的件数（不是勾选数）",
		},
		{
			// 后果：删除“未上传”的本地文件被当成“云端还有一份”⇒ 界面按“可再生副本”处理，
			// 不提示“这是唯一一份”，用户以为下次还能下载回来。
			name: "★★ 删本地后的状态恒为“云端有本地无”（未上传的也被当成有云端备份）",
			from: '\t\t\treturn item.state === "uploaded" ? "cloud-only" : "removed";',
			to: '\t\t\treturn "cloud-only";',
			expect: "未上传的删本地等于整行消失",
		},
	],
});
