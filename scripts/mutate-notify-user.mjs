import { runMutations } from "./lib/mutate.mjs";
import { runNotifyUserSuite } from "./lib/notify-user-suite.mjs";

/**
 * 变异验证：「用户可见提示」的统一出口（`src/notify-user.ts`）。
 *
 * 这一层的三个模块（ingest / download / external-cache）的**所有**用户提示都走它，
 * 所以这里的每一条变异，影响面都是"三处提示一起坏"。
 *
 * ⚠️ 最危险的方向不是"说的文字不对"，而是**"该说话时被吞掉"** ——
 * 那些提示出现的时刻都是"文件已经安全落盘、只是后续某步没走完"，
 * 用户看到的是"成功"，而实际状态与他的理解不一致，且事后无从解释。
 */
await runMutations({
	source: "src/notify-user.ts",
	entries: ["src/notify-user"],
	suite: runNotifyUserSuite,
	mutations: [
		{
			// 后果：没有出口时仍然去调它 ⇒ **抛 TypeError**。而这个助手跑在渲染路径
			// 与删除路径上，一次未捕获的异常会毁掉整篇笔记的渲染（渲染层反复强调过这条）。
			name: "★★ 没有出口时照样去调（把渲染/删除路径炸掉）",
			from: "\tif (!deps.notify) return;",
			to: "\tif (false) return;",
			expect: "必须安静返回",
		},
		{
			// 后果：绕过接线层的文案解析，直接把**键名**说给用户 ⇒ 界面上出现
			// `ingestCopyMoveFailed` 这样的字符串，用户看不懂自己遇到了什么。
			name: "★ 跳过文案解析（用户看到一串键名）",
			from: "\tdeps.notify(deps.t ? deps.t(key, params) : key);",
			to: "\tdeps.notify(key);",
			expect: "解析后",
		},
		{
			// 后果：说了两遍 ⇒ 本来只是"告知一次"的降级提示变成刷屏
			//（批量上传时一张图两条，用户会以为出了两个问题）。
			name: "★ 同一句说两遍（降级提示变成刷屏）",
			from: "\tif (!deps.notify) return;\n\tdeps.notify(deps.t ? deps.t(key, params) : key);",
			to: "\tif (!deps.notify) return;\n\tdeps.notify(deps.t ? deps.t(key, params) : key);\n\tdeps.notify(deps.t ? deps.t(key, params) : key);",
			expect: "只说一句",
		},
		{
			// 后果：把参数丢掉 ⇒ 提示里没有"哪个文件、什么错"，用户拿到一句
			// 无法行动的话（这类提示的全部价值就是那个原因）。
			name: "★ 参数被丢掉（提示里没有原因）",
			from: "\tdeps.notify(deps.t ? deps.t(key, params) : key);",
			to: "\tdeps.notify(deps.t ? deps.t(key) : key);",
			expect: "参数要原样转交",
		},
	],
});
