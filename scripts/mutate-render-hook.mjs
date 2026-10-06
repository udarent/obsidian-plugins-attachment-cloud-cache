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
	],
});
