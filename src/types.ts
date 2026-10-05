/**
 * 插件的共享类型。
 *
 * 关于凭据的一条硬约束：**`S3Config` 里不存明文密钥**，
 * 只存指向宿主 `SecretStorage` 的**引用名**（`*Ref` 结尾）。
 * 原因是 `data.json` 会随 vault 一起被同步、备份、分享 ——
 * 明文密钥放进去等于把它交给了所有能读到 vault 的人。
 * 这条约束由 `test-settings.mjs` 钉住（断言不存在明文凭据字段）。
 */

/** 缓存目录的布局方式。 */
export type CacheLayout =
	/** 全部平铺在缓存根目录下。 */
	| "flat"
	/** 按扩展名分目录。 */
	| "byExt"
	/** 镜像对象存储里的 key 结构（单一心智模型，默认）。 */
	| "mirror";

/** 上传成功后对**本地原文件**的处理。 */
export type LocalFileAction =
	/** 移入缓存目录 —— 默认，也是"离线可用"的前提。 */
	| "cache"
	/** 原地保留（不搬动）。 */
	| "keep"
	/** 移入回收站。 */
	| "trash"
	/** 每次询问。 */
	| "ask";

export interface S3Config {
	/** 服务端点，如 `https://abc.r2.cloudflarestorage.com`。 */
	endpoint: string;
	/** 区域；R2 固定为 `auto`。 */
	region: string;
	/** 桶名。 */
	bucket: string;
	/** 公开访问前缀，如 `https://img.example.com`。 */
	publicUrlBase: string;
	/** SecretStorage 中存放 Access Key ID 的**引用名**（不是密钥本身）。 */
	accessKeyIdRef: string;
	/** SecretStorage 中存放 Secret Access Key 的**引用名**。 */
	secretAccessKeyRef: string;
	/** 对象 key 模板，支持 `{hash} {ext} {hash2} {filename} {date}`。 */
	objectKeyTemplate: string;
}

export interface PluginSettings {
	enabled: boolean;
	s3: S3Config;
	/** 参与处理的扩展名（小写，不含点）。 */
	enabledExtensions: string[];
	/** 附件目录；空字符串 = 跟随 Obsidian 的附件设置。 */
	attachmentFolder: string;
	cacheEnabled: boolean;
	/** 缓存目录（相对 vault 根）。 */
	cacheFolder: string;
	cacheLayout: CacheLayout;
	localFileAction: LocalFileAction;
	/** 粘贴时自动上传。 */
	pasteUpload: boolean;
	/** 拖拽时自动上传。 */
	dropUpload: boolean;
	/**
	 * 遇到「属于本存储但没有本地副本」的图片时是否自动下载。
	 *
	 * 覆盖「并非本机上传」的图（换设备同步来的、缓存被清过的）。
	 * 关闭后这类图在离线时不可见。
	 */
	fallbackDownload: boolean;
	/** 渲染后延迟补扫的秒数（0 = 关闭）。 */
	cacheDelaySeconds: number;
}

/** 一条上传/缓存操作记录（用于"最近活动"）。 */
export interface LogEntry {
	time: string;
	status: string;
	notePath: string;
	sourcePath: string;
	remoteUrl: string;
	trashed: boolean;
}
