/**
 * 插件流程**需要宿主与插件提供什么** —— 一个显式接口。
 *
 * ## 为什么需要它
 *
 * 拆 `main.ts` 的过程里反复撞到同一件事：一条流程（云端清理、孤儿询问、释放空间…）
 * 往往依赖**同一组**宿主能力 —— `t` 取文案、`currentIndex` 取索引、`buildClient` 造客户端、
 * `fileCards` 装配文件卡片、`confirmMaintenance` 弹确认框。
 *
 * 不定义这个接口的话，每条流程都要自己声明一份"参数表"：改一处能力就改 N 处，
 * 而且**没有人能一眼看出"一条流程到底被允许碰什么"**。
 *
 * ## 纪律
 *
 * - `plugin/*` 的流程函数**只吃 `PluginContext`**，不吃插件实例 —— 于是它们的依赖面
 *   是**可数的**（这个文件就是那份清单）。
 * - 接口**只声明真正被用到的成员**。加成员前先问"是不是又有一条流程要走捷径"。
 * - `main.ts` 提供实现（多数是薄转发，把实例方法接到这里）。
 */

import type { App, PluginManifest } from "obsidian";
import type { CacheIndex } from "../cache/index";
import type { HostContext } from "../host/runtime";
import type { S3Client } from "../s3/client";
import type { PluginSettings } from "../types";
import type { ConfirmOptions } from "../ui/confirm-modal";
import type { FileCard, FileCardInput } from "../ui/file-cards";

/**
 * 一条流程能看到的全部东西。
 *
 * ⚠️ 它是**窄接口**，不是"插件实例的别名"：能在这里列出来的，都是被至少一条流程
 * 真正用过的能力。想让流程碰别的东西时，先看能不能不碰。
 */
export interface PluginContext {
	/** 宿主应用（读笔记、读写 vault、取活动视图…）。 */
	readonly app: App;
	/** 插件自己的 manifest —— 需要它来定位插件目录（删除留痕写在那里）。 */
	readonly manifest: PluginManifest;
	/** 当前设置（**可写**：有的流程就是来改设置的）。 */
	readonly settings: PluginSettings;
	/** 文案查询（语种已定）。 */
	t(key: string, params?: Record<string, unknown>): string;
	/** 当前索引（懒建、可能为空）。 */
	currentIndex(): CacheIndex;
	/** 宿主上下文（索引落盘等）。 */
	hostContext(): HostContext;
	/** 按当前设置造客户端；没配齐时 `null`。 */
	buildClient(): S3Client | null;
	/** 把候选算成"怎么展示"（缩略图 + 名字 + 类型标记）。 */
	fileCards(items: readonly FileCardInput[], limit: number): FileCard[];
	/** 统一的确认框（真机探针里被替换掉的那一个）。 */
	confirmMaintenance(options: ConfirmOptions): Promise<boolean>;
}
