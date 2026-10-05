/**
 * 让 Node 测试环境更接近**真实宿主**（Obsidian 的 WebView）。
 *
 * ## 为什么需要它
 *
 * `src/` 里的代码会碰一些浏览器全局，而这些在 Node 里并不存在 ——
 * 典型的是 `window`（例如 `window.setTimeout`、`window.crypto`）。
 *
 * ⚠️ 关键点：这些全局**不是"测试专用"的替身**，而是宿主**真的有**的东西。
 * 桌面与移动端的 Obsidian 都是 WebView，`window` 一定存在。
 * 所以这里做的是"把测试环境补齐到与宿主同一水平"，而不是"给被测代码开后门"。
 *
 * 反过来若不做这件事，就会出现一种很坏的失衡：
 * 源码按宿主写了 `window.setTimeout`（lint 也要求这么做，见 eslint.config.mts
 * 的 `obsidianmd/prefer-window-timers`），测试却在 Node 里因为 `window is not defined`
 * 直接崩 —— 于是要么去改源码迁就测试（把宿主上正确的写法改坏），
 * 要么每次都在测试文件里手工补一行（迟早有人漏）。
 *
 * ## 只补"宿主一定有的"，不补"宿主一定没有的"
 *
 * 这里**刻意不**提供 `Buffer` / `process` / `require`：
 * 那些在移动端真的不存在，而 `eslint.config.mts` 已把它们在 `src/**` 里禁掉。
 * 若在这里补上，就等于把 lint 的门换成纸糊的 —— 源码里误用了也测不出来。
 */
export function installHostGlobals() {
	if (typeof globalThis.window === "undefined") {
		// 直接指向 globalThis：`window.setTimeout` 与 `setTimeout` 在 Node 里是同一个函数，
		// 足以让"宿主上存在的 API 在这里也存在"这一条成立。
		globalThis.window = globalThis;
	}
	return globalThis.window;
}
