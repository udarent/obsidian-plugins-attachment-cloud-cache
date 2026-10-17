/**
 * 「本机文件」：`file:///D:/…` 这类**库外绝对路径**的解析、判定与读取。
 *
 * ## 它服务的是什么
 *
 * 用户 2026-10-15 报的场景：企业微信截图那种链接 ——
 * `![](file:///D:/企业微信文件/WXWork/…/企业微信截图_17907591882999.png)`。
 * 这类地址与「站外文件」是**同一件事的两半**：都不是库内的东西，都要被搬进用户自己的存储、
 * 把笔记里的链接换成远端地址。差别只有**字节从哪来**：站外是 `requestUrl` 去网上下，
 * 这里是**从本机磁盘读**。
 * ⇒ 所以这条链**复用** `core/external-cache.ts` 的后半段（`ingestAttachment` + 字面替换改写），
 * 只有"取字节"那一步不同。
 *
 * ## ⚠️⚠️ 这是全库唯一会**读你本机任意文件**的地方
 *
 * `core/download.ts` 那条守卫讲的是"未经同意绝不把**站外**字节写进 vault"；
 * 这里方向是反的、而且危险更大：**把你的本机文件传到你的存储**（而那个桶可能是公开读的）。
 * 用户 2026-10-15 定的边界是两条：
 *
 * 1. **只走显式入口** —— 「缓存外部文件（可挑选）…」的勾选 / 批量命令的确认框。
 *    自动那条路（打开笔记就处理）继续**无视** `file:`：`decideExternalCache` 里那句
 *    `!http(s) ⇒ ignore` 一个字都不用动，模块头那句"唯一会下载别人的文件的地方"因此仍然成立。
 * 2. **不加"允许读取的目录"白名单**（用户明确否掉）⇒ "同意"落在
 *    **逐份勾选 + 清单里显示绝对路径**上。⚠️ 所以候选列表**必须显示完整路径**，
 *    只显示文件名就等于让用户在看不见风险的情况下点确认（界面那条纪律在 picker 那边）。
 *
 * ⚠️ 于是**扩展名闸门是唯一还站着的技术边界**，它被刻意收窄成"**能嵌进笔记的那几类**"
 * （`isEmbeddable`：图 / 音 / 视频 / PDF）。**不要**为了让某一种新格式能过而放宽它 ——
 * 那会把"用户勾中一张图"扩大成"用户勾中任意文件"，而这条路的两端（任意磁盘路径、
 * 可能是公开的桶）都没变。
 *
 * ## ⚠️ 只有桌面端能读得到
 *
 * `file:///D:/…` 在手机上不存在（移动端拿不到这个路径）。插件**不是** desktop-only
 * （`manifest.json` 的 `isDesktopOnly: false`），所以判据只能是**运行时**的
 * `Platform.isDesktopApp`，不能是打包期假设。⚠️ 这是本项目**第一次**做平台判断，
 * 写法就是把结果当参数注入（`decideLocalFile` 的 `isDesktop`）—— 于是纯判据可穷举，
 * 而"谁去问平台"只有入口那一处。
 *
 * ## ⚠️ 懒加载 `node:fs` —— ⚠️⚠️ 而且**必须用宿主作用域里的 `require`**（2026-10-16 两次真机实测）
 *
 * 顶层 `import "node:fs/promises"` 不行：产物是 **CJS 单文件**（`esbuild.config.mjs`：
 * `format: "cjs"`，Node 内置模块列在 `external` 里），顶层导入会让**手机端在加载插件时**
 * 就抛错 —— 那不是"这个功能不可用"，而是**整个插件都装不上**。
 *
 * ⭐⭐ 但"写在函数体里"**只有配上 `require` 才成立**：`await import("node:fs/promises")`
 * 看着更现代，可 esbuild 在 CJS 输出里**不会**把它改写成 `require`（两者语义不同：
 * 动态 import 走 ESM 加载器）⇒ 产物里留着原样的 `import("node:fs/promises")`，
 * 而**那一句在宿主里被 CORS 拦下**（`app://obsidian.md` 的协议白名单里没有 `node:`，
 * 原文见 {@link fsPromises}）⇒ 每一份本机文件都被报成「已经找不到了」，
 * 而用户指着的那份文件好好地在磁盘上（2026-10-16 实测：
 * `![](file:///D:/企业微信文件/…/企业微信截图_…png)`，74909 字节、就在那儿）。
 *
 * ⚠️⚠️ 同样**不能**写 `module.require(...)` —— 那是第一次修完之后换上的写法，
 * 也已被真机否掉：能证明的只有"宿主提供了 **`require` 这个标识符**"
 *（产物里成片的 `require("obsidian")`，插件能加载起来就说明它可用）；
 * 而**宿主那个 `module` 对象上有没有 `require` 方法，没有任何证据**。
 * 写 `module.require` 的后果是**整条命令静默死掉**：那句调用抛 `TypeError`，
 * 而命令是异步的 ⇒ 用户看到的就是"**点击命令没有反应**"（2026-10-16 实测）。
 * ⇒ 只用**宿主自己用的那一个** `require`。
 *
 * ⚠️⚠️ 这条链**此前从没在真机上成功过**，而所有测试都是绿的 —— 因为验收跑在 **Node** 里，
 * 那里的动态 `import()` 是好的，而且夹具**自己往 `module` 上挂了 `require`**：
 * **夹具比真机宽容**，于是"测试全绿而功能一直不工作"。
 * ⇒ 这是"**夹具与真机不一致时先怀疑夹具**"那条教训的**第三次**应验 ——
 * 这次不是夹具伪造了缺陷，而是**夹具掩盖了它**（夹具照实的那一半已同步修正）。
 *
 * ⇒ 现在只走 {@link fsPromises}：函数体**内**的 `require()`（CJS 环境同步可用，
 * 而"写在函数里"保住了手机端那条纪律）。
 */

import { contentTypeForExtension, extensionOfName, isEmbeddable } from "./vault-files";

/**
 * 拿本机 `fs/promises` —— 本模块唯一的加载入口（**桌面专有**）。
 *
 * ## ⚠️⚠️ 为什么是宿主的 `require`（2026-10-16 真机实测，两次否掉两个写法）
 *
 * **① 不能用 `await import()`** —— 动态 `import()` 走的是**浏览器的 ESM 加载器**：
 * 它把 `node:fs/promises` 当成一个 **URL** 去 fetch，而宿主渲染进程的 origin 是
 * `app://obsidian.md`，协议白名单里没有 `node:` ⇒ 必被 CORS 拦下。
 * 用户从控制台抄回来的原文：
 *
 * ```
 * Access to script at 'node:fs/promises' from origin 'app://obsidian.md' has been blocked by
 * CORS policy: Cross origin requests are only supported for protocol schemes:
 * app, chrome, chrome-extension, chrome-untrusted, data, http, https.
 * Uncaught (in promise) TypeError: Failed to fetch dynamically imported module: node:fs/promises
 * ```
 *
 * **② 也不能用 `module.require(...)`** —— 宿主给的 `module` 上**没有** `require` 这个方法。
 * 它看着像"同一个东西的另一种写法"，但那只是 CJS 里的**约定**，不是保证：
 * 能证明的只有"宿主提供了 `require` 这个标识符"（产物里成片的 `require("obsidian")`
 * 在那儿，插件能加载起来就说明它可用）。⚠️ 后果特别隐蔽 —— 那句调用抛 `TypeError`，
 * 而命令是异步的 ⇒ **整条命令静默死掉**，用户看到的是"点击没有反应"。
 *
 * ⇒ 用**宿主自己用的那一个** `require`。⚠️ 它仍然只能在**平台守卫之后**被调用 ——
 * 手机端没有 `node:fs`（调用点都在 `decideLocalFile` 说了"桌面 + 可读"之后）。
 *
 * ## ⚠️ 它与本项目 `no-restricted-globals` 的关系（那处例外是**有意**开的）
 *
 * 那条规则禁 `require`，理由写得很清楚：*"移动端不可用"* —— 那是**对的**，
 * 而这里恰恰靠"调用点全在 `Platform.isDesktopApp` 之后"来满足它。
 * 这与 Obsidian 官方 `obsidianmd/no-nodejs-modules` 提示里的写法是同一句：
 * *"use a dynamic `import()` **or `require()`** guarded by `Platform.isDesktop`"*。
 * 我们原先用的是前半句（`import()`）—— **真机证明它在宿主里不可用**，于是改用后半句。
 * ⇒ 例外开在 `eslint.config.mts` 里、**只到这一个文件**，并且仍然拦着
 * `Buffer` / `process` / `__dirname`（那三个在本文件里没有正当用途）。
 */
function fsPromises(): typeof import("node:fs/promises") {
	return require("node:fs/promises") as typeof import("node:fs/promises");
}

/**
 * 本机文件的大小上限（默认值，调用方应当传自己的上限进来）。
 *
 * ⚠️ 与 `core/external-cache.ts` 的 `MAX_EXTERNAL_BYTES` **同值但不是同一份定义**：
 * 那一份属于"站外下载"那一层（它管的是网络流量），这一份属于"读磁盘"（它管的是**内存**：
 * 一次 `readFile` 会把整份文件搬进内存）。两处的判据不同，所以刻意各留一份；
 * 而**接线时用的是同一个数**（执行器把它的上限传下来）。
 */
export const DEFAULT_LOCAL_FILE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * `file:///D:/a/b.png` → `D:/a/b.png`。
 *
 * 不是"能读的本机绝对路径"一律返回 `null`（含：不是 `file:`、相对路径、含空字节）。
 * 支持这几种写法（都是真机上见得到的）：
 *
 * - `file:///D:/x.png` —— 最常见的三斜杠写法（作者部分为空）
 * - `file:/D:/x.png` / `file:D:/x.png` —— 手打或别的工具导出的
 * - `file:////server/share/x.png` / `file://server/share/x.png` —— UNC
 * - 路径里的中文常被百分号编码（`%E4%BC%81…`）⇒ 解一次
 *
 * ⚠️ 刻意**不做**路径规范化（不解析 `..`、不合并分隔符）：README 与确认框里显示的是
 * **笔记里写的那串原文**，用户核对的就是它；把它悄悄换成另一个字符串，等于让他核对的
 * 对象与实际读的文件不一致。`fs` 自己会解析 `..`，而"读不到"会如实报出来。
 */
export function localPathFromUrl(src: unknown): string | null {
	if (typeof src !== "string") return null;
	const raw = src.trim();
	if (!/^file:/i.test(raw)) return null;

	let rest = raw.slice("file:".length);
	if (rest.startsWith("///")) {
		// 空作者 + 绝对路径：`file:///D:/x.png` ⇒ `/D:/x.png`
		rest = rest.slice(2);
	} else if (rest.startsWith("//")) {
		// UNC：`file://server/share/x.png`。保留 `//` 前缀 —— Windows 认这种写法，
		// 而把它改写成盘符形状反而会指到完全不同的地方。
	} else if (rest.startsWith("/")) {
		// `file:/D:/x.png` ⇒ `/D:/x.png`
	}
	// 盘符前那个多余的斜杠要去掉：`/D:/x.png` → `D:/x.png`
	if (/^\/[a-z]:[\\/]/i.test(rest)) rest = rest.slice(1);

	const decoded = decodeSafe(rest);
	// 必须是绝对路径：盘符（`D:/` `D:\`）或 UNC（`//`）
	if (!/^(?:[a-z]:[\\/]|\/\/)/i.test(decoded)) return null;
	// 空字节：下游 `fs` 一定会抛，而那条报错对用户没有任何信息量 ⇒ 在这里就断掉
	if (decoded.includes("\u0000")) return null;
	return decoded;
}

/**
 * 百分号解码，**解不动就按原样用**。
 *
 * ⚠️ 别把"解码失败"当成"不是合法路径"：`100%.png` 这种带裸 `%` 的**目录名**是合法的，
 * 而 `decodeURIComponent` 会对它抛 `URIError`。因为一个百分号拒掉一份本来能读的文件，
 * 用户看到的是"这链接明明在啊"。
 */
function decodeSafe(value: string): string {
	if (!value.includes("%")) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * 取路径末段。
 *
 * ⚠️ 全库第 **3** 处"按分隔符取末段"（另两处在 `object-key.ts` 与 `maintenance/references.ts`，
 * 它们各自服务不同的入参形状）。这里刻意重复而不是抽公共件：那两处的路径早就归一过了，
 * 而这一处的入参是 **Windows 本机路径**（两种分隔符混用、还可能是 UNC）—— 抽成一处就要
 * 同时接受三种形状，反而更容易在别人的调用点上出错。**同一条规则写在 N 处就配 N 条锚点。**
 */
function baseNameOfLocalPath(path: string): string {
	const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return at >= 0 ? path.slice(at + 1) : path;
}

/** 一条本机文件地址的判定结果。 */
export type LocalFileDecision =
	| {
			action: "read";
			/** 要读的绝对路径（原样保留用户在笔记里写的那串的语义，见 `localPathFromUrl`）。 */
			path: string;
			/** 末段（当文件名的来源 —— 对象 key 与本地副本的名字都从它来）。 */
			name: string;
			ext: string;
			contentType: string;
	  }
	/** 是 `file:` 写法，但**这次不读**（非桌面 / 形态不认 / 扩展名不在那几类里）。 */
	| { action: "ignore"; reason: string }
	/**
	 * ⚠️ **根本不归本模块管**（不是 `file:` 写法）—— 调用方直接交给站外那一半。
	 *
	 * 与 `ignore` 分开是**必要**的，不是为了好看：合成一个动作之后，调用方就得自己再写一遍
	 * "这串是不是 `file:`"来分流 —— 而那正是"同一条判据写在两处"的开始（本项目吃过亏的形状：
	 * 两处一岔开，表现是"某类地址两边都不管"或"两边都管"，且不报错）。
	 */
	| { action: "not-mine" };

/**
 * 这条本机文件地址能不能读。**纯函数**：不碰磁盘、不碰网络（"读得到吗"由读取层回答）。
 *
 * ⚠️ 判据顺序刻意固定（三处入口共用同一个顺序，用户看到的"为什么跳过了"才不会两样）：
 * ① 是不是 `file:` 形态（不是 ⇒ `not-mine`）；② 桌面端吗；③ 扩展名在"能嵌进笔记"的那几类里吗。
 */
export function decideLocalFile(input: { src: unknown; isDesktop: boolean }): LocalFileDecision {
	const raw = typeof input.src === "string" ? input.src.trim() : "";
	if (!/^file:/i.test(raw)) return { action: "not-mine" };
	const path = localPathFromUrl(raw);
	if (!path) return { action: "ignore", reason: "解析不出一条本机绝对路径" };
	// ⚠️ 顺序：平台判断在**解析之后**（"这条地址根本不该由本模块管"比"平台不支持"更基础）。
	if (!input.isDesktop) return { action: "ignore", reason: "仅桌面端（手机拿不到本机绝对路径）" };

	const name = baseNameOfLocalPath(path);
	// ⚠️ 只用文件名取扩展名（本机路径没有 MIME 可用）—— `extensionOfName` 对"不像扩展名"的
	// 名字返回空串（`id_rsa` 这种没有点的一律空），于是下面那道闸门对它们也照样拦得住。
	// 刻意**不**再单独写一条"没有扩展名"的分支：`isEmbeddable("")` 已经是 false，
	// 多写一条就是一段永远走不到、却要陪一条锚点的代码。
	const ext = extensionOfName(name);
	if (!isEmbeddable(ext)) {
		// ⚠️ 这句 reason 是**诊断**（进 `skipped` 统计），用户能看到的分类文案在 i18n 里。
		return { action: "ignore", reason: "扩展名不在可嵌入的那几类里（图/音/视频/PDF）" };
	}
	return { action: "read", path, name, ext, contentType: contentTypeForExtension(ext) };
}

/**
 * 本机文件行的**缩略图候选**（按优先次序）—— **一处定义**，两条入口共用
 * （批量命令 `plugin/upload-existing-flow.ts` 与挑选弹窗 `ui/external-picker-modal.ts`）。
 *
 * ## ⚠️ 为什么要给"候选"而不是一个地址（2026-10-16 用户第二次报同一件事之后定的）
 *
 * 清单行左侧那张图是"确认这是不是我要传的那张图"的**唯一**手段。而库外文件的地址形式
 * **不由我们定**：`file:///D:/…` 是从笔记里读到的原文，而**宿主画不出来** ——
 * Chromium 拒绝从 `app://` 原点的页面加载 `file://` 子资源（那正是"协议白名单"
 * 那句话的适用范围）。用户看到的就是「列表上有对应文件了，但是**预览看不到**」：
 * D-44 把那处加工撤销、把原地址递了出去，**判定的结果就是它不显示**。
 *
 * 宿主自己的做法是给一个**前缀**（`Platform.resourcePathPrefix`）——它的文档写着
 * *"The path prefix for resolving **local files** on this platform"*：移动端是 `file:///`、
 * 桌面是 `app://random-id/`（取代旧的 `app://local/`）。⭐ 拼的是**绝对路径** ——
 * 移动端那一档要是拼库里相对路径就毫无意义，所以这个前缀存在的意义正是"前缀 + 绝对路径"。
 *
 * ⚠️ 而**原来那条地址仍留在候选里**：我们对宿主内部协议的了解只到"文档这么写"这一步，
 * 而"画不出来"的代价仅仅是降级成类型标记（`ui/file-cards.ts::renderThumb` 的 `onerror`）。
 * ⇒ 优先用宿主自己的前缀，不行就退回原文 —— **把决定权留给运行时**（D-44 记下的那条）。
 *
 * ⚠️ 三个入参都按 `unknown` 收、不给就少给一条候选：调用方那边 `localPathFromUrl` 可能解析不出来
 *（不是本机路径 / 形态不认识），这时**只有原地址**这一条候选 —— 不给空串、也不抛错。
 */
export function localThumbCandidates(input: { url: unknown; path: unknown; prefix: unknown }): string[] {
	const url = typeof input.url === "string" ? input.url.trim() : "";
	const path = typeof input.path === "string" ? input.path.trim() : "";
	const prefix = typeof input.prefix === "string" ? input.prefix.trim() : "";
	const candidates: string[] = [];
	if (path && prefix) candidates.push(prefix + path);
	if (url) candidates.push(url);
	// 去重：移动端那个前缀就是 `file:///`，两条会撞成同一个地址
	return [...new Set(candidates)];
}

/**
 * 读一份本机文件的结局。 */
export type LocalFileReadResult =
	| { status: "ok"; bytes: Uint8Array; name: string; ext: string }
	| { status: "missing" }
	| { status: "too-large"; size: number }
	| { status: "unreadable"; error: unknown };

/** 读取接缝（测试注入替身用；默认实现是 `readLocalFileBytes`）。 */
export type LocalFileReader = (
	path: string,
	options: { maxBytes?: number }
) => Promise<LocalFileReadResult>;

/**
 * 「这份本机文件**现在还读得到吗**」的探测接缝（默认实现是 `localFileExists`）。
 *
 * ⚠️ 与 `LocalFileReader` 分开：那个**读字节**（一次 `readFile` 把整份文件搬进内存），
 * 这个只回答"在不在"。列清单的阶段只能用它 —— 那一层还没有任何"用户同意读它"。
 */
export type LocalFileProbe = (path: string) => Promise<boolean>;

/**
 * 这份本机文件**现在还读得到吗**：只 `stat`，**不读一个字节**。
 *
 * ## 为什么必须问这一句（2026-10-16 用户实测报的）
 *
 * `decideLocalFile` 是**纯**判据（不碰磁盘 —— "读得到吗"由读取层回答），于是
 * **文件早被删掉**的地址照样会进候选清单，而它**必然失败**。临时目录里的东西
 * （WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存）天天在消失 —— 用户看到的就是
 * **一行没有缩略图、点了一定失败**的条目，他的原话：「没有缩略图的文件实际上已经不存在了，
 * 不应该上传，即便上传也会失败」。
 * ⇒ 列清单之前先问一句。**不问内容、只问在不在**：`stat` 不读字节，
 * 与"逐份勾选才读"那条纪律不冲突（真正读字节仍在同意之后，见 `LocalFileReader`）。
 *
 * ⚠️ 取 `fs` 这一步写在函数里（与 `readLocalFileBytes` 同一条理由：顶层导入会让**手机端
 * 整个插件加载失败**）。手机上这条路根本不会被调用 —— `decideLocalFile` 在平台那一步就拦了。
 */
export async function localFileExists(path: string): Promise<boolean> {
	// ⚠️ 取 `fs` 这一步**放在 try 外面**：它失败 = 这台机器上根本读不到本机文件
	//（不是"这份文件不在"）—— 两件事混成一档，症状就是用户看到"文件明明在却说找不到"。
	// 让它抛出去，由命令层如实报出来；下面那个 `catch` 只管**文件自己**的事。
	const fs = fsPromises();
	try {
		const info = await fs.stat(path);
		return info.isFile();
	} catch (error) {
		// ⭐⭐ **只有"确实没有这条路"才算"不在"**（判据是 `isMissingError`，一处定义）。
		//
		// ⚠️⚠️ 其余**一律不能**当成"不在"（2026-10-16 用户实测报的：那份
		// `D:/企业微信文件/…/企业微信截图_…png` **74909 字节、就在磁盘上**，而清单里
		// 说它"已经找不到了"）。权限、被占用、路径过长、设备不可用……这些都会让 `stat` 抛，
		// 而它们说的都是"**这台机器上读不到**"，不是"这张图没了"。
		if (isMissingError(error)) return false;
		// 分类说不清的，如实说出去（命令层会把这条错误显示出来）——
		// ⚠️ 让"本机文件全被判成不在"这件事**有人看得见**，而不是靠一条静默的 `false` 撑着。
		console.warn(`[attachment-cloud-cache] 本机文件探测失败（不是「不在」）：${path}`, error);
		throw error;
	}
}

/**
 * 这个 `fs` 错误算不算"**这份文件确实不在**"。
 *
 * ⭐⭐ 只有两种：`ENOENT`（没有这条路）与 `ENOTDIR`（路中间有一段不是目录）。
 * **其余一律不算** —— 权限、被占用、路径过长、设备不可用……它们说的都是
 * "**这台机器上读不到**"，不是"这张图没了"。
 *
 * ⚠️⚠️ 判据**只此一份**，`localFileExists` 与 `readLocalFileBytes` 共用：
 * 两处各写一遍"哪些 code 算不在"，迟早分叉成"清单说它不在、真去读又读得到"。
 *
 * ⚠️ 为什么必须把这两件事分开（2026-10-16 用户实测报的）：那份
 * `D:/企业微信文件/…/企业微信截图_…png` **74909 字节、就在磁盘上**，
 * 而清单里说它「已经找不到了」。把"读不到"当成"不在"的代价是**用户被误导** ——
 * 他会以为链接坏了、甚至去删笔记里那条引用。
 */
export function isMissingError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * 从本机磁盘读一份文件。**桌面专有**（手机上调它会抛 —— 所以调用点都在平台判据之后）。
 *
 * ⚠️ **先 `stat` 再 `readFile`**：不先量大小的后果是"一份 2 GB 的文件被整个读进内存"，
 * 而那正是这个上限要防的事。同理，大小上限是**安全阀**（不是用户偏好）—— 别做成设置项。
 */
export async function readLocalFileBytes(
	path: string,
	options: { maxBytes?: number } = {}
): Promise<LocalFileReadResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_LOCAL_FILE_MAX_BYTES;
	// ⚠️ 同 `localFileExists`：取 `fs` 在 try 外面 —— "这台机器读不了本机文件"与
	// "这份文件读不了"是两件事，混进下面的 `unreadable` 会让用户按错的方向去查。
	const fs = fsPromises();
	try {
		const info = await fs.stat(path);
		if (!info.isFile()) return { status: "unreadable", error: new Error("不是普通文件") };
		if (info.size > maxBytes) return { status: "too-large", size: info.size };
		const data = await fs.readFile(path);
		const name = baseNameOfLocalPath(path);
		return { status: "ok", bytes: new Uint8Array(data), name, ext: extensionOfName(name) };
	} catch (error) {
		// 文件被删/挪走是最常见的一种，单独成一个结局：它值得一句**具体**的话
		//（"那个文件不在了"），而不是混进"读不了"。
		// ⚠️ 判据与 `localFileExists` **同一份**（`isMissingError`）：两处各写一遍
		// "哪些 code 算不在"，迟早分叉成"清单说它不在、真去读又读得到"。
		if (isMissingError(error)) return { status: "missing" };
		return { status: "unreadable", error };
	}
}
