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
 *
 * ## ⚠️ 为什么这些成员声明成"函数属性"而不是"方法"
 *
 * 写成方法签名（`t(key): string`）时，类型上它就是一个**依赖 `this` 的成员** ——
 * 于是任何把 `ctx.t` 当成一个值传下去的地方（`runCloudCleanup` 的 `t` 参数就是），
 * 都会被 lint 的 `unbound-method` 拦下，逼着调用方包一层 `(k, p) => ctx.t(k, p)`。
 * 而 `main.ts` 的实现里这些**全是箭头函数**，本来就已经绑好了 ——
 * 声明成 `readonly t: (…) => …` 才与事实相符，也把那层多余的包装消掉。
 */

import type { App, PluginManifest } from "obsidian";
import type { CacheIndex } from "../cache/index";
import type { HostContext } from "../host/runtime";
import type { MaintenanceDeps } from "../maintenance/run";
import type { S3Client } from "../s3/client";
import type { PluginSettings } from "../types";
import type { ConfirmOptions } from "../ui/confirm-modal";
import type { FileCard, FileCardInput } from "../ui/file-cards";
import type { TaskListOptions, TaskListResult } from "../ui/task-list-modal";

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
	readonly t: (key: string, params?: Record<string, unknown>) => string;
	/** 当前索引（懒建、可能为空）。 */
	readonly currentIndex: () => CacheIndex;
	/** 宿主上下文（索引落盘等）。 */
	readonly hostContext: () => HostContext;
	/** 按当前设置造客户端；没配齐时 `null`。 */
	readonly buildClient: () => S3Client | null;
	/** 把候选算成"怎么展示"（缩略图 + 名字 + 类型标记）。 */
	readonly fileCards: (items: readonly FileCardInput[], limit: number) => FileCard[];
	/** 统一的确认框（真机探针里被替换掉的那一个）。 */
	readonly confirmMaintenance: (options: ConfirmOptions) => Promise<boolean>;
	/**
	 * 开一个**清单式弹窗**（缩略图 + 勾选（含全选/全不选）+ 进度），三条链共用
	 * （上传附件 / 检查未被引用的云端附件 / 挑选要缓存的文件）。返回 `null` = 取消或直接关掉。
	 *
	 * ⚠️ 与 `confirmMaintenance` 的分工：那个只有"是/否"，用于**一批已经确定的动作**；
	 * 这个用于"先让用户挑出要处理哪些，再看着它们逐个跑完"。两者都还在用。
	 */
	readonly pickTasks: (options: TaskListOptions) => Promise<TaskListResult | null>;
	/**
	 * 维护类流程共用的依赖装配（`maintenance/run.ts` 那一家）。
	 *
	 * ⚠️ 它进这里而不是进某一条流程的文件：**四条**流程都要它
	 * （批量上传、淘汰、上传附件、空间回收）—— 按本项目的归位判据
	 * （"一个东西进哪个文件看谁在用"），共用的就得放在共用层。
	 *
	 * ⚠️ 与 `PluginContext` 的其它成员一样是**函数**而不是字段：它读 `settings`
	 * 与 `currentIndex()`（两者都会被整体替换），缓存下来的话会拿到上一份。
	 */
	readonly maintenanceDeps: () => MaintenanceDeps;
	/**
	 * 当前是不是桌面端（宿主的 `Platform.isDesktopApp`）。
	 *
	 * ⚠️ **本项目第一次做平台判断**，而它只服务一件事：`file:///D:/…` 这类**本机绝对路径**
	 * 只有桌面读得到（手机端那个路径根本不存在）。判据放在这里，因为"谁去问平台"必须只有**一处**
	 * （`main.ts`）；纯判定层收的是**结果**（`isDesktop: boolean`），于是那层可以穷举。
	 *
	 * ⚠️ 别把它当"能力探测"的通用开关：以后再有平台相关的功能，照这个形状**再加一条**，
	 * 而不是在这里判断"是不是 Electron"（那样一处判断会慢慢承载好几个不相干的功能）。
	 */
	readonly isDesktop: () => boolean;
	/**
	 * 一条库外文件地址（`file:///D:/…`）在清单行里**该用哪些地址当缩略图**（按优先次序）。
	 *
	 * ⚠️ 为什么这也要一个接缝（而不是在流程层直接拼）：它要用**宿主自己的**本地文件前缀
	 * （`Platform.resourcePathPrefix`）—— 那是一次宿主调用，而"谁去问宿主"按纪律只有一处
	 * （`main.ts`）；流程层与界面层收到的是**结果**（一串候选地址）。
	 *
	 * ⚠️ 为什么不给单个地址：库外文件的地址形式**不由我们定**（`file:///…` 在宿主里画不出来，
	 * 见 `local-file.ts::localThumbCandidates`），而"宿主认哪一种"由**运行时**说了算 ——
	 * 渲染时逐个试、全失败才降级成类型标记。
	 */
	readonly localThumbUrls: (url: string) => string[];
}
