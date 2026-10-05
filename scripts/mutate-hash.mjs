import { runMutations } from "./lib/mutate.mjs";
import { runHashSuite } from "./lib/hash-suite.mjs";

/**
 * 变异验证：哈希原语。
 *
 * 手写密码学原语是"错得最安静"的一类代码：结果照出，只是和全世界都不一样。
 * 所以这里逐个确认那几处最容易写错的细节真的被断言守住了 ——
 * 尤其是 **padding 边界**与 **HMAC 的超块长密钥**。
 */
await runMutations({
	source: "src/s3/hash.ts",
	suite: runHashSuite,
	mutations: [
		{
			name: "轮常量抄错一位（0x428a2f98 → …99）",
			from: "0x428a2f98, 0x71374491,",
			to: "0x428a2f99, 0x71374491,",
			expect: "与 node:crypto 不一致",
		},
		{
			name: "padding 长度算错（漏掉'补 0x80 后仍需整块'的情形）",
			from: "const paddedLength = (((data.length + 8) >> 6) + 1) << 6;",
			to: "const paddedLength = (((data.length + 7) >> 6) + 1) << 6;",
			expect: "与 node:crypto 不一致",
		},
		{
			name: "消息扩展里的循环右移位数写错",
			from: "const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);",
			to: "const s0 = rotateRight(w15, 8) ^ rotateRight(w15, 18) ^ (w15 >>> 3);",
			expect: "与 node:crypto 不一致",
		},
		{
			name: "HMAC 的 ipad/opad 写反（0x36 ↔ 0x5c）",
			from: "inner[i] = byte ^ 0x36;",
			to: "inner[i] = byte ^ 0x5c;",
			expect: "HMAC 在密钥",
		},
		{
			name: "超块长密钥不再先哈希（直接截断）",
			from: "const usable = key.length > HMAC_BLOCK_SIZE ? sha256Pure(key) : key;",
			to: "const usable = key;",
			expect: "HMAC 在密钥",
		},
		{
			name: "toBytes 丢掉视图偏移（把整个底层 buffer 当数据）",
			from: "if (input instanceof Uint8Array) return input;",
			to: "if (input instanceof Uint8Array) return new Uint8Array(input.buffer);",
			expect: "只应取它自己的那一段",
		},
		{
			name: "十六进制不再补零（1 变成 '1' 而不是 '01'）",
			from: '.padStart(2, "0");',
			to: ";",
			expect: "hex 必须是两位小写",
		},
	],
});
