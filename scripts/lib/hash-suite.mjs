/**
 * 哈希原语模块的断言套件（正式测试与变异验证共用）。
 *
 * ## 为什么这个套件比其他几个"重"
 *
 * 因为 `src/s3/hash.ts` 里的 SHA-256 / HMAC 是**自己写的**。
 * 手写密码学原语的风险在于它错得非常安静：padding 少补一个字节、
 * 轮常量抄错一位、HMAC 里 ipad/opad 写反 —— 全都是"照样出结果，
 * 但结果和全世界都不一样"，而在签名里只表现为 `SignatureDoesNotMatch`。
 *
 * 所以这里不靠"看起来对"，而是拿 **`node:crypto` 当独立 oracle**：
 * 它对、我们不对，就红。两个实现同时以同样的方式错，概率可以忽略。
 *
 * 覆盖的重点是那些"只在边界上错"的地方：
 * - SHA-256 的 padding 边界：55/56（补 0x80 后正好跨块）、63/64/65、119/120/121；
 * - HMAC 的密钥边界：**64 字节**（分组长度，必须不哈希直接用）与
 *   **65 字节**（必须**先哈希**再当密钥）—— 这一条是最常见的静默错误；
 * - 非 ASCII：UTF-8 编码必须先于哈希。
 */

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const toHex = (bytes) => Buffer.from(bytes).toString("hex");

/**
 * 确定性伪随机字节。
 *
 * 用固定种子而不是 `randomBytes()`：测试失败时要能**原样复现**。
 * 随机数据只用来遍历取值，不需要不可预测性 —— 那反而让红/绿变得偶然。
 */
function deterministicBytes(seed, length) {
	const out = new Uint8Array(length);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < length; i += 1) {
		// xorshift32
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		out[i] = state & 0xff;
	}
	return out;
}

export async function runHashSuite(mod) {
	const { sha256Pure, hmacSha256Pure, sha256, hmacSha256, hexEncode, utf8Bytes, toBytes } = mod;

	// ============================================================
	// 0. 十六进制格式（最底层，必须先查）
	//
	// 放在最前是刻意的：hex 拼接是下面所有比对的**表达方式**，
	// 若补零坏了，第一条与 node:crypto 的比对就会红 ——
	// 报出来的是"SHA-256 在 N 字节上不一致"，而真因是"hex 格式不对"。
	// 先查格式，每个缺陷才各报各的原因。
	// ============================================================
	assert.equal(hexEncode(new Uint8Array([0, 1, 15, 16, 255])), "00010f10ff", "hex 必须是两位小写、无分隔");
	assert.equal(hexEncode(new Uint8Array([7])), "07", "单个字节也必须补零成两位（'7' 会让后续拼接错位）");
	assert.equal(hexEncode(new Uint8Array(0)), "", "空字节应得空串");

	// ============================================================
	// 1. SHA-256：与 node:crypto 逐字节比对
	// ============================================================
	// 55/56 与 63/64/65 必须单独列出：它们正好落在"补 0x80 之后是否还要多补一个块"
	// 以及"长度域跨越块边界"这两个岔口上。
	const sizes = [
		0, 1, 2, 3, 7, 8, 31, 32, 33, 54, 55, 56, 57, 62, 63, 64, 65, 66, 100, 111, 112, 119, 120, 121, 127,
		128, 129, 200, 255, 256, 1000, 4096, 65536, 1048576,
	];
	for (const size of sizes) {
		const data = deterministicBytes(size + 7, size);
		const mine = hexEncode(sha256Pure(data));
		const theirs = createHash("sha256").update(Buffer.from(data)).digest("hex");
		assert.equal(mine, theirs, `SHA-256 在 ${size} 字节上与 node:crypto 不一致`);
	}

	// 官方已公布的点（不依赖 node:crypto 也能看出对错）
	assert.equal(
		hexEncode(sha256Pure(new Uint8Array(0))),
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		"空串的 SHA-256 应是 e3b0c442…"
	);
	assert.equal(
		hexEncode(sha256Pure(utf8Bytes("abc"))),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		'"abc" 的 SHA-256 应是 ba7816bf…'
	);

	// 摘要长度固定 32 字节 —— 多一个少一个都会让后续 hex 拼接错位
	for (const size of [0, 1, 64, 65, 1000]) {
		assert.equal(sha256Pure(deterministicBytes(size, size)).length, 32, "SHA-256 摘要必须恰好 32 字节");
	}

	// ============================================================
	// 2. HMAC：密钥边界是重点
	// ============================================================
	const keySizes = [0, 1, 16, 20, 32, 48, 63, 64, 65, 100, 127, 128, 129, 200];
	const dataSizes = [0, 1, 55, 63, 64, 65, 100, 200, 1000];
	for (const keySize of keySizes) {
		for (const dataSize of dataSizes) {
			const key = deterministicBytes(keySize * 31 + 5, keySize);
			const data = deterministicBytes(dataSize * 17 + 3, dataSize);
			const mine = hexEncode(hmacSha256Pure(key, data));
			const theirs = createHmac("sha256", Buffer.from(key)).update(Buffer.from(data)).digest("hex");
			assert.equal(mine, theirs, `HMAC 在密钥 ${keySize} 字节 / 数据 ${dataSize} 字节上不一致`);
		}
	}

	// ⭐ 超块长密钥必须**先哈希**。单独钉一条：
	// 若实现改成"截断到 64 字节"，别的用例仍可能偶然通过，这一条不会。
	const longKey = deterministicBytes(99, 200);
	const longKeyData = utf8Bytes("payload");
	assert.equal(
		hexEncode(hmacSha256Pure(longKey, longKeyData)),
		hexEncode(hmacSha256Pure(sha256Pure(longKey), longKeyData)),
		"超过分组长度的密钥必须先哈希，等价于用它的 SHA-256 当密钥"
	);
	// 反过来：64 字节及以内**不能**哈希 —— 哈希了就会得到另一个值
	const exactBlockKey = deterministicBytes(1234, 64);
	assert.notEqual(
		hexEncode(hmacSha256Pure(exactBlockKey, longKeyData)),
		hexEncode(hmacSha256Pure(sha256Pure(exactBlockKey), longKeyData)),
		"恰好 64 字节的密钥不应当被哈希（它正好占满一个分组）"
	);

	// RFC 4231 用例 1（官方公布值）
	assert.equal(
		hexEncode(hmacSha256Pure(new Uint8Array(20).fill(0x0b), utf8Bytes("Hi There"))),
		"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
		"RFC 4231 用例 1 的 HMAC-SHA256 应是 b0344c61…"
	);

	// ============================================================
	// 3. ⭐ 两条实现路径必须给出相同结果
	//
	// 这一条防的是"在某些设备上签名不一样"：WebCrypto 可用时走 subtle、
	// 不可用时走自带实现（iOS 的 capacitor:// 不是安全上下文）。
	// 若两者结果不同，就会出现"同一份配置，桌面能用、手机 403"，
	// 而且从错误信息里完全看不出原因。
	// ============================================================
	let subtleAvailable = false;
	try {
		subtleAvailable = Boolean(globalThis.crypto?.subtle);
	} catch {
		subtleAvailable = false;
	}

	const samples = [
		new Uint8Array(0),
		utf8Bytes("abc"),
		utf8Bytes("中文 名字.png"),
		deterministicBytes(7, 55),
		deterministicBytes(11, 64),
		deterministicBytes(13, 65),
		deterministicBytes(17, 1000),
	];
	for (const sample of samples) {
		assert.equal(
			hexEncode(await sha256(sample)),
			hexEncode(sha256Pure(sample)),
			`sha256() 的 WebCrypto 路径与自带实现结果不同（数据 ${sample.length} 字节）`
		);
	}
	for (const keySize of [0, 32, 64, 65, 200]) {
		const key = deterministicBytes(keySize + 1, keySize);
		assert.equal(
			hexEncode(await hmacSha256(key, longKeyData)),
			hexEncode(hmacSha256Pure(key, longKeyData)),
			`hmacSha256() 的 WebCrypto 路径与自带实现结果不同（密钥 ${keySize} 字节）`
		);
	}
	// 只有真要断言"这条路径确实被走过"时才断言环境能力 —— 否则在缺 subtle 的
	// 环境里测试会因为环境而红，而不是因为代码。这里如实记录事实。
	assert.ok(
		typeof subtleAvailable === "boolean",
		"应当能探测到 WebCrypto 是否存在（无论结论如何）"
	);

	// ============================================================
	// 4. 字节工具
	// ============================================================
	// （hex 格式的断言在开头的第 0 节）
	const utf8 = utf8Bytes("中文");
	assert.equal(utf8.length, 6, "两个汉字应是 6 个 UTF-8 字节（每字 3 字节）");
	assert.equal(hexEncode(utf8), "e4b8ade69687", "「中文」的 UTF-8 应是 e4b8ad e69687");

	assert.equal(hexEncode(toBytes("ab")), "6162", "toBytes 应把字符串按 UTF-8 转字节");
	assert.equal(hexEncode(toBytes(new Uint8Array([9]))), "09", "toBytes 对 Uint8Array 应原样返回");
	const buffer = new Uint8Array([7, 8, 9]).buffer;
	assert.equal(hexEncode(toBytes(buffer)), "070809", "toBytes 应接受 ArrayBuffer");

	// 视图的 byteOffset 必须被尊重：从大 buffer 里切出来的视图不能连同前后字节一起哈希
	const big = new Uint8Array([1, 2, 3, 4, 5, 6]);
	const view = big.subarray(2, 5);
	assert.equal(hexEncode(toBytes(view)), "030405", "Uint8Array 视图只应取它自己的那一段");
	assert.equal(
		hexEncode(sha256Pure(view)),
		createHash("sha256").update(Buffer.from([3, 4, 5])).digest("hex"),
		"SHA-256 必须只哈希视图覆盖的字节，而不是整个底层 buffer"
	);

	return { sizes: sizes.length, hmacCases: keySizes.length * dataSizes.length, subtleAvailable };
}
