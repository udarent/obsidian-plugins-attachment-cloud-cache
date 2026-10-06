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
 * 用户可配置的全部设置。
 *
 * 只有 6 个顶层字段 —— 这是刻意的：每一个都对应一个**用户能自己回答的问题**
 * （"哪些要上传""本地副本怎么办""离线看得到吗"），而不是一个实现细节。
 * 被砍掉的 5 个见 `docs/SCOPE.md` 的参数表。
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
	s3: S3Config;
}
