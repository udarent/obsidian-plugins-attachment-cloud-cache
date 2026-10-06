/**
 * 接线判定层（`src/host/intercept.ts`）的断言套件。
 *
 * ## 为什么这一层必须穷举
 *
 * 判定错了就是"调用 `preventDefault()` 之后不管了" —— 用户的图会消失，
 * 而且**不报错**。所以这里的每条边界都要单独设断言，尤其是：
 * - 别人已处理过的事件（重复插入两份链接）
 * - 未配置时**必须放行**（图留给宿主保存）
 * - 判定顺序（"未配置"的提示不能被"载荷里没有文件"这类原因盖掉）
 *
 * ## 为什么不用真事件对象
 *
 * 用结构化最小对象（`{files, getData}`）就能穷举全部组合，
 * 而真 `ClipboardEvent` 在 Node 里造不出来。真事件路径由
 * `test-load-acceptance.mjs` 端到端覆盖。
 */

import assert from "node:assert/strict";

export function runInterceptSuite(mod) {
	const { decideInterception, insertPointFrom } = mod;

	// 设置基准：自己拼一份最小设置 —— 这一层只读 `autoUpload` 与 `enabledExtensions`，
	// 其余字段由类型保证存在即可（判定逻辑不碰它们）。
	const baseSettings = {
		autoUpload: true,
		enabledExtensions: ["png", "jpg"],
		attachmentFolder: "",
		localCopy: "cache",
		cacheFolder: "_attachment-cache",
		fallbackDownload: true,
		s3: {
			endpoint: "https://s3.example.com",
			region: "auto",
			bucket: "b",
			publicUrlBase: "https://cdn.example.com",
			accessKeyIdRef: "ak",
			secretAccessKeyRef: "sk",
			forcePathStyle: true,
			objectKeyTemplate: "{hash}.{ext}",
		},
	};

	const READY = {
		ready: true,
		config: {
			endpoint: "https://s3.example.com",
			bucket: "b",
			region: "auto",
			forcePathStyle: true,
			accessKeyId: "AK",
			secretAccessKey: "SK",
		},
	};
	const NOT_READY_CONN = { ready: false, problem: "存储桶名未填写", fixIn: "connection" };
	const NOT_READY_CRED = { ready: false, problem: "尚未选择访问密钥", fixIn: "credentials" };

	const png = (name = "a.png") => ({
		name,
		size: 3,
		type: "image/png",
		arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
	});
	const txt = (name = "a.txt") => ({ name, size: 1, type: "text/plain" });
	const pasteOf = (files, opts = {}) => ({
		files,
		items: files.map(() => ({ kind: "file" })),
		getData: (t) => (opts.text && t === "text/plain" ? opts.text : ""),
	});

	// ============================================================
	// 1. ⭐ 已被别人处理过 → 一律放行（无论载荷多好、配置多齐）
	// ============================================================
	for (const kind of ["paste", "drop"]) {
		const d = decideInterception({
			alreadyHandled: true,
			kind,
			transfer: pasteOf([png()]),
			settings: baseSettings,
			readiness: READY,
		});
		assert.equal(d.action, "ignore", `${kind}：别人已处理时不得再接管（会插入两份链接）`);
	}

	// ============================================================
	// 2. 开关关着 → 放行，且**不提示**（是用户自己的选择，不是配置问题）
	// ============================================================
	const off = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([png()]),
		settings: { ...baseSettings, autoUpload: false },
		readiness: READY,
	});
	assert.equal(off.action, "ignore", "自动上传关闭时必须放行");
	assert.equal(off.problem, undefined, "关掉开关不该产生'未配置'提示");

	// ============================================================
	// 3. 载荷不可处理 → 放行
	// ============================================================
	const noFiles = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([]),
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(noFiles.action, "ignore", "载荷里没有文件应放行");

	// 不认识的文件（txt）→ 整批放行，而不是"只接管认识的那几个"
	const unknown = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([png(), txt()]),
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(
		unknown.action,
		"ignore",
		"★ 只要有一个文件不认识就必须整批放行 —— 只接管一部分会让剩下的文件被宿主跳过，等于吞掉"
	);
	assert.match(unknown.reason, /不处理|整批/, "原因应说明是「有不处理的文件」，便于排查");

	// 剪贴板里同时有文本 → 放行（用户很可能在粘文字）
	const withText = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([png()], { text: "一段文字" }),
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(withText.action, "ignore", "剪贴板里同时有文本时不得接管（会丢掉那段文字）");

	// 拖拽：没有 files 说明是库内拖动 → 放行
	const internalDrag = decideInterception({
		alreadyHandled: false,
		kind: "drop",
		transfer: { files: [], items: [] },
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(internalDrag.action, "ignore", "库内拖动（无 files）必须放行，否则「移动笔记」会变成什么都没发生");

	// ============================================================
	// 4. ⭐ 未配置 → warn（**不是** ignore，也不是接管）
	//
	// ignore 与 warn 的区别是"要不要告诉用户"：用户按了粘贴、什么都没发生、
	// 也没提示 —— 那是最糟的结果。所以这两条要分开断言。
	// ============================================================
	for (const [label, readiness] of [
		["连接信息缺失", NOT_READY_CONN],
		["凭据未选", NOT_READY_CRED],
	]) {
		const d = decideInterception({
			alreadyHandled: false,
			kind: "paste",
			transfer: pasteOf([png()]),
			settings: baseSettings,
			readiness,
		});
		assert.equal(d.action, "warn", `${label} 时应给出提示而不是静默放行`);
		assert.equal(d.problem, readiness.problem, "提示里要带上是哪一项没配");
		assert.equal(d.fixIn, readiness.fixIn, "要告诉用户去设置页的哪一栏改");
	}

	// ============================================================
	// 5. ⭐ 判定顺序：未配置的提示不能被"载荷没问题"盖过，
	//    也不能被"载荷有问题"抢先 —— 载荷有问题时**连提示都不该有**
	//    （用户根本没打算上传，弹一个"未配置"是噪音）
	// ============================================================
	const offAndUnconfigured = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([png()]),
		settings: { ...baseSettings, autoUpload: false },
		readiness: NOT_READY_CONN,
	});
	assert.equal(
		offAndUnconfigured.action,
		"ignore",
		"★ 开关关着时即使没配置也不该提示 —— 提示属于「配置问题」，而这里用户是主动关掉的"
	);

	const noFilesAndUnconfigured = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([]),
		settings: baseSettings,
		readiness: NOT_READY_CONN,
	});
	assert.equal(
		noFilesAndUnconfigured.action,
		"ignore",
		"★ 粘贴内容里没有文件时不该跑到「未配置」分支 —— 否则随便粘段文字都会弹配置提示"
	);

	// ============================================================
	// 6. 全部就绪 → handle，且把**配置**一起带走
	//
	// 带着 config 而不是让调用方再算一次：两次调用的间隔里配置可能被改动，
	// 那样"提示的原因"与"实际用的配置"会不一致。
	// ============================================================
	const ok = decideInterception({
		alreadyHandled: false,
		kind: "paste",
		transfer: pasteOf([png(), png("b.png")]),
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(ok.action, "handle", "全部就绪时应接管");
	assert.equal(ok.files.length, 2, "应把全部可处理文件带走");
	assert.equal(ok.config, READY.config, "应把已算好的配置一并带走（不要重复算一次）");

	// 拖拽路径同样能 handle（走的是另一套判定：必须有 files）
	const dropOk = decideInterception({
		alreadyHandled: false,
		kind: "drop",
		transfer: { files: [png()], items: [{ kind: "file" }] },
		settings: baseSettings,
		readiness: READY,
	});
	assert.equal(dropOk.action, "handle", "外部文件拖入应接管");

	// ============================================================
	// 7. 插入位置：同步捕获，取不到就退回"按当下选区插"
	// ============================================================
	const editor = { getCursor: (side) => (side === "from" ? { line: 1, ch: 2 } : { line: 1, ch: 5 }) };
	assert.deepEqual(
		insertPointFrom(editor),
		{ from: { line: 1, ch: 2 }, to: { line: 1, ch: 5 } },
		"应捕获选区的 from/to"
	);

	// 没有 getCursor 的编辑器（替身 / 别的实现）→ undefined，而不是抛错
	assert.equal(insertPointFrom({}), undefined, "没有 getCursor 时应返回 undefined，而不是让整次粘贴失败");
	assert.equal(insertPointFrom(null), undefined, "null 同理");
	assert.equal(insertPointFrom(undefined), undefined, "undefined 同理");

	// 宿主实现抛错 → 同样退回，而不是把异常传播出去。
	// 这里**自己接住异常再断言**（而不是让 assert 去捕获）：否则变异之后
	// 报出来的会是那个注入异常的 message，看不出是哪条规则破了 ——
	// 变异验证要求"每条规则因自己的原因失败"。
	let propagated = null;
	try {
		insertPointFrom({
			getCursor() {
				throw new Error("宿主编辑器实现差异");
			},
		});
	} catch (error) {
		propagated = error;
	}
	assert.equal(
		propagated,
		null,
		"getCursor 抛错时应降级为 undefined（插入位置取不到不是致命问题，不该让整次粘贴失败）"
	);

	// 只有 from 可用时（实现的差异）也要能用
	assert.deepEqual(
		insertPointFrom({ getCursor: (side) => (side === "from" ? { line: 0, ch: 0 } : null) }),
		{ from: { line: 0, ch: 0 } },
		"只拿得到 from 时应返回只带 from 的插入位置"
	);

	console.log(
		"Intercept decisions passed (default-handled → ignore; unconfigured → warn and let Obsidian save; " +
			"order pinned so a text-only paste never nags about config; insert point captured sync with graceful fallback)."
	);
}
