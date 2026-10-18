/**
 * 「测试连接」探针回路（`src/probe-sample.ts`）的断言套件。
 *
 * 被**正式测试**与**变异验证**共用（同一份断言，见 `mutate.mjs` 的纪律），
 * 所以这里的每条断言都必须能被单独打坏。
 *
 * ## 这一层坏掉的后果都是**静默**的
 *
 * - 忘了真的 PUT 就去测 ⇒ "测"的是一条不存在的对象，结论是假的（而界面显示正常）；
 * - 放不上去还继续测 ⇒ 同上，而且把"写权限被拒"这条真信息盖掉；
 * - 测量失败时不清理 / 删不掉却报已删 ⇒ 用户的桶里留下一条他不认识的对象；
 * - 探针内容为空 ⇒ "读回一致"变成 0 == 0，等于什么都没验。
 *
 * 最后一条尤其像"看着没问题"：0 字节的比对永远通过。
 */

import assert from "node:assert/strict";

/** 探针生命周期的替身：只记账，不碰网络。 */
function makeIo(overrides = {}) {
	const calls = [];
	return {
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
}

export async function runProbeSampleSuite(mod) {
	const { TEMP_PROBE_KEY, TEMP_PROBE_BODY, runWithTempProbeObject } = mod;
	// `publicUrlFor` 只用来钉住"探针 key 能拼成一条合法地址"（拼不出来这一步会直接抛配置错）
	const { publicUrlFor } = mod;

	// ============================================================
	// 1. 顺序必须是 放 → 测 → 删，且干净跑完不残留
	// ============================================================
	const clean = makeIo();
	const cleanOutcome = await runWithTempProbeObject(clean);
	assert.deepEqual(clean.calls, ["put:probe-key", "measure", "remove:probe-key"], "★ 顺序必须是 放 → 测 → 删");
	assert.deepEqual(
		cleanOutcome,
		{ placed: true, leftBehind: false, value: "probe-result" },
		"干净跑完应报 placed 且不残留"
	);

	// ============================================================
	// 2. 测量自己抛错 ⇒ 清理仍然必须发生
	// ============================================================
	//
	// 实现里测量是"签名读回 + 匿名探测"，两者按契约都不抛错；但**清理不能依赖那个契约** ——
	// 以后谁给它加一条会抛的分支，探针对象就会永久留在用户桶里。
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

	// ============================================================
	// 3. 删不掉 ⇒ 如实回报（方向取保守：报错就当"还在"）
	// ============================================================
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

	// ============================================================
	// 4. 放不上去 ⇒ 回路**没跑起来**：不许测，也不许去删
	// ============================================================
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
	// 5. 探针对象本身要"进得去"也"看得见"
	// ============================================================
	const probeUrl = publicUrlFor({ endpoint: "https://storage.example.com", bucket: "notes" }, TEMP_PROBE_KEY);
	assert.ok(probeUrl.endsWith(`/${TEMP_PROBE_KEY}`), "探针 key 必须能拼成一条合法地址");
	assert.ok(TEMP_PROBE_BODY.trim().length > 0, "探针对象要有非空内容（0 字节的读回比对永远通过，等于没验）");
	assert.ok(
		!/^\//.test(TEMP_PROBE_KEY) && !TEMP_PROBE_KEY.includes(".."),
		"探针 key 不能有前导斜杠或 `..` 段（那会被路径规范化、与签名对不上）"
	);
}
