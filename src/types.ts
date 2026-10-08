/**
 * 插件的共享类型。
 *
 * ## 凭据：哪些进设置，哪些进钥匙串
 *
 * 这两项的处理**不一样**，因为它们的性质不一样：
 *
 * | | 性质 | 存哪 | 为什么 |
 * |---|---|---|---|
 * | 访问密钥 ID | **标识符**（"是谁"）| `data.json`（明文）| 见下 |
 * | 秘密访问密钥 | **秘密**（"证明你是"）| 操作系统钥匙串 | 泄露即可伪造请求 |
 *
 * 访问密钥 ID 之所以可以明文存，是两件事共同决定的：
 *
 * 1. 它**本来就出现在网络请求里**（SigV4 的 `Credential=<访问密钥>/日期/区域/…` 那一段），
 *    也会进服务端日志与账单报表 —— 单独拿到它对签名毫无用处；
 * 2. Obsidian 的密钥存储**装不下它**：`SecretStorage.setSecret` 的 ID 只能是
 *    "lowercase alphanumeric with optional dashes"（非法直接抛错），
 *    而访问密钥 ID 常规就带大写（AWS 的 `AKIA…`、MinIO 生成的那种）。
 *
 * 第 2 点不是推理，是实测撞出来的：早期版本把它建模成"指向钥匙串的引用"
 *（`accessKeyIdRef`），用户想在选择器里填自己的访问密钥时，被挡在
 * "名字不能有大写"那堵墙上 —— 实测那个字段**一直是空的**，从来没能被填上。
 *
 * 秘密访问密钥：设置里只存**槽位名**（`secretAccessKeyRef`），值走
 * `app.secretStorage.getSecret(name)` 取 —— 官方指南原话："When saved, your plugin
 * settings contain the name of the secret, not the actual secret value."
 *
 * ⚠️ 那个槽位名是**插件自动生成**的，用户看不到也不用管：设置界面上它与访问密钥 ID
 * **并排**，输入即写穿到钥匙串。成对签发、成对轮换的两项因此能在同一处改完 ——
 * 早先用 `SecretComponent`（"选择或新建一条**具名**密钥"）时，这一对被拆到了两个地方。
 * 空串 = 尚未存过秘密，所以用 `textValue()` 而非 `requiredTextValue()`：
 * 空串是有意义的状态，不该被悄悄回落成一个指向不存在密钥的名字。
 *
 * ⚠️ 新建钥匙串条目时，**名字**只能用小写字母数字加短横线（Obsidian 的规定）。
 * 名字随便起（如 `minio-secret`），**真正的密钥填在名字下面那一格** ——
 * 设置页的说明文案里写明了这一点（不然用户会很自然地把密钥本身填进"名字"）。
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
	 * vault 最干净 —— 代价是**离线看不了**，这是三档里唯一与"离线可用"相冲突的取舍。
	 */
	| "trash";

export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["cache", "keep", "trash"];

export function isLocalCopyAction(value: unknown): value is LocalCopyAction {
	return typeof value === "string" && (LOCAL_COPY_ACTIONS as readonly string[]).includes(value);
}

/**
 * 遇到**站外**图片时**默认**怎么做。
 *
 * ## 为什么这是一个显式设置，而不是"每次都问"
 *
 * 早先的行为是"首次遇到某个站点时弹通知问一次"。那个设计有两个问题：
 * - **打扰**：询问出现在**阅读**路径上，而"要不要把这张图搬进我的存储"并不是件紧急的事；
 * - **粒度太粗**：它记住的是**站点**，于是"这个站点别的图都要，就这一张不要"根本表达不出来。
 *
 * 现在改成两件事的组合：
 * 1. 这个设置说**默认**怎么办（用户自己选的，不猜）；
 * 2. 想逐张控制时，用「选择要缓存的外链图片」那条命令/按钮**显式勾选** ——
 *    勾选本身就是同意，不受这里的"默认"影响。
 *
 * ⚠️ 出厂是 `skip`（**什么都不做**）：打开功能**不等于**同意去下载别人的图、
 * 更不等于同意改写自己的笔记。
 */
export type ExternalImageDefault =
	/** 遇到站外图时**什么都不做**（默认）。 */
	| "skip"
	/** 遇到站外图时直接下载 → 上传 → 改写链接。 */
	| "cache";

/** 下拉里能选的值。**由它生成选项**，于是"界面能选的"与"类型允许的"只有一处定义。 */
export const EXTERNAL_IMAGE_DEFAULTS: readonly ExternalImageDefault[] = ["skip", "cache"];

export function isExternalImageDefault(value: unknown): value is ExternalImageDefault {
	return typeof value === "string" && (EXTERNAL_IMAGE_DEFAULTS as readonly string[]).includes(value);
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
	 * 访问密钥 ID（MinIO 的「Access Key」、AWS 的「Access Key ID」）。
	 *
	 * ⚠️ **明文存在设置里，这是有意的**：它是**标识符**而不是秘密
	 *（会出现在请求签名与服务端日志里，单独拿到它对签名毫无用处），
	 * 而且 Obsidian 的密钥存储只接受小写 ID、装不下它（详见文件头那段）。
	 * 空串 = 尚未填写（合法状态）。
	 */
	accessKeyId: string;
	/**
	 * SecretStorage 里那条**秘密访问密钥**的名字（用户在选择器里选/建）。
	 * 空串 = 尚未选择 —— 这是合法状态，不是错误值。
	 */
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
 * 只有 7 个顶层字段 —— 这是刻意的：每一个都对应一个**用户能自己回答的问题**
 * （"哪些要上传""本地副本怎么办""离线看得到吗""缓存最多占多大"），
 * 而不是一个实现细节。凡是答不出"用户会怎么回答"的字段都不进来。
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
	 * 是否**启用**「处理站外图片」这条链路（默认**关**）。
	 *
	 * ⚠️ 关着时站外图**一步都不碰**（不下载、不改写、也不列进任何候选）：
	 * 渲染路径会原样保留远端地址，行为与没装这个插件一致。
	 *
	 * 打开本项目**不等于**同意去下载别人的图 —— 那件事由
	 * {@link externalImageDefault} 与「选择要缓存的外链图片」那条命令显式表达。
	 */
	externalImageCache: boolean;
	/**
	 * 遇到站外图片时**默认**怎么做：什么都不做（出厂）/ 直接缓存。
	 *
	 * ⚠️ 只在 {@link externalImageCache} 打开时才有意义（设置页里也是这么显示的）。
	 */
	externalImageDefault: ExternalImageDefault;
	/**
	 * 缓存目录的大小上限（MB）。**0 = 不限制**（默认）。
	 *
	 * 超过之后会在后台自动删除**最久没用过**的缓存副本，磁盘空间**立刻**释放。
	 * 被删掉的副本在下次看到那张图时**自动重新下载** —— 所以上限不会丢数据，
	 * 只会丢掉"那张图此刻的离线可用性"。
	 *
	 * ⚠️ 为什么删得这么干脆（而不是像别处那样先进回收站）：上限要解决的就是**空间**，
	 * 而回收站不释放物理空间 —— 文件离开了 vault、磁盘却还占着，于是表现成
	 * "设了上限，磁盘还是满的"，想释放还得再手动清空回收站。详细理由见
	 * `maintenance/remove.ts`。
	 *
	 * ⚠️ 只统计**缓存目录内**的副本：`localCopy: "keep"` 时副本在附件目录里，
	 * 那是用户的正常附件，既不计入上限、也绝不会被自动淘汰。
	 */
	cacheLimitMb: number;
	s3: S3Config;
}
