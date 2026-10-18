/**
 * 「测试连接」第二步用的**临时探针对象**：写一次 → 读一次 → 删掉。
 *
 * ## 为什么必须有一条真实对象
 *
 * 「别人打得开我笔记里那条链接吗」只能由**真实对象被匿名取了一次**来回答。
 * 拿一条不存在的地址去试是**测反**的：
 *
 * 在 S3 上，匿名 GET/HEAD 一个不存在的 key 回 403 还是 404，取决于请求者**有没有
 * `s3:ListBucket`**（AWS 官方文档原话：有 ListBucket ⇒ 404，没有 ⇒ 403），
 * **与 `GetObject` 是否对匿名公开无关**。于是同一个状态码在不同配置下指向相反结论：
 *
 * - 「公开读、但没允许匿名列举」的桶（绝大多数公开桶都是这样）⇒ 回 **403** ⇒ 被判成"私有"；
 * - 同一个桶若恰好允许匿名列举 ⇒ 回 404 —— 语义直接反过来；
 * - 换成存储桶的**网站端点**（或某些 CDN）规则又变：不存在的对象回 404、存在但没权限回 403
 *   （AWS 网站端点文档明确写了这一点，还提醒这会让别人能推断对象是否存在）。
 *
 * ⇒ 判错的方向正是本项目 1.7.0 要修的病：以为桶是公开的 ⇒ 笔记里写公开地址 ⇒
 * 别人打开全是坏图，而我们这边一切正常。只有真实对象才回答得了关于真实对象的问题。
 *
 * ## 为什么**每次都写**，而不是"有现成的旧对象就借来测"
 *
 * 借一个旧对象只能测到**读**。而用户点这个按钮问的是"这套配置能不能用" ——
 * **上传（PUT）、取回（GET）、删除（DELETE）** 任何一件不通，插件都是坏的，而这三件事
 * 与"桶里有没有旧对象"毫无关系：一个**只有读权限**的密钥在"借旧对象"的测法下
 * **全绿通过**，然后第一次上传就失败（或云端清理删不掉）。所以这一步每次都真做一遍，
 * 而且是**小对象**：几十字节，写完读回来核字节，再删掉。
 *
 * ## ⚠️ 只有用户点按钮才走这条路
 *
 * 自动探测（启动 / 保存设置，可能每敲一个字符一次）**只认索引里已有的对象**做一次匿名 HEAD：
 * 一次列举都不加、一次写都不做。那条路回答的只是"渲染该走哪条路"，不该为了它动用户的桶。
 */

/**
 * 临时探针对象的 key **前缀**。真正的 key 每次测试都不一样（见 {@link tempProbeKey}）。
 *
 * ⚠️ **别改回固定 key**（2026-10-18 真机复现）：固定的 URL 会被**中间层（代理 / CDN / 缓存）**
 * 记住 —— 同一条 `.acc-connection-probe` 的匿名请求在真机上**公开 / 私有交替出现**，
 * 其中"公开"那几次连字节都是我们写的（缓存里的旧响应），而**同一个桶里另一个 key 稳定 403**。
 * 也就是说：探针 URL 一旦被缓存，它测的就不再是桶的权限，而是**缓存的响应**。
 *
 * ⇒ 每次换一个 key（`prefix + 随机`），缓存永远命中不到，读到的就是此刻的真实权限。
 * 代价：删不掉时会留下一个**带随机后缀**的对象（`leftBehind` 会把 key 报给用户），
 * 比"报一个假的公开"轻得多。
 */
export const TEMP_PROBE_KEY_PREFIX = ".acc-connection-probe-";

/**
 * 这一轮要用的探针 key（每次不同）。
 *
 * `random` 可注入，测试里能断言"两次不同"；不注入时用 `Math.random`。
 */
export function tempProbeKey(random: () => number = Math.random): string {
	const part = random()
		.toString(36)
		.slice(2)
		.padEnd(8, "0")
		.slice(0, 8);
	return `${TEMP_PROBE_KEY_PREFIX}${part}`;
}

/**
 * 探针对象的内容。
 *
 * 非空是刻意的 —— 写进去的字节要和读回来的字节**对得上**（0 字节的比对证明不了什么）；
 * 写一句人话是为了万一它没被删掉、用户在桶里看见它时能知道**是谁放的、能不能删**。
 */
export const TEMP_PROBE_BODY = "attachment-cloud-cache connection probe";

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
 *    （"其实删掉了"只是多一句提示；"其实还在"却被告知删干净了，就是垃圾留在他数据里）。
 * 3. **放不上去 ≠ 测失败**：`placed: false` 时把原始错误交回去，让界面说清
 *    "连接正常但写不进去，上传也会这样失败" —— 而不是含糊地说"测不了"。
 *    而且此时**不许**再去测：拿一条不存在的对象测出来的结论是假的。
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
		// 没放上去 ⇒ 什么都没留下，也没测（测出来的结论会是假的）
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
 * **单飞**：同一时刻只跑一轮，并发调用共用同一个 promise。
 *
 * ## 为什么探针回路必须有它
 *
 * 回路用的是**固定的**探测 key（重复测试只覆盖同一个对象）。两轮叠在一起时，后一轮的
 * DELETE 可能落在前一轮的匿名 HEAD **之前** —— 前一轮于是看到 404，而 404 在这里的意思是
 * 「地址通、对象不在 ⇒ 多半前缀写错了」，一条**假的**结论。
 * （用户 2026-10-18 报的「快速连点有时弹出错误的测试结果」就是它。）
 *
 * ## 两条都别省
 *
 * 1. 在飞时直接返回**同一个** promise：第二次点击拿到的是这一轮的结果，不是另起一轮；
 * 2. 跑完（**无论成功还是失败**）必须把句柄清掉：否则第二次点击拿到的是上一次的旧结果 ——
 *    那正好是「测试按钮不刷新」的另一种假象。
 */
export function singleFlight<T>(start: () => Promise<T>): () => Promise<T> {
	let inFlight: Promise<T> | null = null;
	return () => {
		if (inFlight) return inFlight;
		const run = (async () => start())();
		// ⚠️ `finally` 而不是 `then`：失败也必须清句柄，否则一次失败会让按钮**永远**返回同一个失败。
		inFlight = run.finally(() => {
			inFlight = null;
		});
		return inFlight;
	};
}

/**
 * 一轮探针回路的**实测状态**（写 / 读 / 删三段各自成不成立）。
 *
 * ⚠️ 它只描述**这一轮**发生过什么，不参与渲染判定 —— 判定只看 `AccessProbe` 那一格
 * （`link-access.ts`）。界面拿的是 `main.ts::runConnectionProbe()` 的返回值，
 * 不去读全局字段（并发时那会读到另一轮的东西）。
 */
export interface ProbeRoundTripMemo {
	/** 这一轮用的探测对象 key（固定值，出错时用户要照着它去桶里删）。 */
	key: string;
	/** **写不进去**时的原始错误（此时回路没跑起来，后面的段都没有）。 */
	writeError?: unknown;
	/** 写进去了，但**读不回来**时的原始错误。 */
	readError?: unknown;
	/** 读回来了多少字节（读成功时才有值）。 */
	readBytes?: number;
	/** 读回来的字节数与写进去的不一致。 */
	sizeMismatch?: { written: number; read: number };
	/** 探测对象没删掉 —— 会留在桶里。 */
	leftBehind: boolean;
}
