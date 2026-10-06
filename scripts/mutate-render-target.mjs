import { runMutations } from "./lib/mutate.mjs";
import { runRenderTargetSuite } from "./lib/render-target-suite.mjs";

/**
 * 变异验证：渲染目标判定（`src/render/render-target.ts`）。
 *
 * 这一层判错的后果是**断网时图是破的**（该换本地却没换）或**把别人的图拉进 vault**
 * （认错了站外图越过 SCOPE 划的红线）。两种都不报错，所以每条规则都要能被单独打坏。
 */
await runMutations({
	source: "src/render/render-target.ts",
	entries: ["src/render/render-target", "src/cache/index", "src/s3/client"],
	suite: runRenderTargetSuite,
	mutations: [
		{
			// ⚠️ 这条变异一开始**漏过**了（当时的断言都抓不住它）—— 补断言时才发现
			// 那道 http 守卫的真正作用不在"data: 快路径"（那种输入本来就认不出来），
			// 而在**索引被污染**时：索引是不可信输入（`data.json` 可被手改），
			// 一条 `remoteUrl: "attachments/x.png"` 的记录会让笔记里**相对路径**的图
			// 被劫持成缓存副本。去掉守卫，那条断言就会红。
			name: "★ 不再过滤非 http(s) 地址（索引里一条脏记录即可劫持相对路径的图）",
			from: '\tif (!/^https?:\\/\\//i.test(src)) {\n\t\treturn { action: "ignore", reason: "不是 http(s) 图片（本地资源或 data:/blob:）" };\n\t}\n',
			to: "\t// 变异：不过滤非 http 地址\n",
			expect: "不该劫持相对路径",
		},
		{
			// 后果：只认公网前缀 ⇒ 没配 publicUrlBase 的用户，所有图都认不出来 ⇒
			// "换设备后离线可用"整条链断掉（而且看起来只是"图没变成本地"）。
			name: "★ 只认公网前缀（没配 publicUrlBase 的用户全部认不出自己的图）",
			from: "\t\tconst probe = requestTargetFor(address, PROBE_KEY);",
			to: "\t\tthrow new Error(\"变异：不算对象地址前缀\"); void requestTargetFor;",
			expect: "对象地址",
		},
		{
			// 后果：编码问题最难查 —— 链接打得开、图看得见，但**缓存永远不命中**，
			// 于是每次粘贴都重新上传、每次渲染都去联网。
			name: "★ key 被解码两次（非 ASCII 与 % 的 key 与索引对不上）",
			from: "\t\t\tconst key = segments.map((segment) => decodeURIComponent(segment)).join(\"/\");",
			to: "\t\t\tconst key = segments.map((segment) => decodeURIComponent(decodeURIComponent(segment))).join(\"/\");",
			expect: "往返失败",
		},
		{
			// 后果：笔记里一个畸形链接就让**整块渲染失败** —— 为一条认不出的链接
			// 付出这个代价毫无道理。
			name: "畸形百分号编码不再兜住（一个坏链接毁掉整块渲染）",
			from: "\t\t} catch {\n\t\t\t// 畸形百分号编码（`%zz`）→ 不是我们写出的链接\n\t\t\treturn null;\n\t\t}",
			to: "\t\t} catch (error) {\n\t\t\tthrow error;\n\t\t}",
			expect: "不该抛错",
		},
	],
});
