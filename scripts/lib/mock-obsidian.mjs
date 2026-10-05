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

import { existsSync } from "node:fs";
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
		writes: [],
		readBinary: [],
		getBasePath: 0,
	};

	/** 用真实磁盘重算文件列表 —— 保证"磁盘有、Obsidian 看不见"能被模拟出来。 */
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
			await mkdir(dirname(toAbs(rootDir, to)), { recursive: true });
			await rename(toAbs(rootDir, from), toAbs(rootDir, to));
		},
		copy: async (from, to) => {
			await mkdir(dirname(toAbs(rootDir, to)), { recursive: true });
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
					"getBasePath() 在移动端不可用 —— 插件必须只用 Vault / DataAdapter API（见 REWRITE-SCOPE.md 的移动端约束）"
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

		async getFiles() {
			const all = await scan();
			return all.filter((e) => !e.folder).map((e) => new TFile(e.path, vault, e.size));
		},
		async getMarkdownFiles() {
			const files = await vault.getFiles();
			return files.filter((f) => f.extension === "md");
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
		on() {
			return {};
		},
		trigger() {},
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
				await mkdir(dirname(toAbs(rootDir, newPath)), { recursive: true });
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
