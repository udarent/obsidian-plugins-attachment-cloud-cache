/**
 * 「选择要缓存的文件」弹窗 —— 站外图 / 本机文件那条链的**挑选用口**。
 *
 * ## 它补的是"逐张控制"这件事
 *
 * 早先按**站点**询问（记在 `.site-decisions.json` 里），于是"这个站点别的图都要、
 * 就这一张不要"根本表达不出来。现在改成：设置里定**默认**怎么做，
 * 想逐张挑时就用这个弹窗 —— **勾选本身就是同意**，与默认那一档无关。
 *
 * ## ⚠️ 界面**不在这个文件里**（2026-10-15 统一）
 *
 * 它现在只是把"候选"换算成"清单行"，然后把界面交给 `ui/task-list-modal.ts` ——
 * 上传附件、检查未被引用的云端附件用的是**同一个壳**（缩略图 + 勾选 + 进度）。
 * 统一之前这三处是三种样子：一个有勾选没缩略图、一个只有缩略图、一个连缩略图都没有。
 *
 * ## 为什么要做成"注入一个 loader"
 *
 * 清单来自哪里是 I/O（读当前笔记 / 扫全库），而这一层不该知道 vault 的事：
 * 它只拿到"某个范围下有哪些候选"，换算成行，然后把用户勾的结果交回去。
 * 于是"要不要扫全库"这种决定留在接线层（`main.ts`），而这里可以在测试之外被替换掉
 * —— 这正是入口验收能端到端驱动这条链路的原因。
 */

import type { App } from "obsidian";

import { fileNameFromUrl } from "../core/external-cache";
import type { ExternalCandidate } from "../maintenance/batch";
import { EXTERNAL_PICK_SCOPES, buildPickItems } from "./external-picker-logic";
import type { ExternalPickItem, ExternalPickScope } from "./external-picker-logic";
import { externalRowMeta, planFileCards } from "./file-cards";
import type { FileCard } from "./file-cards";
import type { TaskListLabels, TaskReporter } from "./task-list";
import { askTaskList } from "./task-list-modal";

/**
 * 载入某个范围下的候选。**I/O 由调用方负责**（这一层不碰 vault）。
 *
 * 交回来的就是命令那条链的 `ExternalCandidate`（已经去过重、已经过滤掉
 * 本存储/回环地址/未就绪），清单行由 {@link toTaskRows} 从这里构造。
 */
export type ExternalCandidateLoader = (scope: ExternalPickScope) => Promise<ExternalCandidate[]>;

/**
 * 确认之后**就地跑**的事（带逐项进度）。
 *
 * ⚠️ 它是可选参数：设置页那颗"选择文件…"按钮与命令走同一条链，两边都传它
 * （用户点确认之后要看到每张图的进展）；测试里那条接缝则可以只做选择。
 */
export type ExternalPickRunner = (
	picked: readonly ExternalPickItem[],
	report: TaskReporter
) => Promise<void>;

export interface ExternalPickOptions {
	title: string;
	/** 「范围」这个设置项的名字与两个档位。 */
	scopeName: string;
	scopeNote: string;
	scopeVault: string;
	/**
	 * 一条库外文件地址 → 缩略图**候选**（按优先次序）。
	 *
	 * ⚠️ 必须由入口注入（这一层不碰宿主）：本机文件那条要用宿主的本地文件前缀
	 * （`Platform.resourcePathPrefix`），而"谁去问宿主"只有装配点那一处。
	 * 判据本身在 `local-file.ts::localThumbCandidates`（纯函数）。
	 */
	localThumbUrls: (url: string) => string[];
	/** 界面文字（含主按钮；"全选 / 全不选 / 取消"三句由 `buildTaskLabels` 统一给）。 */
	labels: TaskListLabels;
}

/**
 * 候选 → 清单行。
 *
 * ⚠️ 缩略图**不是**"那个地址本身"了（2026-10-16 第二次真机判定之后）：
 * 站外图仍用它自己的地址，而**本机文件**（`file:///D:/…`）那一条在宿主里**画不出来**
 * —— Chromium 拒绝从 `app://` 原点的页面加载 `file://` 子资源。用户报的正是
 * 「列表上有对应文件了，但是**预览看不到**」（D-44 把原地址递出去等判定，判定结果就是它不显示）。
 * ⇒ 改成让入口给**一串候选**（`localThumbUrls`）：宿主自己的本地前缀优先、原文兜底，
 * 渲染时逐个试、全失败才降级成类型标记（`file-cards.ts::renderThumb`）。
 */
function toTaskRows(items: readonly ExternalPickItem[], localThumbUrls: (url: string) => string[]): FileCard[] {
	// ⚠️ 入参就是 `buildPickItems` 的产物 —— **不要再喂回它一次**（那样"候选 → 条目"
	// 这一步会跑两遍，而且得靠 `{ ...item, local: false }` 之类的小补丁把类型糊过去）。
	return planFileCards(
		items.map((item) => ({
			id: item.key,
			name: fileNameFromUrl(item.url) || item.url,
			// ⭐ 站外 `http(s)` 走它自己的地址；本机 `file:///…` 走"宿主前缀 + 绝对路径"、
			// 原文兜底（判据一处：`local-file.ts::localThumbCandidates`）
			thumb: localThumbUrls(item.url),
			// 副标题**只有一处拼法**（`file-cards.ts::externalRowMeta`）：主机，或本机文件
			// 那条绝对路径。⚠️ 它**不含库内路径** —— "会改写哪篇笔记"由运行结果说，
			// 列在这里会被读成"清单里进了一个 `.md` 文件"（2026-10-16 用户三次报的同一件事）。
			meta: externalRowMeta(item),
		})),
		// 这两条推导在这一层用不上（图不在库里、也不是本存储的对象）
		{ resourceUrl: () => null, remoteUrl: () => null }
	);
}

/**
 * 开弹窗让用户勾选。返回勾中的条目；**取消 / 直接关掉返回 `null`**
 * （与"打开了但一张也没勾"区分开：前者是"别问我"，后者是"我看了，没有要的"）。
 */
export function pickExternalImagesWithModal(
	app: App,
	load: ExternalCandidateLoader,
	options: ExternalPickOptions,
	run?: ExternalPickRunner
): Promise<ExternalPickItem[] | null> {
	/** 最近一次取到的条目（按 `key` 回查用户勾了什么）。 */
	let items: ExternalPickItem[] = [];

	return askTaskList(app, {
		title: options.title,
		// 首次的行由下面 `scope.onChange` 立刻填上（弹窗先出现、再取数）
		cards: [],
		scope: {
			name: options.scopeName,
			options: EXTERNAL_PICK_SCOPES.map((value) => ({
				value,
				label: value === "note" ? options.scopeNote : options.scopeVault,
			})),
			// 默认"当前笔记"—— 它最贴近"我正在看这篇、随手挑几张"
			value: "note",
			onChange: async (value) => {
				const scope: ExternalPickScope = value === "vault" ? "vault" : "note";
				items = buildPickItems(await load(scope));
				return toTaskRows(items, options.localThumbUrls);
			},
		},
		labels: options.labels,
		// ⭐ 勾选的键就是 `pickKey`，所以这里能按它把条目还原出来交给调用方
		run: run ? (selected, report) => run(items.filter((item) => selected.includes(item.key)), report) : undefined,
	}).then((answer) => (answer === null ? null : items.filter((item) => answer.selected.includes(item.key))));
}
