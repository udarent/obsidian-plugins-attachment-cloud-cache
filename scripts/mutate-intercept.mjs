import { runMutations } from "./lib/mutate.mjs";
import { runInterceptSuite } from "./lib/intercept-suite.mjs";

/**
 * 变异验证：编辑器事件的判定核心（`src/host/intercept.ts`）。
 *
 * 这一层失效的后果是**用户的图消失且不报错** ——
 * 判定说"接管"，我们就 `preventDefault()`，宿主的原生保存被掐断，
 * 之后的字节全归我们负责。所以每条规则都要能被单独打坏、且被单独抓住。
 */
await runMutations({
	source: "src/host/intercept.ts",
	entries: ["src/host/intercept"],
	suite: runInterceptSuite,
	mutations: [
		{
			// 后果：别的插件已经处理过的事件，我们再插一段链接 —— 笔记里出现两份内容，
			// 而用户只粘了一次。
			name: "★ 不再检查 defaultPrevented（两个插件各插一份链接）",
			from: "\tif (input.alreadyHandled) {\n\t\treturn { action: \"ignore\", reason: \"事件已被其它处理方接管\" };\n\t}\n",
			to: "\t// 变异：不检查 defaultPrevented\n",
			expect: "别人已处理",
		},
		{
			// 后果：接管了但配置不全 → 上传失败 → 图既没上传、也**没被宿主保存**。
			// 正确行为是"放行 + 提示"，让图照常落进附件目录。
			name: "★ 未配置仍然接管（图既没上传也没留下）",
			from: "\tif (!input.readiness.ready) {\n",
			to: "\tif (false) {\n",
			expect: "应给出提示",
		},
		{
			// 后果：宿主的编辑器实现差异（或替身没有 getCursor）会让整次粘贴抛错，
			// 用户看到"粘贴之后什么都没发生"。
			name: "取插入位置时不再降级（宿主实现差异会让整次粘贴失败）",
			from: "\t} catch {\n\t\t// 宿主的编辑器实现差异不该让粘贴失败：退回\"插到当前选区\"即可。\n\t\treturn undefined;\n\t}",
			to: "\t} catch (error) {\n\t\tthrow error;\n\t}",
			expect: "getCursor 抛错时应降级",
		},
		{
			// 后果：拿不到选区末端时仍然塞一个 `to`，插入范围可能是错的
			// （编辑器的 replaceRange 拿到 undefined 的 to 与"没有 to"语义不同）。
			name: "选区末端取不到时仍然编一个（插入范围可能不对）",
			from: "\t\treturn to === null || to === undefined ? { from } : { from, to };",
			to: "\t\treturn { from, to };",
			expect: "只拿得到 from",
		},
	],
});
