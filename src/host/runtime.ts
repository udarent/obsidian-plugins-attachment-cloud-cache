/**
 * 运行时装配：把设置、钥匙串、缓存索引、S3 客户端拼成一次可执行的上传。
 *
 * ## 为什么参数是"每次传入"而不是"启动时造好"
 *
 * 设置可以在插件运行中变（用户在设置页改完就存）。若在 `onload` 时造好
 * 客户端与设置快照，用户改完设置会发现**下一次粘贴仍然按旧配置走**，
 * 而界面上一切正常 —— 这类"改了不生效"的排查成本极高（得先怀疑缓存、
 * 再怀疑重启、最后才想到是快照）。所以每次上传都从**当前**设置现造客户端。
 * 造客户端的成本只是几个字段赋值，没有连接、没有握手。
 *
 * ## 索引落盘为什么要串行
 *
 * `saveCacheIndex` 是"先写 `<path>.tmp` 再改名"。两次并发调用会**共用同一个临时文件名**：
 * A 写完 tmp、B 覆盖 tmp、A 改名 —— 索引文件里可能是半截或错版内容，
 * 症状是"重启后有些图不被认识"，且不报错。
 * 索引是可重建的派生数据，所以这里不引入锁，只用一条 promise 链把写入排成队，
 * 成本是一次微任务，换来的是"写进去的就是内存里的那份"。
 *
 * 另一件事：**排队要"失败不中断"**。前一次写成失败（磁盘满、被占用）时，
 * 后面的写入必须照常进行 —— 否则一次偶发失败会永久堵死队列。
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { PluginSettings } from "../types";
import type { SecretReader } from "../s3/credentials";
import type { S3Client } from "../s3/client";
import type { CacheIndex } from "../cache/index";
import { loadCacheIndex, saveCacheIndex, indexFilePath } from "../cache/store";
import { ingestAttachment } from "../core/ingest";
import type { IngestRequest, IngestResult } from "../core/ingest";
import { processTransfer } from "../core/transfer";
import type { EditorLike, InsertPoint, TransferOutcome } from "../core/transfer";
import type { TransferFileLike } from "../editor/editor-hooks";

/**
 * 把异步任务排成队：**前一个无论成功还是失败，后一个都照常执行**。
 *
 * 返回的函数可以用 `await` 拿到自己那次的结果（不只是"等轮到"）。
 */
export function makeSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return (task) => {
		const run = tail.then(task);
		// ⭐ **保证"失败不中断"的是这一行**，不是上面那个 `then` 的失败回调：
		// `tail` 永远是一个**已兑现**的 promise（每次都被 `catch` 过），
		// 所以下一个任务一定排得上队。
		// （变异验证确认过：把 `then(task, task)` 的第二个参数删掉不影响任何断言 ——
		// 说明那是个多余的参数，留着只会让人以为"保证在那"。）
		tail = run.catch(() => undefined);
		return run;
	};
}

/** 索引的读写。索引对象由它持有，接线层只读 `index`。 */
export interface IndexStore {
	/** **当前**索引对象。可能在 `load()` 之后被换成新的一份，所以要现取。 */
	readonly index: CacheIndex;
	load: () => Promise<{ error: string; skipped: number; existed: boolean }>;
	save: () => Promise<void>;
	/**
	 * 记下"这份副本刚被用到"。返回是否真的更新了（被节流时为 `false`）。
	 *
	 * ⚠️ 只改内存 + **防抖**落盘 —— 它在渲染路径上被调用，那里一次 I/O 都不能有。
	 */
	touch: (key: string) => boolean;
}

/**
 * "最近使用时间"的防抖落盘延迟。
 *
 * 一分钟是刻意的：这份数据只用来给缓存轮换排序（见 `maintenance/eviction.ts`），
 * 而轮换自己也有分钟级的节流。攒一会儿再写完全够用，还能把一屏图触发的
 * 几十次 `touch` 合成一次写盘。
 */
export const DEFAULT_USAGE_FLUSH_DELAY_MS = 60 * 1000;

/** 默认的延迟调度器（用 `window.setTimeout`：弹出窗口里裸 `setTimeout` 不是同一个）。 */
function defaultDefer(task: () => Promise<void>, ms: number): () => void {
	// ⚠️ 包一层再交给 `setTimeout`，而不是把 `task` 直接传进去：
	// 定时器回调**不该返回 Promise**（没人会 await 它，返回了只会让 lint 与读者困惑）。
	// 那个返回值是给**注入的**调度器用的（测试要能 await 到"真的写完了"）。
	const timer = window.setTimeout(() => {
		void task();
	}, ms);
	return () => window.clearTimeout(timer);
}

export interface IndexStoreOptions {
	now?: () => number;
	/**
	 * 延迟调度器（返回取消函数）。
	 *
	 * 注入是为了**可测**：防抖落盘若只能靠真等，"它到底会不会写、会不会重复写"
	 * 就变成了不可断言的行为。
	 *
	 * ⚠️ `task` 返回那次落盘的 Promise。真实的 `setTimeout` 会忽略它（那不重要）——
	 * 重要的是**注入的调度器可以 `await` 它**，于是"防抖到点之后真的写下去了"
	 * 是一条能断言的确定性行为，而不是靠轮询去猜。
	 *
	 * 类型刻意写成 `() => Promise<void>` 而不是 `() => void | Promise<void>`：
	 * 后者会被 lint 按 `void` 那一支判定，于是"返回 Promise"被当成误用
	 *（而这里恰恰要求它返回）。
	 */
	defer?: (task: () => Promise<void>, ms: number) => () => void;
	flushDelayMs?: number;
	/** 落盘失败时的记录口（不能用来打扰用户：它由渲染触发）。 */
	onError?: (error: unknown) => void;
}

/**
 * 按插件目录定位并读写索引。
 *
 * `pluginDir` 取 `manifest.dir`（装好的插件一定有值）；缺失时按 `id` 拼一个
 * 兜底路径 —— 索引写错位置只会导致"缓存不被认识"，比整个插件起不来轻得多，
 * 所以这里选择兜底而不是抛错。
 */
export function createIndexStore(
	app: App,
	pluginDir: string | undefined,
	pluginId: string,
	makeIndex: () => CacheIndex,
	options: IndexStoreOptions = {}
): IndexStore {
	const dir = (pluginDir ?? `.obsidian/plugins/${pluginId}`).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const path = indexFilePath(dir);
	const serialize = makeSerializer();
	const now = options.now ?? Date.now;
	const defer = options.defer ?? defaultDefer;
	const flushDelayMs = options.flushDelayMs ?? DEFAULT_USAGE_FLUSH_DELAY_MS;
	let current = makeIndex();
	/** 排队中的那次防抖落盘（`null` = 没有排队）。 */
	let cancelFlush: (() => void) | null = null;

	const report = (error: unknown): void => {
		try {
			options.onError?.(error);
		} catch {
			// 连记录都失败也不能影响渲染
		}
	};

	/** 整份落盘（串行化 + 取消排队中的防抖落盘）。 */
	const save = async (): Promise<void> => {
		// 马上就要整份写盘了 —— 把排队中的那次防抖落盘取消，避免紧接着重复写一遍
		if (cancelFlush) {
			cancelFlush();
			cancelFlush = null;
		}
		// 在**执行时**读 `current`（而不是排队时先抓一份快照）：
		// 排队期间若又上传了一张图，写下去的应当包含它。
		await serialize(() => saveCacheIndex(app.vault.adapter, path, current));
	};

	const load = async (): Promise<{ error: string; skipped: number; existed: boolean }> => {
		const result = await loadCacheIndex(app.vault.adapter, path);
		// 换掉整个对象而不是逐条搬：`loadCacheIndex` 已经把坏条目筛过一遍，
		// 直接用它作为"当前真相"最简单。接线层每次都现取 `index`，不会持有旧引用。
		current = result.index;
		return { error: result.error, skipped: result.skipped.length, existed: result.existed };
	};

	return {
		get index() {
			return current;
		},
		load,
		save,
		touch(key: string): boolean {
			let updated = false;
			try {
				updated = current.touch(key, now());
			} catch (error) {
				// 记"最近使用"失败绝不能影响渲染（它只是给轮换排序用的）
				report(error);
				return false;
			}
			if (!updated) return false;
			// 已经排过一次就复用：屏幕上的几十张图只会合成一次写盘
			if (!cancelFlush) {
				// 用局部函数 `save` 而不是 `this.save`：`this` 在解构调用时会失效，
				// 而那种失效是静默的（落盘永远不会发生，但没有任何报错）。
				cancelFlush = defer(() => {
					cancelFlush = null;
					// 返回这个 Promise 让调度器（测试里是注入的）能 await 到写完；
					// `catch` 保证即使没人 await，也不会变成未处理的拒绝。
					return save().catch(report);
				}, flushDelayMs);
			}
			return true;
		},
	};
}

/** 宿主提供的、与本次上传有关的全部环境。 */
export interface HostContext {
	app: App;
	/** 当前设置。用取值函数是为了每次上传都拿到**最新**的那份。 */
	settings: () => PluginSettings;
	/** 当前索引。同上 —— `load()` 之后对象会换，所以不能抓快照。 */
	index: () => CacheIndex;
	/** 索引变更后落盘（已串行化）。 */
	persistIndex: () => Promise<void>;
	notify: (message: string) => void;
	t: (key: string, params?: Record<string, unknown>) => string;
	/** 钥匙串读取（凭据的值只在这里取，绝不进设置）。 */
	secretStorage: SecretReader;
	/**
	 * 刚刚在附件目录里落下一份**中转文件**（见 `IngestDeps.onStaged`）。
	 *
	 * 粘贴那条路的"先落盘再上传"与"新增附件自动接管"共用同一个宿主事件
	 * （`vault.on("create")`）—— 有了这个上报，后者才分得清"用户加的附件"
	 * 与"我们自己刚写下去的"。
	 */
	onStaged?: (path: string) => void;
}

export interface TransferRequest {
	client: S3Client;
	editor: EditorLike;
	files: TransferFileLike[];
	insertPoint?: InsertPoint;
	/** 触发这次操作的笔记路径，让宿主决定附件落在哪个目录。 */
	sourcePath?: string;
}

/**
 * 执行一次"粘贴/拖拽 → 上传 → 缓存 → 插入链接"。
 *
 * 这里只做装配：判定已在 `intercept.ts` 做完，具体的上传与插入在
 * `core/ingest.ts` 与 `core/transfer.ts` 里（两者都有各自的测试）。
 */
export async function runTransfer(host: HostContext, request: TransferRequest): Promise<TransferOutcome> {
	const settings = host.settings();

	const ingest = (req: IngestRequest): Promise<IngestResult> =>
		ingestAttachment(
			{
				app: host.app,
				settings,
				client: request.client,
				index: host.index(),
				persistIndex: host.persistIndex,
				notify: host.notify,
				// 中转文件的标记（见 `HostContext.onStaged`）：没有它，自动接管那条链
				// 会把自己刚落下、还要用它上传的中转文件当成用户新加的附件再传一遍。
				onStaged: host.onStaged,
			},
			req
		);

	return processTransfer(
		{
			settings,
			ingest,
			notify: host.notify,
			t: host.t,
			// 降级链接交给**宿主的生成器**（它按用户的「新链接格式」设置产出
			// `[[路径]]` 或 `[名](路径)`），嵌不嵌由 `buildLocalLink` 按类型表决定。
			// 取不到 `TFile`（宿主索引还没看到刚落盘的文件）时返回 null，
			// 让链接层退回普通 wikilink —— 图能看，只是形态保守。
			generatedLocalLink: (vaultPath: string): string | null => {
				const file = host.app.vault.getAbstractFileByPath(vaultPath);
				if (!(file instanceof TFile)) return null;
				try {
					return host.app.fileManager.generateMarkdownLink(file, request.sourcePath ?? "");
				} catch {
					// 宿主生成器抛错不该让"图保住了"变成"链接没插" —— 交给兜底形态
					return null;
				}
			},
			sourcePath: request.sourcePath,
		},
		request.editor,
		request.files,
		request.insertPoint
	);
}
