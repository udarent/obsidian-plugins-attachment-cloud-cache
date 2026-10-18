import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withLoadedTs } from "./lib/load-ts.mjs";
import { runInterceptSuite } from "./lib/intercept-suite.mjs";

/**
 * 接线判定层的测试。
 *
 * 判定错了就是"preventDefault 之后不管了" —— 图会消失且不报错。
 * 真事件路径由 `test-load-acceptance.mjs` 覆盖，这里穷举判定本身。
 */
await withLoadedTs("src/host/intercept.ts", (mod) => {
	runInterceptSuite(mod);
	console.log(
		"Intercept decisions passed (default-handled → ignore; unconfigured → warn and let Obsidian save; " +
			"order pinned so a text-only paste never nags about config; insert point captured sync with graceful fallback; " +
			"the unconfigured reminder is announced once per session)."
	);
});

/**
 * ⭐ 接线静态守卫（`src/host/editor-bridge.ts`）。
 *
 * 为什么是**静态**守卫：这条链需要真实剪贴板事件 + 真实 S3，套件里没有它的驱动器
 * （与 `test-settings-ui` 守按钮回调用的是同一种办法）。它们守不住"参数传对没"，
 * 只守"这两处接线还在" —— 而漏掉的后果都是用户可见的：
 *
 * - 漏 `beginUpload`：大文件/慢网时**上传期间界面零反馈**（用户会再粘一次）；
 * - 漏 `finally(endUpload)`：状态栏一直停在"正在上传"，用户没有任何办法清掉；
 * - 漏 `claimUnconfiguredNotice`：没配存储的人**每次粘贴**都被念一遍。
 */
{
	const bridge = readFileSync(new URL("../src/host/editor-bridge.ts", import.meta.url), "utf8");
	assert.match(bridge, /host\.beginUpload\?\.\(/, "上传开始必须给状态栏一个信号");
	assert.match(
		bridge,
		/\.finally\(\(\) => host\.endUpload\?\.\(\)\)/,
		"上传结束必须在 finally 里收起指示（失败也要收，否则一直转）"
	);
	assert.match(
		bridge,
		/host\.claimUnconfiguredNotice\?\.\(\) \?\? true/,
		"未配置的提醒必须走每会话一次的闸门"
	);
}
