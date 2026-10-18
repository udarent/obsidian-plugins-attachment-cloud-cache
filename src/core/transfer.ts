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
	fileIdentity,
	type TransferFileLike,
} from "../editor/editor-hooks";
import type { IngestRequest, IngestResult } from "./ingest";
import type { PluginSettings } from "../types";
import { describeError, hintTextFor } from "../error-text";

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
	 * 插入去重：**同一次粘贴里，同一个文件只插一条链接**。
	 *
	 * 剪贴板完全可能把同一张图给成多份：`files` 里一份、`items` 里一份，甚至多个"表示"。
	 * 上游（`filesFromTransfer`）已经按内容身份去过一次重，但那一步只认**元数据**；
	 * 这里再兜一次，避免"用户粘了一次，出现两张一样的图"。
	 *
	 * ## ⚠️ 判据是**输入的文件身份**，不是产出的文本（2026-10-14 改）
	 *
	 * 原判据是"产出的链接文本相同就合并"。D-24 之后它**第一次会造成误伤**：
	 * 同内容异名的两份文件（`a.png` 与 `a-copy.png`）复用同一个对象
	 * ⇒ 显示名同为 `a.png`、地址也相同 ⇒ 两条链接**逐字相同** ⇒ 第二份被当成
	 * "同一张图又给了一份"直接吞掉，用户少一张图。
	 *
	 * 而这两件事在**输入**上是可分的：同一张图的两个包装有同一个身份
	 * （`fileIdentity` = 名字+大小+类型，见它的注释），而两份**不同文件**身份不同。
	 * 代价（如实记）：元数据有出入的同一张图现在可能插两条 —— "多插一张"用户看得见、
	 * 删掉即可；"少插一张"用户会以为图丢了。
	 */
	const inserted = new Set<string>();
	/**
	 * 上传失败但**保住了本地**的那些提示，攒到最后发一条。
	 *
	 * 一次粘贴 5 张图、凭据又错时，逐条提醒会连弹 5 条几乎一样的通知 ——
	 * 与"自动接管"那条路的按结局合并是同一口径（那边早就是一条了，这边漏了）。
	 * 只合并这一类：**连本地都没保住**（`lost`）仍然逐条说清，那是更严重、也更少见的事。
	 */
	const keepLocalFailures: string[] = [];
	const pushPart = (text: string, file: TransferFileLike): void => {
		const id = fileIdentity(file) ?? text;
		if (inserted.has(id)) return;
		inserted.add(id);
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
				pushPart(buildLocalLink(generated, result.localPath, result.ext), file);
				outcome.fallback += 1;
				// ⭐ 说给用户听的是**一句人话 + 改哪儿**（`s3Hint*`），不是 S3 的原始响应体
				// （XML / StringToSign）。原始明细进控制台，供排查与诊断包使用 ——
				// "显示什么"与"记录什么"分开，与 `S3Error.body` 同一条纪律。
				const hint = hintTextFor(result.error, deps.t) ?? describeError(result.error ?? "unknown");
				if (result.error !== undefined) {
					console.error("[attachment-cloud-cache] 上传失败：", result.error);
				}
				keepLocalFailures.push(hint);
			} else {
				outcome.lost += 1;
				deps.notify(
					deps.t("hookLocalFallbackFailed", { error: describeError(result.error ?? "unknown") })
				);
			}
			continue;
		}

		// ⭐ 链接的显示位优先用编排层算定的 `displayName`（= key 里的名字，与**链接目标**逐字一致）：
		// 宿主撞名另落的 `照片 1.png` 会被归一到主干名字，显示位跟着走才不会出现
		// "链接文字是 `照片 1.png`、地址里是 `照片-<哈希>.png`"这种同一链接两个名字。
		// 它取不到时（老形状的 key）才退回文件原名 / 编排层造的可读名。
		pushPart(buildRemoteLink(result.remoteUrl, result.displayName || displayName || result.name, result.ext), file);
		if (result.status === "reused") outcome.reused += 1;
		else outcome.uploaded += 1;
	}

	// ⭐ 失败提示**攒到最后发一条**（见 `keepLocalFailures` 的说明）：
	// 一条时说一个文件，多条时报个数 —— 原因取第一条（同一次粘贴的失败几乎总是同一个原因，
	// 完整明细都在控制台里）。
	if (keepLocalFailures.length === 1) {
		deps.notify(deps.t("hookUploadFailedKeptLocal", { error: keepLocalFailures[0] }));
	} else if (keepLocalFailures.length > 1) {
		deps.notify(
			deps.t("hookUploadFailedMany", { count: keepLocalFailures.length, error: keepLocalFailures[0] })
		);
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
