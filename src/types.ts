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
 * 现在只有两个互斥且都能落地的结果，不存在"选了 A 却得到 B"。
 *
 * ⚠️ **1.2.0（D-17）起从三态收窄成两态**：原来的 `"cache"`（上传后把文件搬进缓存目录）
 * 整个消失 —— 没有缓存目录可搬，那份文件**本身就是**本地副本。老 `data.json` 里的
 * `"cache"` 由 `settings.ts` 静默折成 `"keep"`（见 `localCopyValue`），它不再是一个可选值。
 */
export type LocalCopyAction =
	/**
	 * 留在附件目录原地（**默认**）。
	 *
	 * 不额外建目录；笔记里的链接同样改成远端地址，所以这个文件不再被笔记引用，
	 * 只作为离线副本存在。离线可见。
	 */
	| "keep"
	/**
	 * 不留本地副本（上传后把本地文件移入回收站）。
	 *
	 * vault 最干净 —— 代价是**离线看不了**，这是三档里唯一与"离线可用"相冲突的取舍。
	 *
	 * ⭐ 这一档同时**关掉缓存的两条主动行为**（见 {@link isCacheDisabled}）：
	 * 不为新附件保留副本（上传后移走，索引也不登记），渲染时也**不为它把副本取回来**
	 * （不联网、不落盘）。等价于"只把本插件当普通图床用"：上传 → 拿到一条链接。
	 *
	 * ⚠️ **已经存在的**副本仍然照常使用（例如旧档位留下的，或用户显式缓存进来的站外图）——
	 * 那是"缓存里有什么就用什么"，与"不再往里写"是两件事。1.2.0（D-17）之后副本散落在
	 * 附件目录里（其中就可能混着用户自己的文件），所以没有"一键清空副本"的命令可跑了：
	 * 想真的删掉，只能由用户自己按 R17 的询问逐份决定。
	 */
	| "trash";

export const LOCAL_COPY_ACTIONS: readonly LocalCopyAction[] = ["keep", "trash"];

export function isLocalCopyAction(value: unknown): value is LocalCopyAction {
	return typeof value === "string" && (LOCAL_COPY_ACTIONS as readonly string[]).includes(value);
}

/**
 * 「不留本地副本」这一档是不是等于**关闭缓存**。
 *
 * ⭐ 这个语义只在**这一处**定义，因为有三个互不相干的层要各自做判断，
 * 而它们必须给出同一个答案（不一致的后果都不报错）：
 * - 渲染判定（`render/render-target.ts`）：这一档下不为缺副本的图去联网补齐；
 * - 回退下载（`core/download.ts`）：最后一道闸门 —— 这一层是唯一会把远端字节写进 vault 的地方；
 * - 设置界面（`ui/settings-tab.ts`）：那些在这一档下**永远不会起作用**的开关不显示
 *   （显示一个不起作用的开关比不显示更糟 —— 与「缓存目录」同一条纪律）。
 *
 * 判据写成"要不要写副本"，而不是"要不要用副本"：已经存在的副本不受影响
 * （用户显式缓存进来的站外图仍然离线可见）。
 *
 * ⚠️ 1.7.0 起这一档**不再等于"什么都不显示"**：存储不可公开读取时，缺副本的图改走
 * **预签名地址**（`link-access.ts::displayPathFor`）—— 图照样显示，只是磁盘上不落文件、
 * 离线看不到。所以"关闭缓存"这个说法只对"写不写副本"成立，不要读成"关掉显示"。
 */
export function isCacheDisabled(action: unknown): boolean {
	return action === "trash";
}

/**
 * 「站点名单」的三种模式（1.2.0 新增）。
 *
 * ## 它取代了「遇到站外文件链接时：什么都不做 / 直接缓存」那一档
 *
 * 旧设计把"要不要处理"拆成两个控件：一个总开关 + 一个**默认行为**（什么都不做 / 直接缓存）。
 * 结果没有一个控件单独回答得了"站外文件到底会不会被自动处理"——用户要在两个控件之间
 * 自己脑补组合。现在合成一个开关：**开 = 按普通附件处理，关 = 一步都不碰**。
 * 而"只对某些站点这么做"由这份名单表达。
 *
 * ⚠️ 更早还有过"首次遇到某个站点就弹通知问一次"（记进 `.site-decisions.json`）。
 * 它被撤掉有两个原因，其中的教训仍然管用：询问出现在**阅读**路径上（不紧急的事不该打断），
 * 而且它记的是**站点**、表达不出"这个站点别的图都要，就这一张不要"。
 * 名单是**事前**配置的静态规则，不打断任何路径 —— 两者不是同一个东西。
 *
 * ## ⚠️ 为什么是"三选一"，而不是黑名单、白名单各一个开关
 *
 * 两者同时存在时，"白名单里的站点又被黑名单命中"算哪一边**没有自然的答案**：
 * 让黑名单赢，白名单里写它就没意义；让白名单赢，黑名单就管不住这些站。
 * 与其在文档里解释这条规则，不如让这种组合**根本表达不出来**。
 *
 * ## ⚠️ 名单只管"自动搬"那一路，**不是安全边界**
 *
 * 它决定**自动**遇到站外文件时访不访问那个站点。「手动选择要上传的文件」是一次显式勾选，
 * **不受它约束**（判据见 `render/external-decide.ts` 的 `purpose`）。
 * 真正拦得住的东西只有 `isBlockedHost`（回环 / 链路本地 / 云元数据），
 * 那条是**无条件**的 —— 白名单越不过它。
 */
export type ExternalSiteMode =
	/** 不过滤（出厂默认）：任何站点都按上面的开关处理。 */
	| "off"
	/** 黑名单：名单内的站点**不自动**处理，其余照常。 */
	| "blocklist"
	/** 白名单：**只**自动处理名单内的站点。⚠️ 名单为空 = 一个站点都不处理。 */
	| "allowlist";

/** 下拉里能选的值。**由它生成选项**，于是"界面能选的"与"类型允许的"只有一处定义。 */
export const EXTERNAL_SITE_MODES: readonly ExternalSiteMode[] = ["off", "blocklist", "allowlist"];

export function isExternalSiteMode(value: unknown): value is ExternalSiteMode {
	return typeof value === "string" && (EXTERNAL_SITE_MODES as readonly string[]).includes(value);
}

/**
 * 「统一对象名」（CR-15）的状态位 —— **持久化**，因为它的唯一用途是跨进程拦住改名。
 *
 * | 值 | 什么时候写的 | 改名的后果 |
 * |---|---|---|
 * | `idle` | 没跑过 / 跑完 / 用户放弃 | 允许 |
 * | `running` | 迁移开始（**先写它、再动手**） | 拒绝 |
 * | `interrupted` | 迁移中途抛错（收尾那一步写） | 拒绝（续跑或放弃后才放开） |
 *
 * ⚠️ 崩溃时来不及写 `interrupted` ⇒ 状态**留在 `running`**。这正是设计要的：
 * 重启后仍然拦改名，直到用户明确选「继续」或「放弃」。
 * ⚠️ 判据只能读这个字段，**不能看界面**：按钮灰掉挡不住命令面板与并发回调。
 */
export type MigrationState = "idle" | "running" | "interrupted";

export const MIGRATION_STATES: readonly MigrationState[] = ["idle", "running", "interrupted"];

export function isMigrationState(value: unknown): value is MigrationState {
	return typeof value === "string" && (MIGRATION_STATES as readonly string[]).includes(value);
}

/**
 * 「改名待补」的一条：下次连上网要写进云端声明的显示名（CR-16）。
 *
 * 只影响**别设备看到的名字**：写丢了最坏是显示名旧一轮，绝不参与删除判定。
 */
export interface DeclarationNameEntry {
	/** 新的文件名（含扩展名）。 */
	readonly name: string;
	/** 小写扩展名，不含点。 */
	readonly ext: string;
	/** 入队时间（ISO）。队列按它淘汰最旧的。 */
	readonly at: string;
}

/** `hash → 待补条目`（见 `maintenance/declaration-names.ts`）。 */
export type DeclarationNameBacklog = Readonly<Record<string, DeclarationNameEntry>>;


/** S3 兼容存储的连接参数。 */
export interface S3Config {
	/** 服务端点，如 `https://abc.r2.cloudflarestorage.com`。 */
	endpoint: string;
	/** 区域；R2 固定为 `auto`。 */
	region: string;
	/** 桶名。 */
	bucket: string;
	/** 公开链接地址，如 `https://img.example.com`。图片链接由它拼出来。 */
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
	// 曾经这里有一个 `objectKeyTemplate`（用户可以自由拼 `{hash} {name} {date}` 之类）。
	// ⭐ 1.2.0 **取消了它**：不含完整 `{hash}` 的模板会让**同名但内容不同**的文件得到
	// 同一个 key，而那条路上的"命中缓存即复用"判定不比内容 ⇒ 静默地复用错文件、
	// 甚至在本地副本不在时覆盖桶里的对象。形状现在固定在 `object-key.ts` 的
	// `objectKeyFor` 一处（`<名字>-<完整哈希>[.<扩展名>]`），不再可配。
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
 * 顶层字段刻意保持少 —— 每一个都对应一个**用户能自己回答的问题**
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
	/** 上传成功后本地副本怎么处理。 */
	localCopy: LocalCopyAction;
	// ⚠️ 1.2.0（D-17）起**没有** `cacheFolder` 字段了：缓存目录整个取消，本地副本就是
	// 附件目录里那份原件。老 `data.json` 里那个键由字段表自动丢弃（`fromJSON` 对多余键本就忽略）。
	// ⚠️ 迁移期若还需要"老缓存目录在哪"，**不要**回到这个字段：`data.json` 可能已被之后任意
	// 一次设置保存清掉它 ⇒ 从**索引条目的 `cachePath`** 反推才是可靠来源（设计 §4.4.1 有更正）。
	/**
	 * 遇到「属于本存储但没有本地副本」的图片时是否自动下载。
	 *
	 * 覆盖「并非本机上传」的图（换设备同步来的、缓存被清过的）。
	 * 关闭后这类图在离线时不可见。
	 * ⚠️ 它只管**本存储里的对象**（地址能反推出对象名）—— 范围之外的一律不碰。
	 */
	fallbackDownload: boolean;
	/**
	 * 是否把**站外文件当普通附件处理**（默认**关**）。
	 *
	 * 打开 = 渲染时遇到站外文件就自动下载 → 上传到你的存储 → 改写笔记里的链接，
	 * 与粘贴一张本地图走的是同一条链（连 {@link localCopy} 那一档也一样适用）。
	 * 关着 = 站外文件**一步都不碰**，行为与没装这个插件的这一块一致。
	 *
	 * ⚠️ 它同时是「上传全部附件」处理**站外图**的开关（2026-10-24 用户定的口径）：
	 * 关着 = 那条链连站外图都不碰；打开 = 连站外图一起传（并受站点名单约束）。
	 * 之所以能这么合并：那条链现在**没有清单**了（一次确认），"要不要碰站外"只能靠事前设置。
	 *
	 * ⚠️ 1.2.0 之前这里还配套一个「遇到站外文件链接时：什么都不做 / 直接缓存」。
	 * 那一档已合并进这一个开关，老数据由载入流程里的一次性迁移折算
	 *（`hasLegacyExternalImageDefault` / `legacyAutoCacheEnabled`）。
	 */
	externalImageCache: boolean;
	/**
	 * 站点名单的模式（`off` / `blocklist` / `allowlist`）。
	 *
	 * ⚠️ 只在 {@link externalImageCache} 打开时才有意义 —— 关着时不自动处理任何站点。
	 * 与 `off` 的差别是"自动处理哪些站点"，见 {@link ExternalSiteMode}。
	 */
	externalSiteMode: ExternalSiteMode;
	/**
	 * 名单本身：一行一个域名（`example.com`、`cdn.example.com`）。
	 *
	 * 匹配按**域名后缀**：写 `example.com` 会命中 `img.example.com`；
	 * 带端口（`example.com:8080`）则精确匹配含端口。
	 *
	 * 存成**数组**（一条一项）而不是一整段文本：解析与归一交给纯函数，
	 * 设置里存的就是"用户填了哪些条目"本身。
	 */
	externalSiteList: string[];
	/**
	 * 「上传全部附件」要不要**连笔记里指向这台电脑的文件一起上传**（默认**关**）。
	 *
	 * 一个 `file:///D:/…` 是**库外**的绝对路径 —— 读它等于按笔记里写的地址去翻这台电脑。
	 * 这类地址常常指向临时目录（WPS 的 `Temp/ksohtml/…`、企业微信的截图缓存），
	 * 隔天就没了；而读它**没有任何库内约束**（不在 vault 里，宿主也不管它）。
	 * ⇒ 与 {@link externalImageCache} 同理，"要不要碰库外的东西"必须由用户**事前、显式**决定，
	 * 出厂就开着等于替他做了决定。
	 *
	 * ⚠️ 只在**桌面端**有意义（手机拿不到本机绝对路径，判定层在平台那一步就拦了）。
	 * ⚠️ 它只管「上传全部附件」这一条链；自动那一路（打开笔记时缓存本机文件）
	 * 由渲染判定自己决定，与本字段无关。
	 */
	uploadLocalFiles: boolean;
	/**
	 * 本地副本的大小上限（MB）。**0 = 不限制**（默认）。
	 *
	 * 超过之后会在后台自动删除**最久没用过**的副本，磁盘空间**立刻**释放。
	 * 被删掉的副本在下次看到那张图时**自动重新下载** —— 所以上限不会丢数据，
	 * 只会丢掉"那张图此刻的离线可用性"。
	 *
	 * ⚠️ 为什么删得这么干脆（而不是像别处那样先进回收站）：上限要解决的就是**空间**，
	 * 而回收站不释放物理空间 —— 文件离开了 vault、磁盘却还占着，于是表现成
	 * "设了上限，磁盘还是满的"，想释放还得再手动清空回收站。详细理由见
	 * `maintenance/remove.ts`。
	 *
	 * ⚠️ 只统计**索引里记过的**副本，也就是插件自己经手过的那一份：从未上传过的、
	 * 插件没登记过的附件既不计入上限、也绝不会被自动淘汰 —— 它只碰"我们自己造出来的副本"。
	 */
	cacheLimitMb: number;
	/**
	 * 在控制台打印**排障日志**（每个阶段的输入/输出计数与耗时）。默认**关**。
	 *
	 * ⚠️ 它只影响控制台，不改任何行为；关着时一行都不打（连 `Date.now()` 都不取）。
	 * 用途是"结果不对"时能看出停在哪一段 —— 例如引用扫描认出 12 个目标、
	 * 只解析到 9 个路径，那就该看归一化，而不是去看上传。
	 */
	debugLogging: boolean;
	/**
	 * 本库身份（首次启动时随机生成，之后不再变）。
	 *
	 * ⚠️ **不能用库路径或库名**：用户改目录名不该让所有声明失效（那等于所有对象的保护一起丢）。
	 * ⚠️ 它只是**标识符**，不是秘密 —— 会出现在对象 key 里，服务商能看到。
	 */
	vaultId: string;
	/**
	 * ⚠️ **本设备身份不在这里**（2026-10-28 移出）。
	 *
	 * 它原先存这个对象里 ⇒ 跟着 `data.json` 走 ⇒ **同步软件会把它推到其他设备** ⇒
	 * 同一个库的多台设备拿到**同一个 `deviceId`** ⇒ 都往 `_acc/<vault>/<device>/` 的
	 * 同一份声明里写 ⇒ 后写覆盖先写 ⇒ 先写那台的引用消失 ⇒ 它上传的对象被当成孤儿删掉。
	 *
	 * 现在它存在**宿主本机存储**（`app.loadLocalStorage`），不随 vault 同步。
	 * 读写在 `main.ts` 的 `loadDeviceId()`；用的时候从 `PluginContext.deviceId` 取。
	 */
	/**
	 * 「统一对象名」（CR-15）跑到哪一步了 —— 见 {@link MigrationState}。
	 *
	 * ⚠️ 它**不是**进度条，而是**改名的执行层闸门**：非 `idle` 时 `renameItem` 直接拒绝。
	 * 判据放在执行层是因为界面挡不住命令面板与并发回调（本项目的老规矩：判据不许只有 UI 一层）。
	 */
	migrationState: MigrationState;
	/**
	 * 改名没来得及写进云端声明的那些（CR-16）。
	 *
	 * ⚠️ 它是**补写队列**，不是"改名历史"：同一个 hash 连改几次只留最后一次。
	 * ⚠️ 上传 / 清理 / 迁移**启动前**会 flush 一次；flush 失败只记账，不阻断那件事。
	 */
	declarationNameBacklog: DeclarationNameBacklog;
	s3: S3Config;
}
