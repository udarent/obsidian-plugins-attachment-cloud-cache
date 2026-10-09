import { runMutations } from "./lib/mutate.mjs";
import { runEmbedRebuildSuite } from "./lib/embed-rebuild-suite.mjs";

/**
 * 变异验证：非图片可预览附件的**节点重建**（`src/render/embed-rebuild.ts`）。
 *
 * 这一层坏掉的症状都是"用户看到一张坏图"，而代码里没有报错 —— 所以每条变异
 * 都得对上一条会红的断言：
 *
 * - **不按类型表判断** ⇒ 图片也走重建（多绕一圈，用户看不出差别）；
 * - **把远端地址写进元素** ⇒ 离线时请求已经发出去了，而图还是不出来；
 * - **不防递归** ⇒ 我们渲染出来的节点又被当成"待重建"，无限替换；
 * - **渲染失败也替换** ⇒ 用户在笔记里看到一个**空位**（内容看起来消失了）。
 */
await runMutations({
	source: "src/render/embed-rebuild.ts",
	entries: ["src/render/embed-rebuild", "src/render/render-target", "src/vault-files", "src/s3/client"],
	suite: runEmbedRebuildSuite,
	mutations: [
		{
			// 后果：连图片也走"重建节点"，而 `<img>` 本来是对的 ——
			// 多绕一圈的实现照样能显示，所以只有断言能发现它（图片不该被标记）。
			name: "★ 图片也被重建（多绕一圈，且把最简单的那条路弄坏了）",
			from: '\treturn kind && kind !== "image" ? kind : null;',
			to: "\treturn kind ?? null;",
			expect: "图片**不**重建",
		},
		{
			// 后果：把**远端**地址写进元素 ⇒ 离线时浏览器照样去连远端（请求发得出去），
			// 而图上什么都没有。这是"离线零请求"这条主承诺的直接破坏。
			name: "★ 接管时把远端地址写进元素（离线零请求被破坏）",
			from: '\t\t\tif (resourceUrl) element.setAttribute("src", resourceUrl);',
			to: '\t\t\tif (resourceUrl) element.setAttribute("src", decision.remoteUrl);',
			expect: "绝不能把远端地址写进元素",
		},
		{
			// 后果：我们渲染出来的嵌入节点带着标记，若不再跳过它，
			// 下一轮扫描又会把它当"待重建" ⇒ 无限替换（页面持续抖动、CPU 打满）。
			name: "★ 不防递归（自己渲染出来的节点被反复重建）",
			from: '\t\tif (element.getAttribute(EMBED_MARK)) continue;',
			to: "\t\t// 变异：不防递归",
			expect: "被接管",
		},
		{
			// 后果：渲染不出节点时仍然替换 ⇒ 原元素被换成一个 `undefined`/空位，
			// 用户在笔记里看到"内容消失"（比"显示得差一点"糟得多）。
			name: "★ 渲染失败也替换（笔记里出现一个空位）",
			from: "\tif (!node) return; // 渲染不出来就保留原元素（宁可显示得差一点，也不要空一格）",
			to: "\tif (!node) node = element;",
			expect: "渲染不出来时不得替换成空",
		},
	],
});
