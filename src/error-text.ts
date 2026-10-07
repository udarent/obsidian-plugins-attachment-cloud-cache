/**
 * 把 `unknown` 变成一个能放进用户提示或日志的字符串。
 *
 * ## 为什么值得单独一个模块
 *
 * 这个语义原本在 **8 个文件里各写了一份**（`cache/store`、`core/download`、
 * `core/external-cache`、`core/ingest`、`core/transfer`、`host/editor-bridge`、
 * `host/site-store`、`maintenance/run`）—— 同一个语义、两种写法。
 *
 * 抽出来的真正理由不是少写几行，而是**同一个语义只能有一处**：
 * 8 份里任何一份被改坏（比如有人为了排查改成返回 `error.stack`），
 * 那一处的提示就会与别处不同 —— 而"提示里出现堆栈"这种事，
 * 只有真的出错时才会被看见。
 *
 * ## ⚠️ 一个容易被忽略的细节：为什么不能只写 `String(error)`
 *
 * 因为 `String(new Error("boom"))` 是 **`"Error: boom"`**，而我们想给用户看的是 `"boom"`。
 * 两者不同，所以要有一个分支 —— 套件里有一条断言专门把这件事**显式化**
 *（先断言两者确实不同，再断言取值正确），否则"少写一个分支"看起来毫无影响。
 *
 * ## 这是忠实抽取，不是行为升级
 *
 * 特意**没有**顺手做成更聪明（比如从普通对象里捞 `message`、或 JSON 序列化）：
 * 那会改变 27 个调用点的提示文本，而这一轮的意图是消除重复、不是改行为。
 * 兜底分支保持 `String(error)`，普通对象因此会得到 `"[object Object]"` ——
 * 信息量很低，但这是最后一道，**不该在这里猜结构**（猜错会把 `"undefined"` 塞进用户提示）。
 */

/**
 * 取一段可读的错误文本。
 *
 * - `Error`（含子类）→ 它的 `message`
 * - 其它任何值 → `String(value)`（抛字符串/数字/null 在 JS 里都合法）
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
