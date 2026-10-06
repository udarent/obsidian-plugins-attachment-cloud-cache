/**
 * 插件入口。
 *
 * ## 接线清单（改这里之前先读这一段）
 *
 * `onload` 里注册的东西就是**用户实际能用到**的全部能力。没在这里注册的模块，
 * 哪怕测试全绿、代码再周全，运行时也**一行都不会执行** —— 这是本项目踩过的坑：
 * 曾经有 8 个模块（上传编排、缓存索引、粘贴判定……）全都有测试，
 * 而入口只注册了设置页，于是装进 vault 的插件除了设置界面什么都不做。
 *
 * 因此 `main.ts` 有一条专门的验收测试（`scripts/test-load-acceptance.mjs`）：
 * 它加载**真实构建产物**、跑 `onload()`、断言钩子真的被注册了。
 * 判据很直接：**把下面任何一行注册代码删掉，那条测试必须变红。**
 *
 * ## 关于那个 ribbon 图标
 *
 * 这里**故意没有** ribbon 图标。曾经有一个，但它只能弹一句"设置界面即将提供" ——
 * 而设置界面现在已经存在，用程序打开设置页的 API 却**不在公开类型里**
 * （`app.setting` / `openTabById` 都没出现在钉住的 `obsidian.d.ts` 中）。
 * 能用的写法是 `(this.app as any).setting...`，但那绕过类型系统、依赖未公开接口 ——
 * 与本项目"只用两端都有、且公开的 API"的纪律冲突（那条纪律由 lint 强制）。
 *
 * 用户找设置的正常路径是「设置 → 第三方插件 → 本插件的齿轮」；
 * 而"没配置就用"时粘贴会给出明确报错并指向设置页 —— 那条路径比一个图标更有用。
 */

import { Notice, Plugin, getLanguage } from "obsidian";

import { SETTINGS_DEFAULTS, mergePluginSettings } from "./settings";
import type { PluginSettings } from "./types";
import { detectLocale, translate } from "./i18n";
import { SettingsTab } from "./ui/settings-tab";
import { CacheIndex } from "./cache/index";
import { createIndexStore, makeSerializer } from "./host/runtime";
import type { HostContext } from "./host/runtime";
import { createEditorHandlers } from "./host/editor-bridge";

export default class AttachmentCloudCachePlugin extends Plugin {
	settings: PluginSettings = { ...SETTINGS_DEFAULTS };
	locale = "en";

	/** 索引的读写（含串行化落盘）。`onload` 里初始化。 */
	private indexStore: ReturnType<typeof createIndexStore> | null = null;

	/**
	 * 落盘队列。索引自己的写入已经在 `createIndexStore` 里串行化了，
	 * 这一条是给其它将来要写盘的模块复用的 —— 两条队列分开会让
	 * "不同数据的写入互相插队"重新变成可能，而症状同样是难查的。
	 */
	private readonly serialize = makeSerializer();

	async onload(): Promise<void> {
		await this.loadSettings();
		// ⚠️ 语种要在**注册设置页之前**定下来 —— 设置页在 `display()` 里取文案，
		// 若此时 locale 还是初始的 "en"，中文用户第一次打开会看到英文界面。
		this.locale = detectLocale(getLanguage());

		this.addSettingTab(new SettingsTab(this.app, this));

		await this.loadCacheIndex();

		// 粘贴与拖拽注册在这两个事件上（`@since 1.1.0`），而不是 document 上的 DOM 事件：
		// 宿主会把 `Editor` 直接递过来，不必自己判断"哪个编辑器有焦点"，
		// 也不用猜移动端的事件路径是否一致。
		// `registerEvent` 让宿主在卸载时自动注销 —— 手动 `offref` 迟早会漏掉一条。
		const handlers = createEditorHandlers({
			host: this.hostContext(),
			onError: (error) => {
				// 这里只留技术细节（原始 message 可能很长，不适合弹窗）；
				// 用户可见的交代由 handler 内部的 notify 负责。
				console.error("[attachment-cloud-cache] 上传流程出现未预期的错误", error);
			},
		});
		this.registerEvent(this.app.workspace.on("editor-paste", handlers.onPaste));
		this.registerEvent(this.app.workspace.on("editor-drop", handlers.onDrop));
	}

	onunload(): void {
		// 事件由 `registerEvent` 自动注销，无需手写 offref。
		// 这里只清掉自有引用，避免插件实例被延长引用（热重载时尤其明显）。
		this.indexStore = null;
	}

	/** 供各模块统一的文案查询入口。 */
	t(key: string, params?: Record<string, unknown>): string {
		return translate(this.locale, key, params ?? {});
	}

	async loadSettings(): Promise<void> {
		// ⚠️ 走 mergePluginSettings 而不是直接赋值：data.json 可能是手改的、
		// 旧版本的、或被别的工具写坏的，必须逐字段校验后再用。
		this.settings = mergePluginSettings(SETTINGS_DEFAULTS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * 读缓存索引。
	 *
	 * ⚠️ **读失败绝不能挡住插件启动**：索引是可重建的派生数据，
	 * 而它读失败的时机恰好是插件加载。在这里抛错等于"一个索引文件损坏
	 * 就让用户连设置页都进不去"。所以失败只提示、然后以空索引继续跑
	 * （`loadCacheIndex` 自己也不抛；这里再兜一层，因为适配器与宿主 API
	 * 在异常场景下的行为不归我们保证）。
	 */
	private async loadCacheIndex(): Promise<void> {
		this.indexStore = createIndexStore(this.app, this.manifest.dir, this.manifest.id, () => new CacheIndex());

		try {
			const { error, skipped, existed } = await this.indexStore.load();
			if (error) {
				new Notice(this.t("indexLoadFailed", { error }));
			} else if (skipped > 0) {
				// 坏条目被丢弃是容错，但用户有权知道"有些图的本地副本不被认识了"。
				new Notice(this.t("indexSkipped", { count: skipped }));
			} else if (!existed) {
				// 首次运行：不提示。刚装上的插件弹"索引不存在"只会让人以为出错了。
			}
		} catch (error) {
			this.indexStore = null;
			new Notice(this.t("indexLoadFailed", { error: error instanceof Error ? error.message : String(error) }));
		}
	}

	/**
	 * 交给接线层的宿主上下文。
	 *
	 * `settings` / `index` 都是**取值函数**而不是快照：设置页改完立即生效，
	 * 索引在 `load()` 后会换对象 —— 抓快照会让"改了不生效"这类问题
	 * 以最难排查的形式出现（界面上一切正常，只有行为不对）。
	 */
	private hostContext(): HostContext {
		const store = this.indexStore;
		return {
			app: this.app,
			settings: () => this.settings,
			index: () => store?.index ?? new CacheIndex(),
			persistIndex: async () => {
				if (store) await this.serialize(() => store.save());
			},
			notify: (message) => new Notice(message),
			t: (key, params) => this.t(key, params),
			secretStorage: this.app.secretStorage,
		};
	}
}
