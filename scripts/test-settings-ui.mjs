import { withLoadedTs } from "./lib/load-ts.mjs";
import { runSettingsUiSuite } from "./lib/settings-ui-suite.mjs";

/**
 * 设置界面支撑模块的测试。
 *
 * 三个模块一起打进**同一个** bundle：`settings-bindings` 会调用
 * `settings-logic` 的扩展名转换函数，分两次 build 会让两边的实现不是同一份。
 *
 * 这些模块都**不碰 DOM**，所以能穷举 —— 这是刻意的：设置界面里最难查的问题
 * 恰恰是"改了没生效"（绑定错）与"选项没作用"（假选项）这两类静默失效。
 *
 * 断言在 `lib/settings-ui-suite.mjs`（与变异验证共用）。
 */
await withLoadedTs(["src/ui/settings-logic", "src/ui/settings-bindings", "src/s3/credentials"], async (mod) => {
	runSettingsUiSuite(mod);
	console.log(
		"Settings-UI tests passed (extension lists parse from commas/spaces/ideographic commas/newlines " +
			"and round-trip, conditional visibility hides the cache folder unless the copy is cached, " +
			"dropdown options are generated from the type list so no fake option can appear, " +
			"bindings read/write dotted keys without inventing intermediate objects, " +
			"empty values are refused only where empty would silently break a feature, " +
			"and credentials distinguish 'never chosen' from 'the chosen secret no longer exists')."
	);
});
