import { runMutations } from "./lib/mutate.mjs";
import { runLoadAcceptance } from "./lib/load-acceptance-suite.mjs";

/**
 * 变异验证：维护功能的**执行层**（`src/maintenance/run.ts`）。
 *
 * 执行层的大部分行为（先自愈再清理、拿不到删除凭据就跳过、不删原文件）
 * 要么已经在 `test-maintenance.mjs` 的纯判定层被钉住，要么需要一个
 * **验收环境里造不出来的场景**（比如"宿主的文件索引滞后于磁盘"）——
 * 硬塞一条打不中要害的变异，只会让"全部被捕获"这句话贬值。
 *
 * 所以这里只留三条**在验收环境里真的能观察、且后果具体**的变异：
 * 批量上传只传不改链接（用户以为笔记已经搬走了），
 * 以及两条**把调用点换掉删除原语** —— 两条调用路径各一条。
 *
 * 那两条正是现在真正的风险所在：删除原语本身已经被"只用 Vault.delete、
 * 不许碰回收站"钉住了（见 `mutate-remove.mjs`），但**调用点绕开它**完全可能 ——
 * 直接调 `fileManager.trashFile` 也能"删掉文件"，只是空间不释放，
 * 于是症状变成"我设了上限/清理了缓存，磁盘却没变"。
 */
await runMutations({
	source: "src/maintenance/run.ts",
	entries: ["src/main"],
	reexportDefault: ["src/main"],
	suite: (mod) => runLoadAcceptance({ loadPluginClass: () => mod }),
	mutations: [
		{
			name: "★ 批量上传只传不改链接（笔记仍指向本地，用户以为已经搬走了）",
			from: "\t\t\tawait deps.app.vault.modify(note, rewritten.text);",
			to: "\t\t\tvoid note; // 变异：不改笔记",
			expect: "链接被改写成远端地址",
		},
		{
			// 后果：删除绕过 `remove.ts`，直接把文件送进回收站 ⇒ 文件离开 vault
			// 而物理空间不释放，用户会以为"清理了缓存/清了下限，磁盘却没变"。
			// ⚠️ 1.2.0 起这条循环是**两条路径共用**的（自动淘汰 + F18 存量清理），
			// 所以这一条锚点同时守着两条 —— 这里原先是**重复的两条**（淘汰一条、
			// "后台淘汰"一条），而那两条锚的是同一行，本身就是冗余。
			name: "★ 删除绕过删除原语，改走回收站（空间不释放）",
			from:
				"\t\t\tawait removeCacheFile(deps.app, file);\n" +
				"\t\t\tresult.evicted += 1;",
			to: "\t\t\tawait deps.app.fileManager.trashFile(file);\n\t\t\tresult.evicted += 1;",
			expect: "也必须用 Vault.delete",
		},
		{
			// ⚠️ 这是整套代码里**最要命**的一行：清单是上一拍算的，而"云端现在还有没有它"
			// 只能问服务端 —— 答不上来（离线、出错、404）就必须**不删**，
			// 因为那种副本可能是**最后一份**（别的设备已经把云端对象清掉了）。
			// 后果：删掉最后一份 ⇒ 数据真的没了，且不可逆、无声。
			name: "★★ 不再复核「云端现在确实还有它」（可能删掉最后一份）",
			from: "\t\tif (!stillInCloud) {",
			to: "\t\tif (false) {",
			expect: "云端确认不上时，本地副本必须留着",
		},
		{
			// 后果：F18 的存量清理"问也问了、清单也列了"，执行时却一个都不删 ——
			// 用户看到的是一句"已删除 0 个"，而磁盘一点没变（功能静默失效）。
			name: "★ 存量清理不再把候选交给删除循环（问了却什么都不删）",
			from: "\tawait deleteVerifiedCopies(deps, selection.candidates, result);",
			to: "\tawait deleteVerifiedCopies(deps, [], result);",
			expect: "切到「不留副本」后清掉了存量副本",
		},
		{
			// 后果：外链那一趟根本不跑 ⇒ 命令只搬库内文件，笔记里的外链图原样留着
			//（用户以为"都搬走了"，而图还在别人的服务器上 —— 而确认框刚刚承诺过会处理它们）。
			name: "★ 批量上传不处理外链候选（笔记里的外链图原样留着）",
			from: "\tif (options.external && options.external.candidates.length > 0 && deps.cacheExternal) {",
			to: "\tif (false) {",
			expect: "外链图被下载、上传，笔记里的链接被改写",
		},

		// ── ⭐ 收尾删"宿主撞名另落的重复副本"（D-24 ④，2026-10-14 用户要求）──
		{
			// 后果：这一步整个不跑 ⇒ 同一张图插第二次之后，本地永远留两份
			//（云端与链接都已经是一份，只有磁盘上多一份）。
			name: "★ 重复副本的收尾整个不跑（本地永远留着两份）",
			from: "\tawait dropRedundantCopies(deps, redundantCopies, stillMentioned, result);",
			to: "\tvoid redundantCopies; void stillMentioned;",
			expect: "宿主撞名另落的那一份被删掉",
		},
		{
			// 后果：这一趟里**有过改写失败**却照删 ⇒ 那些"没改掉、还指着它"的引用
			// 会指向一个刚被删掉的文件（用户视角就是"图丢了"）。
			name: "★★ 有引用没能改写也照删（把还被指着的那份删掉）",
			from: "\tif (result.failed > 0 || result.canvasSkipped > 0) {",
			to: "\tif (false) {",
			expect: "一份都不删",
		},
		{
			// 后果：正文里那条**认不出来**的引用（URL 编码）被无视 ⇒ 删掉之后
			// 笔记里留下一条指向不存在文件的链接。
			name: "★★ 删除前不看正文里还留着的那条引用（删掉还被指着的文件）",
			from: "\t\tif (stillMentioned.has(path)) {",
			to: "\t\tif (false) {",
			expect: "认不出来的引用", /* TEMP */
		},
		{
			// 后果：删法绕开删除原语、改走回收站 ⇒ 文件离开 vault 而**空间不释放**
			//（用户明确说过"不用放回收站"：同内容的副本进回收站只是把垃圾挪个地方）。
			// 后果：删法绕开删除原语、改走回收站 ⇒ 文件离开 vault 而**空间不释放**
			//（用户明确说过"不用放回收站"：同内容的副本进回收站只是把垃圾挪个地方）。
			// 症状：文件确实不见了（所以"被删掉"那次等待能过），但它**不是**走 `vault.delete`
			// 删的 —— 8d 那条"要被真的删掉"当场抓住，紧接着还有一条 `calls.trash` 断言守着同一件事。
			// ⚠️ `duplicate` 这个变量名是**故意**与淘汰循环里那个 `file` 区分开的 ——
			// 两处调用逐字相同会让锚点不唯一，而"锚点必须唯一"是本项目的硬纪律
			//（不唯一的锚点打坏的是别人那一行，报出来的红会指向错误的原因）。
			name: "★ 重复副本被送进回收站（空间不释放 ⇒ 与用户的要求相反）",
			from: "\t\t\tawait removeCacheFile(deps.app, duplicate);",
			to: "\t\t\tawait deps.app.fileManager.trashFile(duplicate);",
			expect: "重复副本要被真的删掉",
		},
		{
			// 后果：改写规则**不带显示名** ⇒ wikilink 整条换形态时显示位退回"原路径最后一段"
			// ⇒ 宿主撞名另落的重复副本会把序号留在链接文字里（`![dup 1.png](…/dup-<哈希>.png)`），
			// 而地址里是主干名字。用户 2026-10-14 报的第五件事：同一个链接两个名字。
			name: "★ 改写规则不带显示名（链接文字里留着宿主的「 1」）",
			from: "\t\trules.push({ from: path, to: ingestResult.remoteUrl, display: ingestResult.displayName });",
			to: "\t\trules.push({ from: path, to: ingestResult.remoteUrl });",
			expect: "★ 显示名必须用主干名字（宿主的「 1」不许出现在链接文字里）",
		},
		// ⚠️ 这里原本还有一条**完全重复**的锚点（"后台淘汰绕过删除原语"），锚的是同一行 ——
		// 重复锚点不会增加覆盖，只会让"全部被捕获"这句话贬值。两条路径（自动淘汰 /
		// 存量清理）现在共用同一段循环，所以上面那一条就够。纪律：**锚点必须唯一**。
	],
});
