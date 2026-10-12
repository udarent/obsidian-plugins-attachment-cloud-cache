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
}

export interface FileCardDeps {
	/** vault 相对路径 → 能直接放进 `img[src]` 的地址；拿不到（文件不在）时 `null`。 */
	resourceUrl: (vaultPath: string) => string | null;
	/** 由 key 推导的远端地址；推不出来时 `null`。 */
	remoteUrl: (key: string) => string | null;
}

/** 一行清单。 */
export interface FileCard {
	/** 与输入的 `id` 同一份（调用方按它回查要删什么）。 */
	id: string;
	/** 显示给用户的名字：原始文件名，没有就是 `id`。 */
	label: string;
	/** 类型标记（大写扩展名，如 `PDF`）；拿不到扩展名时是空串。 */
	badge: string;
	/** 缩略图地址；`null` = 不显示图（非图片，或两个来源都拿不到地址）。 */
	thumbUrl: string | null;
	/** 缩略图来自**本地副本**（= 不联网）。 */
	fromLocalCopy: boolean;
}

/**
 * 把清单里的每一项算成"怎么展示"（纯函数）。
 *
 * 地址的优先级是**本地副本优先**：它是磁盘上已经存在的那一份，
 * 显示它既不联网、也正好是"你库里那份"。拿不到（文件被删/不在宿主索引里）才退到远端地址。
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

		let thumbUrl: string | null = null;
		let fromLocalCopy = false;
		if (embedKindFor(ext) === "image") {
			const local = typeof item.localPath === "string" ? item.localPath.trim() : "";
			const localUrl = local ? deps.resourceUrl(local) : null;
			if (localUrl) {
				thumbUrl = localUrl;
				fromLocalCopy = true;
			} else {
				const key = typeof item.remoteKey === "string" ? item.remoteKey.trim() : "";
				thumbUrl = key ? deps.remoteUrl(key) : null;
			}
		}

		cards.push({ id, label, badge, thumbUrl, fromLocalCopy });
	}

	return cards;
}

/**
 * 把清单画进容器（`Modal.contentEl` / 确认框正文）。
 *
 * ⚠️ 用 `attr` 写 `src`（= `setAttribute`）而**不是** `img.src = …`：
 * 渲染钩子改写了 `HTMLImageElement.prototype.src` 的 setter，而那一层是**为笔记内容**服务的
 * （把远端地址换成本地副本；缺副本时还会**触发回退下载**）。用在这里是错的：
 * ① 这张图跟笔记无关，被换成另一份地址没有意义；
 * ② "缺副本"那一种情况下它会去**下载**对象 —— 而这个对话框问的正是"要不要删掉它"。
 *
 * ⚠️ 图加载不出来时**静默降级成类型标记**：破图图标比"没有图"更像一个故障，
 * 而它最常见的成因（桶私有 / 匿名读没开 / 文件已不在）都不是故障。
 */
export function renderFileCards(container: HTMLElement, cards: readonly FileCard[]): void {
	for (const card of cards ?? []) {
		if (!card) continue;
		const row = container.createDiv({ cls: "acc-file-card" });
		const thumb = row.createSpan({ cls: "acc-file-thumb" });

		if (card.thumbUrl) {
			const image = thumb.createEl("img", {
				cls: "acc-file-thumb-img",
				// `alt` 留空：名字就在旁边，读屏软件重复念一遍没有信息量
				attr: { src: card.thumbUrl, alt: "" },
			});
			image.onerror = () => {
				image.remove();
				thumb.addClass("acc-file-badge");
				thumb.setText(card.badge);
			};
		} else {
			thumb.addClass("acc-file-badge");
			thumb.setText(card.badge);
		}

		row.createSpan({ cls: "acc-file-name", text: card.label });
	}
}
