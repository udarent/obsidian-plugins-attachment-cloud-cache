import { runMutations } from "./lib/mutate.mjs";
import { runExternalNoticeSuite } from "./lib/external-notice-suite.mjs";

/**
 * 变异验证：站外缓存询问通知（`src/ui/external-notice.ts`）。
 *
 * 这一层坏掉的方式都很"轻"：通知一闪而过、少一颗按钮、点完不关、连点两下结果变了。
 * 每一条单独看都不致命，合起来就是"用户没法可靠地回答这个问题"。
 */
await runMutations({
	source: "src/ui/external-notice.ts",
	entries: ["src/ui/external-notice"],
	suite: runExternalNoticeSuite,
	mutations: [
		{
			// 后果：通知按默认时长自动消失。用户还没读完那段文字它就不见了 ——
			// 而这是**只问一次**的机会，错过就再也问不到（只能去设置里清记忆）。
			name: "★ 通知不再常驻（用户还没看完就消失了）",
			from: "\tconst notice = factory(options.message, 0);",
			to: "\tconst notice = factory(options.message, 4000);",
			expect: "常驻",
		},
		{
			// 后果：点完不关 ⇒ 屏幕上留着一个已经没有意义的空壳（而它是常驻的）。
			name: "★ 选完不关闭通知（留着一个空的常驻通知）",
			from: "\t\t\tsettled = true;\n\t\t\tnotice.hide();\n\t\t\tresolve(choice);",
			to: "\t\t\tsettled = true;\n\t\t\tresolve(choice);",
			expect: "必须关闭通知",
		},
		{
			// 后果：只剩「缓存」一颗按钮 ⇒ 用户无法说"别问了"，
			// 于是每次打开这篇笔记都会被问（而他只能选择同意或关掉通知）。
			name: "★ 只给一颗按钮（用户没法说「别问了」）",
			from: '\t\tnotice.containerEl.createEl("button", { text: options.neverLabel }).addEventListener("click", () => finish("never"));\n',
			to: "\t\t// 变异：不给第二个选择\n",
			expect: "两个选择",
		},
		{
			// 后果：每次点击都会走完一遍收尾（关闭通知等）。
			//
			// ⚠️ 归因如实写在这里：**答案本身不会变**（Promise 的额外 resolve 天然被忽略），
			// 所以真正被这条守卫挡住的是"重复的收尾动作"。变异验证里先红的就是这一条
			// （`hidden` 被加了两次）—— 而不是"答案被改掉"。
			name: "★ 重复点击不再设防（每点一下都重复做一次收尾）",
			from: "\t\t\tif (settled) return;\n",
			to: "\t\t\t// 变异：不设防\n",
			expect: "关闭动作只该发生一次",
		},
	],
});
