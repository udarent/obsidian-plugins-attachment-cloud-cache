/**
 * 「测试连接第二步该拿哪条对象去试」的断言套件（`src/probe-sample.ts`）。
 *
 * 被**正式测试**与**变异验证**共用（同一份断言，见 `mutate.mjs` 的纪律），
 * 所以这里的每条断言都必须能被单独打坏。
 *
 * ## 这一层坏掉的后果
 *
 * 它决定的不是"测得准不准"，而是**测不测得成**：
 *
 * - 索引命中却还去列举桶 ⇒ 自动探测（保存设置时每敲一个字符一次）平白多一次网络请求；
 * - 列举失败就抛 ⇒ 没有 `ListBucket` 权限的人**永远测不了**第二步（而这权限与上传无关）；
 * - 默认就允许临时探针 ⇒ 自动探测开始往用户的桶里写字，而用户从没点过任何按钮；
 * - 测失败就不删 / 删不掉却说删了 ⇒ 用户的桶里留下一条**他不认识**的对象。
 *
 * 最后一条是这一层最该守的：我们把东西放进用户的数据里，就有责任说清它还在不在。
 */

import assert from "node:assert/strict";

/** 探针生命周期的替身：只记账，不碰网络。 */
function makeIo(overrides = {}) {
	const calls = [];
	const io = {
		calls,
		key: "probe-key",
		put: async (key) => {
			calls.push(`put:${key}`);
		},
		remove: async (key) => {
			calls.push(`remove:${key}`);
			return true;
		},
		measure: async () => {
			calls.push("measure");
			return "probe-result";
		},
		...overrides,
	};
	return io;
}

export async function runProbeSampleSuite(mod) {
	const { TEMP_PROBE_KEY, TEMP_PROBE_BODY, planProbeSample, runWithTempProbeObject } = mod;
	// `publicUrlFor` 只用来钉住"探针 key 能拼成一条合法地址"（拼不出来这一步会直接抛配置错）
	const { publicUrlFor } = mod;

	// ============================================================
	// 1. 索引优先：有现成的真实对象就**不再**联网找样本
	// ============================================================
	let listCalls = 0;
	const indexed = await planProbeSample({
		indexedKeys: ["photo-abc.png"],
		listFirstKey: async () => {
			listCalls += 1;
			return "bucket-object.png";
		},
	});
	assert.deepEqual(indexed, { key: "photo-abc.png", source: "index" }, "★ 索引里有对象就直接用它");
	assert.equal(listCalls, 0, "★ 索引命中时**不许**再去列举桶（自动探测每次都走这条，多一次请求就是纯浪费）");

	// 空 key 不能进候选：拿空 key 拼地址会得到 `null` ⇒ 整个探测白跑、界面显示"没有可检查的对象"
	const blankOnly = await planProbeSample({ indexedKeys: ["", "   "], allowTempObject: true });
	assert.equal(blankOnly.source, "temp", "索引里的空 key 不能拿去拼地址");

	// ============================================================
	// 2. 索引空 ⇒ 去桶里找一条**真的**（只读列举）
	// ============================================================
	const fromBucket = await planProbeSample({ indexedKeys: [], listFirstKey: async () => "bucket-object.png" });
	assert.deepEqual(fromBucket, { key: "bucket-object.png", source: "bucket" }, "索引空时应改用桶里第一个对象");

	// ============================================================
	// 3. 列举失败（最常见的是没有 ListBucket 权限）**不该**打断测试
	// ============================================================
	//
	// ⚠️ 这里必须自己 `try/catch`：那条"不该抛"的断言如果只写成 `await planProbeSample(...)`，
	// 变异后异常会直接冒到调用方，报出的是原始错误（`AccessDenied`）而不是这句话 ——
	// 于是"被抓住了"但**原因对不上**，等于没抓住。
	let noListPermission;
	try {
		noListPermission = await planProbeSample({
			indexedKeys: [],
			listFirstKey: async () => {
				throw new Error("AccessDenied");
			},
			allowTempObject: true,
		});
	} catch (error) {
		assert.fail(
			`★ 列举失败（没有列举权限）不应打断测试 —— 该退到临时探针，实际抛了：${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	assert.deepEqual(
		noListPermission,
		{ key: TEMP_PROBE_KEY, source: "temp" },
		"列举失败时应退到临时探针"
	);

	// ============================================================
	// 4. 默认**不许**临时探针：自动探测绝不写用户的桶
	// ============================================================
	const automatic = await planProbeSample({ indexedKeys: [], listFirstKey: async () => null });
	assert.deepEqual(automatic, { key: null, source: "none" }, "★ 没有 allowTempObject 时**不许**临时放探针");

	// ============================================================
	// 5. 临时探针的善后：放 → 测 → 删，且每一处失败都有确定的收场
	// ============================================================
	const clean = makeIo();
	const cleanOutcome = await runWithTempProbeObject(clean);
	assert.deepEqual(clean.calls, ["put:probe-key", "measure", "remove:probe-key"], "★ 顺序必须是 放 → 测 → 删");
	assert.deepEqual(
		cleanOutcome,
		{ placed: true, leftBehind: false, value: "probe-result" },
		"干净跑完应报 placed 且不残留"
	);

	// 测量自己抛错（正常实现不会，但清理必须是 `finally`）
	let removedAfterThrow = false;
	await assert.rejects(
		() =>
			runWithTempProbeObject(
				makeIo({
					remove: async () => {
						removedAfterThrow = true;
						return true;
					},
					measure: async () => {
						throw new Error("测量炸了");
					},
				})
			),
		/测量炸了/
	);
	assert.equal(removedAfterThrow, true, "★ 测量失败也必须删掉探针对象");

	// 删不掉 ⇒ 必须如实回报（方向取保守：报错就当"还在"）
	const dirty = await runWithTempProbeObject(
		makeIo({
			remove: async () => {
				throw new Error("AccessDenied");
			},
		})
	);
	assert.equal(dirty.leftBehind, true, "★ 删不掉要如实回报");
	assert.equal(dirty.value, "probe-result", "删不掉不该把已经拿到的结论丢掉");

	// 对象本来就不在（DELETE 回 404）⇒ 桶里是干净的
	const alreadyGone = await runWithTempProbeObject(makeIo({ remove: async () => false }));
	assert.equal(alreadyGone.leftBehind, false, "对象本来就不在 = 桶里干净");

	// 放不上去 ⇒ 探测**没发生**：不能再拿一条不存在的地址去测（那结论是假的）
	let measuredAfterPutFailure = false;
	let removedAfterPutFailure = false;
	const putFailed = await runWithTempProbeObject(
		makeIo({
			put: async () => {
				throw new Error("拒绝写入");
			},
			remove: async () => {
				removedAfterPutFailure = true;
				return true;
			},
			measure: async () => {
				measuredAfterPutFailure = true;
				return "假的结论";
			},
		})
	);
	assert.equal(putFailed.placed, false, "★ 放不上去时要说 placed:false（界面据此说「写不进去」而不是「测不了」）");
	assert.equal(putFailed.putError?.message, "拒绝写入", "放不上去的原始错误要带回给界面归类");
	assert.equal(measuredAfterPutFailure, false, "放不上去就**不该**再去测");
	assert.equal(removedAfterPutFailure, false, "放不上去时不该去删（没有东西可删）");

	// ============================================================
	// 6. 探针对象本身要"进得去"也"看得见"
	// ============================================================
	const probeUrl = publicUrlFor({ endpoint: "https://storage.example.com", bucket: "notes" }, TEMP_PROBE_KEY);
	assert.ok(probeUrl.endsWith(`/${TEMP_PROBE_KEY}`), "探针 key 必须能拼成一条合法地址");
	assert.ok(TEMP_PROBE_BODY.trim().length > 0, "探针对象要有非空内容（传后校验核 Content-Length，空体等于不校验）");
	assert.ok(
		!/^\//.test(TEMP_PROBE_KEY) && !TEMP_PROBE_KEY.includes(".."),
		"探针 key 不能有前导斜杠或 `..` 段（那会被路径规范化、与签名对不上）"
	);
}
