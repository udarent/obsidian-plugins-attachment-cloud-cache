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
			// 后果：公开 + 不留副本的视频**不换节点** ⇒ 用户只看到那张播不了的 `<img>`，
			// 而这一档本来能播（公开桶取得到字节，只是宿主不肯把它当 `<video>`）。
			name: "★ 公开 + 不留副本的视频不换节点（只留一张播不了的 <img>）",
			from: '\t\t\t\tdeps.onNonImageEmbed?.(img, { kind: "direct", key: decision.key, remoteUrl: decision.remoteUrl });\n',
			to: "\t\t\t\t// 变异：不换节点\n",
			expect: "视频要走「直连换节点」",
		},
		{
			// 后果：私有存储 + 不留副本时**不换地址** ⇒ 元素上留着那条必 403 的远端地址，
			// 而用户以为"图床式"已经生效（他看到的是一屏坏图，却没有任何报错）。
			name: "★ 私有 + 不留副本时不换预签名地址（一屏坏图，且不报错）",
			from: "\t\t\tdeferSignedUrl(img, deps, decision, { result });\n",
			to: "\t\t\t// 变异：不换预签名地址\n",
			expect: "要按 key 去签一次",
		},
		{
			// 后果：把 `src` 写成一个空/坏地址 —— 连**在线**都看不到图了，
			// 比"不改"明显更糟。
			name: "★ 拿不到本地可用地址时照样改写（把图写成坏地址）",
			from: "\t\t\t\tdeferLocalCopy(img, deps, decision, { result });\n\t\t\t\tcontinue;\n",
			to: "\t\t\t\t// 变异：不补齐、也不跳出（于是往下写一个空/坏地址）\n",
			expect: "不该计入改写",
		},
		{
			// 后果（2026-10-12 **真机探针 ② 实测抓到过**）：索引记着副本、而那份文件已被删时，
			// 渲染**什么都不做** —— 图按远端显示（在线可见），但「离线可用」静默失效、
			// 副本再也回不来，而且不会有任何报错。
			// ⚠️ 这一条是补丁的守门人：把 `deferLocalCopy` 拿掉（退回旧的 `continue`）必须变红。
			name: "★★ 副本不在时不再去补齐（离线可用静默失效，副本永远回不来）",
			from: "\t\t\t\tdeferLocalCopy(img, deps, decision, { result });\n",
			to: "\t\t\t\t// 变异：不补齐\n",
			expect: "必须去把副本找回来",
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
		{
			// 后果：实时预览里**再也没有站外候选** ⇒ 编辑态里「缓存外站图片」完全没有反应
			//（既不询问也不缓存）。这正是这次修掉的那个用户可见缺陷 —— 别让它回来。
			name: "★ 不再上报站外候选（编辑态里站外缓存彻底哑火）",
			from:
				"\t\t\t\t\t} else if (deps.onExternalSrc && isHttpUrl(value)) {\n" +
				"\t\t\t\t\t\t// 站外图（阅读视图那条路已在后处理器里处理；这里是**实时预览**的唯一入口）。\n" +
				"\t\t\t\t\t\t// 同上：这一层不负责措辞与判定，只把候选交出去。\n" +
				"\t\t\t\t\t\tdeps.onExternalSrc(element, String(value).trim());\n" +
				"\t\t\t\t\t}\n",
			to: "\t\t\t\t\t}\n",
			expect: "实时预览里的站外图必须原样交出去",
		},
		{
			// 后果：`app://` / `data:` / 相对路径都被当成站外候选上报，
			// 全 app 的每一次图片赋值都变成一次跨模块调用。
			name: "站外候选不再做 http(s) 前置筛（本地资源也被上报）",
			from: "deps.onExternalSrc && isHttpUrl(value)",
			to: "deps.onExternalSrc",
			expect: "不该被当成站外候选",
		},
		{
			// 后果：上报环节一抛错就**连带把地址赋值也毁了** —— 整篇笔记渲染不出来。
			// 这条路径跑在全 app 的图片赋值上，容错必须留在这里。
			name: "★ 上报抛错时不再兜住（整篇笔记渲染不出来）",
			from:
				"\t\t\t\t} catch (error) {\n" +
				"\t\t\t\t\t// 任何意外都不能让图片赋值失败 —— 那会让整篇笔记渲染不出来\n" +
				"\t\t\t\t\tlog(error);\n" +
				"\t\t\t\t\tnext = value;\n" +
				"\t\t\t\t}\n",
			to: "\t\t\t\t} catch (error) {\n\t\t\t\t\tthrow error;\n\t\t\t\t}\n",
			expect: "站外交接出问题也必须让地址照常写进去",
		},
	],
});
