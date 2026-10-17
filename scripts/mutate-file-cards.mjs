import { runMutations } from "./lib/mutate.mjs";
import { runFileCardsSuite } from "./lib/file-cards-suite.mjs";

/**
 * 变异验证：确认框里的文件清单（`src/ui/file-cards.ts`）。
 *
 * 这一层的产物决定用户在**不可恢复**的按钮前看到什么。它坏掉不会报错 ——
 * 只会让清单回到"一串 sha256"，或者让对话框**去下载**那个正被问"要不要删掉"的对象。
 */
await runMutations({
	source: "src/ui/file-cards.ts",
	entries: ["src/ui/file-cards"],
	suite: runFileCardsSuite,
	mutations: [
		{
			// 后果：明明有本地副本却不用它 ⇒ 每一行都去**联网**取图。
			// 在"库里有几百张、网络又慢"的时候，这个对话框会卡着不出图，
			// 而它本来可以零网络（副本就在磁盘上）。
			name: "★ 跳过本地副本（缩略图一律联网取）",
			from: "\t\t\tconst localUrl = local ? deps.resourceUrl(local) : null;",
			to: "\t\t\tconst localUrl = null;",
			expect: "本地副本优先",
		},
		{
			// 后果：名字被丢掉，一律显示 id ⇒ 回到"用户认不出这是哪张图"的原始问题，
			// 而这是不可恢复的动作：清单是他唯一的核对依据。
			name: "★ 丢掉原始文件名（清单变回一串 key）",
			from: "\t\tconst label = name || id;",
			to: "\t\tconst label = id;",
			expect: "原始文件名",
		},
		{
			// 后果：PDF / 压缩包也去当图片显示 ⇒ 用户看到的是一堆破图图标，
			// 而"破图"会被读成"这些文件坏了"，不是"这个格式没有缩略图"。
			name: "★ 非图片也给缩略图（用户看到一堆破图）",
			from: '\t\tif (embedKindFor(ext) === "image") {',
			to: "\t\tif (true) {",
			expect: "不给缩略图",
		},
		{
			// 后果：拿不到地址时给一个空串/半截地址 ⇒ 界面拿它去加载，得到一次必然失败的请求，
			// 且失败的表现与"这张图真的加载不出来"分不开（事后没法判断是数据问题还是网络问题）。
			name: "★ 拿不到地址也给一个（空地址也是一次注定失败的请求）",
			from: "\t\t\t\tthumbUrls = remote ? [remote] : [];",
			to: '\t\t\t\tthumbUrls = remote ? [remote] : [""];',
			expect: "不给空串",
		},
		{
			// 后果：图片加载失败时什么都不做 ⇒ 界面上留一个破图图标。
			// 而它最常见的成因（桶私有 / 匿名读没开）**不是故障** —— 显示得像故障就会把人引去查错的东西。
			name: "★ 图加载失败时不降级（界面留一个破图）",
			from:
				"\t\t\timage.remove();\n" +
				'\t\t\tthumb.addClass("acc-file-badge");\n' +
				"\t\t\tthumb.setText(card.badge);\n",
			to: "\t\t\tvoid image;\n",
			expect: "降级成标记",
		},
		{
			// 后果：**候选链只试第一条** —— 库外文件那条路给的是"宿主前缀 + 原文"两条
			//（`file:///…` 在宿主里画不出来），只试第一条就等于把"宿主认哪一种"
			// **又替运行时做了决定**：用户看到的还是"列表里有文件、预览看不到"。
			// ⚠️ 这条链上"替宿主提前断言"已经错两次（D-42 的 `module.require`、
			// D-44 的反向提前掐掉），所以这一条必须有人守。
			name: "★★ 候选链只试第一条（库外文件仍然是「预览看不到」）",
			from: "\t\t\tif (next) {\n",
			to: "\t\t\tif (false) {\n",
			expect: "接着试第二条",
		},
		{
			// 后果：站外图 / 本机文件那些行**永远没有缩略图** —— 它们的图既不在库内、
			// 也不是本存储的对象，上面那两条推导（本地副本 / 远端 key）一个都推不出来，
			// 只能靠调用方把地址递进来（`thumb`）。忽略了它就只剩一个类型标记。
			name: "★ 忽略调用方直接给的地址（站外 / 本机文件的行永远没有图）",
			from: "\t\t\tif (explicit.length > 0) {",
			to: "\t\t\tif (false) {",
			expect: "调用方给的地址优先",
		},
		{
			// 后果：图**永远不出现**，而且**没有任何报错**（2026-10-15 真机踩过一次：
			// 用户报「.png 缩略图不显示图片」，而这一行正是相对既有可用实现唯一的变化）。
			// 宿主的弹窗容器带 transform/opacity 开合动画 ⇒ 原生懒加载在那种容器里
			// 可能根本不触发；更糟的是不触发时**连 `onerror` 都没有** ⇒
			// "降级成类型标记"那条兜底也走不到，界面上就是一块空白。
			name: "★★ 缩略图加回原生懒加载（图可能永远不出现，且连错误都不报）",
			from: '\t\t\tattr: { src: first, alt: "" },',
			to: '\t\t\tattr: { src: first, alt: "", loading: "lazy" },',
			expect: "不许带 loading",
		},
		{
			// 后果：**本机文件（`file:///D:/…`）那一行不再显示那条绝对路径** ⇒ 用户勾中它就是
			// 签了"读这条路径"，而屏幕上只剩一个空副标题 —— 等于让他在**看不见风险**的情况下
			// 点确认（本机路径正是这条披露里唯一承重的内容）。
			// ⚠️ 这一行**不含库内路径**（"出自哪篇笔记"由运行结果说，列出来会被读成
			// 「清单里进了一个 `.md` 文件」—— 用户 2026-10-16 三次报的同一件事）；
			// 那条规则是**结构性**的（入参里不收 `notePath`）⇒ 不需要锚点守着，这里只守披露那半。
			name: "★ 副标题丢掉本机文件的绝对路径（让人盲签读本机文件）",
			from: "\treturn host || url;\n",
			to: "\treturn host;\n",
			expect: "本机文件（host 为空）要显示那条路径",
		},
	],
});
