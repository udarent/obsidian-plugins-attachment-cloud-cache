/**
 * 编辑器事件的**判定核心**（纯函数，不碰 DOM、不碰宿主）。
 *
 * ## 为什么"要不要接管"要单独成一层
 *
 * 拦下粘贴/拖拽意味着调用 `preventDefault()` —— 宿主的原生保存就此被掐断，
 * 之后的字节完全由我们负责。判错的代价是**用户的图消失**，
 * 而正确性只取决于几个输入（事件是否已被处理、载荷里有什么、配置齐不齐），
 * 全都是可以直接构造的。所以判定做成纯函数穷举，接线层只剩"读事件、执行决定"。
 *
 * ## 三个输入，顺序刻意固定
 *
 * 1. **`alreadyHandled`** —— 官方文档明写"Check for `evt.defaultPrevented`
 *    before attempting to handle this event"。别的插件先处理了，我们就退出：
 *    两方都插一段链接的后果是笔记里出现重复内容，而用户只粘了一次。
 * 2. **`plan`**（`shouldInterceptPaste` / `shouldInterceptDrop`）—— 先判"该不该管"。
 *    这两个函数内部已经把最便宜的开关（`autoUpload`）放在最前面，
 *    所以"功能关着"永远给出同一个原因，不会被载荷细节掩盖。
 * 3. **`readiness`** —— 只有确实要接管时，才检查"接得下来吗"。
 *
 * ⚠️ 顺序 3 在 2 之后不能颠倒：没配好存储的用户粘贴一张图时，
 * 我们想给的是"未配置"这条明确提示，而不是"载荷里有文件"这种无用的放行原因。
 *
 * ## 未配置时**放行**，而不是接管后失败
 *
 * `warn` 这个分支不 `preventDefault()`：图会由宿主照常存进 vault，
 * 用户的图还在，只是没上传。反过来（先接管再报错）会让图彻底消失 ——
 * 一个还没配好的插件不该有这种破坏力。
 */

import type { Readiness } from "../s3/credentials";
import type { S3ClientConfig } from "../s3/client";
import type { PluginSettings } from "../types";
import { shouldInterceptDrop, shouldInterceptPaste } from "../editor/editor-hooks";
import type { TransferFileLike, TransferLike } from "../editor/editor-hooks";
import type { InsertPoint } from "../core/transfer";

/** 一次事件的处理决定。 */
export type InterceptDecision =
	/** 放行：交给宿主原生处理，我们什么都不做。 */
	| { action: "ignore"; reason: string }
	/** 放行但提示：配置不全，图会按宿主的原样保存。 */
	| { action: "warn"; problem: string; fixIn: "connection" | "credentials" }
	/** 接管：已获得配置，调用方可以 `preventDefault()` 并开始上传。 */
	| { action: "handle"; files: TransferFileLike[]; config: S3ClientConfig };

export interface InterceptInput {
	/** 事件是否已被别人处理（`evt.defaultPrevented`）。 */
	alreadyHandled: boolean;
	kind: "paste" | "drop";
	transfer: TransferLike | null | undefined;
	settings: PluginSettings;
	/** 调用方**先算好**再传进来；在这里重算可能拿到不同结果。 */
	readiness: Readiness;
}

/** 按固定顺序判定一次编辑器事件。 */
export function decideInterception(input: InterceptInput): InterceptDecision {
	if (input.alreadyHandled) {
		return { action: "ignore", reason: "事件已被其它处理方接管" };
	}

	const plan =
		input.kind === "paste"
			? shouldInterceptPaste(input.transfer, input.settings)
			: shouldInterceptDrop(input.transfer, input.settings);

	if (!plan.intercept) {
		return { action: "ignore", reason: plan.reason };
	}

	if (!input.readiness.ready) {
		return { action: "warn", problem: input.readiness.problem, fixIn: input.readiness.fixIn };
	}

	return { action: "handle", files: plan.files, config: input.readiness.config };
}

/**
 * 编辑器上只需要 `getCursor` 这一件事就能捕获插入位置。
 *
 * ⚠️ 为什么必须在**事件同步阶段**捕获，而不是上传结束后再取当前位置：
 * 上传是异步的（可能要几秒），期间用户完全可能点到别处去。
 * 那时再取光标，链接会插进用户根本没在看的那一行。
 */
export interface CursorLike {
	getCursor?: (side?: "from" | "to" | "head" | "anchor") => unknown;
}

/**
 * 把当前选区变成插入位置；取不到就返回 `undefined`（调用方退回"插到当前选区"）。
 *
 * 取不到是**正常情况**而不是错误：测试替身、将来的其它编辑器实现都可能没有
 * `getCursor`，此时不该整次上传失败 —— 内容照插，只是插入点按当下的选区来算。
 */
export function insertPointFrom(editor: CursorLike | null | undefined): InsertPoint | undefined {
	if (!editor || typeof editor.getCursor !== "function") return undefined;
	try {
		const from = editor.getCursor("from");
		if (from === null || from === undefined) return undefined;
		const to = editor.getCursor("to");
		return to === null || to === undefined ? { from } : { from, to };
	} catch {
		// 宿主的编辑器实现差异不该让粘贴失败：退回"插到当前选区"即可。
		return undefined;
	}
}
