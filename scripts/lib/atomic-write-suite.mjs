/**
 * `src/atomic-write.ts` 的断言套件（与变异验证共用）。
 *
 * ## 这里守的是什么
 *
 * `writeJsonAtomically` 原本在 `cache/store.ts` 与 `host/site-store.ts` 里
 * **各有一份逐字相同**的实现（25 行 ×2，连注释都一样）。抽出来之后，
 * "两个 store 的落盘语义一致"从"靠人记得同步改"变成"结构上只可能一致"。
 *
 * 两条语义各自都会**静默**出错，所以都要钉住：
 *
 * 1. **先写 `.tmp` 再 rename** —— 直接写目标文件会在写到一半时留下截断的 JSON，
 *    而同步工具（Syncthing / iCloud / git）可能在任何时刻读到它。
 * 2. **rename 不被支持时退回直接写** —— 某些适配器不允许覆盖式改名。
 *    没有这条兜底，那类宿主上会变成"永远存不上"（而用户只看到"设置没保存"）。
 *
 * ⚠️ 断言看的是**调用序列**而不是最终状态：最终状态在两种路径下都一样
 *（目标文件里都是那份 JSON），只有序列能区分"原子"与"直接写"。
 */

import assert from "node:assert/strict";

/**
 * 一个记录**调用顺序**的适配器替身。
 *
 * 刻意不用 `mock-obsidian.mjs`：那个替身会真的落盘、但**不记调用顺序**，
 * 而本套件要看的恰恰是"先写 tmp 还是先写目标"。
 */
function makeAdapter(options = {}) {
	const calls = [];
	const files = new Set();
	const adapter = {
		async exists(path) {
			calls.push(`exists:${path}`);
			return files.has(path);
		},
		async mkdir(path) {
			calls.push(`mkdir:${path}`);
			files.add(path);
		},
		async write(path, data) {
			calls.push(`write:${path}`);
			if (options.writeFailsFor === path) throw new Error(`写 ${path} 失败`);
			if (options.writeFailsFor === "*") throw new Error("写失败");
			files.add(path);
			options.written?.push({ path, data });
		},
		async rename(from, to) {
			calls.push(`rename:${from}->${to}`);
			if (options.renameFails) throw new Error("适配器不支持覆盖式改名");
			files.delete(from);
			files.add(to);
		},
		async remove(path) {
			calls.push(`remove:${path}`);
			if (options.removeFails) throw new Error("删不掉");
			files.delete(path);
		},
	};
	return { adapter, calls, files };
}

export async function runAtomicWriteSuite(mod) {
	const { writeJsonAtomically } = mod;
	const PATH = "_attachment-cache/index.json";
	const FOLDER = "_attachment-cache";
	const PAYLOAD = '{"version":1}';

	// ============================================================
	// 1. ⭐ 正常路径：先写 `.tmp`、再 rename 覆盖
	// ============================================================
	{
		const { adapter, calls } = makeAdapter();
		await writeJsonAtomically(adapter, PATH, PAYLOAD);
		assert.deepEqual(
			calls.filter((call) => call.startsWith("write:") || call.startsWith("rename:")),
			[`write:${PATH}.tmp`, `rename:${PATH}.tmp->${PATH}`],
			"★ 必须先写 .tmp 再 rename —— 直接写目标文件会在写到一半时留下截断的 JSON"
		);
	}

	// ============================================================
	// 2. 载荷原样落盘（不要在中间层再序列化一次）
	// ============================================================
	{
		const written = [];
		const { adapter } = makeAdapter({ written });
		await writeJsonAtomically(adapter, PATH, PAYLOAD);
		assert.equal(written.length, 1, "只该写一次（正常路径下不写目标文件）");
		assert.equal(written[0].data, PAYLOAD, "★ 载荷要逐字落盘，中间层不得改动它");
	}

	// ============================================================
	// 3. 父目录缺失时先建（"用户手工删过插件目录下的文件"时的自愈）
	// ============================================================
	{
		const { adapter, calls } = makeAdapter();
		await writeJsonAtomically(adapter, PATH, PAYLOAD);
		const mkdirAt = calls.indexOf(`mkdir:${FOLDER}`);
		const writeAt = calls.indexOf(`write:${PATH}.tmp`);
		assert.ok(mkdirAt >= 0, "父目录不存在时必须先 mkdir（否则 write 会抛错）");
		assert.ok(mkdirAt < writeAt, "★ mkdir 必须在写之前 —— 顺序反了就是一次必然失败的写");
	}
	{
		// 目录已存在则不必再建（每次保存都 mkdir 是多余的宿主调用）
		const { adapter, calls } = makeAdapter();
		adapter.exists = async (path) => {
			calls.push(`exists:${path}`);
			return true;
		};
		await writeJsonAtomically(adapter, PATH, PAYLOAD);
		assert.ok(!calls.some((call) => call.startsWith("mkdir:")), "目录已存在时不该再 mkdir");
	}

	// ============================================================
	// 4. ⭐ rename 不被支持 → 退回直接写，并清掉临时文件
	// ============================================================
	// 没有这条兜底，那类适配器上会变成"永远存不上"，而症状只是"设置没保存"。
	{
		const written = [];
		const { adapter, calls, files } = makeAdapter({ renameFails: true, written });
		await writeJsonAtomically(adapter, PATH, PAYLOAD);
		assert.deepEqual(
			calls.filter((call) => call.startsWith("write:")),
			[`write:${PATH}.tmp`, `write:${PATH}`],
			"★ rename 失败要退回直接写目标文件（退化的只是原子性，不是可用性）"
		);
		assert.ok(
			!files.has(`${PATH}.tmp`),
			"★ 退回之后必须清掉临时文件，否则会留下垃圾（且同步工具会读到它）"
		);
		assert.equal(written.at(-1)?.path, PATH, "退回时写的是目标文件");
	}

	// ============================================================
	// 5. 清临时文件失败**不能**影响主流程
	// ============================================================
	// 它只是个中间产物；为了删不掉它而让"保存"失败，损失大得多。
	//
	// ⚠️ 写成"捕获后断言没抛"而不是"直接 await"：后者在实现抛错时会以
	// **适配器那句原始错误**（"删不掉"）失败，报出来的原因与这条规则对不上 ——
	// 断言必须自己给出**它守的是哪件事**。
	{
		const { adapter } = makeAdapter({ renameFails: true, removeFails: true });
		let thrown = null;
		try {
			await writeJsonAtomically(adapter, PATH, PAYLOAD);
		} catch (error) {
			thrown = error;
		}
		assert.equal(
			thrown,
			null,
			"★ 清临时文件失败必须被吞掉 —— 不能让它把保存变成失败"
		);
	}

	// ============================================================
	// 6. 退回路径里连写也失败 → 错误要抛出去
	// ============================================================
	// 静默失败会变成"设置看起来保存了、其实没有"，而那是最难查的一类问题。
	await assert.rejects(
		writeJsonAtomically(makeAdapter({ renameFails: true, writeFailsFor: "*" }).adapter, PATH, PAYLOAD),
		/写失败/,
		"★ 连兜底写都失败时必须抛出去（静默失败 = 用户以为存上了）"
	);

	// ============================================================
	// 7. 路径归一：反斜杠与多余前导斜杠
	// ============================================================
	// 两个 store 的路径分别来自插件目录推演与用户配置，两种写法都得能处理，
	// 而 mkdir 收到的一定要是**归一后的目录**（否则会在 vault 里建出奇怪的层级）。
	{
		const { adapter, calls } = makeAdapter();
		await writeJsonAtomically(adapter, "\\_state\\site-decisions.json", PAYLOAD);
		assert.ok(
			calls.includes("mkdir:_state"),
			`★ 反斜杠路径要归一出正确的父目录（实际调用：${JSON.stringify(calls)}）`
		);
	}
	{
		const { adapter, calls } = makeAdapter();
		await writeJsonAtomically(adapter, "/plain.json", PAYLOAD);
		assert.ok(!calls.some((call) => call.startsWith("mkdir:")), "根目录下的文件不该去 mkdir 空目录名");
	}
}
