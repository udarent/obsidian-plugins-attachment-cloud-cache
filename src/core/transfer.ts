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
	altTextForFile,
	buildLocalImageEmbed,
	buildRemoteImageMarkdown,
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

	for (const file of files) {
		const name = typeof file.name === "string" && file.name !== "" ? file.name : undefined;
		// alt 用**主干**而不是整个文件名：`![shot](…)` 比 `![shot.png](…)` 更像说明文字，
		// 而且附件名字里常带时间戳，写在链接里会把整段 Markdown 撑得很长。
		const alt = altTextForFile(file);

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
				parts.push(buildLocalImageEmbed(result.localPath, alt));
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

		parts.push(buildRemoteImageMarkdown(result.remoteUrl, alt));
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
