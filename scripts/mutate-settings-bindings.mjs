import { runMutations } from "./lib/mutate.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 变异验证：声明式设置项 ↔ 设置对象的绑定（`src/ui/settings-bindings.ts`）。
 *
 * 这一层的失效是**最难查的一类**：界面照常显示、点了也存了，
 * 只是重开之后设置被重置成默认值 —— 用户看到的现象是"改了没用"，
 * 而代码里没有任何报错。所以每条绑定规则都必须有断言守住。
 */
await runMutations({
	source: "src/ui/settings-bindings.ts",
	entries: ["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"],
	suite: runSettingsUiSuite,
	mutations: [
		{
			name: "空段不再算非法键（a..b 会被当成合法路径，写到错误的位置）",
			from: '\tif (parts.some((p) => p === "")) return null;',
			to: "\t// 变异：不检查空段",
			expect: "空键非法",
		},
		{
			name: "写不进时谎报成功（调用方以为存下了，实际什么都没发生）",
			from: '\t}\n\tif (typeof node !== "object" || node === null) return false;\n\n\t(node as Record<string, unknown>)[parts[parts.length - 1]] = value;',
			to: '\t}\n\tif (typeof node !== "object" || node === null) return true;\n\n\t(node as Record<string, unknown>)[parts[parts.length - 1]] = value;',
			expect: "不创建",
		},
		{
			name: "设置值不再转成控件值（数组直接塞进文本框）",
			from: '\tconst convert = typeof key === "string" ? PRESENT[key] : undefined;\n\treturn convert ? convert(stored) : stored;',
			to: "\tvoid key;\n\treturn stored;",
			expect: "数组字段要转成文本",
		},
		{
			name: "★ 控件值不再转回设置值（用户改完重启就被静默重置）",
			from: '\tconst convert = typeof key === "string" ? COERCE[key] : undefined;\n\treturn convert ? convert(raw) : raw;',
			to: "\tvoid key;\n\treturn raw;",
			expect: "文本框的字符串必须转回数组",
		},
		{
			name: "空值不再被拦（清空缓存目录会让缓存静默失效，且要等重启才发现）",
			from: '\t\t\treturn value.trim() !== "";',
			to: "\t\t\treturn true;",
			expect: "空缓存目录不可写",
		},
	],
});
