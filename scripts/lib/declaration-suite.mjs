/**
 * 「共享桶的引用声明」纯逻辑套件（`src/s3/declaration.ts`）。
 *
 * 为什么值得一整套穷举：这一层的错误**不会立刻表现出来** —— 少写一条引用，
 * 要等到某台设备清理孤儿时才暴露，而那时候的动作是**删除云端对象**。
 * 所以每条规则都单独钉一次，并且按"后果"写断言名字。
 */

import assert from "node:assert/strict";

/** 造一个合法哈希（64 位小写十六进制）：`hash(3)` → "00…03"。 */
const hash = (n) => n.toString(16).padStart(64, "0");

const ref = (name, addedAt = "2026-10-25T00:00:00.000Z") => ({ name, ext: "png", addedAt });

const decl = (vault, device, refs, updatedAt = "2026-10-25T00:00:00.000Z") => ({
	v: 1,
	vault,
	device,
	updatedAt,
	refs,
});

const writes = (steps) => steps.filter((step) => step.kind === "write");
const deletes = (steps) => steps.filter((step) => step.kind === "delete");

export function runDeclarationSuite(mod) {
	const {
		DECLARATION_ROOT,
		SEGMENT_LIMIT,
		isSafeId,
		vaultPrefix,
		devicePrefix,
		headKey,
		segmentKey,
		segmentNumber,
		isHeadKey,
		isDeclarationKey,
		emptyDeclaration,
		parseDeclaration,
		mergeRefs,
		compactionDue,
		planUpdates,
		fingerprint,
	} = mod;

	// ============================================================
	// 1. 布局：前缀、段号补零、以及**防前缀逃逸**的 id 校验
	// ============================================================
	{
		assert.equal(DECLARATION_ROOT, "_acc/v1", "前缀必须以下划线开头并带格式版本");

		assert.equal(vaultPrefix("v1"), "_acc/v1/v1", "vault 前缀形状");
		assert.equal(devicePrefix("v1", "d1"), "_acc/v1/v1/d1", "设备前缀形状");
		assert.equal(headKey("v1", "d1"), "_acc/v1/v1/d1/head.json", "head 的 key");
		assert.equal(segmentKey("v1", "d1", 7), "_acc/v1/v1/d1/seg-0007.json", "段号补零到 4 位");
		assert.equal(segmentKey("v1", "d1", 12345), "_acc/v1/v1/d1/seg-12345.json", "超过 9999 自然变长");

		assert.equal(segmentNumber("_acc/v1/v1/d1/seg-0007.json"), 7, "能从 key 反解段号");
		assert.equal(segmentNumber("_acc/v1/v1/d1/seg-7.json"), null, "少位的段号不认（形状只有一种）");
		assert.equal(segmentNumber("_acc/v1/v1/d1/head.json"), null, "head 不是段");
		assert.equal(isHeadKey("_acc/v1/v1/d1/head.json"), true, "认出 head");
		assert.equal(isDeclarationKey("_acc/v1/v1/d1/seg-0001.json"), true, "认出段");
		assert.equal(isDeclarationKey("_acc/v1/v1/d1/photo.png"), false, "普通对象不是声明");

		assert.equal(devicePrefix("../x", "d1"), "", "★ 带 `..` 的 id 一律拒绝（否则能写到别的前缀）");
		assert.equal(devicePrefix("v1", "a/b"), "", "★ 带斜杠的 id 一律拒绝");
		assert.equal(devicePrefix("", "d1"), "", "空 id 拒绝");
		assert.equal(isSafeId("Abc"), false, "id 只认小写（生成端一致，别留两种写法）");
		assert.equal(isSafeId("v-1"), true, "短横线合法");
	}

	// ============================================================
	// 2. 解析：任何一处不合法就整份 null（不能"跳过坏条目"）
	// ============================================================
	{
		const good = decl("v1", "d1", { [hash(1)]: ref("报告.pdf") });
		const parsed = parseDeclaration(JSON.stringify(good));
		assert.deepEqual(parsed, good, "合法声明原样解析");

		assert.equal(parseDeclaration("not json"), null, "坏 JSON ⇒ null");
		assert.equal(parseDeclaration(JSON.stringify({ ...good, v: 2 })), null, "版本不是 1 ⇒ null");
		assert.equal(parseDeclaration(JSON.stringify({ ...good, refs: [] })), null, "refs 是数组 ⇒ null");
		assert.equal(parseDeclaration(JSON.stringify({ ...good, vault: "../x" })), null, "vault 不合法 ⇒ null");
		assert.equal(
			parseDeclaration(JSON.stringify(decl("v1", "d1", { zzz: ref("x.png") }))),
			null,
			"★ refs 的键不是合法哈希 ⇒ 整份 null（宁可不判，也不把坏条目当'没引用'）"
		);
		assert.equal(
			parseDeclaration(JSON.stringify(decl("v1", "d1", { [hash(1)]: { name: "", ext: "png", addedAt: "x" } }))),
			null,
			"空名字 ⇒ null（显示名是别人唯一能核对的东西）"
		);
	}

	// ============================================================
	// 3. 读端合并：同 hash 取序号最大，head 当最新
	// ============================================================
	{
		const H = hash(1);
		const merged = mergeRefs({
			head: decl("v1", "d1", { [H]: ref("新名字.png") }),
			segments: [{ number: 2, decl: decl("v1", "d1", { [H]: ref("旧名字.png") }) }],
		});
		assert.equal(
			merged.get(H).name,
			"新名字.png",
			"head 当最新：同 hash 在 head 与旧段里各一份时，取 head 的（名字更新）"
		);

		const byNumber = mergeRefs({
			head: null,
			segments: [
				{ number: 3, decl: decl("v1", "d1", { [H]: ref("段3.png") }) },
				{ number: 9, decl: decl("v1", "d1", { [H]: ref("段9.png") }) },
			],
		});
		assert.equal(byNumber.get(H).name, "段9.png", "同 hash 在两个段里 ⇒ 取段序号最大的那条");

		assert.equal(mergeRefs({ head: null, segments: [] }).size, 0, "什么都没有 ⇒ 空集合");
	}

	// ============================================================
	// 4. 写计划：新增 / 封存 / 减引用 / 改名 / 压缩
	// ============================================================
	{
		const H = hash(1);
		const fresh = planUpdates({
			vault: "v1",
			device: "d1",
			state: { head: null, segments: [] },
			adds: { [H]: ref("a.png") },
			now: "2026-10-25T01:00:00.000Z",
		});
		assert.equal(fresh.length, 1, "首次写只需要写 head");
		assert.equal(fresh[0].kind, "write", "而且是一次写");
		assert.ok(fresh[0].key.endsWith("/head.json"), "写的是 head");
		assert.ok(H in fresh[0].decl.refs, "新增的引用进了 head");

		// 恰好 500 条不该封存（边界：判据是 > SEGMENT_LIMIT）
		const exact = {};
		for (let i = 0; i < SEGMENT_LIMIT; i += 1) exact[hash(i + 1)] = ref(`f${i}.png`);
		const atLimit = planUpdates({
			vault: "v1",
			device: "d1",
			state: { head: null, segments: [] },
			adds: exact,
			now: "2026-10-25T01:00:00.000Z",
		});
		assert.equal(writes(atLimit).length, 1, "恰好 500 条 ⇒ 只写 head，不封存");

		// 501 条 ⇒ 封存 500 条成 seg-0001，head 留 1 条
		const over = { ...exact };
		over[hash(9999)] = ref("last.png", "2026-10-25T02:00:00.000Z");
		const sealed = planUpdates({
			vault: "v1",
			device: "d1",
			state: { head: null, segments: [] },
			adds: over,
			now: "2026-10-25T03:00:00.000Z",
		});
		const sealedWrites = writes(sealed);
		assert.equal(sealedWrites.length, 2, "501 条 ⇒ head ＋ 一个新段");
		const newSeg = sealedWrites.find((step) => segmentNumber(step.key) === 1);
		assert.ok(newSeg, "封存的段号从 1 开始");
		assert.equal(Object.keys(newSeg.decl.refs).length, SEGMENT_LIMIT, "一段装 500 条");
		const headWrite = sealedWrites.find((step) => isHeadKey(step.key));
		assert.equal(Object.keys(headWrite.decl.refs).length, 1, "剩下 1 条留在 head");
		assert.ok(hash(9999) in headWrite.decl.refs, "★ 留在 head 的是**最新**那条（按 addedAt 切）");
	}

	{
		// 减引用：在段里 ⇒ 只重写那一段（head 不动）
		const A = hash(1);
		const B = hash(2);
		const steps = planUpdates({
			vault: "v1",
			device: "d1",
			state: {
				head: decl("v1", "d1", { [B]: ref("b.png") }),
				segments: [{ number: 4, decl: decl("v1", "d1", { [A]: ref("a.png") }) }],
			},
			removes: [A],
			now: "2026-10-25T04:00:00.000Z",
		});
		assert.equal(steps.length, 1, "一次减引用 = 一次写（不是全量重写）");
		assert.equal(segmentNumber(steps[0].key), 4, "写的是包含该 hash 的那一段");
		assert.equal(Object.keys(steps[0].decl.refs).length, 0, "该段被删空");
		assert.equal(
			steps.filter((step) => step.kind === "delete").length,
			0,
			"★ 段被删空 ⇒ 写成空 refs 占位，不是删文件（段号连续是读端排序的前提）"
		);

		assert.deepEqual(
			planUpdates({
				vault: "v1",
				device: "d1",
				state: { head: decl("v1", "d1", { [B]: ref("b.png") }), segments: [] },
				removes: [hash(77)],
				now: "2026-10-25T04:00:00.000Z",
			}),
			[],
			"要减的 hash 本来就没有 ⇒ 零步骤（这个操作必须幂等）"
		);
	}

	{
		// 改名：hash 已经在段里 ⇒ 重写那一段，**不允许在 head 里再存一份**
		const A = hash(1);
		const steps = planUpdates({
			vault: "v1",
			device: "d1",
			state: {
				head: decl("v1", "d1", {}),
				segments: [{ number: 2, decl: decl("v1", "d1", { [A]: ref("旧名.png") }) }],
			},
			adds: { [A]: ref("新名.png") },
			now: "2026-10-25T05:00:00.000Z",
		});
		assert.equal(writes(steps).length, 1, "改名也只写一次");
		assert.equal(segmentNumber(writes(steps)[0].key), 2, "写的是那一段");
		assert.equal(writes(steps)[0].decl.refs[A].name, "新名.png", "段里的名字被更新");
		assert.equal(
			writes(steps).some((step) => isHeadKey(step.key)),
			false,
			"★ head 不动（同 hash 只许出现在一段里）"
		);
	}

	{
		// 压缩：两个空段 ⇒ 触发；顺序必须是「先写新段、再删旧段」
		const A = hash(1);
		const state = {
			head: null,
			segments: [
				{ number: 1, decl: decl("v1", "d1", { [A]: ref("a.png") }) },
				{ number: 2, decl: decl("v1", "d1", {}) },
				{ number: 3, decl: decl("v1", "d1", {}) },
			],
		};
		assert.equal(compactionDue(state), true, "空段 ≥ 2 ⇒ 该压缩");

		const steps = planUpdates({ vault: "v1", device: "d1", state, now: "2026-10-25T06:00:00.000Z" });
		const firstDeleteAt = steps.findIndex((step) => step.kind === "delete");
		const lastWriteAt = steps.map((step) => step.kind).lastIndexOf("write");
		assert.ok(
			firstDeleteAt > lastWriteAt,
			"压缩期间的中断残留可被合并：先写新段、再删旧段（writes 全在 deletes 之前）"
		);
		const newSegments = writes(steps).filter((step) => segmentNumber(step.key) !== null);
		assert.equal(newSegments.length, 1, "内容装得下就只写一个新段");
		assert.equal(segmentNumber(newSegments[0].key), 4, "新段号 = 现有最大 + 1（序号只增不减）");
		assert.ok(A in newSegments[0].decl.refs, "旧段里的引用被搬进新段");
		assert.deepEqual(
			deletes(steps).map((step) => segmentNumber(step.key)).sort((x, y) => x - y),
			[1, 2, 3],
			"三个旧段（含两个空段）全部删除"
		);

		assert.equal(
			compactionDue({
				head: null,
				segments: [{ number: 1, decl: decl("v1", "d1", { [A]: ref("a.png") }) }],
			}),
			false,
			"一个非空段 ⇒ 不压缩（别没事重写）"
		);
	}

	{
		let threw = false;
		try {
			planUpdates({
				vault: "../x",
				device: "d1",
				state: { head: null, segments: [] },
				adds: { [hash(1)]: ref("a.png") },
				now: "2026-10-25T07:00:00.000Z",
			});
		} catch {
			threw = true;
		}
		assert.equal(threw, true, "★ id 不合法必须抛错（静默不写＝什么都没保护）");
	}

	// ============================================================
	// 5. 指纹：只取决于集合（顺序无关），集合或时间变了就要变
	// ============================================================
	{
		const a = { key: "_acc/v1/v1/d1/head.json", lastModified: "2026-10-25T01:00:00.000Z" };
		const b = { key: "_acc/v1/v1/d1/seg-0001.json", lastModified: "2026-10-25T02:00:00.000Z" };

		assert.equal(
			fingerprint([a, b]),
			fingerprint([b, a]),
			"指纹与输入顺序无关（只取决于集合）"
		);
		assert.notEqual(
			fingerprint([a, b]),
			fingerprint([a]),
			"少一个文件 ⇒ 指纹必须变（否则批量删除会拿旧结论继续删）"
		);
		assert.notEqual(
			fingerprint([a]),
			fingerprint([{ ...a, lastModified: "2026-10-25T09:00:00.000Z" }]),
			"时间变了 ⇒ 指纹必须变"
		);
		assert.equal(fingerprint([]), fingerprint([]), "空集合稳定（首次使用也能比）");
	}

	return { cases: 5 };
}
