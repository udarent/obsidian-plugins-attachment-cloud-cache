/**
 * SHA-256 与 HMAC-SHA256 —— 签名的底层原语。
 *
 * ## 为什么不用 `node:crypto`
 *
 * 移动端没有它。本项目有一条已确认的硬约束：
 * **代码只使用两端都有的 API**，否则移动端一跑就崩。所以签名原语不能用 Node 内置模块。
 *
 * ## 为什么也不能只靠 `crypto.subtle`
 *
 * WebCrypto 的 `subtle` 只在**安全上下文**里存在。两个宿主的情况不一样：
 * - 桌面（Electron `app://`）：可用。
 * - Android（Capacitor `http://localhost`）：可用（localhost 属潜在可信来源）。
 * - ⚠️ **iOS（Capacitor `capacitor://localhost`）：自定义 scheme，`crypto.subtle` 可能为 `undefined`。**
 *   这是 Capacitor 上的已知差异，而本项目**无法在本机验证 iOS**（没有可用的 iOS 设备）。
 *
 * 所以策略是**优先 WebCrypto、缺失时降级到自带实现**，而不是"假定它存在"。
 * 这样一来：性能路径在能用的地方照走，iOS 上也不会因为一个 `undefined` 就整个签名崩掉。
 * 这与本项目"不做平台分支，而是不做平台假设"是同一条纪律。
 *
 * ## 自带实现凭什么可信
 *
 * 手写 SHA-256 的风险是真的（padding 边界、超块长密钥、轮常量抄错都会**静默**算错）。
 * 所以它不靠人眼保证，而是被 `test-hash.mjs` 拿 `node:crypto` 当**独立 oracle** 钉住：
 * 空串、`abc`、55/56/63/64/65/119/120 字节等 padding 边界、1MiB 随机数据、
 * 以及 63/64/65 字节与超长密钥的 HMAC —— 逐字节比对。
 * 再加一条：**两条路径（subtle 与自带）必须在同一批输入上给出相同结果**，
 * 否则"在某些设备上签名会不一样"，而那是最难查的一类线上问题。
 */

/** SHA-256 轮常量（FIPS 180-4，前 64 个素数立方根小数部分的前 32 位）。 */
const ROUND_CONSTANTS = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 32 位循环右移。`>>> 0` 保证结果是无符号的 —— 否则高位的 1 会以负数形式往下传播。 */
function rotateRight(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256（纯 TS，无宿主依赖）。 */
export function sha256Pure(data: Uint8Array): Uint8Array {
	// 填充：先补一个 0x80，再补 0 直到长度 ≡ 56 (mod 64)，最后 8 字节放**比特**长度。
	// 8 字节长度域用两个 32 位写入，所以先补够 56 的余数再留 8 字节。
	const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
	const message = new Uint8Array(paddedLength);
	message.set(data);
	message[data.length] = 0x80;

	const view = new DataView(message.buffer);
	const bitLength = data.length * 8;
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(paddedLength - 4, bitLength >>> 0);

	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const schedule = new Uint32Array(64);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let i = 0; i < 16; i += 1) schedule[i] = view.getUint32(offset + i * 4);

		for (let i = 16; i < 64; i += 1) {
			const w15 = schedule[i - 15];
			const w2 = schedule[i - 2];
			const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
			const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
			schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) >>> 0;
		}

		let a = hash[0];
		let b = hash[1];
		let c = hash[2];
		let d = hash[3];
		let e = hash[4];
		let f = hash[5];
		let g = hash[6];
		let h = hash[7];

		for (let i = 0; i < 64; i += 1) {
			const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temp1 = (h + sigma1 + choice + ROUND_CONSTANTS[i] + schedule[i]) >>> 0;
			const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (sigma0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		hash[0] = (hash[0] + a) >>> 0;
		hash[1] = (hash[1] + b) >>> 0;
		hash[2] = (hash[2] + c) >>> 0;
		hash[3] = (hash[3] + d) >>> 0;
		hash[4] = (hash[4] + e) >>> 0;
		hash[5] = (hash[5] + f) >>> 0;
		hash[6] = (hash[6] + g) >>> 0;
		hash[7] = (hash[7] + h) >>> 0;
	}

	const digest = new Uint8Array(32);
	const digestView = new DataView(digest.buffer);
	for (let i = 0; i < 8; i += 1) digestView.setUint32(i * 4, hash[i]);
	return digest;
}

/** HMAC-SHA256 的分组长度（SHA-256 的 64 字节）。 */
const HMAC_BLOCK_SIZE = 64;

/** HMAC-SHA256（纯 TS）。 */
export function hmacSha256Pure(key: Uint8Array, data: Uint8Array): Uint8Array {
	// ⚠️ 密钥长于分组长度时必须**先哈希**再用；直接截断是常见且静默的错误。
	// 64 / 65 字节这两条边界由 `test-hash.mjs` 单独钉住。
	const usable = key.length > HMAC_BLOCK_SIZE ? sha256Pure(key) : key;

	const inner = new Uint8Array(HMAC_BLOCK_SIZE + data.length);
	const outer = new Uint8Array(HMAC_BLOCK_SIZE + 32);
	for (let i = 0; i < HMAC_BLOCK_SIZE; i += 1) {
		const byte = i < usable.length ? usable[i] : 0;
		inner[i] = byte ^ 0x36;
		outer[i] = byte ^ 0x5c;
	}
	inner.set(data, HMAC_BLOCK_SIZE);

	outer.set(sha256Pure(inner), HMAC_BLOCK_SIZE);
	return sha256Pure(outer);
}

/** 字符串 → UTF-8 字节（`TextEncoder` 在桌面与移动 WebView 里都有）。 */
export function utf8Bytes(input: string): Uint8Array {
	return new TextEncoder().encode(input);
}

/** 宽松地把字符串 / 字节数组 / ArrayBuffer 统一成 `Uint8Array`（不复制视图以外的东西）。 */
export function toBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof input === "string") return utf8Bytes(input);
	if (input instanceof Uint8Array) return input;
	return new Uint8Array(input);
}

/** 字节 → 小写十六进制。 */
export function hexEncode(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

/**
 * 取出 WebCrypto 的 `subtle`；**不存在就返回 null**（而不是抛错）。
 *
 * 为什么要自己探测而不是直接用 `crypto.subtle`：
 * `subtle` 只在安全上下文里存在，而 iOS 上 Capacitor 用的是自定义 scheme
 * （`capacitor://localhost`），那里 `crypto.subtle` 可能是 `undefined`。
 * 本项目**无法在本机验证 iOS**，所以宁可当作"可能没有"来处理。
 *
 * 用 `window.crypto` 而不是 `globalThis`：Obsidian 的桌面与移动端都是 WebView，
 * `window` 一定存在；而 `globalThis` 在弹出窗口（popout）里指向的可能不是同一个对象。
 */
function subtleCrypto(): SubtleCrypto | null {
	const holder = (window as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
	return holder && holder.subtle ? holder.subtle : null;
}

/** 把 `Uint8Array` 视图裁成独立的 `ArrayBuffer`（给 WebCrypto / `requestUrl` 用）。 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/**
 * SHA-256。优先 WebCrypto，缺失或失败时降级到 `sha256Pure`。
 *
 * "失败也降级"是刻意的：某些环境下 `subtle` 存在但调用会抛（例如被策略禁用），
 * 那种情况降级比让整个上传失败要好。
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const subtle = subtleCrypto();
	if (subtle) {
		try {
			return new Uint8Array(await subtle.digest("SHA-256", toArrayBuffer(data)));
		} catch {
			// 落到自带实现
		}
	}
	return sha256Pure(data);
}

/** HMAC-SHA256。优先 WebCrypto，缺失或失败时降级到 `hmacSha256Pure`。 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const subtle = subtleCrypto();
	if (subtle) {
		try {
			const cryptoKey = await subtle.importKey(
				"raw",
				toArrayBuffer(key),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"]
			);
			return new Uint8Array(await subtle.sign("HMAC", cryptoKey, toArrayBuffer(data)));
		} catch {
			// 落到自带实现
		}
	}
	return hmacSha256Pure(key, data);
}

/** SHA-256 的十六进制摘要（签名里到处都要用，单独提出来避免重复拼接）。 */
export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
	return hexEncode(await sha256(toBytes(data)));
}
