/**
 * 「测试连接」第二步（匿名可达性）该拿**哪一条对象**去试。
 *
 * ## 为什么需要这一层
 *
 * 判「别人打得开我笔记里那条链接吗」，必须**匿名请求一条真实对象的地址**：
 * 拿一条不存在的地址去试，任何结论都不是关于"链接能不能打开"的
 * （`link-access.ts` 文件头那张表：404 只证明"地址通、对象不在"，证明不了桶公开）。
 *
 * 从前只从**索引**里取第一条 key ⇒ 全新库（还没上传过任何东西）**测不了第二步**，
 * 界面上只能如实说"没有链接可检查"。而"第一次配置存储"恰恰是最需要这一步的时刻：
 * 用户想先确认配对了、再往里放东西。索引为空但桶里已有对象（换了设备 / 索引丢了）
 * 是同一个病：索引不是事实，桶才是。
 *
 * ## 三级候选（代价从低到高）
 *
 * | 顺序 | 来源 | 代价 | 什么时候走到 |
 * |---|---|---|---|
 * | 1 | 索引里第一条 key | 0（纯内存） | 上传过东西（绝大多数时候） |
 * | 2 | 桶里第一个对象（`listObjects`，**只读**） | 1 次列举 | 换了设备 / 索引丢了 / 桶里本来就有东西 |
 * | 3 | **临时探针对象**（PUT → 匿名测 → DELETE） | 一写一删 | 桶也是空的，且用户**亲手点了按钮** |
 *
 * ## 为什么不用"探一条不存在的 key"（那样一行都不用写桶）
 *
 * 因为那条路**根本给不出答案**。在 S3 上，匿名 GET/HEAD 一个不存在的 key 回 403 还是 404，
 * 取决于请求者**有没有 `s3:ListBucket`**（AWS 官方文档原话：有 ListBucket ⇒ 404，没有 ⇒ 403），
 * **与 `GetObject` 是否对匿名公开无关**。于是同一个状态码在不同配置下指向相反结论：
 *
 * - 「公开读、但没允许匿名列举」的桶（绝大多数公开桶都是这样）⇒ 回 **403** ⇒ 只读探针会报"私有"；
 * - 同一个桶若恰好允许匿名列举 ⇒ 回 404 —— 语义直接反过来；
 * - 换成存储桶的**网站端点**（或某些 CDN）规则又变：不存在的对象回 404、存在但没权限回 403
 *   （AWS 网站端点文档明确写了这一点，还提醒这会让别人能推断对象是否存在）。
 *
 * ⇒ 判错的方向正是本项目 1.7.0 要修的病：以为桶是公开的 ⇒ 笔记里写公开地址 ⇒
 * 别人打开全是坏图，而我们这边一切正常（反过来把公开误判成私有，则每张图白下载一遍）。
 * 多写一个几十字节的对象再删掉，代价是**可见、有限、可解释**的；判错的代价不是。
 * 所以这里宁可写一次：**只有真实对象才能回答关于真实对象的问题**。
 *
 * ## ⚠️ 第三级只在用户点按钮时发生
 *
 * 启动与保存设置时的自动探测只是在回答"渲染该走哪条路"，为了它往用户的桶里写字
 * 是不可接受的（保存设置可能是每敲一个字符一次）。所以 `allowTempObject` 默认 **false**：
 * 自动探测仍然只在索引里已有对象时才发请求 —— 行为与从前一致，多一次网络请求都不加。
 */

/** 临时探针对象的 key。**固定**一条：重复测试只覆盖同一个对象，不会在桶里越堆越多。 */
export const TEMP_PROBE_KEY = ".acc-connection-probe";

/**
 * 探针对象的内容。
 *
 * 非空是刻意的（`putObject` 的传后校验会核 `Content-Length`）；写一句人话是为了
 * 万一它没被删掉、用户在桶里看见它时能知道**是谁放的、能不能删**。
 */
export const TEMP_PROBE_BODY = "attachment-cloud-cache connection probe";

/** 这一次探测试的是哪一类对象。 */
export type ProbeSampleSource = "index" | "bucket" | "temp";

/** 候选方案：`source === "none"` 表示**一条都没有**（此时 `key` 为 `null`）。 */
export interface ProbeSamplePlan {
	key: string | null;
	source: ProbeSampleSource | "none";
}

/**
 * 三级候选，**按顺序**取第一个可用的。**纯编排**（I/O 全部注入），可以穷举。
 *
 * @param indexedKeys 索引里的 key（调用方传进来，这一层不认识 `CacheIndex`）
 * @param listFirstKey 只读列举「桶里第一个对象的 key」；失败/没有就返回 `null`。
 *   不传 = 这一步不做（自动探测走的就是这条：**不加网络请求**）
 * @param allowTempObject 是否允许临时放一个探针对象（只有用户点按钮时为 true）
 */
export async function planProbeSample(options: {
	indexedKeys?: readonly string[] | null;
	listFirstKey?: (() => Promise<string | null>) | null;
	allowTempObject?: boolean;
}): Promise<ProbeSamplePlan> {
	for (const key of options.indexedKeys ?? []) {
		const clean = typeof key === "string" ? key.trim() : "";
		// 索引里可能有空串（手改过 / 反序列化出问题）—— 空 key 不能拿去拼地址
		if (clean !== "") return { key: clean, source: "index" };
	}

	if (options.listFirstKey) {
		try {
			const listed = await options.listFirstKey();
			const clean = typeof listed === "string" ? listed.trim() : "";
			// ⚠️ 列举失败**不当错误**往上抛：它只说明"我们找不到现成的样本"，
			// 下一步（临时探针）照样能给出结论。真正的失败会在写那一步如实暴露。
			if (clean !== "") return { key: clean, source: "bucket" };
		} catch {
			// 没有列举权限、网络抖了一下 —— 都一样：往下走
		}
	}

	if (options.allowTempObject) return { key: TEMP_PROBE_KEY, source: "temp" };
	return { key: null, source: "none" };
}

/** 临时探针跑完之后的**结果 + 善后状态**。 */
export interface TempProbeOutcome<T> {
	/** 放上去了吗。`false` ⇒ 探测**没发生**（`value` 为 `undefined`）。 */
	placed: boolean;
	/** 放上去时的原始错误（`placed === false` 时有值）。 */
	putError?: unknown;
	/** 探测结果（`placed === false` 时为 `undefined`）。 */
	value?: T;
	/** ⚠️ 桶里**还留着**那个探测对象（没删掉）。 */
	leftBehind: boolean;
	/** 删除失败时的原始错误。 */
	removeError?: unknown;
}

/**
 * 「放一个临时探针对象 → 测它 → 删掉」。
 *
 * ## 三条硬要求
 *
 * 1. **探测失败也必须删** —— 所以清理在 `finally` 里，不依赖测量成不成功。
 * 2. **删不掉要如实说**（`leftBehind`），不能静默：那个对象会留在用户的桶里，
 *    而用户自己不会想到去查。方向取**保守**的：删的时候报错 = 当它还留着
 *   （"其实删掉了"只是多一句提示；"其实还在"却被告知删干净了，就是垃圾留在他数据里）。
 * 3. **放不上去 ≠ 测失败**：`placed: false` 时把原始错误交回去，让界面说清
 *    "连接正常但写不进去，上传也会这样失败" —— 而不是含糊地说"测不了"。
 *
 * ⚠️ 这里的 `remove` 返回 `false`（对象本来就不在）算**干净**：目标状态是不留在桶里。
 */
export async function runWithTempProbeObject<T>(deps: {
	key: string;
	put: (key: string) => Promise<unknown>;
	remove: (key: string) => Promise<boolean>;
	measure: () => Promise<T>;
}): Promise<TempProbeOutcome<T>> {
	try {
		await deps.put(deps.key);
	} catch (putError) {
		// 没放上去 ⇒ 什么都没留下
		return { placed: false, putError, leftBehind: false };
	}

	const outcome: TempProbeOutcome<T> = { placed: true, leftBehind: false };
	try {
		outcome.value = await deps.measure();
	} finally {
		try {
			await deps.remove(deps.key);
		} catch (removeError) {
			outcome.leftBehind = true;
			outcome.removeError = removeError;
		}
	}
	return outcome;
}

/**
 * 上一次探测**试的是哪条对象**。设置页据此解释「这次是怎么测的」
 *（临时探针要在界面上说一句，否则用户看到一个自己没上传过的文件名会以为见了鬼）。
 */
export interface ProbeSampleMemo {
	source: ProbeSampleSource;
	key: string;
	/** 临时探针没删掉 —— 会留在桶里。 */
	leftBehind: boolean;
	/** 临时探针**放不上去**时的原始错误（此时探测没有发生，`leftBehind` 无意义）。 */
	writeError?: unknown;
}
