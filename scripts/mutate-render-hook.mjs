import { runMutations } from "./lib/mutate.mjs";
import { runRenderHookSuite } from "./lib/render-hook-suite.mjs";

/**
 * 变异验证：渲染钩子（`src/render/render-hook.ts`）。
 *
 * 这一层是"离线可用"真正落地的地方。它失效的表现极其安静：
 * 图还是显示着（走远端），只是**断网时变成破图** —— 而用户会以为
 * "这插件不支持离线"，不会去报 bug。
 */
await runMutations({
	source: "src/render/render-hook.ts",
	entries: ["src/render/render-hook", "src/render/render-target", "src/cache/index", "src/s3/client"],
	suite: runRenderHookSuite,
	mutations: [
		{
			// 后果：把 `src` 写成一个空/坏地址 —— 连**在线**都看不到图了，
			// 比"不改"明显更糟。
			name: "★ 拿不到本地可用地址时照样改写（把图写成坏地址）",
			from: "\t\t\tif (!resourceUrl) continue; // 拿不到可用地址 → 保持原样，别改成坏链接\n",
			to: "\t\t\t// 变异：拿不到地址也继续\n",
			expect: "不该计入改写",
		},
		{
			// 后果：编辑器重渲染时对**同一个元素**再赋一次同样的远端地址
			//（这在实时预览里很常见）⇒ 兜底监听器堆积 ⇒ 一次加载失败触发多次自愈。
			//
			// ⚠️ 最初这条变异打的是 processImages 里的同名守卫，结果**漏过**了 ——
			// 因为那条守卫是死代码（src 已被改写，第二次进来判定直接 ignore）。
			// 删掉死代码后，改打实时预览路径上这个**真的会重复**的守卫。
			name: "★ 实时预览不再去重兜底监听器（重渲染使监听器堆积，一次失败触发多次自愈）",
			from: "\tif (pendingRemote.get(img)?.wired) return;\n",
			to: "\t// 变异：不去重\n",
			expect: "只该挂一个兜底",
		},
		{
			// 后果：本地副本失效 → 退回远端 → 又失败 → 再兜底 …… 无限循环。
			name: "★ 兜底不再摘除记录（本地失效时来回改写，无限互相触发）",
			from: "\t\tfallbacks.delete(img);\n",
			to: "\t\t// 变异：不摘除\n",
			expect: "兜底只做一次",
		},
		{
			// 后果：插件卸载后仍在改全局 prototype —— 症状出现在**别的插件**身上，
			// 而且几乎不可能被归因到我们这里。
			name: "★ 卸载时不还原原 setter（卸载后仍在改全局 prototype）",
			from: "\t\t\tObject.defineProperty(prototype, \"src\", descriptor);",
			to: "\t\t\tvoid descriptor; // 变异：不还原",
			expect: "卸载后不该再改",
		},
		{
			// 后果：阅读视图看的图**永远不会**被记成"常用" ⇒ 缓存轮换只能按上传时间排，
			// 于是"一年前上传但天天在看"的图可能比"昨天上传后再没打开过"的先被淘汰。
			name: "★ 阅读视图不再记录「刚被看到」（轮换退化成按上传时间排）",
			from: '\t\t\t// 记下"这张图刚被看到" —— 缓存轮换靠它区分"常看"与"早就没人看"\n\t\t\tdeps.onLocalCopyUsed?.(decision.key);\n',
			to: "\t\t\t// 变异：不记录使用\n",
			expect: "刚被看到",
		},
		{
			// 后果：同上，但影响的是**编辑态**（实时预览）—— 而编辑态恰恰是看图最频繁的场景。
			name: "★ 实时预览不再记录「刚被看到」（编辑态看的图永远不会被认为常用）",
			from: "\t\t\t\t\t\t\t// 同上：这一份副本刚被用到（实时预览这条路径也一样要记）\n\t\t\t\t\t\t\tdeps.onLocalCopyUsed?.(decision.key);\n",
			to: "\t\t\t\t\t\t\t// 变异：不记录使用\n",
			expect: "刚被看到",
		},
	],
});
