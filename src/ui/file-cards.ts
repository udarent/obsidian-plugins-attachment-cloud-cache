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
	 * 行里的**副标题**（第二行的小字）：路径、站点、出现在哪篇笔记里这类
	 * "能让用户核对是哪一个"的信息。空串 = 不画第二行。
	 */
	meta?: string;
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
	/** 副标题（第二行小字）；空串 = 不画。 */
	meta: string;
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
		const label = name || id;
		// 扩展名从**名字**取（它与 key 里的那份可能是同一件事，但名字是用户认得的那个）
		const ext = extensionOfName(name) || extensionOfName(id);
		const badge = ext ? ext.toUpperCase() : "";

		let thumbUrls: readonly string[] = [];
		let fromLocalCopy = false;
		if (embedKindFor(ext) === "image") {
			// 调用方给的地址：**一个字符串就是一串只有一条的候选**（站外那条路就这样给）。
			// ⚠️ 归一化只此一处 —— 两条入口各自把单值/数组揉一遍，迟早出现"一个认、一个不认"。
			const explicit = (typeof item.thumb === "string" ? [item.thumb] : item.thumb ?? [])
				.map((url) => (typeof url === "string" ? url.trim() : ""))
				.filter((url) => url !== "");
			const local = typeof item.localPath === "string" ? item.localPath.trim() : "";
			const localUrl = local ? deps.resourceUrl(local) : null;
			if (explicit.length > 0) {
				// 站外地址 / 本机得到的候选：这一串就是图本身（第一个能画出来的算数）
				thumbUrls = explicit;
			} else if (localUrl) {
				thumbUrls = [localUrl];
				fromLocalCopy = true;
			} else {
				const key = typeof item.remoteKey === "string" ? item.remoteKey.trim() : "";
				const remote = key ? deps.remoteUrl(key) : null;
				thumbUrls = remote ? [remote] : [];
			}
		}

		cards.push({
			id,
			label,
			badge,
			thumbUrls,
			fromLocalCopy,
			meta: typeof item.meta === "string" ? item.meta.trim() : "",
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
			//（一次最多 200 行，见 `task-list-modal.ts`），打开时最多只建这么多 `<img>`。
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

/** 把清单画进容器（`Modal.contentEl` / 确认框正文）：只读的一列（缩略图 + 名字 + 副标题）。 */
export function renderFileCards(container: HTMLElement, cards: readonly FileCard[]): void {
	for (const card of cards ?? []) {
		if (!card) continue;
		const row = container.createDiv({ cls: "acc-file-card" });
		renderThumb(row, card);
		row.createSpan({ cls: "acc-file-name", text: card.label });
		// ⚠️ 副标题是**兄弟节点、不是包一层**：这一列的 DOM 形状已经有一处断言钉着
		// （`file-cards-suite` 按 `children[1]` 取名字），包一层会让它静默换个位置。
		if (card.meta) row.createSpan({ cls: "acc-file-meta", text: card.meta });
	}
}
