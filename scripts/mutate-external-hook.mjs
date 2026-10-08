import { runMutations } from "./lib/mutate.mjs";
import { runExternalHookSuite } from "./lib/external-hook-suite.mjs";

/**
 * 变异验证：站外缓存编排（`src/render/external-hook.ts`）。
 *
 * 这一层跑在**每次重新渲染**上（滚动、切视图、编辑都会触发），所以它坏掉的
 * 三类症状都不报错：
 *
 * | 坏法 | 症状 |
 * |---|---|
 * | 不去重 | 同一张图被反复下载上传（渲染会反复跑） |
 * | 失败不摘除 | 那个 URL 被永久卡住，用户重试也没反应 |
 * | 默认行为判反 | 设置里写着"什么都不做"，插件却在后台搬图并改写笔记 |
 *
 * ⚠️ 早先这里还有一整套「按站点询问」（`ask` / `remember` / 站点记忆）——
 * 已整条拆掉，所以那几条锚点也随之删除（留着只会是"变异点未找到"）。
 */
await runMutations({
	source: "src/render/external-hook.ts",
	entries: ["src/render/external-hook"],
	suite: runExternalHookSuite,
	mutations: [
		{
			// 后果：同一张图在**每次重新渲染**时再入队一次 ⇒ 反复下载上传同一个地址。
			// 渲染会因滚动、切视图而反复发生，所以这条一坏就是"一直在下载"。
			name: "★ 不再按 URL 去重（同一张图被反复下载）",
			from: "\t\tif (inflight.has(url)) return false;\n",
			to: "\t\t// 变异：不去重\n",
			expect: "只该发起一次",
		},
		{
			// 后果：失败后那个 URL **永久**留在表里 ⇒ 用户重试也被静默忽略。
			// （实测过另一种写法：`.then` 而不是 `.finally` —— 失败路径就不摘除了。）
			name: "★ 失败后不摘除 inflight（那个 URL 被永久卡住）",
			from: "\t\t\t.finally(() => inflight.delete(url));\n",
			to: "\t\t\t;\n",
			expect: "失败后必须能重试",
		},
		{
			// 后果：拿不到笔记路径也照样入队 ⇒ 图进了存储、笔记没变（改不了），
			// 彻底的半成品，而且不会有任何提示。
			name: "★ 没有笔记路径也不早退（缓存了却改不了笔记）",
			from: '\t\t\tconst notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";\n\t\t\tif (!notePath) {\n\t\t\t\tresult.skipped = list.length;\n\t\t\t\treturn result;\n\t\t\t}\n',
			to: '\t\t\tconst notePath = typeof ctx?.sourcePath === "string" ? ctx.sourcePath.trim() : "";\n',
			expect: "不该缓存",
		},
		{
			// 后果：**默认行为判反** —— 用户选了「什么都不做」，渲染路径却照搬不误。
			// 这条把 `wait` 与 `ignore` 一起放行，于是"默认不动手"这一档完全失效。
			name: "★ 默认行为判反（选了「什么都不做」却照搬不误）",
			from: '\t\t\t\t\tif (decision.action !== "cache") {\n',
			to: '\t\t\t\t\tif (false) {\n',
			expect: "非 http(s) 的图不该被处理",
		},
		{
			// 后果：单张图出问题（元素实现有毛病）时异常冒出去 ⇒ 整次渲染中断，
			// 后面那些图全都不处理。
			name: "★ 单张图抛错就中断整批（后面的图全都不处理）",
			from: "\t\t\t\t} catch (error) {\n\t\t\t\t\t// 单张图出问题不能拖垮整次渲染（还有别的图要处理）\n\t\t\t\t\treport(error);\n\t\t\t\t\tresult.skipped += 1;\n\t\t\t\t}\n",
			to: "\t\t\t\t} catch (error) {\n\t\t\t\t\tthrow error;\n\t\t\t\t}\n",
			expect: "这个元素的实现有问题",
		},
	],
});
