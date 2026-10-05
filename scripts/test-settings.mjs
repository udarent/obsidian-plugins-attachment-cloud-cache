import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSettingsSuite } from "./lib/settings-suite.mjs";

/**
 * 设置模块的测试。
 *
 * 断言在 `lib/settings-suite.mjs`（被变异验证共用，避免两套断言漂移）。
 * 这里只负责"从源码加载"这一件事。
 *
 * 为什么这个模块要第一个测：`{ ...defaults, <逐个枚举的字段> }` 这种合并写法会
 * **静默丢字段** —— 用户改了、存进了 data.json，重启后被重置回默认值。
 * 类型系统抓不到（`...defaults` 补全了所有键，编译通过），也没有任何报错。
 */
await withLoadedTs("src/settings.ts", (mod) => {
	const { scalars } = runSettingsSuite(mod);
	console.log(
		"Settings tests passed (defaults reflect positioning, credentials stay out, " +
			`${scalars} scalar fields round-trip by dynamic derivation, bad input degrades safely).`
	);
});
