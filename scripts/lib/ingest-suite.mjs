/**
 * 上传编排（`src/core/ingest.ts`）的断言套件。
 *
 * ## 这套断言为什么必须用**真实磁盘 + 真实 HTTP**
 *
 * 编排层要保证的性质，没有一条能在 mock 层面验证：
 * - 「缓存文件真的落盘了」→ 必须 `stat` 真实文件；
 * - 「上传的字节逐字节一致」→ 必须有一个真实服务端收下并比对；
 * - 「上传失败时字节仍在」→ 必须真的去读那个文件；
 * - 「恰好 1 次 PUT、0 次 GET」→ 必须数真实请求。
 *
 * 所以这里同时接上 `mock-s3`（真实 HTTP，服务端**独立重算**签名）与
 * `mock-obsidian`（真实磁盘 + 可模拟移动端的受限 API）。
 *
 * ## 哈希用**独立实现**算
 *
 * 期望的 key 里含内容哈希。这里用 `node:crypto` 现算，而不是调被测代码的
 * `sha256Hex` —— 后者只能证明"它等于它自己"。顺带这也把
 * 哈希 → key → 缓存路径 这条链整体与一个独立实现对齐了。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppMock } from "./mock-obsidian.mjs";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "test-bucket";
const FIXED_NOW = new Date("2026-10-06T05:06:58Z");

const sha256Hex = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** 刻意包含 0x00 / 0xFF / 非法 UTF-8：文本通道会悄悄改掉这些字节。 */
const HOSTILE_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f, 0xed, 0xfd,
]);

/**
 * 搭一个完整的运行环境：临时 vault（真实磁盘）+ 本地 S3（真实 HTTP）+ 客户端 + 索引。
 *
 * 每次用例都重建，避免互相污染 —— 上一轮吃过"用例之间靠共享状态传递"的苦。
 */
/**
 * ⭐ 夹具根目录：**整个进程复用一个**（2026-10-13 实测后改）。
 *
 * 原先每个用例都 `mkdtemp` 建一个新目录。语义上没问题，但在这台机器上极贵 ——
 * 代价不在目录、在**新建文件**本身（同一台机器上实测，10 轮取平均）：
 *
 *   · 新目录 + 3 个新文件 + 读 + 删 ....... 985 ms/轮
 *   · 同路径、删掉再建同样的文件 .......... 483 ms/轮
 *   · 同路径、同文件名，**只覆盖内容** ....   3 ms/轮   ← 差 328 倍
 *
 * 差额是 Windows 实时防护对新文件的扫描（它按路径缓存）。本套件 29 个用例、
 * 而变异验证会把整套跑 8 遍 ⇒ 这是这里最大的一笔与"测什么"无关的开销。
 *
 * ⚠️ 复用的正确性依赖两件事，两点都不能少：
 *   ① 每个用例开始前**清空**根目录 —— 这才等价于原先的"全新目录"；
 *   ② 目录**每进程一个**（`mkdtemp` 依旧唯一）⇒ 并行进程之间不会互相踩，
 *      退出时尽力删掉。
 */
let sharedRoot = null;

async function harnessRoot() {
	if (sharedRoot === null) {
		sharedRoot = await mkdtemp(join(tmpdir(), "acc-ingest-"));
		process.once("exit", () => {
			try {
				rmSync(sharedRoot, { recursive: true, force: true });
			} catch {
				/* 尽力而为：本身在系统临时目录里 */
			}
		});
	}
	// ①：把上一个用例留下的东西清干净（含子目录）
	//    ⚠️ 不能假定目录一直在：用例自己可能把它删掉（download-suite 就有一处
	//    `finally` 里 `rm(h.root)` —— 原先每次都是新目录，所以那样写没问题）。
	//    ⇒ 目录不在时重建，等价于"全新目录"。
	const names = await readdir(sharedRoot).catch(() => []);
	for (const name of names) await rm(join(sharedRoot, name), { recursive: true, force: true });
	await mkdir(sharedRoot, { recursive: true });
	return sharedRoot;
}

async function makeHarness(mod, options = {}) {
	const root = await harnessRoot();
	// ⚠️ `createAppMock` 返回的是**包装对象**（`{ app, calls, ... }`），
	// 真正要交给被测代码的是 `.app`。传错这一层会让 `app.fileManager` 变成 undefined，
	// 而报错是一句莫名的 "Cannot read properties of undefined"。
	const harness = createAppMock(root);
	// 宿主侧的附件设置（模拟 Obsidian 自己的「新附件的默认位置」）。
	// 留空 = vault 根目录，正是全新 vault 的默认状态。
	harness.setAttachmentFolder(options.hostAttachmentFolder ?? "");
	const app = harness.app;

	const server = createMockS3({
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: "auto",
		bucket: BUCKET,
		...options.s3,
	});
	const endpoint = await server.start();

	const sent = [];
	const baseTransport = nodeTransport();
	const client = new mod.S3Client(
		{
			endpoint,
			region: "auto",
			bucket: BUCKET,
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			forcePathStyle: true,
			...options.client,
		},
		{
			transport: async (request) => {
				sent.push(request);
				return baseTransport(request);
			},
			now: () => FIXED_NOW,
			sleep: async () => {},
		}
	);

	const settings = {
		...mod.SETTINGS_DEFAULTS,
		...options.settings,
		// ⚠️ 1.2.0 起这里没有"钉模板"那一步了：key 形状**不可配置**（模板设置已取消），
		// 所以本套件判断的形状就是产品唯一的形状，不会再随某个默认值漂移。
		s3: { ...mod.SETTINGS_DEFAULTS.s3, ...options.settings?.s3 },
	};

	const index = new mod.CacheIndex();
	const notices = [];
	let persistCount = 0;
	let persistError = null;

	const deps = {
		app,
		settings,
		client,
		index,
		persistIndex: async () => {
			persistCount += 1;
			if (persistError) throw persistError;
		},
		notify: (message) => notices.push(message),
		// ⚠️ 文案键在这层选、文字由接线层给（见 `IngestDeps.t`）。这里把**键名**当文案，
		// 于是断言可以**与语言无关**地钉住"到底说没说那一句" ——
		// 原先断言里那半句中文，正是核心层硬编码文案留下的痕迹。
		t: (key) => key,
		now: () => FIXED_NOW,
	};

	return {
		root,
		app,
		appCalls: harness.calls,
		server,
		endpoint,
		client,
		settings,
		index,
		deps,
		sent,
		notices,
		get persistCount() {
			return persistCount;
		},
		setPersistError(error) {
			persistError = error;
		},
		/** 磁盘上读文件；不存在返回 null（避免用例里到处写 try/catch）。 */
		async read(vaultPath) {
			try {
				return await readFile(join(root, ...vaultPath.split("/")));
			} catch {
				return null;
			}
		},
		async exists(vaultPath) {
			try {
				await stat(join(root, ...vaultPath.split("/")));
				return true;
			} catch {
				return false;
			}
		},
		async write(vaultPath, data) {
			const abs = join(root, ...vaultPath.split("/"));
			await mkdir(join(abs, ".."), { recursive: true });
			await writeFile(abs, data);
		},
		/** 直接从磁盘删掉（模拟"用户清空了缓存目录"，不经过宿主的 API）。 */
		async remove(vaultPath) {
			await rm(join(root, ...vaultPath.split("/")), { force: true });
		},
		async cleanup() {
			// ⚠️ 只关服务器：根目录**整个进程共用**（见 harnessRoot），
			// 由下一个用例开头清空、进程退出时统一删（见那里的说明）。
			await server.close();
		},
	};
}

/** 跑一个用 harness 的用例，无论成败都收掉临时资源。 */
async function withHarness(mod, options, fn) {
	const harness = await makeHarness(mod, options);
	try {
		return await fn(harness);
	} finally {
		await harness.cleanup();
	}
}

export async function runIngestSuite(mod) {
	const { ingestAttachment, planLocalCopy } = mod;

	// ============================================================
	// 1. planLocalCopy —— 纯函数，先穷举（它把"用户选了什么"翻译成"我们做什么"）
	//
	// ⚠️ 1.2.0（D-17）取消了缓存目录，"搬进缓存"这一态随之消失：
	// 签名从 (action, cachePathUsable) → (action)，结果集从三个 → 两个。
	//
	// 历史留在这里（免得以后再绕回去）：
	// ① `cacheEnabled` 与 `localFileAction` 不**正交**，二者能组成"选了移入缓存却得到
	//    原地保留"的静默矛盾 ⇒ 先合并成单个 `LocalCopyAction`；
	// ② 合并之后仍有 `cache` 这一档，而它的唯一含义就是"搬到缓存目录" ⇒
	//    那条目录本身被取消后，这一档与 `keep` 同义，于是它也从结果集里消失了。
	// ============================================================
	assert.equal(planLocalCopy("trash"), "trash", "选回收站就是回收站（不留本地副本 ⇒ 离线看不了）");
	assert.equal(planLocalCopy("keep"), "keep-in-place", "原地保留就是原地保留");
	// 老设置的 `"cache"`（1.2.0 之前的值）现在与 keep 同义 —— 副本**就是**附件本身，
	// 没有第二个地方可去。这条同时钉住"不该有人偷偷搬文件"。
	assert.equal(planLocalCopy("cache"), "keep-in-place", "老设置的 cache 已与原地保留同义（没有缓存目录可搬）");
	// 反向守护：不能出现"任何输入都返回 trash"（那会把用户的图全丢进回收站）
	assert.notEqual(planLocalCopy("keep"), "trash", "keep 不得被当成 trash");

	// ============================================================
	// 2. 正常路径：上传 → **原地保留** → 登记索引（1.2.0：副本就是附件本身）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "photo.png",
			mime: "image/png",
		});

		const expectedHash = sha256Hex(HOSTILE_BYTES);
		// ⭐ 1.2.0：形状固定 = `<原名>-<内容哈希>.<扩展名>`（独立算出的哈希，不读实现）
		const expectedKey = `photo-${expectedHash}.png`;

		assert.equal(result.status, "uploaded", `应上传成功，实际 ${result.status}`);
		assert.equal(result.key, expectedKey, "key 应由**独立算出的**内容哈希与原始文件名决定");
		assert.equal(
			result.remoteUrl,
			`${h.endpoint}/${BUCKET}/${expectedKey}`,
			"远端 URL 应是端点/桶/key（没配 publicUrlBase 时）"
		);
		// ⭐ 1.2.0（D-17）：副本 = 附件目录里那份原文件（**不再**按 key 镜像到缓存目录）。
		// 落点由宿主的附件设置决定（这里宿主没配 ⇒ vault 根），名字用**原始文件名**。
		assert.equal(result.localPath, "photo.png", "副本应原地保留在附件目录，且用原始文件名");

		// ── 网络：恰好 1 次 PUT、0 次 GET ──
		assert.equal(h.server.countByMethod("PUT"), 1, "上传应当**恰好** 1 次 PUT");
		assert.equal(h.server.countByMethod("GET"), 0, "上传过程里不得有任何 GET");
		assert.equal(h.server.requests[0].signatureOk, true, `服务端独立重算的签名必须通过：${h.server.requests[0].signatureReason}`);
		assert.equal(
			h.server.requests[0].headers["content-type"],
			"image/png",
			"应声明 Content-Type（否则浏览器里是下载而不是显示）"
		);

		// ── 磁盘：那份副本真的存在，且字节与本地逐字节一致 ──
		const cached = await h.read(result.localPath);
		assert.ok(cached, `副本必须真的落盘：${result.localPath}`);
		assert.equal(Buffer.compare(cached, Buffer.from(HOSTILE_BYTES)), 0, "缓存副本必须与原始字节逐字节一致");
		assert.equal(
			Buffer.compare(h.server.stored(expectedKey), Buffer.from(HOSTILE_BYTES)),
			0,
			"服务端收到的字节必须与原始字节逐字节一致"
		);

		// ── ⭐ 关键反转（1.2.0 / D-17）：文件**原地不动** ──
		//
		// 从前这里断言的是"原文件已被搬走、附件目录里不该留副本"。
		// 现在恰好相反：那份文件**就是**本地副本，搬走它等于把用户的附件拿走。
		assert.equal(await h.exists("photo.png"), true, "⭐ 上传后原文件必须**留在原地**（它本身就是本地副本）");
		assert.equal(
			Buffer.compare(await h.read("photo.png"), Buffer.from(HOSTILE_BYTES)),
			0,
			"留在原地的那份内容必须与粘贴的字节逐字节一致"
		);
		assert.equal(await h.exists("_attachment-cache"), false, "⭐ 不再有任何缓存目录被建出来");

		// ── 索引登记 ──
		const entry = h.index.get(expectedKey);
		assert.ok(entry, "索引里应登记这条对象");
		assert.equal(entry.cachePath, result.localPath, "索引应记录**真实**的本地副本路径");
		assert.equal(entry.remoteUrl, result.remoteUrl, "索引应记录写入笔记的那个 URL");
		assert.equal(entry.size, HOSTILE_BYTES.length, "索引应记录字节数");
		assert.equal(entry.etag, result.etag, "索引应记录 ETag");
		assert.equal(entry.sourceName, "photo.png", "索引应记录原始文件名（仅用于报告）");
		assert.ok(h.persistCount >= 1, "索引变更后应落盘");

		// ── 索引应能被序列化并原样读回 ──
		const reloaded = mod.CacheIndex.fromJSON(JSON.parse(JSON.stringify(h.index.toJSON())));
		assert.equal(reloaded.skipped.length, 0, "自己写出的索引不该有被丢弃的条目");
		assert.deepEqual(
			reloaded.index.get(expectedKey),
			entry,
			"索引落盘再读回后，条目内容应完全一致"
		);
	});

	// ============================================================
	// 2b. 非 ASCII 名字进 key：**不编码**（编码会让链接 404）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "报告 扫描.png",
			mime: "image/png",
		});

		const expectedHash = sha256Hex(HOSTILE_BYTES);
		assert.equal(result.status, "uploaded", `应上传成功，实际 ${result.status}`);
		assert.equal(result.key, `报告 扫描-${expectedHash}.png`, "新默认模板的 key 应自带文件名（非 ASCII 不编码）");
		assert.equal(h.server.countByMethod("PUT"), 1, "带名字的 key 也应一次 PUT 成功");
		assert.equal(
			Buffer.compare(h.server.stored(result.key), Buffer.from(HOSTILE_BYTES)),
			0,
			"服务端按带名字的 key 收到的字节必须逐字节一致"
		);
	});

	// ============================================================
	// 3. 同内容**同名**重复粘贴 → 跳过上传（零网络请求）
	//
	// ⚠️ 1.2.0 起"去重"的口径收窄了一格，这条用例把这个收窄**如实钉住**：
	// key = `<名字>-<哈希>.<扩展名>`，所以"同一份内容"只有在**名字也相同**时才会
	// 落到同一个 key 上。名字不同的同一份内容 = 另一个对象（这是 C2 的已知代价：
	// 桶里按名字组织 ⇒ 名字就成了身份的一部分）。
	//
	// 代价最常出现在**剪贴板**上：那是**时间戳命名**（`Pasted image 2026...`），
	// 所以同一张图贴两次得到两个名字 ⇒ 两份对象。⚠️ 目前**未做**任何缓解
	// （按内容哈希复用已有对象是一条可行路：`CacheIndex.wasContentUploaded` 现成），
	// 要不要做是独立决定，别顺手加。
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.equal(h.server.countByMethod("PUT"), 1, "第一次应上传");

		// 同名同内容 ⇒ 同 key ⇒ 复用（一个字都不重传）
		const again = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(again.status, "reused", "同内容同名字应复用，而不是重新上传");
		assert.equal(again.key, first.key, "同内容同名字必须得到同一个 key");
		assert.equal(again.remoteUrl, first.remoteUrl, "复用时 URL 应与首次一致");
		assert.equal(again.localPath, first.localPath, "复用时本地副本路径应一致");
		assert.equal(
			h.server.countByMethod("PUT"),
			1,
			"同内容同名字重复粘贴**不得**再发 PUT —— 省掉一次可能几十 MB 的上行"
		);
		assert.equal(h.server.countByMethod("GET"), 0, "复用路径上不该有任何下载");
	});

	// 3b. 同内容**不同名字** ⇒ 另一个对象（名字进了 key，跨名去重就不再成立）
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");

		const renamed = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "另一个名字.png", mime: "image/png" });
		assert.equal(renamed.status, "uploaded", "换名字的同一份内容会得到另一个 key ⇒ 会真的再传一次（C2 的已知代价）");
		assert.notEqual(renamed.key, first.key, "★ 名字不同 ⇒ key 必须不同（否则链接会指向名字对不上的对象）");
		assert.equal(h.server.countByMethod("PUT"), 2, "两份对象、两次 PUT");
		// ⚠️ 但**字节**仍然各存一份、内容一致：桶里多了一份，不是丢了什么
		assert.equal(
			Buffer.compare(h.server.stored(first.key), h.server.stored(renamed.key)),
			0,
			"两份对象的字节完全一样（多占一份空间，不是数据不一致）"
		);
	});

	// ⚠️ 复用的前提是**索引里有记录**，而不是"附件目录里恰好有个同名文件"。
	// 那个文件可能是同步过来的、或用户手工放进去的 —— 我们并不确定它上传过。
	//
	// 这一条同时记录了一个**刻意的取舍**：目标路径已占用时，落盘一律另取序号
	// （`… .png` → `… 1.png`），而**不是**判断"内容相同就直接复用"。
	// 理由：落盘名来自**原始文件名**（不是 key），所以"同一个路径"绝不等于"同一份内容"——
	// 两个不同内容的 `photo.png` 会落在同一处。直接复用就等于认错了文件。
	// 另取序号的代价只是"索引丢失后重贴同一张图会多一份副本"，
	// 而多出来的那份会被「本地副本上限」按最久未用淘汰 —— 用一点可回收的空间
	// 换"任何情况下都不会认错文件"，这个交换是划算的。
	await withHarness(mod, {}, async (h) => {
		const key = `photo-${sha256Hex(HOSTILE_BYTES)}.png`;
		const occupied = "photo.png";
		await h.write(occupied, Buffer.from(HOSTILE_BYTES)); // 只放文件，不登记索引

		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "索引里没有记录时必须真的上传（不能只看文件在不在）");
		assert.equal(h.server.countByMethod("PUT"), 1, "应发出 1 次 PUT");

		// 已存在的那份**不得被改动**
		assert.equal(
			Buffer.compare(await h.read(occupied), Buffer.from(HOSTILE_BYTES)),
			0,
			"已存在的同名文件必须原封不动（它可能是同步来的、也可能是用户自己放的）"
		);
		// 新的副本另取序号，且内容一致
		assert.notEqual(result.localPath, occupied, "目标已占用时应另取序号，绝不覆盖");
		assert.equal(result.localPath, "photo 1.png", "同名策略应是加序号");
		assert.equal(
			Buffer.compare(await h.read(result.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"新副本的字节应与原始内容一致"
		);
		// 索引指向**真实**位置，而不是推导值
		assert.equal(h.index.get(key)?.cachePath, result.localPath, "索引必须记录真实路径");
	});

	// ⭐ 索引里有记录、但本地副本**已被删掉** → 不能复用，必须重新落盘。
	//
	// 这是"缓存可随时删除"这条承诺的直接后果：用户清空了缓存目录，
	// 索引却还在插件目录里。若只看索引就复用，返回的 localPath 会指向一个不存在的文件，
	// 于是笔记里链接有效、但离线渲染找不到本地副本 —— 而且不会报任何错。
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.ok(await h.exists(first.localPath), "先确认副本存在");

		// 模拟"用户清空了缓存目录"
		await h.remove(first.localPath);
		assert.equal(await h.exists(first.localPath), false, "副本已删除");

		const second = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.ok(
			second.status !== "reused" || (await h.exists(second.localPath)),
			`本地副本不在时不得直接复用并返回一个不存在的路径（实际 ${second.status} → ${second.localPath}）`
		);
		assert.equal(
			await h.exists(second.localPath),
			true,
			"⭐ 结果里的 localPath 必须指向**真实存在**的文件 —— 否则离线渲染会静默失效"
		);
		assert.equal(
			Buffer.compare(await h.read(second.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"重建的副本内容应正确"
		);
	});

	// ============================================================
	// 4. ⭐ 上传失败：字节必须留下（"绝不丢图"）
	// ============================================================
	await withHarness(mod, { s3: { intercept: () => ({ status: 403, code: "AccessDenied" }) } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });

		assert.equal(result.status, "fallback", "上传失败应走降级");
		assert.equal(result.remoteUrl, "", "降级时没有远端 URL 可用");
		assert.ok(result.localPath, "⭐ 降级时**必须**给出本地路径 —— 否则用户粘贴的图就没了");
		assert.equal(result.error?.kind, "auth", "应把失败归为鉴权问题");
		assert.equal(h.server.countByMethod("PUT"), 1, "403 不可重试 → 只应发 1 次请求");

		const kept = await h.read(result.localPath);
		assert.ok(kept, `降级的副本必须真的在磁盘上：${result.localPath}`);
		assert.equal(Buffer.compare(kept, Buffer.from(HOSTILE_BYTES)), 0, "降级副本必须与原始字节逐字节一致");

		// 降级时副本留在附件目录（而不是缓存目录）—— 缓存是"可随时删除"的，
		// 把用户唯一的副本放进会被清掉的地方等于埋雷。
		assert.equal(
			result.localPath.includes("_attachment-cache"),
			false,
			"降级副本不应落在缓存目录里（缓存被清理时用户就真的丢了）"
		);

		// 索引不该登记一条没上传成功的记录（否则渲染时会以为远端有这个对象）
		assert.equal(h.index.get(result.key), undefined, "上传失败不得登记索引");

		// 附件目录里确实有那个文件
		assert.equal(await h.exists(result.localPath), true, "附件目录里应有那个文件");
	});

	// 降级路径也要能重试成功（用户改好设置后再粘一次）
	await withHarness(mod, {}, async (h) => {
		const bad = await ingestAttachment(
			{ ...h.deps, client: makeFailingClient(mod, h, 500) },
			{ bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" }
		);
		assert.equal(bad.status, "fallback", "先制造一次失败");
		assert.ok(await h.exists(bad.localPath), "失败后本地有副本");
		const before = h.server.countByMethod("PUT");

		const good = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(good.status, "uploaded", "换回可用客户端后应成功");
		assert.ok(h.server.countByMethod("PUT") > before, "应真的发了 PUT");
		assert.ok(await h.exists(good.localPath), "成功后缓存里有副本");
	});

	// ============================================================
	// 5. ⭐ 同名文件绝不覆盖
	// ============================================================
	// 这是本项目里少数会造成**不可逆**损失的操作：粘贴时若允许覆盖，
	// 用户可能抹掉一个同名的、完全无关的、没有其它副本的文件。
	await withHarness(mod, { settings: { localCopy: "keep" } }, async (h) => {
		const original = Buffer.from("这是我原本就有的文件，绝不能被覆盖");
		await h.write("photo.png", original);

		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });

		assert.equal(result.status, "uploaded");
		assert.notEqual(result.localPath, "photo.png", "目标已占用时必须另取名字，不得覆盖");
		assert.equal(result.localPath, "photo 1.png", "同名策略应是加序号（与宿主自己的行为一致）");

		assert.equal(
			Buffer.compare(await h.read("photo.png"), original),
			0,
			"⭐ 已存在的同名文件必须**原封不动**"
		);
		assert.equal(
			Buffer.compare(await h.read("photo 1.png"), Buffer.from(HOSTILE_BYTES)),
			0,
			"新文件应写到另取的名字下，且内容正确"
		);

		// 再来一次 → 应拿 2
		const again = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "photo.png", mime: "image/png" });
		assert.equal(again.status, "reused", "同样的内容第二次应命中索引复用");
		assert.equal(again.localPath, "photo 1.png", "复用的应是上次那份");
		assert.equal(Buffer.compare(await h.read("photo.png"), original), 0, "原文件仍然不能被动到");
	});

	// ============================================================
	// 6. localCopy = keep → 副本留在附件目录，索引指向它（1.2.0 起这是**唯一**的保留形态）
	// ============================================================
	await withHarness(mod, { settings: { localCopy: "keep" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "keep-me.png", mime: "image/png" });
		assert.equal(result.status, "uploaded");
		assert.equal(result.localPath, "keep-me.png", "原地保留就该留在附件目录");
		assert.equal(
			result.localPath.includes("_attachment-cache"),
			false,
			"选「原地保留」时不该往缓存目录里搬"
		);
		assert.ok(await h.exists("keep-me.png"), "文件应真的在那里");
		// 原先是单独一条用例（`cacheEnabled = false` → 原地保留、不建缓存目录）。
		// 那个状态**已经不存在了**：它正是"选了移入缓存却得到原地保留"这个静默矛盾的来源，
		// 合并成单个 `localCopy` 之后，`keep` 是表达"原地保留"的唯一方式。
		// 所以这里把那条断言收进来，而不是让一个已删除的状态继续留在测试里。
		assert.equal(await h.exists("_attachment-cache"), false, "原地保留时不该建出缓存目录");
		assert.equal(
			h.index.get(result.key)?.cachePath,
			"keep-me.png",
			"⭐ 索引要记录**真实**位置 —— 否则离线渲染按 key 推导出的缓存路径会找不到文件"
		);
	});

	// ============================================================
	// 7. localCopy = trash → 不留本地副本；**但台账照记**
	// ============================================================
	await withHarness(mod, { settings: { localCopy: "trash" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "temp.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "即使不留本地副本，上传本身要成功");
		assert.equal(result.localPath, "", "回收站处置后本地没有副本");
		assert.equal(await h.exists("temp.png"), false, "暂存的文件应已被移入回收站");
		assert.equal(
			h.index.get(result.key),
			undefined,
			"没有本地副本时不该登记索引（索引的用途是「按 URL 找本地副本」）"
		);
		// ⭐⭐ 这一档**必须**写上传台账 —— 它就是 N11 的现场。
		//
		// 云端清理的自动入口靠"这个 key 是我们经手过的吗"认领对象，而它原先借的是
		// **索引条目**；这一档没有副本 ⇒ 没有条目 ⇒ 借条目的判据在这一档对**所有**对象
		// 答"不是我们的" ⇒ 那个询问在该档**一次都不出现**（而这一档正是"只当图床用"
		// 的人，云端只增不减，最需要它）。台账与副本无关，所以它必须在这里被写上。
		assert.equal(
			h.index.wasUploaded(result.key),
			true,
			"⭐ 不留副本这一档也要记台账 —— 否则云端清理的自动入口在该档永不出现（N11）"
		);
	});

	// ============================================================
	// 8.（已删除）原「cacheEnabled = false → 原地保留」用例
	//
	// 那个状态随参数重设计一起消失了：`cacheEnabled` 与 `localFileAction` 不正交，
	// 二者能组成"选了移入缓存却得到原地保留"的静默矛盾，所以合并成了单个 `localCopy`。
	// 它唯一独有的断言（不建缓存目录）已并入上面的 `localCopy = keep` 用例。
	// 这里保留说明而不是留一个测不到东西的空壳 —— 空壳测试比没有测试更糟，
	// 它会让人以为那个状态仍然存在。
	// ============================================================

	// ============================================================
	// 9. ~~嵌套 key（`{date}/…`）~~
	// ============================================================
	//
	// ⚠️ 这一节随 1.2.0 **删掉了**：key 形状固定成 `<原名>-<哈希>.<扩展名>`，
	// 里面**不可能再有目录分隔符**，于是"带目录的 key / 按需建出中间层"这个主题
	// 整体消失了。留一条跑不到的用例，比没有用例更糟：它会让人以为那个能力还在
	//（死主题的断言永远绿，而且改坏了也没人知道）。
	//
	// ⚠️ 顺带如实记一条**能力损失**：从前用户可以靠 `{date}/…`、`{hash2}/…` 在桶里
	// 分层组织对象，现在没有了。要换回来只能重新引入模板 —— 而模板正是
	// "不含完整哈希 ⇒ 静默串内容"那条事故的来源，取舍已经做过。
	//
	// `sanitizeKey` 本身保留（key 的最后一道闸门）：即使上游哪一步漏了分隔符清洗，
	// 它也保证不产出危险 key。它的断言在 `object-key` 套件里。

	// ============================================================
	// 10. 截图粘贴：没有文件名，靠 MIME 推扩展名
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, mime: "image/png" });
		assert.equal(result.status, "uploaded");
		assert.ok(result.key.endsWith(".png"), `无文件名时应由 MIME 推出扩展名，实际 key=${result.key}`);
		assert.ok(
			h.index.get(result.key)?.sourceName.includes("Pasted image"),
			"无文件名时应造一个可读的名字，方便用户在附件目录里辨认"
		);
		assert.ok(await h.exists(result.localPath), "副本应落盘");
	});

	// ============================================================
	// 10b. ⭐ 名字里那段"扩展名"不是真扩展名时，落盘名要补上真实类型
	//
	// 1.2.0（D-17）之后，**落地的那份名字就是最终名字**（不再有"按 key 重命名"那一步）。
	// 而 Obsidian 按名字判断怎么显示一个附件：名字没有类型 ⇒ 缓存明明成功了，
	// 用户却看不到图，以为"没缓存"。站外图片的 URL 尾巴正是这种名字
	// （`OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA`）。
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const urlTail = "OIP-C.sPb8lvTxu-zlEqgEmUgCTwAAAA";
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: urlTail, mime: "image/png" });

		assert.equal(result.status, "uploaded");
		assert.equal(result.localPath, "OIP-C.png", "名字里那段令牌不是扩展名 ⇒ 去掉它、换成真实类型");
		assert.equal(await h.exists(result.localPath), true, "那份副本要真的落盘");
		// ⚠️ 链接的显示名**保持原样**（用户认的是它，不该被我们改）
		assert.equal(result.name, urlTail, "显示的原始文件名不该被改动（只有落盘名补类型）");
	});

	// 反向守护：名字本来就带正常扩展名 ⇒ **一个字符都不许动**
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "我的 照片.png", mime: "image/png" });
		assert.equal(result.localPath, "我的 照片.png", "名字里的扩展名正常时不要动它（用户起的名字优先）");
	});

	// ============================================================
	// 11. ⭐ 扩展名完全未知：不得产出以点结尾的 key
	//
	// `{hash}.{ext}` 在 ext 为空时会渲染成 `abc.` —— Windows **会静默丢掉结尾的点**，
	// 于是同一个 key 在 Windows 上变成 `abc`、在别处还是 `abc.`：
	// 缓存文件名与索引记录对不上，且只在部分平台上出现。
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, mime: "application/octet-stream" });
		assert.equal(result.status, "uploaded");
		assert.ok(!result.key.endsWith("."), `key 不得以点结尾（Windows 会丢掉它）：${result.key}`);
		assert.ok(result.key.endsWith(".bin"), `未知类型应兜底成 .bin，实际 ${result.key}`);
		assert.ok(!result.localPath.endsWith("."), "缓存路径同样不得以点结尾");
		// 无扩展名可推时，Content-Type 应是通用二进制类型
		assert.equal(
			h.server.requests[0].headers["content-type"],
			"application/octet-stream",
			"未知类型应声明通用二进制类型"
		);
	});

	// ============================================================
	// 12. publicUrlBase 改了 → 不能复用旧 URL，必须重新上传并更新记录
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const first = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "a.png", mime: "image/png" });
		assert.equal(first.status, "uploaded");
		assert.equal(h.server.countByMethod("PUT"), 1);

		// 用户换了公开域名（例如从直连桶改成挂 CDN）
		const movedClient = new mod.S3Client(
			{
				endpoint: h.endpoint,
				region: "auto",
				bucket: BUCKET,
				accessKeyId: ACCESS_KEY_ID,
				secretAccessKey: SECRET_ACCESS_KEY,
				forcePathStyle: true,
				publicUrlBase: "https://img.example.com",
			},
			{ transport: nodeTransport(), now: () => FIXED_NOW, sleep: async () => {} }
		);
		h.deps.settings.s3.publicUrlBase = "https://img.example.com";

		const second = await ingestAttachment({ ...h.deps, client: movedClient }, {
			bytes: HOSTILE_BYTES,
			name: "a.png",
			mime: "image/png",
		});
		assert.ok(
			second.status === "uploaded" || second.status === "reused",
			`换了公开域名后不应沿用旧 URL，实际状态 ${second.status}`
		);
		assert.equal(
			second.remoteUrl,
			`https://img.example.com/${first.key}`,
			"应使用新的公开地址"
		);
		assert.equal(
			h.index.get(first.key)?.remoteUrl,
			`https://img.example.com/${first.key}`,
			"索引里的 URL 必须同步更新，否则渲染时会按旧域名找不到"
		);
	});

	// ============================================================
	// 13. 索引落盘失败：上传仍算成功，但必须**说出来**
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		h.setPersistError(new Error("磁盘只读"));
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "b.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "索引存不上不该让上传算失败（URL 已经能用了）");
		assert.equal(h.server.countByMethod("PUT"), 1);
		assert.ok(await h.exists(result.localPath), "缓存副本仍然应落盘");
		assert.ok(
			h.notices.some((message) => message === "ingestIndexPersistFailed"),
			`索引保存失败必须让用户知道，实际提示：${JSON.stringify(h.notices)}`
		);
	});

	// ============================================================
	// 14. 老设置里 `cacheFolder` 为空/留着旧值时，行为**完全不受影响**
	//
	// 1.2.0 之前这是一个真实的分支（"缓存路径推不出来 ⇒ 降级为原地保留"）。
	// 现在没有任何路径依赖它 —— 这条用例保留下来，钉住"残留的旧设置值不会改变行为"。
	// ============================================================
	await withHarness(mod, { settings: { cacheFolder: "" } }, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "c.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "旧设置值不该让上传失败");
		assert.equal(result.localPath, "c.png", "副本仍落在附件目录");
		assert.ok(await h.exists("c.png"), "文件应留在附件目录");
	});

	// ============================================================
	// 15. 空的字节数组不能崩（粘贴到空内容 / 上游出了岔子）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const result = await ingestAttachment(h.deps, { bytes: new Uint8Array(0), name: "empty.png", mime: "image/png" });
		assert.equal(result.status, "uploaded", "零字节也应能走完流程而不抛错");
		assert.equal(result.localPath.length > 0, true, "零字节也该有个本地路径");
		assert.ok(await h.exists(result.localPath), "零字节文件应真的落盘");
	});

	// ============================================================
	// 16. 索引持久化（真实适配器 + 真实磁盘）
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		const adapter = h.app.vault.adapter;
		const path = mod.indexFilePath(".obsidian/plugins/attachment-cloud-cache");

		// 16a. 文件不存在 → 空索引，且**不算错误**（首次运行是正常状态）
		const missing = await mod.loadCacheIndex(adapter, path);
		assert.equal(missing.existed, false, "首次运行时应报告文件不存在");
		assert.equal(missing.error, "", "文件不存在不是错误");
		assert.equal(missing.index.size, 0);

		// 16b. 存 → 读 往返
		const index = new mod.CacheIndex();
		index.set({
			key: "a.png",
			cachePath: "_attachment-cache/a.png",
			remoteUrl: "https://img.example.com/a.png",
			size: 12,
			contentType: "image/png",
			etag: "abc",
			uploadedAt: FIXED_NOW.toISOString(),
			// 刚写下的副本就是"刚被用到"的（缓存轮换靠这个时间排序）
			lastUsedAt: FIXED_NOW.getTime(),
			sourceName: "a.png",
		});
		await mod.saveCacheIndex(adapter, path, index);

		const reloaded = await mod.loadCacheIndex(adapter, path);
		assert.equal(reloaded.error, "", "刚写出的索引应能无错读回");
		assert.equal(reloaded.skipped.length, 0);
		assert.deepEqual(reloaded.index.get("a.png"), index.get("a.png"), "往返后条目应完全一致");
		// 临时文件不得残留
		assert.equal(await h.exists(`${path}.tmp`), false, "原子写入用的临时文件不应残留");

		// 16c. 坏 JSON → 空索引 + 记录原因，绝不抛错（抛错会让插件在启动时挂掉）
		await h.write(path, "{ 这不是合法 JSON");
		const broken = await mod.loadCacheIndex(adapter, path);
		assert.equal(broken.index.size, 0, "坏 JSON 应降级为空索引");
		assert.ok(broken.error.includes("JSON"), `应记录解析失败的原因，实际：${broken.error}`);

		// 16d. 结构合法但条目半坏 → 坏条目丢弃并计数，好条目保留
		await h.write(
			path,
			JSON.stringify({
				version: 1,
				entries: [
					{ key: "good.png", cachePath: "c/good.png" },
					{ key: "no-path.png" },
					{ cachePath: "c/no-key.png" },
					"完全不是对象",
					{ key: "good.png", cachePath: "c/duplicate.png" },
				],
			})
		);
		const partial = await mod.loadCacheIndex(adapter, path);
		assert.equal(partial.index.size, 1, "只应保留唯一那条完整记录");
		assert.ok(partial.index.get("good.png"), "完整的那条应保留");
		assert.equal(partial.index.get("good.png").cachePath, "c/good.png", "重复 key 应保留**先出现**的那条");
		assert.equal(partial.skipped.length, 4, `应记录 4 条被丢弃的条目，实际 ${partial.skipped.length}`);
		assert.ok(
			partial.skipped.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0),
			"每条被丢弃的记录都要给出原因（沉默丢弃等于把问题藏起来）"
		);
	});

	// 16e. 索引文件路径
	assert.equal(
		mod.indexFilePath(".obsidian/plugins/attachment-cloud-cache"),
		".obsidian/plugins/attachment-cloud-cache/.cache-index.json",
		"索引应放在插件目录下（缓存是每设备独立的，跟着 vault 同步会造成跨设备路径错乱）"
	);
	assert.equal(mod.indexFilePath(""), ".cache-index.json", "目录为空时应退化到相对路径而不是抛错");

	// ============================================================
	// 17. ⭐⭐ 落点：跟随**宿主自己**的附件位置
	//
	// ⚠️ 2026-10-12（D-20）：这一节原本守的是「设置里的『附件目录覆盖』必须**真的覆盖**宿主」。
	// 那个设置项是围着已取消的缓存目录设的，随它一并删除 ⇒ 落点只剩"跟随宿主"一个答案。
	// 保留的几条守的是"跟随"本身，含宿主的 `./`（与笔记同目录）与 `/`（= 没指定）两种写法。
	// ============================================================
	await withHarness(
		mod,
		{ settings: { localCopy: "keep" }, hostAttachmentFolder: "host-attach" },
		async (h) => {
			const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "shot.png", mime: "image/png" });
			assert.equal(result.localPath, "host-attach/shot.png", "应跟随宿主的附件设置");
		}
	);

	// 17c. 宿主设置是 `"./"` —— Obsidian 用它表示「与当前笔记同目录」，是个**相对**写法，
	// 所以要按触发这次粘贴的笔记路径反推，而不是当成一个叫 `.` 的目录。
	await withHarness(
		mod,
		{ settings: { localCopy: "keep" }, hostAttachmentFolder: "./" },
		async (h) => {
			const result = await ingestAttachment(h.deps, {
				bytes: HOSTILE_BYTES,
				name: "shot.png",
				mime: "image/png",
				sourcePath: "notes/我的笔记.md",
			});
			assert.equal(result.localPath, "notes/shot.png", "宿主设成「与笔记同目录」时应落在笔记旁边");
		}
	);

	// 17d. 宿主设置是 `"/"` —— Obsidian 用它与空串表示同一件事（vault 根目录）。
	// ⚠️ 这一条与使用者直接相关：那一栏填 `/` 同样必须被理解成"没指定目录"，
	// 而不是一个叫 `/` 的目录。
	await withHarness(
		mod,
		{ settings: { localCopy: "keep" }, hostAttachmentFolder: "/" },
		async (h) => {
			const result = await ingestAttachment(h.deps, { bytes: HOSTILE_BYTES, name: "shot.png", mime: "image/png" });
			assert.equal(result.localPath, "shot.png", "宿主设成根目录时应落在 vault 根目录");
		}
	);

	// ============================================================
	// 18. ⭐⭐ 迁移已有附件（`existingPath`）：不落中转副本；上传成功后**也不搬动它**
	//
	// 批量上传时调用方直接把"库里那个文件"指出来。此时若仍走"先落盘再上传"，
	// 附件目录里就会凭空多出一个 `existing 1.png`（原文件占着名字 ⇒ 另取序号）。
	//
	// ⭐ 1.2.0（D-17）：上传成功后那个文件**留在原处**，它本身就是本地副本 ——
	// 索引按真实路径记下它。调用方仍然只把"确实被笔记引用着"的文件交进来
	// （`selectUploadCandidates` 的 `referencedPaths`）：那些引用会被同一条命令
	// 改写成远端地址，而文件留在原处正是我们要的结果。
	// ============================================================
	await withHarness(mod, {}, async (h) => {
		await h.write("existing.png", Buffer.from(HOSTILE_BYTES));

		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "existing.png",
			sourcePath: "existing.png",
			existingPath: "existing.png",
		});

		assert.equal(result.status, "uploaded");
		// ⚠️ 光看"最后有没有残留"不够：那份中转副本从前会被搬进缓存，
		// 于是"凭空多一个文件"在最终状态里看不出来 —— 但它真的发生过
		// （一次多余的整块写入、一次 create 事件、一次同步噪音，而用户看到的
		//  正是"上传时附件目录不停冒出新文件"）。所以要直接查**写盘动作**。
		assert.equal(
			h.appCalls.writes.includes("existing 1.png"),
			false,
			"⭐ 迁移模式不得在附件目录里写中转副本（哪怕只是短暂写一次）"
		);
		// ⚠️ 这条存在性断言**必须排在字节读取之前**：文件万一不在了时 `h.read` 返回 null，
		// 而 `Buffer.compare(null, …)` 抛的是一个与规则无关的 TypeError ——
		// 变异验证会因此判成"原因不符"（红得对，但看不出为什么红）。
		assert.equal(await h.exists("existing.png"), true, "⭐ 迁移模式下那个文件留在原处（它就是本地副本）");
		assert.equal(await h.exists("existing 1.png"), false, "⭐ 不得在附件目录里凭空多出一份中转副本");
		assert.equal(result.localPath, "existing.png", "本地路径就是那个仍然存在的文件");
		assert.equal(
			Buffer.compare(await h.read(result.localPath), Buffer.from(HOSTILE_BYTES)),
			0,
			"那份文件的字节应与原件一致"
		);
		assert.equal(h.index.get(result.key)?.cachePath, result.localPath, "索引应指向那份真实存在的文件");
	});

	// 18b. 迁移 + 「原地保留」→ 原文件本身就是本地副本，不该再写第二份
	await withHarness(mod, { settings: { localCopy: "keep" } }, async (h) => {
		await h.write("keep.png", Buffer.from(HOSTILE_BYTES));

		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "keep.png",
			existingPath: "keep.png",
		});

		assert.equal(result.status, "uploaded");
		assert.equal(result.localPath, "keep.png", "原地保留时本地副本就是原文件本身");
		assert.equal(await h.exists("keep 1.png"), false, "⭐ 不得凭空多写一份副本");
		assert.equal(h.index.get(result.key)?.cachePath, "keep.png", "索引应指向那份真实存在的文件");
	});

	// 18c. ⭐ 迁移 + 「不留本地副本」→ 绝不删用户的原件
	//
	// `trash` 在这里被**降级为原地保留**：用户要求的是"别为我留副本"，
	// 而那个文件不是我们的副本，是他的资产 —— 删它超出了他的授权范围。
	// 索引仍登记它（那是一条**真实存在**的路径）—— 自愈只改索引、不碰文件，
	// 所以不会与任何清理类动作冲突。
	await withHarness(mod, { settings: { localCopy: "trash" } }, async (h) => {
		await h.write("mine.png", Buffer.from(HOSTILE_BYTES));

		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "mine.png",
			existingPath: "mine.png",
		});

		assert.equal(result.status, "uploaded");
		assert.equal(
			await h.exists("mine.png"),
			true,
			"⭐ 用户的原件绝不能被回收站处置 —— trash 在迁移模式下降级为原地保留"
		);
		assert.equal(result.localPath, "mine.png", "本地路径指向那个仍然存在的文件");
		assert.equal(await h.exists("_attachment-cache"), false, "不留副本就不该建出缓存目录");
	});

	// 18d. 迁移 + 上传失败 → 原文件在，且**一个中转垃圾都不留**
	await withHarness(mod, { s3: { intercept: () => ({ status: 403, code: "AccessDenied" }) } }, async (h) => {
		await h.write("fail.png", Buffer.from(HOSTILE_BYTES));

		const result = await ingestAttachment(h.deps, {
			bytes: HOSTILE_BYTES,
			name: "fail.png",
			existingPath: "fail.png",
		});

		assert.equal(result.status, "fallback");
		assert.equal(result.localPath, "fail.png", "失败时本地路径应是那个**原本就存在**的文件");
		assert.equal(await h.exists("fail.png"), true, "原文件当然还在");
		assert.equal(await h.exists("fail 1.png"), false, "⭐ 迁移失败时更不该多出任何文件");
		assert.equal(h.index.get(result.key), undefined, "上传失败不得登记索引");
	});

	// 18e. 迁移重复一次 → 命中索引复用（护栏：新路径不该把幂等性弄坏）
	await withHarness(mod, {}, async (h) => {
		await h.write("dup.png", Buffer.from(HOSTILE_BYTES));
		const request = { bytes: HOSTILE_BYTES, name: "dup.png", existingPath: "dup.png" };

		const first = await ingestAttachment(h.deps, request);
		const second = await ingestAttachment(h.deps, request);

		assert.equal(second.status, "reused", "同一份内容第二次应复用");
		assert.equal(second.localPath, first.localPath);
		assert.equal(h.server.countByMethod("PUT"), 1, "复用时不得再上传");
	});

	return { scenarios: 18 };
}

/** 造一个"总是失败"的客户端，用来构造降级路径。 */
function makeFailingClient(mod, harness, status) {
	const base = nodeTransport();
	return new mod.S3Client(
		{
			endpoint: harness.endpoint,
			region: "auto",
			bucket: BUCKET,
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			forcePathStyle: true,
		},
		{
			transport: async (request) => {
				// 先让真实服务端收下（签名校验照跑），再强行改写成失败响应，
				// 这样失败是"真的经过了网络"，不是凭空造的
				const response = await base(request);
				return { ...response, status, body: new TextEncoder().encode("<Error><Code>InternalError</Code></Error>") };
			},
			now: () => FIXED_NOW,
			sleep: async () => {},
			maxAttempts: 1,
		}
	);
}
