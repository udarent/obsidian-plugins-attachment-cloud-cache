import assert from "node:assert/strict";

/**
 * 删除留痕（`src/maintenance/delete-log.ts`）。
 *
 * 这一套守的是"**事后查得到**"这件事本身：
 * - 记录必须能被独立解析（JSON Lines，一行一条，字段齐全）；
 * - 一批删除**只写一次**（不是每个对象写一次 —— 那会让"一次删除"在日志里散成 N 条）；
 * - ⚠️ **写失败绝不抛错**：删云端是不可恢复的主流程，为一个附属功能把它炸断，
 *   代价完全不成比例（这条是本节最要紧的断言）；
 * - 认不出的取值/空 key 要被挡掉，而不是写进一条谁也读不懂的行。
 */

/** 固定时间的替身（日志里的 `at` 必须可预测，否则断言只能写"像不像 ISO 串"）。 */
const AT = new Date("2026-10-11T12:00:00.000Z");

/** 造一个收集写入的替身。`fail` 为真时抛错，用来验"写失败不抛错"。 */
function collector(options = {}) {
	const calls = [];
	return {
		calls,
		append: async (text) => {
			if (options.fail) throw new Error("磁盘满");
			calls.push(text);
		},
	};
}

export async function runDeleteLogSuite(mod) {
	const { DELETE_LOG_FILE, deleteLogPath, formatDeleteLogEntry, recordDeletions } = mod;
	assert.ok(DELETE_LOG_FILE && typeof DELETE_LOG_FILE === "string", "应当导出日志文件名");
	assert.ok(typeof deleteLogPath === "function", "应当导出路径推导");
	assert.ok(typeof formatDeleteLogEntry === "function", "应当导出单行格式化");
	assert.ok(typeof recordDeletions === "function", "应当导出写入函数");

	// ============================================================
	// 1. 路径：插件目录 → 日志文件的 vault 相对路径
	// ============================================================
	{
		assert.equal(
			deleteLogPath(".obsidian/plugins/attachment-cloud-cache"),
			`.obsidian/plugins/attachment-cloud-cache/${DELETE_LOG_FILE}`,
			"正常路径"
		);
		assert.equal(
			deleteLogPath("C:\\vault\\.obsidian\\plugins\\acc"),
			`C:/vault/.obsidian/plugins/acc/${DELETE_LOG_FILE}`,
			"★ Windows 反斜杠要归一（不归一会生成一个宿主根本不认识的路径）"
		);
		assert.equal(
			deleteLogPath(".obsidian/plugins/acc/"),
			`.obsidian/plugins/acc/${DELETE_LOG_FILE}`,
			"尾部斜杠不该生成双斜杠"
		);
		assert.equal(deleteLogPath(""), DELETE_LOG_FILE, "空目录也要给出一个可用的相对路径（不抛错）");
		assert.equal(deleteLogPath(null), DELETE_LOG_FILE, "非字符串同样不抛错");
	}

	// ============================================================
	// 2. 单行格式：JSON Lines（能被独立解析，字段齐全）
	// ============================================================
	{
		const line = formatDeleteLogEntry(
			{ key: "abc.png", name: "报告 1,2.png", outcome: "deleted", scope: "orphan" },
			AT.toISOString()
		);
		assert.equal(line.endsWith("\n"), true, "每条记录占一行（追加写靠它分隔）");
		assert.equal(line.trimEnd().includes("\n"), false, "一条记录内部不得有换行（否则一行不再是一条）");
		const parsed = JSON.parse(line);
		assert.deepEqual(
			parsed,
			{
				at: AT.toISOString(),
				key: "abc.png",
				name: "报告 1,2.png",
				outcome: "deleted",
				scope: "orphan",
			},
			"字段要逐项写出来（含逗号/中文的文件名必须原样可读回）"
		);
	}

	// ============================================================
	// 3. 一批只写一次；空批不写
	// ============================================================
	{
		const sink = collector();
		const records = [
			{ key: "a.png", name: "a.png", outcome: "deleted", scope: "command" },
			{ key: "b.png", name: "b.png", outcome: "alreadyGone", scope: "command" },
		];
		const written = await recordDeletions({ append: sink.append, now: () => AT }, records);
		assert.equal(written, 2, "如实返回写下的行数");
		assert.equal(sink.calls.length, 1, "★ 一批只写一次（不是每个对象写一次）");
		const lines = sink.calls[0].split("\n").filter(Boolean);
		assert.equal(lines.length, 2, "两行都要在这一次写入里");
		assert.equal(JSON.parse(lines[1]).outcome, "alreadyGone", "★ 404（本来就不在）要如实标注，不能混成「已删除」");

		const empty = collector();
		assert.equal(await recordDeletions({ append: empty.append, now: () => AT }, []), 0, "空批返回 0");
		assert.equal(empty.calls.length, 0, "空批不该产生任何写入（不写空文件）");
	}

	// ============================================================
	// 4. ⭐ 写失败**绝不抛错**
	//
	// 这一条是本节的重点：删云端对象是**不可恢复的主流程**，而留痕只是"事后可查"的
	// 加强项。若日志写不进去（磁盘满、权限、同步中被占用）就把删除链炸断，
	// 等于为了附属功能破坏了主功能 —— 而且是在一个不可恢复的动作上。
	// ============================================================
	{
		const errors = [];
		const sink = collector({ fail: true });
		let written;
		try {
			written = await recordDeletions(
				{
					append: sink.append,
					now: () => AT,
					onError: (error) => errors.push(error),
				},
				[{ key: "a.png", name: "a.png", outcome: "deleted", scope: "orphan" }]
			);
		} catch (error) {
			assert.fail(`⭐ 写日志失败**绝不能抛错**（会让一次已经确认过的删除变成失败）。实际抛出：${error}`);
		}
		assert.equal(written, 0, "写失败时如实返回 0 行（不假装写了）");
		assert.equal(errors.length, 1, "失败要上报（否则这条链静默不工作，谁也不知道）");
	}

	// ============================================================
	// 5. 认不出的输入要被挡掉，而不是写成一堆读不懂的行
	// ============================================================
	{
		const sink = collector();
		const written = await recordDeletions(
			{ append: sink.append, now: () => AT },
			[
				{ key: "  ", name: "空白 key", outcome: "deleted", scope: "command" },
				{ key: "", name: "空 key", outcome: "deleted", scope: "command" },
				null,
				undefined,
				{ key: "ok.png", name: 42, outcome: "weird", scope: "nope" },
			]
		);
		assert.equal(written, 1, "★ 只留下 key 合法的那一条");
		const parsed = JSON.parse(sink.calls[0]);
		assert.equal(parsed.key, "ok.png", "合法的 key 原样保留");
		assert.equal(parsed.name, "", "非字符串的文件名归空串（不写 undefined/null 进日志）");
		assert.equal(parsed.outcome, "deleted", "★ 认不出的处置一律按「已删除」记（宁可保守）");
		assert.equal(parsed.scope, "command", "★ 认不出的入口一律按命令记（不发明新的取值）");

		// 全是被挡掉的 ⇒ 一次写入都不该发生
		const allBad = collector();
		assert.equal(
			await recordDeletions({ append: allBad.append, now: () => AT }, [null, { key: " " }]),
			0,
			"全被挡掉时返回 0"
		);
		assert.equal(allBad.calls.length, 0, "全被挡掉时不该写文件");
	}

	return { cases: 6 };
}
