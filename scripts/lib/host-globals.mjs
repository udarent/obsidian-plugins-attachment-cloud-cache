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
	installDomHelpers(globalThis);
	return globalThis.window;
}

/**
 * 补齐宿主提供的**元素创建助手**（`createDiv` / `createEl` / `createSpan`）。
 *
 * ## 为什么只补到"够用"就停
 *
 * 宿主（Obsidian 的 WebView）确实有这几个全局函数，所以补它们符合上面那条原则。
 * 但这里返回的**不是 DOM**：它只有"能挂子节点、能取第一个子节点"这点能力，
 * 供"重建附件节点"那条路（`Main.ts` 的 `renderEmbed`）在测试进程里跑通。
 *
 * ⚠️ 这是一个**有意的浅替身**：任何依赖真实 DOM 行为（样式、事件冒泡、
 * `querySelector` 的完整选择器语法…）的断言都**不该**用它 —— 那属于
 * "替身比被测代码更懂宿主"，会掩盖缺陷。套件里真正需要元素形状的地方
 * （如 `embed-rebuild-suite`）自己造元素，比这里更可控。
 */
function installDomHelpers(target) {
	if (typeof target.createElement !== "function") return;

	const makeElement = (tag) => {
		const children = [];
		return {
			tagName: String(tag).toUpperCase(),
			children,
			childNodes: children,
			style: {},
			dataset: {},
			classList: { add() {}, remove() {}, contains: () => false },
			setText() {},
			empty() {
				children.length = 0;
			},
			appendChild(node) {
				children.push(node);
				return node;
			},
			createEl: (childTag, options) => {
				const node = makeElement(childTag);
				if (options && typeof options === "object" && typeof options.text === "string") node.textContent = options.text;
				children.push(node);
				return node;
			},
			createDiv: (options) => {
				const node = makeElement("div");
				if (options && typeof options === "object" && typeof options.text === "string") node.textContent = options.text;
				children.push(node);
				return node;
			},
			createSpan: (options) => {
				const node = makeElement("span");
				if (options && typeof options === "object" && typeof options.text === "string") node.textContent = options.text;
				children.push(node);
				return node;
			},
			addEventListener() {},
			remove() {},
			get firstElementChild() {
				return children.length > 0 ? children[0] : null;
			},
		};
	};

	// 三个助手都只做一件事：造一个元素（可选带文本）。写成显式的三条，
	// 而不是一个"按名字分支"的循环 —— 后者的 `createEl` 需要额外处理 tag 参数，
	// 混在一起只会让读的人多绕一圈。
	if (typeof target.createDiv !== "function") {
		target.createDiv = (options) => withText(makeElement("div"), options);
	}
	if (typeof target.createSpan !== "function") {
		target.createSpan = (options) => withText(makeElement("span"), options);
	}
	if (typeof target.createEl !== "function") {
		target.createEl = (tag, options) => withText(makeElement(tag ?? "div"), options);
	}
}

/** 给元素挂上 `options.text`（宿主那几个助手的共同约定）。 */
function withText(element, options) {
	if (options && typeof options === "object" && typeof options.text === "string") {
		element.textContent = options.text;
	}
	return element;
}
