/**
 * 编辑器事件的接线：把宿主的 `editor-paste` / `editor-drop` 事件接到上传流程上。
 *
 * ## 为什么用 `workspace.on("editor-paste")` 而不是在 document 上抓 DOM 事件
 *
 * 两条路都能拿到粘贴，但后者要自己回答一串问题，而且每个答案都可能错：
 * 事件发生在哪个编辑器上？当前视图是不是 Markdown 视图？移动端的事件路径一样吗？
 * 而 `editor-paste` / `editor-drop` 是**宿主主动发的、带类型的编辑器事件**
 * （`@since 1.1.0`，远低于本插件 1.13.0 的地板），它直接把 `Editor` 递过来，
 * 也不需要我们判断"哪个编辑器有焦点"。
 *
 * 官方文档对这两个事件给了两条明确要求，本模块都照着做了：
 * - "Check for `evt.defaultPrevented` before attempting to handle this event"
 *   → 别的插件先处理了就退出，否则笔记里会出现两份链接。
 * - "Use `evt.preventDefault()` to indicate that you've handled the event"
 *   → 只有真的接管时才调用它。
 *
 * ## 一处与原生行为的已知差异（拖拽的插入位置）
 *
 * 拖拽时，原生行为把链接插在**指针落点**。而本插件只能插在**捕获到的选区**上，
 * 因为公开类型里**没有**"指针坐标 → 编辑器位置"的映射
 * （1.13.0 的 `obsidian.d.ts` 里搜不到任何 coords / posAt 类 API；
 * 能做这件事的是 CodeMirror 的视图对象，它不在公开类型里，本项目 lint 禁止绕过类型）。
 *
 * 后果：拖拽时若指针落点与光标不在同一处，链接会插在光标处而不是落点处。
 * 这是**有意保留**的差异 —— 相比"为定位指针而依赖未公开 API"，
 * 位置略有偏差的代价小得多。已记在 `docs/SCOPE.md` 的"已知差异"里。
 *
 * ## 为什么失败只提示、不抛错
 *
 * 事件处理器抛出的异常会被宿主吞掉并只留一条控制台记录，
 * 用户看到的是"粘贴之后什么都没发生"。所以每条出口都要有**用户可见**的交代：
 * 要么插入链接，要么说明为什么没插（图仍由宿主按原样保存）。
 */

import type { Editor } from "obsidian";

import { connectionReadiness } from "../s3/credentials";
import { createS3Client } from "../s3/client";
import { decideInterception, insertPointFrom } from "./intercept";
import type { HostContext } from "./runtime";
import { runTransfer } from "./runtime";
import type { TransferLike } from "../editor/editor-hooks";

/** 事件里能拿到的最小信息集（抽出来是为了让插拔逻辑不依赖具体事件类）。 */
export interface EditorEventLike {
	/** 宿主的 `preventDefault()`。 */
	preventDefault: () => void;
	defaultPrevented: boolean;
	/** 剪贴板 / 拖拽载荷。 */
	clipboardData?: TransferLike | null;
	dataTransfer?: TransferLike | null;
}

/** 事件里附带的笔记信息的最小形状。 */
export interface NoteInfoLike {
	file?: { path?: string } | null;
}

export interface EditorBridgeOptions {
	host: HostContext;
	/** 宿主事件处理器不会等我们，所以这里**同步返回**、异步继续。 */
	onError?: (error: unknown) => void;
}

/**
 * 造两个可以直接注册到 `workspace.on(...)` 的处理器。
 *
 * 注意返回的是**同步函数**：宿主的 `on('editor-paste')` 不 `await` 回调，
 * 所以我们同步完成"判定 + preventDefault + 捕获插入点"这三件事，
 * 再把耗时的上传挂到后台。这也是插入位置必须**同步捕获**的原因（见 `intercept.ts`）。
 */
export function createEditorHandlers(options: EditorBridgeOptions) {
	const { host } = options;

	const handle = (kind: "paste" | "drop", evt: EditorEventLike, editor: Editor, info: NoteInfoLike): void => {
		const settings = host.settings();
		const transfer = kind === "paste" ? (evt.clipboardData ?? null) : (evt.dataTransfer ?? null);

		// `connectionReadiness` 只在这里算一次，并把结果交给判定 —— 判定里不再重算，
		// 否则两次调用之间配置若被改动，"提示的原因"与"实际用的配置"会不一致。
		const decision = decideInterception({
			alreadyHandled: evt.defaultPrevented === true,
			kind,
			transfer,
			settings,
			readiness: connectionReadiness(host.secretStorage, settings),
		});

		if (decision.action === "ignore") return;

		if (decision.action === "warn") {
			// ⚠️ **不** preventDefault：图交给宿主照常存进 vault。
			// 一个还没配好的插件没有资格让用户的图消失。
			host.notify(
				host.t("hookNotConfigured", {
					problem: decision.problem,
					where: host.t(decision.fixIn === "credentials" ? "hookFixCredentials" : "hookFixConnection"),
				})
			);
			return;
		}

		// 到这里为止都是同步的 —— 字节的命运从这一行起归我们。
		evt.preventDefault();

		// 插入位置在**同步阶段**取：上传要几秒，期间用户可能已经点到别处。
		const insertPoint = insertPointFrom(editor);
		const client = createS3Client(decision.config);
		const sourcePath = info?.file?.path;

		void runTransfer(host, {
			client,
			editor,
			files: decision.files,
			insertPoint,
			sourcePath,
		})
			.then((outcome) => {
				// `lost > 0` 表示有文件连本地副本都没保住 —— 这是本项目里最严重的失败，
				// 必须让用户知道，而不是安静地少一张图。
				if (outcome.lost > 0) {
					host.notify(host.t("hookLostFiles", { count: outcome.lost }));
				}
			})
			.catch((error) => {
				// `processTransfer` 承诺不抛错；真抛了说明有没预料到的路径，
				// 记录下来而不是让宿主吞掉 —— 否则用户只会看到"什么都没发生"。
				options.onError?.(error);
				host.notify(host.t("hookUnexpectedFailure", { error: describe(error) }));
			});
	};

	return {
		onPaste: (evt: EditorEventLike, editor: Editor, info: NoteInfoLike) => handle("paste", evt, editor, info),
		onDrop: (evt: EditorEventLike, editor: Editor, info: NoteInfoLike) => handle("drop", evt, editor, info),
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
