/**
 * 删除留痕：云端对象被删掉时，把清单**追加**写到一条日志里。
 *
 * ## 它补的是什么缺口
 *
 * 删云端对象是**不可恢复**的，而在此之前，插件对这个动作**不留任何痕迹** ——
 * 用户能看到的只有一条一闪而过的通知。事后想回答"我到底删了什么、什么时候删的"
 * 就完全没有依据了。
 *
 * 2026-10-11 起这个询问是**自动出现**的（某个对象失去最后一个引用就弹）。
 * 「自动触发」+「不可恢复」+「无留痕」三件事叠在一起，是本产品风险最集中的一处，
 * 所以先补成本最低的那一层：**留个可追查的记录**。
 *
 * ⚠️ 它**不是**"回收站"：日志里的对象**不会**因此能恢复。
 * 真正的宽限期（先 `CopyObject` 到某个前缀、N 天后再真删）是另一件事，
 * 代价是"谁来做 N 天后的真删"这个持久化任务 —— 见设计 §6.3.3，仍未做。
 *
 * ## 为什么写在**插件目录**而不是缓存目录
 *
 * 缓存目录是**承诺过可以整体删除**的（那是"离线副本可再生"这条承诺的一部分）——
 * 把留痕写在那里，用户清理副本时就把证据一起删掉了，等于白留。
 * 插件目录与缓存索引同处一地，是"插件自己的数据"，不会被缓存清理碰。
 *
 * ## 为什么这个模块不直接用宿主的 adapter
 *
 * 与其它维护模块同一条纪律：**可注入 = 可穷举**。
 * 这里只做"把记录变成文本行"和"写失败不许抛错"这两件事，怎么写由调用方接。
 */

/** 日志文件名。与缓存索引一样以点开头（不进宿主的文件索引）。 */
export const DELETE_LOG_FILE = ".deleted-objects.log";

/** 一次删除留在日志里的一行。 */
export interface DeletedObjectRecord {
	/** 对象 key。 */
	key: string;
	/** 索引里记的原始文件名（可能为空 —— 换设备下载回来的副本没有文件名）。 */
	name: string;
	/** 对象是不是真的删掉了；`alreadyGone` = 服务端回 404，本来就不存在。 */
	outcome: "deleted" | "alreadyGone";
	/** 走的是哪条入口：孤儿通知、那条命令，还是「统一对象名」的迁移。 */
	scope: "orphan" | "command" | "migration";
}

/**
 * 日志文件该写在哪（vault 相对路径）；**插件目录未知时返回 `null`**。
 *
 * 与 `indexFilePath` 同一条清洗规则（反斜杠归一、掐掉首尾斜杠）。
 *
 * ⚠️ 为什么"未知"要返回 `null` 而不是给一个兜底文件名：正常的宿主环境里
 * `manifest.dir` 一定有值，没有值说明插件目录**还没被挂上**（开发/探针环境）。
 * 那种时候给兜底名，日志就落到 **vault 根**（`.deleted-objects.log`）——
 * 一个我们没打算放、用户也没要求放的文件，还会跟着 vault 同步出去。
 * 说不出来就不写，比"写到一个猜出来的地方"安全（删云端本身照常进行）。
 */
export function deleteLogTargetPath(pluginDir: string | null | undefined): string | null {
	const clean = String(pluginDir ?? "")
		// 纯空白等于没有目录名 —— 不 trim 的话会拼出 `"   /.deleted-objects.log"`
		// 这种路径，而它同样会落到 vault 根附近（宿主对它的解释不可预测）
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return clean ? `${clean}/${DELETE_LOG_FILE}` : null;
}

/**
 * 把一条记录变成**一行** JSON（行尾带换行）。
 *
 * 选 JSON Lines 而不是"人类可读的一行字"：这条日志的用途是**事可查**（脚本也能读），
 * 而字段里有对象 key（十六进制 + 扩展名）与文件名（可能含空格、逗号、中文）——
 * 用分隔符拼文本必然要发明一套转义规则，JSON 是现成的。
 */
export function formatDeleteLogEntry(record: DeletedObjectRecord, at: string): string {
	return `${JSON.stringify({
		at,
		key: record.key,
		name: record.name,
		outcome: record.outcome,
		scope: record.scope,
	})}\n`;
}

export interface DeleteLogDeps {
	/**
	 * 追加一段文本（由接线层接到宿主的 `DataAdapter.append` 上）。
	 *
	 * ⚠️ 由它负责 **建目录与建文件**（宿主的 `append` 自己会处理缺失的文件）。
	 */
	append: (text: string) => Promise<void>;
	/** 现在的时间。注入是为了让套件能固定它。 */
	now?: () => Date;
	/** 写失败时的上报口 —— 见 `recordDeletions` 的说明（绝不抛错）。 */
	onError?: (error: unknown) => void;
}

/**
 * 把这一批删除写进日志。返回**实际写下的行数**。
 *
 * ## ⚠️ 写失败**绝不抛错**
 *
 * 留痕是"事后可追查"的加强项，而删除本身是用户已经确认过的动作 ——
 * 让"日志写不进去"（磁盘满、权限、同步中的文件被占）把整条删除链**炸断**，
 * 等于为了一个附属功能破坏了主功能，而且是在一个不可恢复的动作上。
 * 所以失败只上报，返回值如实为 0 行。
 *
 * ## 过滤
 *
 * key 为空/纯空白的记录一律丢掉（日志里留一条没有 key 的行毫无意义），
 * 全部被丢掉时不写文件（不产生空写入）。
 */
export async function recordDeletions(
	deps: DeleteLogDeps,
	records: readonly DeletedObjectRecord[]
): Promise<number> {
	const at = (deps.now?.() ?? new Date()).toISOString();
	const lines: string[] = [];
	for (const raw of records ?? []) {
		// ⚠️ 全程用**可选链**读字段：这一层的输入来自"删完之后攒下的清单"，
		// 而它一路从宿主 API 的返回值拼过来 —— 出现 `null`/`undefined` 条目时
		// 应当**跳过**，不是在这里抛错（抛错会把删除链带走，见上面那段说明）。
		const key = typeof raw?.key === "string" ? raw.key.trim() : "";
		if (!key) continue;
		lines.push(
			formatDeleteLogEntry(
				{
					key,
					name: typeof raw?.name === "string" ? raw.name : "",
					// 只认**恰好**是 "alreadyGone" 的那一个取值：其余一律按"真的删掉了"记。
					// （这一栏是给人看的，宁可写得保守 —— 说"删了"而其实"本来就没有"，
					// 也比反过来强：后者会让人以为"还有东西等着删"。）
					outcome: raw?.outcome === "alreadyGone" ? "alreadyGone" : "deleted",
					// 只有这三个取值；未知值一律按 `command`（那一栏是给人看的，
					// 宁可写得保守也不敢凭空造一个新入口）。
					scope:
						raw?.scope === "orphan" ? "orphan" : raw?.scope === "migration" ? "migration" : "command",
				},
				at
			)
		);
	}

	if (lines.length === 0) return 0;

	try {
		await deps.append(lines.join(""));
		return lines.length;
	} catch (error) {
		deps.onError?.(error);
		return 0;
	}
}
