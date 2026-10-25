import { runMutations } from "./lib/mutate.mjs";
import { runSharedBucketFlowSuite } from "./lib/shared-bucket-flow-suite.mjs";

/**
 * 变异验证：共享桶的**接线**（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 四条各自对应一种"看不出来"的坏法：关着功能却照发请求（用户莫名被要求 ListBucket）、
 * 身份形状不校验（所有设备写到同一前缀、声明互相覆盖）、把读失败当成"对象不存在"
 * （声明读不出来 ⇒ 全都像没人引用）、写失败报成功（对象传上去却没有保护）。
 */
await runMutations({
	source: "src/plugin/shared-bucket-flow.ts",
	suite: runSharedBucketFlowSuite,
	mutations: [
		{
			// 后果：功能关着也照发请求 ⇒ 没打开共享桶的用户突然收到 AccessDenied，
			// 或者每次上传都多一次无用的 list + put。
			name: "★ 关着功能却照发请求（不该付的代价）",
			from: "\tif (!ctx.settings.sharedBucket || refs.length === 0) return true;",
			to: "\tif (refs.length === 0) return true;",
			expect: "关着时一次请求都不发",
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
