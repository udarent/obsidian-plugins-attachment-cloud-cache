import { runMutations } from "./lib/mutate.mjs";
import { runSharedBucketFlowSuite } from "./lib/shared-bucket-flow-suite.mjs";

/**
 * 变异验证：共享桶的**接线**（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 四条各自对应一种"看不出来"的坏法：**没有身份**也照发请求（写到空前缀、所有设备互相覆盖）、
 * 身份形状不校验（所有设备写到同一前缀、声明互相覆盖）、把读失败当成"对象不存在"
 * （声明读不出来 ⇒ 全都像没人引用）、写失败报成功（对象传上去却没有保护）。
 */
await runMutations({
	source: "src/plugin/shared-bucket-flow.ts",
	suite: runSharedBucketFlowSuite,
	mutations: [
		{
			// 后果：没有身份也照发请求 ⇒ 前缀拼成 `_acc//`，所有设备写进同一处互相覆盖，
			// 而用户看到的是"引用好像记过了"。2026-10-28 起"共享桶开关"已删，这条变异改钉身份检查。
			name: "★★ 没有身份却照发请求（写到空前缀、所有设备互相覆盖）",
			from: "\tconst self = identityOf(selfSource(ctx));\n\tif (!self) {",
			to: "\tconst self = identityOf(selfSource(ctx));\n\tif (false) {",
			expect: "★ 没有身份时不许抛（早退就是全部动作）",
		},
		{
			// 后果：`vaultId` / `deviceId` 含 `/` 或 `..` 时照样拼前缀 ⇒ 声明写到别的前缀，
			// 或者所有设备挤进同一个目录互相覆盖 ⇒ 某些对象的保护凭空消失。
			name: "★★ 身份形状不校验（声明写到别的前缀）",
			from: "\tif (!isSafeId(vaultId) || !isSafeId(deviceId)) return null;",
			to: "\tif (false) return null;",
			expect: "带 `..` 的一律不认",
		},
		{
			// 后果：所有读取错误都被当成"对象不存在"（`null`）⇒ 声明消失 = 没人引用 ⇒
			// 清理会删掉别的设备还在用的对象。这是这一层最贵的一次静默。
			name: "★★ 读失败被当成「对象不存在」",
			from: "\t\t\t\tif (isNotFound(error)) return null;",
			to: "\t\t\t\tif (true) return null;",
			expect: "非 404 的错误必须抛",
		},
		{
			// 后果：没有身份也去写声明 ⇒ 与上面同形（空前缀），只是发生在改名那条路上。
			name: "★ 没有身份也去写声明",
			from: '	if (!self) return "off";',
			to: '	if (false) return "off";',
			expect: "没有身份 ⇒ 什么都不做",
		},
		{
			// 后果：补写失败也当成"结清" ⇒ 队列被清空，而声明里还是旧名字。
			// 症状是"改了名、过几天又变回去"，且没有任何报错。
			name: "★★ 补写失败也结清（名字永远补不上）",
			from: '		if (outcome === "renamed" || outcome === "absent") {',
			to: '		if (true) {',
			// 先红的是状态码断言（`读失败 ⇒ 一条都没补`）—— 比"队列被清空"更早说话
			expect: "读失败 ⇒ 一条都没补",
		},
		{
			// 后果：没有身份也去读全库、写声明 ⇒ 白跑一整个全库扫描，而且写进空前缀。
			name: "★ 没有身份也做整份对账",
			from: '	if (!self) return false;\n\n\tlet referenced: Set<string>;',
			to: '	if (false) return false;\n\n\tlet referenced: Set<string>;',
			expect: "★ 没有身份时不许抛（早退就是全部动作）",
		},
		{
			// 后果：删完不摘引用 ⇒ 那条记录替一个不存在的对象永远做保护，
			// 别的设备清理时被它挡下，而用户看到的是"删掉了又回候选里"。
			name: "★★ 删完不摘引用（声明替不存在的对象做保护）",
			from: '	const result = await declareRefs({ io: declarationIoFor(client), self }, {}, hashes);',
			to: '	const result = await declareRefs({ io: declarationIoFor(client), self }, {}, []);',
			expect: "删掉的对象必须触发一次声明重写",
		},
		{
			// 后果：声明写失败却返回成功 ⇒ 这一批照常上传，而那批对象**没有任何保护**。
			name: "★★ 写失败报成功（对象传上去却没有保护）",
			from: "\tconst result = await declareRefs({ io: declarationIoFor(client), self }, adds);\n\tif (result.ok) return true;",
			to: "\tconst result = await declareRefs({ io: declarationIoFor(client), self }, adds);\n\tif (true) return true;",
			expect: "写失败 ⇒ 返回 false",
		},
	],
});
