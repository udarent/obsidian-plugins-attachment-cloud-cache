/**
 * 回退下载（`src/core/download.ts`）的断言套件。
 *
 * ## 为什么必须用真实 HTTP + 真实磁盘
 *
 * 这一层要保证的性质没有一条能在 mock 层面成立：
 * - 「字节逐字节落到磁盘」→ 必须真读那个文件；
 * - 「一屏里同一张图只发一次 GET」→ 必须**数真实请求**；
 * - 「绝不覆盖已有文件」→ 必须真的有一个同名文件在那里；
 * - 「失败时不留半个文件」→ 必须真的去 `stat`。
 *
 * ## 边界比功能更重要
 *
 * 这一层是**唯一**会把远端字节写进用户 vault 的地方。所以除了"能下载"，
 * 还要断言：站外图**拒绝**、并发只下一次、同名不覆盖、离线失败不打扰用户。
 *
 * ## ⭐ 1.2.0（D-17）：落点从"缓存目录 / key 镜像"改成"附件目录 / 原始文件名"
 *
 * 从前下载的目标是 `cachePathFor(key)`（缓存目录 + key），于是断言里到处是
 * `_attachment-cache/<key>`。缓存目录取消之后，副本落在**附件目录**、
 * 名字取**原始文件名**（三级兜底见 `download-target.ts`），撞名先比内容哈希、
 * 再按 `名字 1.ext` 加序号 —— 断言因此整体换了形状。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppMock } from "./mock-obsidian.mjs";
import { createMockS3, nodeTransport } from "./mock-s3.mjs";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const BUCKET = "download-bucket";
const NOW = new Date("2026-10-06T12:00:00Z");

/** 刻意含 0x00 / 0xFF / 非法 UTF-8：文本通道会改掉这些字节。 */
const HOSTILE_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a, 0x7f, 0xed, 0xfd,
]);

const sha256Hex = (bytes) => createHash("sha256").update(Buffer.from(bytes)).digest("hex");

export async function runDownloadSuite(mod) {
	const { createLocalCopyEnsurer, shouldReportDownloadFailure } = mod;
	const { CacheIndex } = mod;

	// ============================================================
	// 0. 「该不该打扰用户」—— 纯函数先穷举
	//
	// 这条规则写反的两种后果都不好：把离线当故障 → 断网时刷屏；
	// 把配置错静默掉 → 用户永远查不出配错了。
	// ============================================================
	const errorOf = (kind) => Object.assign(new Error(`模拟 ${kind}`), { kind });

	for (const kind of ["network", "throttled", "server"]) {
		assert.equal(
			shouldReportDownloadFailure(errorOf(kind)),
			false,
			`${kind} 属于"此刻用户做不了什么"（离线/临时故障）→ 应静默，否则离线时会被刷屏`
		);
	}
	for (const kind of ["auth", "notFound", "client", "unknown"]) {
		assert.equal(shouldReportDownloadFailure(errorOf(kind)), true, `${kind} 说明配置有问题 → 应提示`);
	}
	// 不认识的错误（不是 S3Error）宁可说出来
	assert.equal(shouldReportDownloadFailure(new Error("随便什么")), true, "不认识的错误应提示");
	assert.equal(shouldReportDownloadFailure(null), true, "null 也应提示（宁可多说）");
	assert.equal(shouldReportDownloadFailure("字符串"), true, "非对象也应提示");

	// ============================================================
	// 搭一个完整环境：真实 HTTP 服务 + 真实磁盘上的 vault
	// ============================================================
	async function makeHarness(options = {}) {
		const root = await mkdtemp(join(tmpdir(), "acc-download-"));
		const harness = createAppMock(root);
		const app = harness.app;

		// 故障注入：mock 的 `intercept` 在创建时给定，所以用闭包里的可变标志
		// 来实现"只让**下一次**请求失败"（用来构造 403 / 5xx 场景）。
		let pendingInject = null;
		const server = createMockS3({
			accessKeyId: ACCESS_KEY_ID,
			secretAccessKey: SECRET_ACCESS_KEY,
			region: "auto",
			bucket: BUCKET,
			intercept: () => {
				const injected = pendingInject;
				pendingInject = null;
				return injected;
			},
		});
		const endpoint = await server.start();
		const transport = nodeTransport();
		const client = new mod.S3Client(
			{
				endpoint,
				region: "auto",
				bucket: BUCKET,
				accessKeyId: ACCESS_KEY_ID,
				secretAccessKey: SECRET_ACCESS_KEY,
				forcePathStyle: true,
			},
			{ transport, now: () => NOW, sleep: async () => {} }
		);

		const settings = {
			autoUpload: true,
			enabledExtensions: ["png"],
			localCopy: "cache",
			fallbackDownload: true,
			s3: {
				endpoint,
				region: "auto",
				bucket: BUCKET,
				publicUrlBase: `${endpoint}/${BUCKET}`,
				accessKeyId: "",
				secretAccessKeyRef: "",
				forcePathStyle: true,
			},
			...options.settings,
		};

		const index = new CacheIndex();
		const notices = [];
		const staged = [];
		/** 登记自写台账那一刻，目标文件**是否已经存在**（用来钉住"写之前登记"）。 */
		let existedWhenStaged = null;
		let persistCount = 0;

		const ensure = createLocalCopyEnsurer({
			app,
			settings: () => settings,
			// 未配置凭据时宿主拿不到客户端（）
			client: () => (options.noClient ? null : client),
			index: () => index,
			persistIndex: async () => {
				persistCount += 1;
			},
			notify: (message) => notices.push(message),
			// ⚠️ 文案键在这层选、文字由接线层给（见 `src/notify-user.ts`）。这里把键名当文案，
			// 断言于是**与语言无关** —— 原先断言里那半句中文，正是核心层硬编码兜底留下的痕迹。
			t: (key) => key,
			now: () => NOW,
			onStaged: (path) => {
				staged.push(path);
				// ⭐ 顺序判据：登记这一刻文件还**不该**存在（写之前登记）——
				// 反过来的话，宿主的 create 事件会先于台账到达，自动接管那条链就会
				// 把这份副本当成"用户新加的附件"再上传一遍。
				existedWhenStaged = existsSync(join(root, ...path.split("/")));
			},
		});

		return {
			root,
			app,
			server,
			endpoint,
			client,
			settings,
			index,
			notices,
			ensure,
			persistCount: () => persistCount,
			staged,
			existedWhenStaged: () => existedWhenStaged,
			urlFor: (key) => `${settings.s3.publicUrlBase}/${key}`,
			/** 往 mock 服务端放一个对象（模拟"远端已经有这张图"）。 */
			putObject: (key, bytes, contentType = "image/png") => {
				server.objects.set(key, { body: Buffer.from(bytes), contentType });
			},
			/** 让**下一次**请求失败（403 / 5xx 等）。 */
			injectOnce: (response) => {
				pendingInject = response;
			},
			close: async () => {
				await server.close();
				await rm(root, { recursive: true, force: true });
			},
		};
	}

	// ============================================================
	// 1. 正常下载：字节逐字节落盘 + 登记索引 + 落盘索引
	// ============================================================
	{
		const h = await makeHarness();
		try {
			// C2 形状的 key：名字 + 完整哈希尾 ⇒ 反推得出原始文件名
			const key = `obj-a-${sha256Hex(HOSTILE_BYTES)}.png`;
			h.putObject(key, HOSTILE_BYTES, "image/png");

			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "downloaded", "应下载成功");
			// ⭐ 1.2.0：落点是**附件目录**（这里宿主没配 ⇒ vault 根），
			// 名字由 `displayNameForKey` 从 key 反推 = `obj-a.png`
			assert.equal(outcome.localPath, "obj-a.png", "副本应落在附件目录，并用 key 里携带的原始文件名");

			const onDisk = await readFile(join(h.root, outcome.localPath));
			assert.deepEqual(
				new Uint8Array(onDisk),
				HOSTILE_BYTES,
				"★ 落盘字节必须逐字节一致（文本通道会改掉 0x00/0xFF）"
			);

			const entry = h.index.get(key);
			assert.ok(entry, "应登记索引");
			assert.equal(entry.cachePath, outcome.localPath, "索引要记**真实**路径");
			assert.equal(entry.size, HOSTILE_BYTES.length);
			assert.equal(entry.remoteUrl, h.urlFor(key), "索引要记下远端地址（渲染时按它反查）");
			assert.equal(h.persistCount(), 1, "索引改动后应落盘一次");
			assert.equal(h.notices.length, 0, "成功时不该打扰用户");
			assert.equal(h.server.countByMethod("GET"), 1, "应恰好 1 次 GET");
			// ⭐ 落盘前必须登记进**自写台账**（与粘贴那条路共用）：那份文件同样会触发
			// 宿主的 create 事件，而自动接管那条链靠这本台账认出"这是我们自己写的"。
			assert.deepEqual(h.staged, ["obj-a.png"], "下载落盘前必须登记自写台账（否则副本会被当成新附件再传一遍）");
			assert.equal(h.existedWhenStaged(), false, "台账要在**写之前**登记（顺序反了等于没登记）");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 1b. C2 之前的老对象（key 是纯哈希）→ 第三级兜底：名字就是 key 本身
	//
	// 那种 key 里**没有**名字可反推，而"绝不硬猜"是刻意的：与其编一个名字，
	// 不如如实用哈希名 —— 用户至少能靠它在云端/本地一一对应。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = `${sha256Hex(HOSTILE_BYTES)}.png`;
			h.putObject(key, HOSTILE_BYTES, "image/png");

			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "downloaded", "老 key 也要能补回副本");
			assert.equal(outcome.localPath, key, "没有名字可反推时应如实用 key 当文件名（绝不硬猜）");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 2. ⭐ 并发去重：同一个 key 同时请求 N 次，只发 1 次 GET
	//
	// 场景很常见：同一张图被一屏里的多个 <img> 引用，
	// 而渲染钩子对**每一个**元素各调用一次。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = `concurrent-${sha256Hex(HOSTILE_BYTES)}.png`;
			h.putObject(key, HOSTILE_BYTES, "image/png");

			const results = await Promise.all([
				h.ensure(key, h.urlFor(key)),
				h.ensure(key, h.urlFor(key)),
				h.ensure(key, h.urlFor(key)),
				h.ensure(key, h.urlFor(key)),
			]);

			assert.equal(h.server.countByMethod("GET"), 1, "★ 并发只该发 1 次 GET（4 张图共用一份字节）");
			for (const result of results) {
				assert.equal(result.status, "downloaded", "四次调用都该拿到成功结果");
				assert.equal(result.localPath, "concurrent.png", "四次都该指向同一个副本");
			}
			assert.equal(h.index.size, 1, "索引里只该有一条");

			// 下载完之后再调用 → 走"本地已有"，零网络
			const again = await h.ensure(key, h.urlFor(key));
			assert.equal(again.status, "reused", "本地已有 → 复用");
			assert.equal(h.server.countByMethod("GET"), 1, "复用不该再发请求");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 3. ⭐ 失败之后必须**能重试**（去重表的摘除要发生在失败路径上）
	//
	// 若用 `.then` 而不是 `.finally` 摘除，一次失败会让这个 key
	// **永远**被判为"正在下载" —— 表现为"这张图再也下载不了了"，且不报错。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = "retry.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");

			// 第一次：指向一个不存在的 key → 404 失败
			const failed = await h.ensure("missing-key.png", h.urlFor("missing-key.png"));
			assert.equal(failed.status, "failed", "远端没有这个对象时应失败");

			// 第二次：同一个 key 但这次远端有 → 必须真的再试一次
			h.putObject("missing-key.png", HOSTILE_BYTES, "image/png");
			const retried = await h.ensure("missing-key.png", h.urlFor("missing-key.png"));
			assert.equal(retried.status, "downloaded", "★ 失败后必须能重试（去重表要在失败时也摘掉）");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 4. ⭐ 站外 URL 一律拒绝（红线：站外图永不下载）
	//
	// 判定侧已经筛过一遍，这一层再验一次：它是唯一会写字节进 vault 的地方。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const outcome = await h.ensure("evil.png", "https://evil.example.net/evil.png");
			assert.equal(outcome.status, "refused", "★ 非本存储的 URL 必须拒绝下载");
			assert.equal(h.server.countByMethod("GET"), 0, "拒绝时一个请求都不该发");
			assert.equal(h.index.size, 0, "拒绝时不该登记索引");

			// 前缀相同但 key 对不上（例如把别人的 key 塞进我们的前缀）也要拒绝
			const mismatched = await h.ensure("a.png", h.urlFor("b.png"));
			assert.equal(mismatched.status, "refused", "★ URL 里的 key 与请求的 key 不一致时必须拒绝");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 5. 关闭回退下载 → 不下载（这是用户的选择，不是失败）
	// ============================================================
	{
		const h = await makeHarness({ settings: { fallbackDownload: false } });
		try {
			const key = "disabled.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");
			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "disabled", "关掉开关时不做任何事");
			assert.equal(h.server.countByMethod("GET"), 0, "关掉开关时不该发请求");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 5b. ⭐ 「不留副本」档 = 关闭缓存 → 不下载（用户的选择，不是失败）
	//
	// 这一层是**唯一**会把远端字节写进用户 vault 的地方。用户选了"不留副本"之后，
	// 若某条别的入口（命令、将来的新调用点）走到这里，那道闸门必须拦住它 ——
	// 否则"离线不可用"的承诺会被静默推翻，而界面上完全看不出来。
	// ============================================================
	{
		const h = await makeHarness({ settings: { localCopy: "trash" } });
		try {
			const key = "cacheoff.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");
			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "disabled", "「不留副本」档下不做任何事");
			assert.equal(h.server.countByMethod("GET"), 0, "★ 这一档绝不能联网（否则用户的选择被悄悄推翻）");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 6. ⭐ 绝不覆盖：目标路径已被占用时另取序号
	//
	// 用户完全可以把 key 模板改成 `{filename}`，那时"同路径"不再等于"同内容"。
	// 覆盖就等于静默抹掉一个可能没有其它副本的文件。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = `occupied-${sha256Hex(HOSTILE_BYTES)}.png`;
			h.putObject(key, HOSTILE_BYTES, "image/png");

			// 预先在**落点**（反推出来的原名）放一个内容不同的同名文件
			const occupiedPath = "occupied.png";
			const precious = Buffer.from("这是用户自己的文件，绝不能被覆盖");
			await writeFile(join(h.root, occupiedPath), precious);

			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "downloaded", "仍应下载成功");
			assert.notEqual(outcome.localPath, occupiedPath, "★ 不得写到已占用的路径上");
			// 序号约定与粘贴落盘那条路一致（`uniqueVaultPath` 用 `名字 1.ext`）
			assert.equal(outcome.localPath, "occupied 1.png", "撞名应另取序号（与粘贴同款约定）");

			const preserved = await readFile(join(h.root, occupiedPath));
			assert.deepEqual(
				new Uint8Array(preserved),
				new Uint8Array(precious),
				"★ 原文件必须一个字节都没被改动"
			);
			assert.deepEqual(
				new Uint8Array(await readFile(join(h.root, outcome.localPath))),
				HOSTILE_BYTES,
				"下载的内容要落在新序号路径上"
			);
			// ⭐ 再下载一次：这次目标仍是 `occupied.png`（被占），而 `occupied 1.png`
			// 已经**是这份内容** ⇒ 复用它，不该再堆一个 `occupied 2.png`
			h.index.remove(key); // 清掉索引，逼它重新走一遍落点判定
			const again = await h.ensure(key, h.urlFor(key));
			assert.equal(again.localPath, "occupied 1.png", "内容相同的那一份应被复用，而不是继续堆序号");
			assert.equal(h.server.countByMethod("GET"), 1, "★ 复用那条路上不该再发 GET");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 7. 老设置 `cacheFolder` 为空/残留值 → 行为**不受任何影响**
	//
	// 1.2.0 之前这是一个真实分支（"缓存目录没配 ⇒ 推不出路径 ⇒ 失败 + 提示"）。
	// 缓存目录取消后，落点由附件设置决定，与它无关 —— 这条用例钉住"旧字段不再参与"。
	// ============================================================
	{
		const h = await makeHarness({ settings: { cacheFolder: "" } });
		try {
			const key = "nocache.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");
			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "downloaded", "旧字段为空也该照常下载（它已不参与落点计算）");
			assert.equal(outcome.localPath, key, "落点仍在附件目录");
			assert.equal(h.notices.length, 0, "成功时不该有任何提示");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 8. 离线（网络不可达）→ 失败但**不打扰用户**
	//
	// 用户此刻就是断网了，弹一堆"下载失败"既无用又惹人烦。
	// ============================================================
	{
		const h = await makeHarness();
		try {
			await h.server.close(); // 服务停掉 ⇒ 网络不可达
			const outcome = await h.ensure("offline.png", h.urlFor("offline.png"));
			assert.equal(outcome.status, "failed", "断网时应失败");
			assert.equal(h.notices.length, 0, "★ 离线失败不该弹提示（那是离线的正常表现）");
			// 也不该留下任何半个文件（落点现在是附件目录 = vault 根）
			await assert.rejects(
				() => stat(join(h.root, "offline.png")),
				"失败时不该留下半个文件"
			);
		} finally {
			await rm(h.root, { recursive: true, force: true });
		}
	}

	// ============================================================
	// 9. 鉴权失败 → 失败且**要提示**（这是配置问题，用户需要知道）
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = "denied.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");
			h.injectOnce({ status: 403, code: "AccessDenied" }); // 让服务端对下一次请求回 403
			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "failed", "被拒时应失败");
			assert.equal(h.notices.length, 1, "★ 鉴权失败要提示（否则用户永远查不出配错了）");
			assert.equal(h.index.size, 0, "失败时不该登记索引");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 9b. 未配置凭据（拿不到客户端）→ 不下载、**不提示**
	//
	// 渲染路径上每张图都会走到这里；逐张弹"未配置"会把界面刷爆，
	// 而这件事在粘贴时与设置页里都已经说过了。
	// ============================================================
	{
		const h = await makeHarness({ noClient: true });
		try {
			const key = "noclient.png";
			h.putObject(key, HOSTILE_BYTES);
			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(
				outcome.status,
				"unavailable",
				"★ 拿不到客户端时应明确是「还没配好」，而不是笼统的 failed"
			);
			assert.equal(h.notices.length, 0, "未配置不该弹提示（渲染时每张图都会走到这里）");
			assert.equal(h.server.countByMethod("GET"), 0, "未配置时不该发请求");
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 10. 空参数不抛错（渲染路径上抛错会毁掉整篇笔记）
	// ============================================================
	{
		const h = await makeHarness();
		try {
			for (const [key, url] of [
				["", h.urlFor("a.png")],
				["a.png", ""],
				[null, h.urlFor("a.png")],
				["a.png", null],
			]) {
				let thrown = null;
				try {
					await h.ensure(key, url);
				} catch (error) {
					thrown = error;
				}
				assert.equal(thrown, null, "空参数不该抛错");
			}
		} finally {
			await h.close();
		}
	}

	// ============================================================
	// 11. 索引里记着但文件已被删 → 重新下载（"缓存被清"这个场景的正解）
	// ============================================================
	{
		const h = await makeHarness();
		try {
			const key = "pruned.png";
			h.putObject(key, HOSTILE_BYTES, "image/png");

			// 索引说本地有，但文件其实不在（用户删掉了那份副本）
			h.index.set({
				key,
				cachePath: "pruned-elsewhere.png",
				remoteUrl: h.urlFor(key),
				size: 999,
				contentType: "image/png",
				etag: "stale",
				uploadedAt: "2026-01-01T00:00:00.000Z",
				sourceName: "",
			});

			const outcome = await h.ensure(key, h.urlFor(key));
			assert.equal(outcome.status, "downloaded", "★ 索引说本地有、但文件不在 → 应重新下载");
			assert.equal(h.server.countByMethod("GET"), 1, "应真的去下载");
			assert.deepEqual(
				new Uint8Array(await readFile(join(h.root, outcome.localPath))),
				HOSTILE_BYTES,
				"重新下载的内容要正确"
			);
			assert.equal(
				h.index.get(key).size,
				HOSTILE_BYTES.length,
				"★ 索引要刷新成真实值（原来的 size:999 是过期数据）"
			);
		} finally {
			await h.close();
		}
	}

	// ⚠️ 自述**不在套件里打印**：套件会被变异验证复用，在那里打印会混进变异输出
	//（而且它自称 "passed" 在变异过程中是错的语义）。入口负责宣告，这里只交出要报的值。
	return { sha256Prefix: sha256Hex(HOSTILE_BYTES).slice(0, 8) };
}
