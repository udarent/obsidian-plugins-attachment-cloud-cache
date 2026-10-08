import { withLoadedTs } from "./lib/load-ts.mjs";
import { runExternalPickerSuite } from "./lib/external-picker-suite.mjs";

/**
 * 「选择要缓存的外链图片」纯逻辑的测试。
 *
 * 只把那个纯模块进 bundle：它的类型依赖来自 `maintenance/batch`，那是**类型导入**，
 * 打包时会被抹掉，不需要额外入口。
 */
await withLoadedTs(["src/ui/external-picker-logic"], (mod) => {
	runExternalPickerSuite(mod);
	console.log(
		"External-picker tests passed (the selection unit is note + url so the same image in two notes stays two " +
			"entries, rows missing an address or a note are dropped, duplicate rows collapse, toggling returns a new set " +
			"instead of mutating the caller's, odd keys change nothing, and select-all covers exactly the rows on screen)."
	);
});
