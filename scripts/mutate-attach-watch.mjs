import { runMutations } from "./lib/mutate.mjs";
import { runAttachWatchSuite } from "./lib/attach-watch-suite.mjs";

/**
 * 变异验证：新增附件自动接管（`src/maintenance/attach-watch.ts`）。
 *
 * 这条链挂在 `vault.on("create")` 上，也就是**全库所有新文件**都会经过它，
 * 而它做过的每一件事都很难被用户看见（上传是后台的、通知只有一条）：
 *
 * - **误接管**：把不是用户附件的东西传上去，还去改写引用它的笔记；
 * - **漏接管**：手机上加了图什么都没发生 —— 正是用户报上来的那条；
 * - **退避失效**：宿主的链接是在文件落盘**之后**才写进笔记的，
 *   少了重试，这条入口会在"第一次判定时还没看到引用"之后彻底静默 ——
 *   症状与没修之前**一模一样**，而这正是最容易发生的坏法。
 */

await runMutations({
	source: "src/maintenance/attach-watch.ts",
	entries: [
		"src/maintenance/attach-watch",
		"src/maintenance/batch",
		"src/cache/index",
		"src/cache-path",
		"src/vault-files",
		"src/settings",
		"src/types",
	],
	suite: runAttachWatchSuite,
	mutations: [
		{
			// 这条是整个模块存在的理由：宿主的链接**晚于**文件出现，
			// 所以"现在还没有引用"必须被当成"还没到时候"。
			// 改成终局判定 ⇒ 首次判定之后彻底静默，症状与用户报的那条完全一致。
			name: "★ 「还没被引用」不再重试（首次判定即终局 ⇒ 手机上加了图仍然什么都不发生）",
			from: "return { adopt: false, reason, retry: !input.referencedPaths.has(path) };",
			to: "return { adopt: false, reason, retry: false };",
			expect: "「还没被引用」只是还没到时候 ⇒ retry 必须为真",
		},
		{
			// 粘贴那条路的"先落盘再上传"也会触发 create。少了这道闸门，
			// 自动接管会把它当成用户新加的附件再传一遍（并且跟那条路抢同一个文件）。
			name: "★ 自写护栏失效（粘贴落下的中转文件被重复接管）",
			from: '\tif (input.isSelfWrite) return { adopt: false, reason: "是我们自己刚落盘的中转文件", retry: false };',
			to: '\tif (false) return { adopt: false, reason: "是我们自己刚落盘的中转文件", retry: false };',
			expect: "是我们自己刚落下的中转文件：不该接管",
		},
		{
			// 缓存副本（回退下载写的、别的设备同步来的）不是用户新加的附件。
			// 少了这道闸门，一次同步就能让每台设备把同一份内容互相传一遍。
			name: "★ 缓存目录护栏失效（缓存副本被当成用户新附件上传）",
			from: "\tif (isUnderCacheFolder(path, input.cacheFolder)) {",
			to: "\tif (false) {",
			expect: "文件在缓存目录里：不该接管",
		},
		{
			// 开关关掉之后这条入口必须一步都不碰（与粘贴那条路的语义一致）。
			name: "★ 自动上传开关失效（关掉后仍然接管）",
			from: '\tif (!input.autoUpload) return { adopt: false, reason: "自动上传已关闭", retry: false };',
			to: '\tif (false) return { adopt: false, reason: "自动上传已关闭", retry: false };',
			expect: "自动上传关着：不该接管",
		},
		{
			// 一批只处理第一个 ⇒ 分享多张图、一次拷进几个文件时，剩下的永远不上传。
			name: "★ 攒批只处理第一个（同一次里的其余文件永远不上传）",
			from: "\t\tif (adoptable.length > 0) {",
			to: "\t\tif (adoptable.length > 0) {\n\t\t\tadoptable.splice(1);",
			expect: "整批一起交给执行层",
		},
		{
			// 收尾时清空整个攒批 ⇒ 等待期间新报上来的文件被一起吞掉
			//（用户加了第二张图，它永远不上传）。
			name: "★ 收尾清空整个攒批（等待期间新来的文件被吞掉）",
			from: "\t\t\t\tfor (const path of waiting) pendingPaths.delete(path);",
			to: "\t\t\t\tpendingPaths.clear();",
			expect: "等待期间新来的文件必须留在攒批里，不能被一起清掉",
		},
		{
			// 接管过的文件必须从攒批里摘掉，否则每一拍都重传一次。
			name: "★ 接管过的文件不摘出攒批（每拍重复上传同一个文件）",
			from: "\t\t\t\tadoptable.push(path);\n\t\t\t\tpendingPaths.delete(path);",
			to: "\t\t\t\tadoptable.push(path);",
			expect: "接管过的文件不再重复处理",
		},
		{
			// 卸载不取消定时器 ⇒ 插件已经卸载了还会去改用户的笔记（热重载时改两次）。
			name: "★ 卸载不取消已排的调度（卸载后仍然改写笔记）",
			from: "\t\t\tif (handle !== null) cancel(handle);",
			to: "\t\t\tif (false) cancel(handle);",
			expect: "卸载必须取消已排的调度（否则卸载后还会去改用户笔记）",
		},
		{
			// 台账永不过期 ⇒ 用户将来真的有一个同名附件时，它会被永远当成
			// "我们自己刚写的"而永不上传。这个坏法只在几天后才显形。
			name: "★ 自写台账永不过期（将来同名附件永不上传）",
			from: "\t\t\tif (expiresAt <= now()) {\n\t\t\t\tentries.delete(path);\n\t\t\t\treturn false;\n\t\t\t}",
			to: "\t\t\tif (false) {\n\t\t\t\tentries.delete(path);\n\t\t\t\treturn false;\n\t\t\t}",
			expect: "过期之后不能再认",
		},
	],
});
