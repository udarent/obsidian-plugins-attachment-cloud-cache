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
 * 1. **只走显式入口** —— 「缓存站外文件（可挑选）」的勾选 / 批量命令的确认框。
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
 * ## ⚠️ 懒加载 `node:fs`
 *
 * 产物是 **CJS 单文件**（`esbuild.config.mjs`：`format: "cjs"`，Node 内置模块列在 `external` 里），
 * 于是**顶层** `import "node:fs/promises"` 会在手机端**加载插件时**就抛错 ——
 * 那不是"这个功能不可用"，而是**整个插件都装不上**。所以 `readLocalFileBytes` 把 `import()`
 * 写在函数体里（cjs + external 下 esbuild 会把它编译成**调用时才 require**），
 * 而且调用点全都在 `decideLocalFile` 说了"桌面 + 可读"之后。
 */

import { contentTypeForExtension, extensionOfName, isEmbeddable } from "./vault-files";

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

/** 读一份本机文件的结局。 */
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
	try {
		// ⚠️ `import()` 写在函数里（而不是顶层）：见模块头"懒加载 node:fs"那段 ——
		// 顶层导入会让**手机端整个插件加载失败**。
		const fs = await import("node:fs/promises");
		const info = await fs.stat(path);
		if (!info.isFile()) return { status: "unreadable", error: new Error("不是普通文件") };
		if (info.size > maxBytes) return { status: "too-large", size: info.size };
		const data = await fs.readFile(path);
		const name = baseNameOfLocalPath(path);
		return { status: "ok", bytes: new Uint8Array(data), name, ext: extensionOfName(name) };
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		// 文件被删/挪走是最常见的一种，单独成一个结局：它值得一句**具体**的话
		//（"那个文件不在了"），而不是混进"读不了"。
		if (code === "ENOENT") return { status: "missing" };
		return { status: "unreadable", error };
	}
}
