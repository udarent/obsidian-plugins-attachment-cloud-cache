import { withLoadedTs } from "./lib/load-ts.mjs";
import { runI18nSuite } from "./lib/i18n-suite.mjs";

/**
 * 文案（i18n）的测试。
 *
 * 双语插件最容易静默漏掉的三类问题：加了 key 只写英文忘了中文、两表键名不一致、
 * 文案要 `{count}` 而调用处传了别的名字。这三类都**不会报错**，只在真实使用中
 * 才被发现，所以必须单独测。
 *
 * 另外两类同样静默、但更隐蔽的：语言识别把 `zh-CN` 漏掉（中文系统上界面变英文，
 * 用户只会以为插件不支持中文）、以及非标量参数被 `String()` 成 `[object Object]`
 * 塞进用户可见的提示里。
 *
 * 断言在 `lib/i18n-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs("src/i18n.ts", (mod) => {
	const stats = runI18nSuite(mod);
	console.log(
		`i18n tests passed (${stats.keys} keys, en/zh parity, placeholder symmetry, ` +
			"zh-CN/zh-TW recognition, non-scalar params keep the placeholder instead of rendering [object Object])."
	);
});
