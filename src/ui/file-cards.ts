/**
 * 「确认框里那张清单」怎么展示 —— 要用户逐项核对的确认框共用
 * （孤儿询问、云端清理；1.2.0 起 `clean-cache` 退役，它那份清单也走这里）。
 *
 * ## 它补的是什么
 *
 * 两处确认框都要列出"即将被删掉的对象"，而它们能给的只有**对象 key**
 * （`<名字>-<sha256>.<扩展名>`）与（有的话）**本地路径**。光看那串十六进制，
 * 用户**认不出是哪张图** —— 而清单正是他按下按钮前唯一能用来核对的信息。
 * 按下之后不可恢复。
 *
 * 所以每一行给两样东西：**能认出来的图**（有本地副本就用它 —— 零网络；
 * 否则用存储里的地址）与**名字**（索引里记的原始文件名；没有就退化成 key ——
 * 那是我们唯一还能说的事实，不编造一个看起来像名字的东西）。
 *
 * ## ⚠️ 缩略图**只给图片**，别的一律显示类型标记
 *
 * "能不能用 `<img>` 显示"由**类型表**决定（复用 `embedKindFor`/`extensionOfName`，
 * 与链接生成、渲染共用同一套判定）。PDF / 音频 / 视频塞进 `<img>` 只会得到一个破图，
 * 那比"显示一个 PDF 标记"更糟 —— 与"宁可不显示，也不要显示一个可能不对的东西"同一条纪律。
 *
 * ## 为什么判定与渲染分成两层
 *
 * 取地址要用宿主的 API（`getResourcePath`）与设置（`publicUrlFor`）——
 * 那些从外面**注入** ⇒ 判定（`planFileCards`）是纯函数、可以穷举；
 * 渲染（`renderFileCards`）只剩"把结果画出来"这一件事。
 * 本项目的弹窗层进不了单测（宿主的 `Modal` 只能真机驱动），所以能搬进纯函数的部分都要搬。
 */

import { embedKindFor, extensionOfName } from "../vault-files";

/**
 * 一行能"打开"到哪里（2026-10-22，D-66）。
 *
 * ⭐ 为什么分成两类而不是只给一个字符串：**打开方式由目标种类决定**，而两者的失败方式
 * 完全不同 —— 库内文件可能**已经不在了**（宿主会给我们 `null`），库外地址则可能
 * 打不开浏览器。让判据在纯函数里定种类，打开那一侧就只剩"照做"。
 */
export type FileCardOpenTarget =
	/** 库内文件（vault 相对路径）：交给宿主用它自己的视图打开。 */
	| { kind: "vault"; value: string }
	/** 库外地址（站外 `http(s)`）：交给系统浏览器。 */
	| { kind: "url"; value: string };

/**
 * 一格里的一句话，以及**它该是什么语气**（2026-10-23，列表改成多列时加的）。
 *
 * ⚠️ 语气由**调用方**给，不在这里由文案猜：判 `text === "已上传"` 来上色，文案一改颜色就没了，
 * 而且是静默的。`tone` 只描述"这件事的性质"，具体颜色在 `styles.css` 一处定。
 */
export type FileCardCellTone = "muted" | "ok" | "warn" | "accent";

/** 表格模式下的**一格**（键与 `TaskListColumn.key` 对应；缺的键就是空格）。 */
export interface FileCardCell {
	text: string;
	tone?: FileCardCellTone;
	/** 悬停说明（`title`）：留全文的地方 —— 格子里一律单行省略。 */
	title?: string;
}

/** 清单里的一项：调用方给得出多少就给多少（缺的那部分自然降级）。 */
export interface FileCardInput {
	/**
	 * 主标识。没有名字时**退化成它显示给用户**。
	 *
	 * 两处入口传的都是**对象 key**；本地路径由索引里的 `cachePath` 补上
	 * （有就比 key 更有信息量：`keep` 档那条路径就是用户自己的附件）。
	 */
	id: string;
	/** 索引里记的原始文件名（可能没有 —— 「不留副本」档没有条目）。 */
	name?: string;
	/** 本地副本的 vault 相对路径（有 ⇒ 缩略图**零网络**）。 */
	localPath?: string;
	/** 由它推导远端地址（孤儿询问与云端清理两条路都有 key）。 */
	remoteKey?: string;
	/**
	 * **调用方直接给一个地址**当缩略图 —— 优先于上面两条推导。
	 *
	 * 给谁用：站外图（地址就是那个 URL）与本机文件（`file:///D:/…`）——
	 * 它们的图不在库里、也不是本存储的对象，前两条推导对它们都无从下手。
	 * ⚠️ 仍然**只对图片类型**生效（见设计 §7.3.2）：非图片给一个 URL 只会得到破图。
	 *
	 * ⚠️⚠️ 也可以给**一串候选**（按优先次序）：库外文件那条路必须这样给 ——
	 * 它的地址形式不由我们定（`file:///…` 在宿主里画不出来，而"宿主认哪种形式"
	 * 由运行时说了算，见 `local-file.ts::localThumbCandidates`）。
	 * 渲染时逐个试、全失败才降级成类型标记。
	 */
	thumb?: string | readonly string[];
	/**
	 * 行内的**小标签**（紧跟名字）：目前只有一种用法 —— 「**没有被任何笔记引用**」（D-68）。
	 *
	 * ⚠️ 与 `meta` 分开两个字段：`meta` 说的是"它在哪"（路径 / 主机），
	 * 这里是"它有什么特别之处"。拼成一行会让两者在长路径下互相遮蔽，
	 * 而这条标签正是用户判断"要不要勾它"的唯一依据。
	 */
	hint?: string;
	/**
	 * 行内小标签的**图标**（lucide 名，如 `alert-triangle`）。给了就**只画图标**，
	 * `hint` 变成它的悬停说明（`title` / `aria-label`）。
	 *
	 * ⭐ 2026-10-22（D-71，用户要求）：失效的附件不要在文案里读，**在列表里用图标标出来**。
	 * ⚠️ 这一层**不 import 宿主**（文件头那条纪律），所以真正的图标由清单壳
	 * （`ui/task-list-shell.ts`，它本来就 import `obsidian`）去画；这一层只把名字带过去。
	 * 只读清单（`renderFileCards`）拿不到图标 API ⇒ 退回显示 `hint` 文字
	 * （那几条链没有"图标"这个场景，显示文字也说得清）。
	 */
	hintIcon?: string;
	/**
	 * 行里的**副标题**（第二行的小字）：路径、站点、出现在哪篇笔记里这类
	 * "能让用户核对是哪一个"的信息。空串 = 不画第二行。
	 */
	meta?: string;
	/**
	 * 「打开」这一下要去哪（D-66）。
	 *
	 * 缺省（不传）时**自动推导**：有本地副本 ⇒ 库内文件；有远端地址 ⇒ 那个地址。
	 * 给 `null` 是**明确的"这一行不给打开"**（本机 `file:///…` 那条就是：宿主与浏览器
	 * 都不认它，画一个点了没反应的链接比不画更糟）—— 所以这里区分"没给"与"给了 null"。
	 */
	open?: FileCardOpenTarget | null;
	/**
	 * 这一行末尾那颗链接的**文案**（缺省用界面的统一文案「打开」）。
	 *
	 * 给谁用：**已经失效**的附件那一行 —— 它自己打不开了（文件已经不在了），
	 * 链接去的是**引用它的那篇笔记**（D-70），文案得说"打开笔记"而不是"打开"。
	 */
	openLabel?: string;
	/**
	 * 能不能勾选。**缺省 `true`**。
	 *
	 * ⭐ 给 `false` 的是"只摆出来给你看 / 点"的行（D-70：失效的附件）——
	 * 它们**必然做不成任何事**，而清单里出现一个"勾了也不会被处理"的行，
	 * 用户会以为插件漏了它（本项目那条纪律：清单里只该出现点了能成的东西）。
	 * ⚠️ 所以这一行**不进默认勾选、全选也不选它**，界面上勾选框是禁用的。
	 */
	selectable?: boolean;
	/**
	 * 表格模式下的**各列内容**（2026-10-23，R24 的列表改成多列）。
	 *
	 * 键由调用方与 `TaskListOptions.columns` 对齐；值为字符串或 `{ text, tone, title }`。
	 * ⚠️ 与 `hint` / `meta` 是**两套并存的表达**：两行式（没给 `columns`）用"名字 ＋ 一行小字"，
	 * 表格把同一批事实摊进各自的列。别指望两边自动同步 —— 谁读哪个由容器决定。
	 */
	cells?: Readonly<Record<string, string | FileCardCell>>;
}

export interface FileCardDeps {
	/** vault 相对路径 → 能直接放进 `img[src]` 的地址；拿不到（文件不在）时 `null`。 */
	resourceUrl: (vaultPath: string) => string | null;
	/** 由 key 推导的远端地址；推不出来时 `null`。 */
	remoteUrl: (key: string) => string | null;
}

/**
 * 站外 / 本机那一类行的**副标题**。⚠️ **全库只有这一处拼它。**
 *
 * ## 取值（只有两档，**都不含库内路径**）
 *
 * - 本机文件（`file:///D:/…`）**没有主机** ⇒ 给**那条绝对路径**：用户勾中它就是签了
 *   "读这条路径"，只显示一个空主机名等于让他在看不见风险的情况下点确认。
 * - 站外地址 ⇒ **只给主机**。
 *
 * ## ⚠️⚠️ 为什么**不再显示"它出自哪篇笔记"**（2026-10-16 用户**三次**报同一件事之后定）
 *
 * 原来这一行是 `主机 — 笔记路径`（含 `.md`）。用户每一轮都把它读成
 * "**清单里进了一个 `.md` 文件**"：第一次我加了「笔记：」前缀、第二次去掉后缀
 * —— 两次都被否掉（第二次他直接说「不是界面显示的问题」）。
 * 第三次他把话说到最清楚：「**这个链接对应的文件不是附件，不应该进入上传列表**」。
 *
 * ⇒ 结论不是改文案，而是**这一行压根不该出现库内路径**：
 * 它只是"来自哪个站点"的**元信息**；"会改写哪篇笔记"由**运行结果**说
 *（`Rewrote N link(s) across M note(s)`），不需要在这里列出来。
 * ⭐ 而且这条规则是**结构性**的：入参里**不收** `notePath` ⇒ 想写也写不出来
 *（比"写一条规则再指望没人违反"稳）。
 * ⚠️ 代价（认了）：全库范围下同一个地址出现在两篇笔记里时，两行看起来一样 ——
 * 勾的是**地址**，不是笔记。
 */
export function externalRowMeta(input: { host?: unknown; url?: unknown } | null | undefined): string {
	const host = typeof input?.host === "string" ? input.host.trim() : "";
	const url = typeof input?.url === "string" ? input.url.trim() : "";
	// 主机为空 = 本机文件那条路 ⇒ 给绝对路径（唯一的例外，也是承重的那半）
	return host || url;
}

/** 一行清单。 */
export interface FileCard {
	/** 与输入的 `id` 同一份（调用方按它回查要删什么 / 要处理什么）。 */
	id: string;
	/** 显示给用户的名字：原始文件名，没有就是 `id`。 */
	label: string;
	/**
	 * **纯文件名**（不带目录），表格模式的"名称"列用它；缺省时等于 {@link label}。
	 *
	 * ⚠️ 为什么要和 `label` 分开：`label` 是**完整路径**（D-66：拆成"名字 + 目录"两行时，
	 * 库根目录的文件与没有本地副本的对象推不出路径）。而表格把"位置"放进了**单独一列**，
	 * 名称列里再带路径就是重复 —— 两种形态要的东西不一样，所以这里给两个字段，不猜。
	 */
	fileName: string;
	/** 表格模式下各列的内容（见 {@link FileCardInput.cells}）；非表格模式不读它。 */
	cells: Readonly<Record<string, FileCardCell>>;
	/** 类型标记（大写扩展名，如 `PDF`）；拿不到扩展名时是空串。 */
	badge: string;
	/**
	 * 缩略图候选地址（按优先次序，空数组 = 不给图）：
	 * 非图片、或两个来源都拿不到地址时是空的。
	 *
	 * ⚠️ 为什么是**一串**：库外文件（站外 / 本机）的地址形式不由我们定 ——
	 * 渲染时逐个试，全失败才降级成类型标记（见 `renderThumb`）。
	 */
	thumbUrls: readonly string[];
	/** 缩略图来自**本地副本**（= 不联网）。 */
	fromLocalCopy: boolean;
	/**
	 * 副标题（第二行小字）；空串 = 不画。
	 *
	 * - **站外 / 本机** ⇒ 由调用方给（主机 / 绝对路径，见 `externalRowMeta`）；
	 * - **库内文件** ⇒ **空**：完整路径已经是主文本（`label`）了，再给一行就是重复。
	 *
	 * ⚠️ 这里的值**绝不是库内路径**（站外行那三次误读的教训，见 `externalRowMeta`）。
	 */
	meta: string;
	/**
	 * 行内的小标签（紧跟名字）；空串 = 不画。
	 *
	 * ⚠️ 它**不是**副标题：`meta` 说"在哪"（路径 / 主机），这里说"有什么特别"。
	 */
	hint: string;
	/**
	 * 行内小标签的图标（lucide 名）；空串 = 画 `hint` 的文字。
	 *
	 * ⚠️ 有它时**只画图标**，`hint` 只作 `title` / `aria-label`（见 `FileCardInput.hintIcon`）。
	 */
	hintIcon: string;
	/** 「打开」的目标（见 {@link FileCardOpenTarget}）；`null` = 这一行不给打开。 */
	open: FileCardOpenTarget | null;
	/** 末尾那颗链接的文案；空串 = 用界面的统一文案（见 `FileCardInput.openLabel`）。 */
	openLabel: string;
	/** 能不能勾选（`false` = 只摆出来看 / 点，见 `FileCardInput.selectable`）。 */
	selectable: boolean;
}

/**
 * 把入参里的 `cells` 归一化（字符串 ⇒ `{ text }`；丢掉空键与空文本）。
 *
 * ⚠️ 归一化只此一处：两个入口各自揉一遍，迟早出现"一个认字符串、一个不认"。
 */
function normalizeCells(
	raw: Readonly<Record<string, string | FileCardCell>> | null | undefined
): Record<string, FileCardCell> {
	const out: Record<string, FileCardCell> = {};
	for (const [key, value] of Object.entries(raw ?? {})) {
		if (!key) continue;
		if (typeof value === "string") {
			const text = value.trim();
			if (text !== "") out[key] = { text };
			continue;
		}
		if (!value || typeof value !== "object") continue;
		const text = typeof value.text === "string" ? value.text.trim() : "";
		if (text === "") continue;
		const cell: FileCardCell = { text };
		if (value.tone) cell.tone = value.tone;
		const title = typeof value.title === "string" ? value.title.trim() : "";
		if (title !== "") cell.title = title;
		out[key] = cell;
	}
	return out;
}

/**
 * 把清单里的每一项算成"怎么展示"（纯函数）。
 *
 * 缩略图地址的优先级：**调用方直接给的** > **本地副本** > **远端地址**。
 * 中间的"本地副本优先"是刻意的：它是磁盘上已经存在的那一份，显示它既不联网、
 * 也正好是"你库里那份"。拿不到（文件被删/不在宿主索引里）才退到远端地址。
 * 最前面那一档给"图根本不在库里"的两类（站外图、本机文件）用。
 */
export function planFileCards(
	items: readonly FileCardInput[],
	deps: FileCardDeps
): FileCard[] {
	const cards: FileCard[] = [];

	for (const item of items ?? []) {
		if (!item || typeof item !== "object") continue;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!id) continue;

		const name = typeof item.name === "string" ? item.name.trim() : "";
		const local = typeof item.localPath === "string" ? item.localPath.trim() : "";
		/**
		 * 行里**显示的那串**：库内文件给**完整路径**（`attachments/图 1.png`）。
		 *
		 * ⭐ 2026-10-22（D-66）参照 File Cleaner Redux 的做法（它的行文本就是 `file.path`）：
		 * 用户要的是"文件名带路径"，而拆成"名字一行 + 目录一行"时，**库根目录的文件**
		 * 与**没有本地副本的对象**那两行根本推不出路径 ⇒ 他实测「清理」命令后报「没有完整路径」。
		 * 一条路径做主文本，两种情况都自然覆盖；站外 / 本机没有库内路径 ⇒ 退回文件名。
		 */
		const label = local || name || id;
		// 扩展名从**名字**取（它与 key 里的那份可能是同一件事，但名字是用户认得的那个）
		const ext = extensionOfName(name) || extensionOfName(id);
		const badge = ext ? ext.toUpperCase() : "";

		const key = typeof item.remoteKey === "string" ? item.remoteKey.trim() : "";
		// ⚠️ 远端地址**只算一次**：缩略图与「打开」都要用它 —— 两处各算一次，
		// 迟早出现"图能显示、点开却没有地址"（或者反过来）。
		const remote = key ? deps.remoteUrl(key) : null;

		let thumbUrls: readonly string[] = [];
		let fromLocalCopy = false;
		if (embedKindFor(ext) === "image") {
			// 调用方给的地址：**一个字符串就是一串只有一条的候选**（站外那条路就这样给）。
			// ⚠️ 归一化只此一处 —— 两条入口各自把单值/数组揉一遍，迟早出现"一个认、一个不认"。
			const explicit = (typeof item.thumb === "string" ? [item.thumb] : item.thumb ?? [])
				.map((url) => (typeof url === "string" ? url.trim() : ""))
				.filter((url) => url !== "");
			const localUrl = local ? deps.resourceUrl(local) : null;
			if (explicit.length > 0) {
				// 站外地址 / 本机得到的候选：这一串就是图本身（第一个能画出来的算数）
				thumbUrls = explicit;
			} else if (localUrl) {
				thumbUrls = [localUrl];
				fromLocalCopy = true;
			} else {
				thumbUrls = remote ? [remote] : [];
			}
		}

		// 副标题只留**不是路径**的那种信息：站外=主机、本机=绝对路径（见 `externalRowMeta`）。
		// ⚠️ 库内文件的主文本已经是完整路径了，再给一行就是重复。
		// ⚠️ 站外 / 本机**不给库内路径** —— 那条界线是 2026-10-16 用户三次误读之后定的。
		// 打开：调用方给的最优先（`null` = 明确不给）；否则按"本地副本 ⇒ 库内文件、
		// 有远端地址 ⇒ 那个地址"推导。推导不出来的（本机 `file:///…`）就是不给。
		const open: FileCardOpenTarget | null =
			item.open === null
				? null
				: item.open ??
					(local
						? { kind: "vault", value: local }
						: remote
							? { kind: "url", value: remote }
							: null);

		cards.push({
			id,
			label,
			// 文件名：没有名字（云端对象、或只给了 key）时退回 id —— 那是唯一还能说的事实
			fileName: name || id,
			cells: normalizeCells(item.cells),
			badge,
			thumbUrls,
			fromLocalCopy,
			// 调用方给了就用它（站外=主机、本机=绝对路径）；库内行没有副标题可给
			meta: typeof item.meta === "string" ? item.meta.trim() : "",
			hint: typeof item.hint === "string" ? item.hint.trim() : "",
			hintIcon: typeof item.hintIcon === "string" ? item.hintIcon.trim() : "",
			open,
			openLabel: typeof item.openLabel === "string" ? item.openLabel.trim() : "",
			// ⚠️ 只有**明确 `false`** 才不可选：缺省/`undefined` 一律可选 ——
			// 反过来（"只有 true 才可选"）会让所有既有调用方**静默**变成不可勾选。
			selectable: item.selectable !== false,
		});
	}

	return cards;
}

/**
 * 画**一个缩略图**（图或类型标记）—— 所有列表界面共用这一份。
 *
 * ⚠️ 用 `attr` 写 `src`（= `setAttribute`）而**不是** `img.src = …`：
 * 渲染钩子改写了 `HTMLImageElement.prototype.src` 的 setter，而那一层是**为笔记内容**服务的
 * （把远端地址换成本地副本；缺副本时还会**触发回退下载**）。用在这里是错的：
 * ① 这张图跟笔记无关，被换成另一份地址没有意义；
 * ② "缺副本"那一种情况下它会去**下载**对象 —— 而这个对话框问的正是"要不要删掉它"。
 *
 * ⚠️ 图加载不出来时**静默降级成类型标记**：破图图标比"没有图"更像一个故障，
 * 而它最常见的成因（桶私有 / 匿名读没开 / 文件已不在 / 站外地址过期）都不是故障。
 */
export function renderThumb(container: HTMLElement, card: FileCard): void {
	const thumb = container.createSpan({ cls: "acc-file-thumb" });
	const candidates = card.thumbUrls ?? [];
	const [first] = candidates;
	if (first) {
		const image = thumb.createEl("img", {
			cls: "acc-file-thumb-img",
			// `alt` 留空：名字就在旁边，读屏软件重复念一遍没有信息量
			//
			// ⚠️⚠️ **不许加 `loading: "lazy"`**（2026-10-15 用户真机报「.png 缩略图不显示图片」）。
			//
			// 那一行当时是相对**既有可用**的清单渲染（云端清理那个弹窗）**唯一**的变化，
			// 而原生懒加载在宿主的弹窗容器里不可靠：`.modal-container`/`.modal` 带
			// `transform` + `opacity` 的开合动画，滚动根与合成层判定都会被搅乱，
			// 最坏的结果不是"晚一点加载"而是**永远不加载**（图不出现、也不触发 `onerror`，
			// 于是连"降级成类型标记"都走不到 —— 那正是用户看到的样子）。
			//
			// ⚠️ 性能要求（用户同日提的"文件太多会卡"）**不靠它**兜：清单是**分块画**的
			//（一次最多 200 行，见 `task-list-shell.ts` 的 `ROW_DRAW_CHUNK`），打开时最多只建这么多 `<img>`。
			// 取舍写在这里：宁可首屏多几个请求，也不要"图根本不出来"这种看不见的坏掉。
			attr: { src: first, alt: "" },
		});
		// ⚠️ 候选是**一串**（库外文件那条路会给多条，见 `local-file.ts::localThumbCandidates`）：
		// 这张画不出来就试下一张，全试完才降级 —— ⭐ **把"宿主认哪个形式"交给运行时**，
		// 而不是我们在构建清单时替它挑一个（这条链上"替宿主提前断言"已经错过两次）。
		let index = 0;
		image.onerror = () => {
			index += 1;
			const next = candidates[index];
			if (next) {
				// ⚠️ 必须走 `setAttribute` —— 理由与上面那个 `attr` 完全一样：
				// 渲染钩子改写了 `HTMLImageElement.prototype.src` 的 setter。
				image.setAttribute("src", next);
				return;
			}
			image.remove();
			thumb.addClass("acc-file-badge");
			thumb.setText(card.badge);
		};
	} else {
		thumb.addClass("acc-file-badge");
		thumb.setText(card.badge);
	}
}

/**
 * 渲染层的两个注入项（**每个清单都必须传 `onOpen`**，否则那一列没有「打开」）。
 *
 * ⚠️ 为什么"处理器"要注入而不是在这里直接调宿主：这一层刻意不 import `App`
 * （`planFileCards` 是纯函数、渲染只碰 DOM），真机行为由 `main.ts` 那边接
 *（与 `fileCards()` 的同一条分工：判定在纯函数、接线在装配点）。
 */
export interface FileCardHandlers {
	/** 「打开」的文案（i18n）。空 = 用 `↗` 兜底，不留一个空链接。 */
	openLabel?: string;
	/** 点「打开」。**没给就不画链接** —— 点不动的链接比没有链接更糟。 */
	onOpen?: (target: FileCardOpenTarget) => void;
}

/**
 * 把一行末尾的「打开」画出来。
 *
 * ⚠️⚠️ 位置固定在**行的最后一个子节点**：名字在 `children[1]` 这件事有断言钉着
 *（`file-cards-suite` 按索引取名字），把链接插到名字前面会让它静默指向别的东西。
 */
function renderOpen(container: HTMLElement, card: FileCard, handlers: FileCardHandlers): void {
	const target = card.open;
	if (!target) return;
	const onOpen = handlers.onOpen;
	if (!onOpen) return;
	// ⚠️ `as unknown as`：`HTMLAnchorElement.onclick` 的签名带 `this` 与 `MouseEvent`，
	// 而这里只需要"赋一个可被替身调用的函数" —— 替身（渲染测试）没有事件系统。
	const link = container.createEl("a", {
		cls: "acc-file-open",
		// 行自己的文案优先（失效附件那一行的链接去的是**笔记**，见 `FileCardInput.openLabel`）
		text: card.openLabel?.trim() || handlers.openLabel?.trim() || "↗",
		// ⚠️ `target ? … : ""` 而不是 `target.value`：这条判据万一被改坏，症状要是
		// "画了一个点不动的链接"（有断言钉着），而不是在这里抛 TypeError 把整行吞掉。
		attr: { href: "#", title: target ? target.value : "" },
	}) as unknown as { onclick?: (event?: { preventDefault?: () => void }) => void };
	// ⚠️ 用 `onclick` 而不是 `addEventListener`：渲染测试用的是记账替身（没有事件系统），
	// 而 `onclick` 在真 DOM 与替身上都是"赋一个函数"这一件事。
	link.onclick = (event) => {
		// 别让 `#` 把弹窗滚回顶部（真机上是可见的跳动）
		event?.preventDefault?.();
		onOpen(target);
	};
}

/** 把清单画进容器（`Modal.contentEl` / 确认框正文）：只读的一列（缩略图 + 名字 + 目录 + 打开）。 */
export function renderFileCards(
	container: HTMLElement,
	cards: readonly FileCard[],
	handlers: FileCardHandlers = {}
): void {
	for (const card of cards ?? []) {
		if (!card) continue;
		const row = container.createDiv({ cls: "acc-file-card" });
		renderThumb(row, card);
		row.createSpan({ cls: "acc-file-name", text: card.label });
		// ⭐ 小标签紧跟名字（D-68）：名字仍是 `children[1]`，它只往后排 ——
		// 已有断言按 `children[1]` 取名字，插在名字**之前**会让那条断言静默指向别处。
		// ⚠️ 有 `hintIcon` 时这一层仍显示文字（它不 import 宿主 ⇒ 画不了图标），
		// 但把 `title` 补上 —— 同一个字段在两条渲染路径上的语义不能一半有一半没有。
		if (card.hint) {
			const tag = row.createSpan({ cls: card.hintIcon ? "acc-file-hint acc-file-hint-icon" : "acc-file-hint", text: card.hint });
			if (card.hintIcon) tag.setAttribute("title", card.hint);
		}
		// ⚠️ 副标题是**兄弟节点、不是包一层**：这一列的 DOM 形状已经有一处断言钉着
		// （`file-cards-suite` 按 `children[1]` 取名字），包一层会让它静默换个位置。
		if (card.meta) row.createSpan({ cls: "acc-file-meta", text: card.meta });
		// 「打开」永远在最后（理由见 `renderOpen`）
		renderOpen(row, card, handlers);
	}
}
