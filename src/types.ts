/**
 * 插件的共享类型。
 *
 * ## 凭据：为什么这里是 `*Ref` 而不是密钥本身
 *
 * Obsidian 1.11.4 起提供了 `SecretStorage` + `SecretComponent`。它的模型是：
 * **用户在钥匙串里给密钥起个名字，插件只存那个名字**，取用时用
 * `app.secretStorage.getSecret(name)` 换出真正的值。
 * 官方指南原话："When saved, your plugin settings contain **the name of the secret**,
 * not the actual secret value."
 *
 * 所以 `accessKeyIdRef` / `secretAccessKeyRef` 存的是**名字**，这是正确模型，不是抄来的包袱：
 * - `data.json` 会随 vault 同步、备份、分享 —— 里面**绝不能**出现密钥本身；
 * - 同一个密钥可以被多个插件共用，改一次全生效。
 *
 * ⚠️ 一个容易搞错、值得单独记住的点：**`SecretComponent` 不是密码输入框**，
 * 而是"选择或新建一个具名密钥"的选择器（它返回的是**名字**）。
 * 所以设置项的值可以合法地为空 = "还没选"。这一点决定了这两个字段用
 * `textValue()` 而非 `requiredTextValue()`：空串是有意义的状态，
 * 不该被悄悄回落成一个指向不存在密钥的名字。
 */

/**
 * 上传后**本地副本**怎么处理。
 *
 * ⚠️ 这个类型取代了原来的 `cacheEnabled` + `LocalFileAction` 两个字段 ——
 * 它们描述的是同一件事（本地副本的命运），拆成两个必然产生矛盾组合：
 * `action: "cache"` + `cacheEnabled: false` 会**静默退化**成"原地保留"，
 * 而 `action: "trash"` 会**压过**缓存开关（开了"缓存"却永远拿不到离线）。
 * 现在只有三个互斥且都能落地的结果，不存在"选了 A 却得到 B"。
 */
export type LocalCopyAction =
	/**
	 * 移入缓存目录（默认）。
	 *
	 * 附件目录因此保持干净，副本集中在缓存目录里，而缓存目录是**可整体清理**的。
	 * 离线可见。
	 */
	| "cache"
	/**
	 * 留在附件目录原地。
	 *
	 * 不额外建目录；笔记里的链接同样改成远端地址，所以这个文件不再被笔记引用，
	 * 只作为离线副本存在。vault 会因此持续变大。离线可见。
	 */
	| "keep"
	/**
	 * 不留本地副本（上传后把本地文件移入回收站）。
	 *
	 * 与上游插件的经典行为一致，vault 最干净 —— 代价是**离线看不了**。
	 */
	| "trash";

export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["cache", "keep", "trash"];

export function isLocalCopyAction(value: unknown): value is LocalCopyAction {
	return typeof value === "string" && (LOCAL_COPY_ACTIONS as readonly string[]).includes(value);
}

/**
 * 淘汰 / 清理缓存文件时，用哪种方式把文件拿掉。
 *
 * 两个取值的区别**只在用户能感知的那一件事上**：磁盘空间什么时候真的释放。
 *
 * - 两者都会让文件立刻离开 vault（同步与备份的体积马上变小）；
 * - 区别是物理空间"立刻"释放，还是"等系统清空回收站"。
 *
 * 这是它值得成为一个设置项的唯一理由 —— 别把它读成"危险/安全"的两档，
 * 因为它删的**只是缓存副本**：笔记里存的一直是远端地址，被删掉的副本
 * 下次看到那张图时会**自动重新下载**。所以两种取值都不会丢数据。
 *
 * ⚠️ 它**从不作用于用户自己的附件**（`localCopy: "trash"` 那条路径始终走回收站）——
 * 见 `maintenance/remove.ts` 的说明。
 */
export type DeleteMode =
	/**
	 * 直接删除（默认）。
	 *
	 * 磁盘空间**立刻**释放 —— 这正是"设了上限"最常被期待的效果
	 * （尤其是磁盘紧张、或缓存目录本身占了大头的时候）。
	 * 代价是不可撤销：删错了只能靠"下次看到那张图时重新下载"回来。
	 */
	| "permanent"
	/**
	 * 移入系统回收站。
	 *
	 * 误删可恢复；但空间要等系统清空回收站才真正释放，
	 * 所以"设了上限磁盘还是满的"是这条取值下的**正常现象**，不是 bug。
	 */
	| "trash";

export const DELETE_MODES: readonly DeleteMode[] = ["permanent", "trash"];

export function isDeleteMode(value: unknown): value is DeleteMode {
	return typeof value === "string" && (DELETE_MODES as readonly string[]).includes(value);
}

/** S3 兼容存储的连接参数。 */
export interface S3Config {
	/** 服务端点，如 `https://abc.r2.cloudflarestorage.com`。 */
	endpoint: string;
	/** 区域；R2 固定为 `auto`。 */
	region: string;
	/** 桶名。 */
	bucket: string;
	/** 公开访问前缀，如 `https://img.example.com`。图片链接由它拼出来。 */
	publicUrlBase: string;
	/**
	 * SecretStorage 里那个密钥的**名字**（用户在选择器里选/建）。
	 * 空串 = 尚未选择 —— 这是合法状态，不是错误值。
	 */
	accessKeyIdRef: string;
	/** 同上，Secret Access Key 的名字。 */
	secretAccessKeyRef: string;
	/**
	 * 是否用 path-style 寻址（`端点/桶/键`）。
	 *
	 * 默认 `true`，且**对主流服务商都安全**：R2 的 S3 端点不支持 virtual-host
	 * （`桶.账号.r2...`），而 MinIO / B2 / Wasabi / AWS 都接受 path-style。
	 * 只有"需要按子域解析（如 AWS 桶 + CDN）"时才要动它 ——
	 * 属于高级设置，不该出现在主流程里。
	 */
	forcePathStyle: boolean;
	/** 对象 key 模板，支持 `{hash} {ext} {hash2} {filename} {date}`。 */
	objectKeyTemplate: string;
}

/**
 * 缓存上限的最大值（MB），= 1 TB。
 *
 * 存在的意义是"挡住手滑"：有人在输入框里敲出 `999999999999` 时，
 * 不至于让后续的字节换算溢出到不可预期的比较结果。真填这么大等于不限制。
 */
export const CACHE_LIMIT_MB_MAX = 1024 * 1024;

/**
 * 用户可配置的全部设置。
 *
 * 只有 8 个顶层字段 —— 这是刻意的：每一个都对应一个**用户能自己回答的问题**
 * （"哪些要上传""本地副本怎么办""离线看得到吗""缓存最多占多大""删了怎么找回来"），
 * 而不是一个实现细节。被砍掉的 5 个见 `docs/SCOPE.md` 的参数表。
 */
export interface PluginSettings {
	/**
	 * 粘贴 / 拖拽时自动上传。
	 *
	 * 关闭后插件不再接管这两类事件（宿主恢复原生行为，图片照常存进 vault），
	 * 但**已有缓存仍然生效** —— 所以"暂时不想上传、但要保留离线可看"成立。
	 */
	autoUpload: boolean;
	/** 参与处理的扩展名（小写，不含点）。也是"什么不会被上传"的唯一判据。 */
	enabledExtensions: string[];
	/** 附件目录；空字符串 = 跟随 Obsidian 的附件设置。 */
	attachmentFolder: string;
	/** 上传成功后本地副本怎么处理。 */
	localCopy: LocalCopyAction;
	/** 缓存目录（相对 vault 根）。仅在 `localCopy === "cache"` 时起作用。 */
	cacheFolder: string;
	/**
	 * 遇到「属于本存储但没有本地副本」的图片时是否自动下载。
	 *
	 * 覆盖「并非本机上传」的图（换设备同步来的、缓存被清过的）。
	 * 关闭后这类图在离线时不可见 —— 但**站外图片永不下载**，与这个开关无关。
	 */
	fallbackDownload: boolean;
	/**
	 * 遇到**站外**图片时，按站点询问一次：是否下载、上传到自己的存储、并改写链接。
	 *
	 * ⚠️ 默认**关**。打开后插件会对外发 PUT 并**改写笔记里的链接** ——
	 * 这类动作的同意应当显式给出，而不是默默替用户做掉。
	 *
	 * 关闭时站外图**一步都不碰**（不下载、不改写、也不询问）：
	 * 渲染路径会原样保留远端地址，行为与没装这个插件一致。
	 */
	externalImageCache: boolean;
	/**
	 * 缓存目录的大小上限（MB）。**0 = 不限制**（默认）。
	 *
	 * 超过之后会在后台自动淘汰**最久没用过**的缓存副本（移入系统回收站）。
	 * 被淘汰的副本在下次看到那张图时**自动重新下载** —— 所以上限不会丢数据，
	 * 只会丢掉"那张图此刻的离线可用性"。
	 *
	 * ⚠️ 只统计**缓存目录内**的副本：`localCopy: "keep"` 时副本在附件目录里，
	 * 那是用户的正常附件，既不计入上限、也绝不会被自动淘汰。
	 */
	cacheLimitMb: number;
	/**
	 * 淘汰 / 清理缓存文件时怎么删。**默认 `permanent`（立刻释放磁盘空间）**。
	 *
	 * 对**自动轮换**与**「清理缓存文件」命令**都有效 —— 两者做的是同一件事
	 * （把缓存目录里的文件拿掉），没有理由让它们各自有一套行为：
	 * 那种不一致会表现成"我清理了缓存，磁盘空间却没变"。
	 *
	 * ⚠️ 不影响用户自己的附件：上传后不留本地副本（`localCopy: "trash"`）
	 * 那条路径删的是**用户的原始文件**，始终走回收站。
	 */
	deleteMode: DeleteMode;
	s3: S3Config;
}
