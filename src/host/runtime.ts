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
		// `then(task, task)` 而不是 `then(task)`：前一次失败时也要继续，
		// 否则队列会被一次偶发错误永久堵死。
		const run = tail.then(task, task);
		// 队尾只用来串联，因此吞掉结果与异常（各自的结果已经交给 `run` 的调用方）
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
	makeIndex: () => CacheIndex
): IndexStore {
	const dir = (pluginDir ?? `.obsidian/plugins/${pluginId}`).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const path = indexFilePath(dir);
	const serialize = makeSerializer();
	let current = makeIndex();

	return {
		get index() {
			return current;
		},
		async load() {
			const result = await loadCacheIndex(app.vault.adapter, path);
			// 换掉整个对象而不是逐条搬：`loadCacheIndex` 已经把坏条目筛过一遍，
			// 直接用它作为"当前真相"最简单。接线层每次都现取 `index`，不会持有旧引用。
			current = result.index;
			return { error: result.error, skipped: result.skipped.length, existed: result.existed };
		},
		async save() {
			// 在**执行时**读 `current`（而不是排队时先抓一份快照）：
			// 排队期间若又上传了一张图，写下去的应当包含它。
			await serialize(() => saveCacheIndex(app.vault.adapter, path, current));
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
			},
			req
		);

	return processTransfer(
		{
			settings,
			ingest,
			notify: host.notify,
			t: host.t,
			sourcePath: request.sourcePath,
		},
		request.editor,
		request.files,
		request.insertPoint
	);
}
