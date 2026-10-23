/**
 * 排障日志：**只进控制台，绝不进 UI**。
 *
 * ## 为什么要有它（2026-10-22，D-67）
 *
 * 这个插件的判据链很长（引用扫描 → 目标归一 → 库内解析 → 候选筛选 → 执行），
 * 而「结果不对」几乎从不报错 —— 它表现为「少了一个」「多了一个」「两条命令说法相反」。
 * 前几轮排查这类问题，每次都要现写一个探针（编译 `references.ts`、造夹具、跑一遍）；
 * 真机上则只能靠远程指挥。
 *
 * 开这个开关之后，**每个阶段把自己的输入/输出计数与耗时打到控制台**：
 * 真机出了问题，用户把那段贴过来就能定位到哪一段的数目不对。
 *
 * ## 三条纪律
 *
 * 1. **开关显式传入**（`enabled` 参数），不读模块级全局。
 *    读全局就要在"设置变更时同步"这一步上做对，而那个错法非常隐蔽：
 *    打开了却没有日志、关掉了还在刷 —— 而那一刻用户正需要日志。
 * 2. **计数从已有返回值取**，不为日志多扫一遍库。日志的价值在"看得见"，
 *    不在"多一份计算"；为它加一趟 I/O 会改变真机上的表现（这正是要观察的东西）。
 * 3. **绝不进 `Notice` / 弹窗**：它是给排障的人看的，不是给用户看的信息。
 *    （用户可见的结论仍然只由 `i18n` 文案说。）
 */

/** 所有行都带这个前缀，便于在控制台过滤（`attachment-cloud-cache`）。 */
const PREFIX = "[attachment-cloud-cache]";

/**
 * 一条排障日志。`data` 是可展开的对象（阶段计数、原因分布那一类）。
 *
 * ⚠️ 出口只能是 **`console.debug`** —— 这不是选择，是**门禁的约束**：
 * Obsidian 的 `no-console` 只允许 `warn` / `error` / `debug`，而 `obsidianmd/*` 在
 * `eslint-comments/no-restricted-disable` 里被列为**不可 disable**（连文件级例外都不许写）。
 * 代价必须如实告诉用户：`debug` 在 DevTools 里属 **Verbose 级别，默认不显示** ——
 * 所以设置项的描述里写明了"需勾选 Verbose"，否则用户开了开关看到空白会以为插件坏了。
 * （`warn` 也可见，但黄色警告样式会让人以为出了错；`console.log` / `info` 被门禁拦。）
 */
export function debugLog(
	enabled: boolean,
	message: string,
	data?: Readonly<Record<string, unknown>>
): void {
	if (!enabled) return;
	if (data === undefined) console.debug(`${PREFIX} ${message}`);
	else console.debug(`${PREFIX} ${message}`, data);
}

/**
 * 带耗时的一条。`startedAt` 由调用方在阶段开始时取 `Date.now()`。
 *
 * ⚠️ 别在循环里每条都取一次 `Date.now()`（几百次调用会有可测的开销，
 * 而日志本身不该让"跑得慢"这件事变得更难判断）。
 */
export function debugTimed(
	enabled: boolean,
	message: string,
	startedAt: number,
	data?: Readonly<Record<string, unknown>>
): void {
	if (!enabled) return;
	debugLog(true, `${message}（${Math.max(0, Date.now() - startedAt)} ms）`, data);
}
