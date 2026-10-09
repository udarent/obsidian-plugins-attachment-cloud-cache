/**
 * 粘贴 / 拖拽的**执行**部分：读字节 → 上传编排 → 把链接插回编辑器。
 *
 * ## 判定与执行分开
 *
 * 判定（`editor/hooks.ts`）是纯函数，因为它必须在**同步**阶段完成
 * （`preventDefault()` 只能在事件派发期间调用）。执行必然是异步的
 * （要读盘、要联网），所以放在这里，并且**不受** `preventDefault` 的时机约束。
 *
 * ## 一个必须处理的现实问题：插入位置
 *
 * 上传可能耗时数秒。在这期间用户完全可能点去别处、或者切到另一个笔记 ——
 * 那时 `replaceSelection()` 会把图片插到**当前**光标处，也就是**错的地方**。
 * 所以调用方应当在前面的同步阶段**捕获**选区，执行时用 `replaceRange()` 插回原位。
 *
 * ## 失败的处置：绝不静默
 *
 * 走到这里说明宿主的原生处理已经被挡掉了，所以**每一种失败都必须有交代**：
 * - 上传失败但有本地副本 → 插本地嵌入链接 + 提示原因（图还能看，只是没上云）；
 * - 连本地副本都没有 → 明确报错（这是最坏情况，必须让用户立刻知道）。
 *
 * 只报错不插入，等于把用户的图吞了；插入一个指向不存在文件的链接，等于埋一个雷。
 */

import {
	buildLocalLink,
	buildRemoteLink,
	displayNameOf,
	type TransferFileLike,
} from "../editor/editor-hooks";
import type { IngestRequest, IngestResult } from "./ingest";
import type { PluginSettings } from "../types";
import { describeError } from "../error-text";

/** 编辑器的**最小**接口。只要这几个方法，便于用假对象穷举。 */
export interface EditorLike {
	replaceSelection(text: string): void;
	replaceRange?(text: string, from: unknown, to?: unknown): void;
}

/** 同步阶段捕获的插入位置。 */
export interface InsertPoint {
	from: unknown;
	to?: unknown;
}

export interface TransferDeps {
	settings: PluginSettings;
	/** 上传编排（注入以便测试与批处理复用同一份逻辑）。 */
	ingest: (request: IngestRequest) => Promise<IngestResult>;
	/** 用户可见提示。 */
	notify: (message: string) => void;
	/** 取文案。 */
	t: (key: string, params?: Record<string, unknown>) => string;
	/**
	 * 把库内路径渲染成**宿主语法**的链接（降级路径用）。
	 *
	 * 由接线层提供（`fileManager.generateMarkdownLink` + 一个 `TFile`），
	 * **不含 `!`** —— 嵌不嵌由 `buildLocalLink` 按可嵌入类型表决定。
	 * 取不到 `TFile` / 拿不到宿主能力时返回 `null`：那时退回我们自己拼的普通链接
	 * （比什么都不插好得多；见 `buildLocalLink`）。
	 */
	generatedLocalLink?: (vaultPath: string) => string | null;
	/** 触发这次操作的笔记路径。 */
	sourcePath?: string;
}

export interface TransferOutcome {
	/** 实际插入编辑器的文本（便于测试与排查）。 */
	text: string;
	uploaded: number;
	reused: number;
	fallback: number;
	/** 连本地副本都没保住的数量 —— 必须为 0，否则就是丢了用户的图。 */
	lost: number;
}

/** 读文件的字节。测试里给的文件对象只需实现 `arrayBuffer()`。 */
async function readBytes(file: TransferFileLike): Promise<Uint8Array> {
	if (typeof file.arrayBuffer !== "function") {
		throw new Error("无法读取文件内容（该文件对象没有 arrayBuffer 方法）");
	}
	return new Uint8Array(await file.arrayBuffer());
}


/**
 * 逐个处理文件并插入链接。
 *
 * 逐个而不是并发：粘贴多张图时顺序插入更符合直觉，且并发上传会同时占满上行
 * （移动端在这一步体验很差）。串行的代价可以接受 —— 粘贴多图的场景本来就少。
 */
export async function processTransfer(
	deps: TransferDeps,
	editor: EditorLike,
	files: TransferFileLike[],
	insertPoint?: InsertPoint
): Promise<TransferOutcome> {
	const parts: string[] = [];
	const outcome: TransferOutcome = { text: "", uploaded: 0, reused: 0, fallback: 0, lost: 0 };

	/**
	 * 插入去重：**同一次粘贴里，同一张图只插一条链接**。
	 *
	 * 剪贴板完全可能把同一张图给成多份：`files` 里一份、`items` 里一份，甚至多个"表示"。
	 * 上游（`filesFromTransfer`）已经按内容身份去过一次重，但那是**元数据**判据
	 * （名字 + 大小 + 类型）—— 宿主给的元数据一旦有出入，去重就会漏。
	 *
	 * 这里的判据是**结果**：同一份字节 ⇒ 同一个 key ⇒ 同一个 URL ⇒ 同一条文本。
	 * 于是它不依赖剪贴板长什么样；用户看到的就是"粘了一次，出现一张图"。
	 * ⚠️ 反过来，两张**内容不同**的图各有各的 URL，即使同名同大小也不会被合并 ——
	 * "少插一张"比"多插一张"更坏（用户会以为图丢了）。
	 */
	const inserted = new Set<string>();
	const pushPart = (text: string): void => {
		if (inserted.has(text)) return;
		inserted.add(text);
		parts.push(text);
	};

	for (const file of files) {
		const name = typeof file.name === "string" && file.name !== "" ? file.name : undefined;
		// 显示名用**原文件名**（含扩展名）：链接文字要能让用户认出"这是哪个文件" ——
		// `[report.pdf](…)` 比 `[report](…)` 有用得多，而 `report` 对着一堆同名文件毫无信息。
		// 文件没有名字时（截图粘贴）留空，等编排层给出它造的那个可读名。
		const displayName = displayNameOf(file);

		let bytes: Uint8Array;
		try {
			bytes = await readBytes(file);
		} catch (error) {
			// 连读都读不出来：这个文件我们没有任何办法留下
			outcome.lost += 1;
			deps.notify(deps.t("hookLocalFallbackFailed", { error: describeError(error) }));
			continue;
		}

		let result: IngestResult;
		try {
			result = await deps.ingest({ bytes, name, mime: file.type, sourcePath: deps.sourcePath });
		} catch (error) {
			// 编排层承诺不抛错；真抛了也要收住，否则后面那些文件全都不处理了
			outcome.lost += 1;
			deps.notify(deps.t("hookLocalFallbackFailed", { error: describeError(error) }));
			continue;
		}

		if (result.status === "fallback") {
			if (result.localPath) {
				// 降级链接：形态交回宿主（按用户的「新链接格式」设置），`!` 由我们按类型表加。
				const generated = deps.generatedLocalLink ? deps.generatedLocalLink(result.localPath) : null;
				pushPart(buildLocalLink(generated, result.localPath, result.ext));
				outcome.fallback += 1;
				deps.notify(
					deps.t("hookUploadFailedKeptLocal", { error: describeError(result.error ?? "unknown") })
				);
			} else {
				outcome.lost += 1;
				deps.notify(
					deps.t("hookLocalFallbackFailed", { error: describeError(result.error ?? "unknown") })
				);
			}
			continue;
		}

		pushPart(buildRemoteLink(result.remoteUrl, displayName || result.name, result.ext));
		if (result.status === "reused") outcome.reused += 1;
		else outcome.uploaded += 1;
	}

	// 一次插入全部链接：这样在编辑器里只占**一步撤销**，用户按一次 Cmd+Z 能整体回退。
	// 逐个插入会让撤销变成"按 N 次才干净"。
	const text = parts.join("\n");
	outcome.text = text;
	if (text) insertText(editor, text, insertPoint);

	return outcome;
}

/** 优先用捕获好的位置插入；没有才退回当前选区。 */
function insertText(editor: EditorLike, text: string, insertPoint?: InsertPoint): void {
	if (insertPoint && typeof editor.replaceRange === "function") {
		editor.replaceRange(text, insertPoint.from, insertPoint.to);
		return;
	}
	editor.replaceSelection(text);
}
