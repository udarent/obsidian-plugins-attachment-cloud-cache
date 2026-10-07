/**
 * Obsidian 宿主 API 的测试替身。
 *
 * ## 设计原则
 *
 * 1. **用真实磁盘**：`Vault` / `DataAdapter` 背后接的是真的 `node:fs`，
 *    所以测试可以写"文件真的落盘了吗"这类端到端断言，而不是断言 mock 被调用了。
 * 2. ⭐ **能模拟移动端约束**：桌面与移动的差异集中在文件访问上，
 *    而**类型系统看不出来**（`getBasePath()` 在 .d.ts 里存在，移动端运行时却不可用）。
 *    所以 `mobile: true` 时让不该用的 API **直接抛错** —— 于是"误用"变成测试红灯，
 *    而不是上线后用户在手机上遇到的静默失败。
 * 3. **记录调用**：`calls` 收集写文件、移动、回收站等动作，供断言"到底做了什么"。
 *
 * ## 为什么不追求覆盖 Obsidian 全部 API
 *
 * 只实现**我们真正用到**的部分。缺什么会以 `is not a function` 立刻暴露，
 * 比写一堆没人调的假实现更清楚。（这条是上一轮反复踩坑后定下的：
 * mock 的能力缺口会静默掩盖真实行为，所以宁可缺失也不要写错语义。）
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

// ─────────────────────────── 文件模型 ───────────────────────────

export class TAbstractFile {
	constructor(path, vault) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.parent = null;
		this.vault = vault;
	}
}

export class TFile extends TAbstractFile {
	constructor(path, vault, size = 0) {
		super(path, vault);
		this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
		this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
		this.stat = { size, ctime: 0, mtime: 0 };
	}
}

export class TFolder extends TAbstractFile {
	constructor(path, vault) {
		super(path, vault);
		this.children = [];
	}
}

/** 把 vault 相对路径转成绝对路径。拒绝逃出根目录的路径（安全闸门）。 */
function toAbs(root, vaultPath) {
	const clean = String(vaultPath ?? "").replace(/^\/+/, "");
	const abs = join(root, ...clean.split("/"));
	const rel = relative(root, abs);
	if (rel.startsWith("..") || (rel !== "" && rel.startsWith(`..${sep}`))) {
		throw new Error(`拒绝访问 vault 之外的路径：${vaultPath}`);
	}
	return abs;
}

// ─────────────────────────── 通知 / UI ───────────────────────────

export class Notice {
	constructor(message, timeout) {
		this.message = message;
		this.timeout = timeout;
		/** 所有创建过的提示，供测试断言"失败时是否明确报错"。 */
		Notice.instances.push(this);
	}
	setMessage(message) {
		this.message = message;
		return this;
	}
	hide() {}
}
Notice.instances = [];

/** 设置项组件替身：所有链式方法返回自身。 */
export function fakeComponent() {
	const component = {};
	const chain = () => component;
	for (const method of [
		"setValue",
		"setPlaceholder",
		"setDisabled",
		"setButtonText",
		"setCta",
		"setTooltip",
		"setIcon",
		"setLimits",
		"setDynamicTooltip",
		"setWarning",
		"setDestructive",
		"setClass",
		"setName",
		"setDesc",
		"setHeading",
		"addOption",
		"addOptions",
		"addText",
		"addToggle",
		"addDropdown",
		"addButton",
		"addExtraButton",
		"addSecret",
		"onChange",
		"onClick",
		"then",
		"register",
	]) {
		component[method] = chain;
	}
	component.inputEl = { type: "", addClass: () => {}, setAttribute: () => {} };
	component.buttonEl = { addClass: () => {}, setAttribute: () => {} };
	component.extraSettingsEl = { addClass: () => {} };
	return component;
}

export class Setting {
	constructor(containerEl) {
		this.containerEl = containerEl;
		this.settingEl = { addClass: () => {} };
		this.descEl = { setText: () => {}, appendChild: () => {}, createEl: () => ({}) };
		Object.assign(this, fakeComponent());
	}
}

export class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = {
			empty: () => {},
			createEl: () => ({ setText: () => {}, addClass: () => {} }),
			createDiv: () => ({}),
			textContent: "",
		};
		this.titleEl = { setText: () => {} };
		this.modalEl = { addClass: () => {} };
		this.scope = { register: () => {} };
	}
	open() {
		this.onOpen?.();
	}
	close() {
		this.onClose?.();
	}
}

export class Component {
	onload() {}
	onunload() {}
	register() {}
	registerEvent() {}
	registerDomEvent() {}
	registerInterval(timer) {
		return timer;
	}
	addChild(child) {
		child.load?.();
		return child;
	}
	load() {}
	unload() {}
}

export class MarkdownRenderChild extends Component {
	constructor(containerEl) {
		super();
		this.containerEl = containerEl;
	}
}

// ─────────────────────────── 插件基类与设置页 ───────────────────────────
//
// ## 为什么这些也必须有替身
//
// 前面的套件都是"直接 import 模块、手动拼 deps"，从来不需要 `Plugin`。
// 但**入口验收**（`test-load-acceptance.mjs`）要跑真实构建产物的 `onload()`，
// 而那里面第一件事就是 `class X extends Plugin` —— 没有这个基类，产物连加载都过不去。
//
// ## 它们必须**记账**
//
// 一个只提供空方法的 `Plugin` 能让 `onload()` 顺利跑完，然后你对"它到底注册了什么"
// 一无所知 —— 这正是本项目漂移了一整个阶段都没被发现的原因。
// 所以每一个注册类方法都往 `plugin.registrations` 里记一条，
// 让验收测试能断言"粘贴/拖拽钩子真的挂上了"，而不是只断言"没抛异常"。

/** 记录一次注册（名字 + 参数），供验收断言。 */
function record(plugin, kind, detail) {
	plugin.registrations.push({ kind, detail });
}

export class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest ?? {};
		/** 全部注册动作，按发生顺序。验收测试读它。 */
		this.registrations = [];
		/** 注册的设置页实例。 */
		this.settingTabs = [];
		/** `registerEvent` 拿到的引用，供断言"卸载时能自动注销"。 */
		this.eventRefs = [];
		/** `register` 拿到的清理函数（宿主在卸载时调用）。 */
		this.cleanups = [];
		/** 命令 / ribbon 图标（当前未使用，留着让"忘了接线"能被测出来）。 */
		this.commands = [];
		this.ribbonIcons = [];
		this.postProcessors = [];
		/** 内存里的 data.json 内容；测试可覆写成固定值。 */
		this._data = {};
	}

	registerEvent(ref) {
		this.eventRefs.push(ref);
		if (ref?.name) record(this, "event", ref.name);
		return ref;
	}

	/**
	 * ⚠️ 必须记账：`register` 是"卸载时清理"的**唯一**入口
	 * （prototype 补丁、启动定时器、周期定时器都走它）。
	 *
	 * 不记账的后果不只是"测不了" —— 是**一整类接线缺口完全没有痕迹**：
	 * 插件忘了注册后台定时器时，验收里看不到任何异常，而用户那边的表现是
	 * "设了缓存上限却从来不会自动轮换"。替身愿意记账，这种缺口才抓得住。
	 *
	 * 测试可以调用这些清理函数来模拟卸载（真实宿主在卸载时会调用它们）。
	 */
	register(callback) {
		this.cleanups.push(callback);
		record(this, "register", "(cleanup)");
		return callback;
	}

	addSettingTab(tab) {
		this.settingTabs.push(tab);
		record(this, "settingTab", tab?.constructor?.name ?? "(匿名)");
		return tab;
	}

	addCommand(command) {
		this.commands.push(command);
		record(this, "command", command?.id ?? "(无 id)");
		return command;
	}

	addRibbonIcon(icon, title) {
		const el = { addClass: () => {}, setAttribute: () => {}, addEventListener: () => {} };
		this.ribbonIcons.push({ icon, title, el });
		record(this, "ribbon", title);
		return el;
	}

	registerMarkdownPostProcessor(processor) {
		this.postProcessors.push(processor);
		record(this, "postProcessor", "(渲染钩子)");
		return processor;
	}

	async loadData() {
		return this._data;
	}

	async saveData(data) {
		this._data = data;
	}
}

/** 设置页基类。`containerEl` 只需要能被 `empty()` 与建元素即可。 */
export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = {
			empty: () => {},
			createEl: () => ({ setText: () => {}, addClass: () => {}, createEl: () => ({}) }),
			createDiv: () => ({ createEl: () => ({}) }),
			addClass: () => {},
		};
	}
	display() {}
	hide() {}
}

/** 具名密钥选择器：链式方法返回自身，测试可读 `lastValue`。 */
export class SecretComponent {
	constructor(app, containerEl) {
		this.app = app;
		this.containerEl = containerEl;
		this.value = null;
		Object.assign(this, fakeComponent());
	}
	setValue(value) {
		this.value = value;
		return this;
	}
	onChange(cb) {
		this.changeHandler = cb;
		return this;
	}
}

/** 宿主语言。默认英文；测试可调 `setLanguage` 验证中英切换。 */
let hostLanguage = "en";
export function getLanguage() {
	return hostLanguage;
}
export function setHostLanguage(language) {
	hostLanguage = language;
}

// ─────────────────────────── 平台 ───────────────────────────

export const Platform = {
	isDesktop: true,
	isMobile: false,
	isMobileApp: false,
	isDesktopApp: true,
	isIosApp: false,
	isAndroidApp: false,
};

/** 按 `mobile` 选项设置 Platform 标志。 */
export function setPlatformMode(mobile) {
	Platform.isDesktop = !mobile;
	Platform.isMobile = mobile;
	Platform.isMobileApp = mobile;
	Platform.isDesktopApp = !mobile;
}

export function normalizePath(path) {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
}

// ─────────────────────────── 密钥存储 ───────────────────────────

/**
 * SecretStorage 的内存替身。
 *
 * ⚠️ 真实实现把密钥交给**操作系统的钥匙串**（不落盘到 data.json）。
 * 测试里用内存即可 —— 但要能验证「凭据没有写进 data.json」这件事，
 * 所以 mock 只进这个 Map，绝不会出现在 `saveData` 的载荷里。
 */
export function createSecretStorage() {
	const map = new Map();
	return {
		getSecret(id) {
			return map.get(id) ?? null;
		},
		setSecret(id, secret) {
			map.set(id, secret);
		},
		listSecrets() {
			return [...map.keys()];
		},
		_map: map,
	};
}

// ─────────────────────────── App / Vault ───────────────────────────

/**
 * 造一个接真实磁盘的 App 替身。
 *
 * @param {string} rootDir  vault 根目录（测试用临时目录）
 * @param {{ mobile?: boolean }} [opts]  `mobile: true` 时启用移动端约束
 */
export function createAppMock(rootDir, opts = {}) {
	const mobile = Boolean(opts.mobile);
	setPlatformMode(mobile);

	const calls = {
		createFolder: [],
		rename: [],
		trash: [],
		delete: [],
		/** `Vault.delete` 收到的第二个参数（不该有人传它，见 remove.ts 的说明）。 */
		deleteForce: undefined,
		writes: [],
		readBinary: [],
		getBasePath: 0,
	};

	/** 用真实磁盘重算文件列表 —— 保证"磁盘有、Obsidian 看不见"能被模拟出来。 */
	/**
	 * 同步扫描（与真实 `Vault.getFiles()` 的同步语义对齐）。
	 *
	 * ⚠️ 用 `readdirSync` 而不是"扫一次缓存起来"：`getFiles()` 必须反映**当下**的磁盘状态 ——
	 * 真实宿主也会在文件变更后立刻更新索引。缓存版本会带来"刚写的文件看不见"的假象，
	 * 而那种假象很难与真实缺陷区分。
	 */
	function scanSync() {
		const out = [];
		function walk(dir) {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = join(dir, entry.name);
				const vaultPath = relative(rootDir, abs).split(sep).join("/");
				if (entry.isDirectory()) {
					out.push({ path: vaultPath, folder: true });
					walk(abs);
				} else {
					let size = 0;
					try {
						size = statSync(abs).size;
					} catch {
						// 拿不到大小不影响"文件存在"这件事
					}
					out.push({ path: vaultPath, folder: false, size });
				}
			}
		}
		walk(rootDir);
		return out;
	}

	async function scan() {
		const out = [];
		async function walk(dir) {
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const abs = join(dir, entry.name);
				const vaultPath = relative(rootDir, abs).split(sep).join("/");
				if (entry.isDirectory()) {
					out.push({ path: vaultPath, folder: true });
					await walk(abs);
				} else {
					const st = await stat(abs);
					out.push({ path: vaultPath, folder: false, size: st.size });
				}
			}
		}
		await walk(rootDir);
		return out;
	}

	/** 适配器：直连文件系统。移动端会禁用部分能力。 */
	const adapter = {
		getName: () => (mobile ? "capacitor" : "desktop"),
		exists: async (p) => existsSync(toAbs(rootDir, p)),
		stat: async (p) => {
			try {
				const st = await stat(toAbs(rootDir, p));
				return { type: st.isDirectory() ? "folder" : "file", ctime: 0, mtime: 0, size: st.size };
			} catch {
				return null;
			}
		},
		list: async (p) => {
			const abs = toAbs(rootDir, p);
			let entries;
			try {
				entries = await readdir(abs, { withFileTypes: true });
			} catch {
				return { files: [], folders: [] };
			}
			const files = [];
			const folders = [];
			for (const e of entries) {
				const child = normalizePath(`${p}/${e.name}`);
				if (e.isDirectory()) folders.push(child);
				else files.push(child);
			}
			return { files, folders };
		},
		read: async (p) => readFile(toAbs(rootDir, p), "utf8"),
		readBinary: async (p) => {
			const buf = await readFile(toAbs(rootDir, p));
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
		write: async (p, data) => {
			calls.writes.push(p);
			await mkdir(dirname(toAbs(rootDir, p)), { recursive: true });
			await writeFile(toAbs(rootDir, p), data, "utf8");
		},
		writeBinary: async (p, data) => {
			calls.writes.push(p);
			await mkdir(dirname(toAbs(rootDir, p)), { recursive: true });
			await writeFile(toAbs(rootDir, p), Buffer.from(data));
		},
		mkdir: async (p) => {
			calls.createFolder.push(p);
			await mkdir(toAbs(rootDir, p), { recursive: true });
		},
		remove: async (p) => {
			await rm(toAbs(rootDir, p), { force: true });
		},
		rmdir: async (p, recursive) => {
			await rm(toAbs(rootDir, p), { recursive, force: true });
		},
		rename: async (from, to) => {
			calls.rename.push([from, to]);
			// ⚠️ **刻意不建父目录** —— 真实文件系统的 `rename` 在目标父目录不存在时
			// 会以 ENOENT 失败，这里若"顺手帮你建好"，就会掩盖"忘了建目录"这类缺陷：
			// 测试全绿，用户在真机上却是"缓存文件搬不过去"。
			// 让替身与真实系统同样严格，缺陷才会在测试里暴露。
			await rename(toAbs(rootDir, from), toAbs(rootDir, to));
		},
		copy: async (from, to) => {
			await writeFile(toAbs(rootDir, to), await readFile(toAbs(rootDir, from)));
		},
		trashSystem: async (p) => {
			const abs = toAbs(rootDir, p);
			const existed = existsSync(abs);
			await rm(abs, { force: true });
			return existed;
		},
		trashLocal: async (p) => rm(toAbs(rootDir, p), { force: true }),
		getResourcePath: (p) => `app://local/${normalizePath(p)}`,
		/**
		 * ⚠️ 移动端**不可用**（类型里有、运行时没有）。
		 * 这里刻意抛错而不是返回假值：让"误用"变成响亮的失败。
		 * 返回假值的话，代码会拿着一个错的绝对路径继续跑，
		 * 表现为"文件莫名写丢了"——那比抛错难查得多。
		 */
		getBasePath() {
			calls.getBasePath += 1;
			if (mobile) {
				throw new Error(
					"getBasePath() 在移动端不可用 —— 插件必须只用 Vault / DataAdapter API（见 docs/SCOPE.md 的移动端约束）"
				);
			}
			return rootDir;
		},
	};

	const vault = {
		adapter,
		configDir: ".obsidian",
		getName: () => "mock-vault",
		getBasePath: () => adapter.getBasePath(),

		/**
		 * ⚠️ **必须同步**，与真实 API 一致：`Vault.getFiles()` 在 Obsidian 里返回数组，
		 * 不是 Promise。
		 *
		 * 替身原来写成 `async`，于是"产品代码里同步遍历它"会拿到一个 Promise ——
		 * 报错是 `getMarkdownFiles is not a function or its return value is not iterable`，
		 * 看起来像产品代码写错了。**是替身错了**：一个异步的替身会让
		 * "同步用法"在测试里永远失败、而"异步用法"在真机上永远失败 ——
		 * 两边都错，且都不指出真正的原因。
		 *
		 * 用同步扫描（`readdirSync`）而不是等着 `pathCache`：真实 API 就是这么同步可用的
		 * （宿主内部维护着文件索引）。`pathCache` 仍然保留，用于单独模拟"索引滞后"场景。
		 */
		getFiles() {
			return scanSync()
				.filter((entry) => !entry.folder)
				.map((entry) => new TFile(entry.path, vault, entry.size));
		},
		getMarkdownFiles() {
			return vault.getFiles().filter((file) => file.extension === "md");
		},
		getAbstractFileByPath(path) {
			const p = normalizePath(path);
			if (pathCache !== null) {
				const hit = pathCache.find((e) => e.path === p);
				if (!hit) return null;
				return hit.folder ? new TFolder(p, vault) : new TFile(p, vault, hit.size);
			}
			// 未扫描时退化为同步存在性检查
			const abs = toAbs(rootDir, p);
			if (!existsSync(abs)) return null;
			return p.includes(".") ? new TFile(p, vault) : new TFolder(p, vault);
		},
		async create(path, data) {
			calls.writes.push(path);
			await mkdir(dirname(toAbs(rootDir, path)), { recursive: true });
			await writeFile(toAbs(rootDir, path), data, "utf8");
			return new TFile(path, vault);
		},
		async createBinary(path, data) {
			calls.writes.push(path);
			await mkdir(dirname(toAbs(rootDir, path)), { recursive: true });
			await writeFile(toAbs(rootDir, path), Buffer.from(data));
			return new TFile(path, vault);
		},
		async createFolder(path) {
			calls.createFolder.push(path);
			await mkdir(toAbs(rootDir, path), { recursive: true });
			return new TFolder(path, vault);
		},
		async read(file) {
			return readFile(toAbs(rootDir, file.path), "utf8");
		},
		async readBinary(file) {
			calls.readBinary.push(file.path);
			const buf = await readFile(toAbs(rootDir, file.path));
			return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
		},
		async modify(file, data) {
			calls.writes.push(file.path);
			await writeFile(toAbs(rootDir, file.path), data, "utf8");
		},
		async modifyBinary(file, data) {
			calls.writes.push(file.path);
			await writeFile(toAbs(rootDir, file.path), Buffer.from(data));
		},
		/**
		 * **彻底删除**（不经回收站），官方文档原话 "Deletes the file completely"。
		 *
		 * 与 `fileManager.trashFile` **分别记账**（`calls.delete` / `calls.trash`）：
		 * 这两者的区别正是"磁盘空间现在释放还是等清空回收站"，而它是个设置项 ——
		 * 若替身把它们记成同一个数，就**没法断言"到底走了哪一条"**，
		 * 于是"选了直接删除却走了回收站"这类缺陷在测试里完全没有痕迹。
		 *
		 * ⚠️ 与真实 API 一样**不走 adapter**：两个原语都由宿主自己完成删除并更新索引，
		 * 所以这里也是直接动磁盘（而不是转手调 `adapter.remove`，那会掩盖
		 * "产品代码是否真的用了宿主 API"这件事）。
		 */
		async delete(file, force) {
			calls.delete.push(file.path);
			calls.deleteForce = force;
			await rm(toAbs(rootDir, file.path), { force: true });
		},
		getResourcePath(file) {
			return `app://local/${normalizePath(file.path)}`;
		},
		on() {
			return {};
		},
	};

	/**
	 * 同步路径缓存：`getAbstractFileByPath` 在真实 API 里是**同步**的，
	 * 而我们要用真实异步磁盘。所以提供一个 `refreshPathCache()`，
	 * 测试在改动磁盘后调用它来模拟"Obsidian 重新索引"。
	 * 不调用则保持旧快照 —— 这正是"索引滞后"场景。
	 */
	let pathCache = null;

	const workspace = {
		containerEl: { tagName: "DIV", addEventListener: () => {} },
		leaves: [],
		onLayoutReady(cb) {
			layoutReadyCallbacks.push(cb);
		},
		iterateAllLeaves(cb) {
			for (const leaf of workspace.leaves) cb(leaf);
		},
		getActiveFile: () => null,
		getActiveViewOfType: () => null,
		/**
		 * ⚠️ 这里必须**真的记录**处理器，不能返回一个空对象了事。
		 *
		 * 之前的实现是 `on() { return {}; }` —— 注册被静默吞掉。
		 * 后果不只是"测不了"，而是**掩盖了一整类缺陷**：插件入口若忘了注册
		 * 粘贴钩子，测试里毫无异常、注册调用也"成功"返回，
		 * 于是一个功能上完全没接线的插件也能让全套测试变绿。
		 * 验收测试要断言"钩子真的挂上了"，前提就是这个替身愿意记账。
		 *
		 * `registered` 按事件名分组（断言"注册了哪几类"），
		 * `onCalls` 保持调用顺序（断言"确实调用过"）。
		 */
		registered: new Map(),
		onCalls: [],
		on(name, callback) {
			workspace.onCalls.push(name);
			if (!workspace.registered.has(name)) workspace.registered.set(name, []);
			workspace.registered.get(name).push(callback);
			const ref = { name, callback };
			workspace.refs.push(ref);
			return ref;
		},
		refs: [],
		offref(ref) {
			const list = workspace.registered.get(ref?.name);
			if (!list) return;
			const i = list.indexOf(ref.callback);
			if (i >= 0) list.splice(i, 1);
			const j = workspace.refs.indexOf(ref);
			if (j >= 0) workspace.refs.splice(j, 1);
		},
		/** 触发某个事件，返回处理器被调用的次数。 */
		trigger(name, ...args) {
			const list = workspace.registered.get(name) ?? [];
			for (const cb of list) cb(...args);
			return list.length;
		},
	};
	const layoutReadyCallbacks = [];

	const app = {
		vault,
		workspace,
		secretStorage: createSecretStorage(),
		fileManager: {
			async trashFile(file) {
				calls.trash.push(file.path);
				await rm(toAbs(rootDir, file.path), { force: true });
			},
			async renameFile(file, newPath) {
				calls.rename.push([file.path, newPath]);
				// 同上：不建父目录。宿主自己也只做 rename，目录得由调用方先建好。
				await rename(toAbs(rootDir, file.path), toAbs(rootDir, newPath));
			},
			/**
			 * 按附件目录给出可用路径。
			 *
			 * ⚠️ 真实 API **不保证唯一**（返回值可能已被占用），
			 * 所以 mock 也**刻意不做去重** —— 唯一性必须由被测代码自己保证。
			 * 若 mock 帮忙去重，就会掩盖"没做去重导致 createBinary 抛错"这个真实缺陷。
			 */
			getAvailablePathForAttachment(name, sourcePath) {
				const dir = attachmentFolder();
				return normalizePath(dir ? `${dir}/${name}` : name);
			},
			generateMarkdownLink(file, sourcePath, subpath, alias) {
				return alias ? `[[${file.path}|${alias}]]` : `[[${file.path}]]`;
			},
		},
	};

	/** 附件目录：由测试通过 setAttachmentFolder 指定，模拟 Obsidian 的设置。 */
	let attachmentDir = "";
	function attachmentFolder() {
		return attachmentDir;
	}

	const helpers = {
		app,
		calls,
		rootDir,
		mobile,
		setAttachmentFolder(dir) {
			attachmentDir = dir;
		},
		/** 重新扫描磁盘 → 模拟 Obsidian 更新文件索引。 */
		async refreshPathCache() {
			pathCache = await scan();
		},
		/** 模拟 Obsidian 索引滞后：清掉缓存但不重扫。 */
		clearPathCache() {
			pathCache = null;
		},
		async runLayoutReady() {
			const cbs = [...layoutReadyCallbacks];
			for (const cb of cbs) await cb();
		},
		pathsOf(kind) {
			return calls[kind];
		},
	};

	return helpers;
}

// ─────────────────────────── 网络 ───────────────────────────

/**
 * `requestUrl` 替身。
 *
 * ⚠️ 默认**拒绝一切请求**，必须显式 `allow()` 才能通过 ——
 * 这是为了让"离线时还发请求"这类缺陷**必然暴露**：
 * 忘了放开就红，而不是静默走真实网络（那样测试会变得不确定且慢）。
 */
/**
 * `requestUrl` 的**模块级**替身。
 *
 * 存在的理由只是"让 `import { requestUrl } from "obsidian"` 能链接成功"：
 * esbuild 把 `obsidian` 标为 external，若这门导出不存在，模块会在链接期
 * 直接报 "does not provide an export named"，连测试都跑不起来。
 *
 * 默认行为**一律抛错**，刻意不实现 —— 因为模块级套件必须**显式注入 transport**
 * （见 `lib/mock-s3.mjs` 的 `nodeTransport`）。若这里悄悄做点"像样的"事，
 * 会让人误以为真的验证过了网络路径。
 *
 * ## 为什么做成"可替换的实现"而不是写死的抛错
 *
 * 入口验收要跑**真实构建产物**，而那里面用的是宿主自带的 `requestUrl`，
 * 我们插不进 transport（也不能改产品代码来方便测试）。
 * 唯一诚实的做法是替换**这一门实现**为"真的发一次 HTTP"——
 * 那不是"假响应"，服务端照旧独立重算签名。
 *
 * ⚠️ 所以 `setRequestUrlImpl` 只该由那一条验收测试调用，且要传一个**真发请求**的实现；
 * 传一个返回固定响应的桩会把"网络路径已验证"变成谎话。
 */
let requestUrlImpl = async () => {
	throw new Error("requestUrl 替身未实现；测试请显式注入 transport（见 scripts/lib/mock-s3.mjs）");
};

/** 换掉 `requestUrl` 的实现。传 `null` 可恢复默认（抛错）。 */
export function setRequestUrlImpl(impl) {
	requestUrlImpl =
		impl ??
		(async () => {
			throw new Error("requestUrl 替身未实现；测试请显式注入 transport（见 scripts/lib/mock-s3.mjs）");
		});
}

export async function requestUrl(options) {
	return requestUrlImpl(options);
}

export function createRequestUrlMock() {
	const log = [];
	let allowAll = false;
	const allowed = new Set();

	const requestUrl = async (options) => {
		const url = typeof options === "string" ? options : options.url;
		log.push({ url, method: (options && options.method) || "GET" });
		const host = (() => {
			try {
				return new URL(url).host;
			} catch {
				return "";
			}
		})();
		if (!allowAll && !allowed.has(host)) {
			throw new Error(`requestUrl 被测试替身拒绝（未放行的主机：${host || url}）`);
		}
		throw new Error("requestUrl 替身未实现响应；请用 mock S3 服务或显式注入 fetch");
	};

	requestUrl.requests = log;
	requestUrl.allow = (host) => allowed.add(host);
	requestUrl.allowAll = () => {
		allowAll = true;
	};

	return requestUrl;
}
