/**
 * 「统一对象名」（CR-15）在**真实存储**上的端到端验证。
 *
 * ## 为什么需要它（单测证明不了的那一半）
 *
 * `test-migrate-keys` / `test-migrate-flow` 用的是替身客户端：它们能证明"分档与闸门算得对"，
 * 但证明不了三件只有真服务端才回答的事：
 *
 * 1. **`CopyObject` 真的能复制**（`x-amz-copy-source` 的拼法与签名对不对 —— 拼错会回
 *    `SignatureDoesNotMatch` / `InvalidArgument`，而这类的报错完全不指向原因）；
 * 2. **复制后的长度与源一致**（服务端可能按自己的策略处理元数据）；
 * 3. **`DELETE` 之后 `HEAD` 真的是 404**（有的兼容实现对"已删除"的响应不一致）。
 *
 * ## ⚠️ 它会**写远端** —— 但只碰它自己造的那几个 key
 *
 * 一次运行会在指定桶里创建两个对象（一个被笔记引用、一个没人引用），
 * 跑完**删掉它们**（包括复制出来的新对象）。判据是 `planMigration` 只遍历**上传台账**里的
 * key，所以桶里原有的对象**永远不会进候选** —— 但为了万无一失，脚本仍然：
 *
 * - 只接受**显式**给出的一次性桶（`ACC_S3_BUCKET`），不读插件的 `data.json`；
 * - 所有造出来的 key 都带随机段（`acc-e2e-<run>-…`），清理按 key 精确删；
 * - 结束时逐个 `HEAD` 复查"我造的东西一个都不剩"，不剩才算通过。
 *
 * ## 环境变量
 *
 * ```
 * ACC_S3_ENDPOINT=https://minio.example.com
 * ACC_S3_BUCKET=test                  # ← 专用于真机测试的桶
 * ACC_S3_REGION=us-east-1             # 可选（默认 us-east-1，MinIO 一般就这个）
 * ACC_S3_ACCESS_KEY_ID=…
 * ACC_S3_SECRET_ACCESS_KEY=…
 * ACC_S3_PUBLIC_URL_BASE=…            # 可选（配了才会用这个地址拼链接）
 * ACC_S3_FORCE_PATH_STYLE=true        # 可选（默认 true）
 * ```
 *
 * ⚠️ 凭据**只从环境变量读**：真机脚本不去挖宿主的 `secretStorage`（那是另一条链的隐私边界）。
 *
 * ## 它在本地做什么
 *
 * 用一个**临时库目录**（`mkdtemp`）跑真实的 `unifyObjectNames`：笔记是真文件、索引是真的
 * `CacheIndex`、改写真落盘。跑完整个目录删掉 —— **不碰你自己的库**。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withLoadedTs } from "./lib/load-ts.mjs";
import { createAppMock } from "./lib/mock-obsidian.mjs";

const env = process.env;
const config = {
	endpoint: String(env.ACC_S3_ENDPOINT ?? "").trim(),
	bucket: String(env.ACC_S3_BUCKET ?? "").trim(),
	region: String(env.ACC_S3_REGION ?? "us-east-1").trim() || "us-east-1",
	accessKeyId: String(env.ACC_S3_ACCESS_KEY_ID ?? "").trim(),
	secretAccessKey: String(env.ACC_S3_SECRET_ACCESS_KEY ?? ""),
	...(String(env.ACC_S3_PUBLIC_URL_BASE ?? "").trim()
		? { publicUrlBase: String(env.ACC_S3_PUBLIC_URL_BASE).trim() }
		: {}),
	forcePathStyle: String(env.ACC_S3_FORCE_PATH_STYLE ?? "true").trim() !== "false",
};

const missing = [
	["ACC_S3_ENDPOINT", config.endpoint],
	["ACC_S3_BUCKET", config.bucket],
	["ACC_S3_ACCESS_KEY_ID", config.accessKeyId],
	["ACC_S3_SECRET_ACCESS_KEY", config.secretAccessKey],
].filter(([, value]) => !value);

if (missing.length > 0) {
	console.error("缺少环境变量：" + missing.map(([name]) => name).join("、"));
	console.error("（凭据只从环境变量读 —— 真机脚本不去挖宿主的 secretStorage）");
	process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = (line = "") => console.log(line);

let failures = 0;
/** 一条断言；`detail` 只在失败时打（成功时保持输出干净）。 */
function check(label, ok, detail = "") {
	if (ok) {
		log(`  ✓ ${label}`);
		return true;
	}
	failures += 1;
	log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
	return false;
}

/**
 * 用 Node 的 `fetch` 做传输。
 *
 * ⚠️ 必须**注入**：`obsidian` 的替身里 `requestUrl` 是"默认拒绝一切请求"的
 * （它的存在只为让链接期过得去，见 `lib/mock-obsidian.mjs` 的说明）。
 * 想验证真实网络路径，就得显式给一个真传输。
 */
const fetchTransport = async ({ url, method, headers, body }) => {
	const response = await fetch(url, { method, headers, body: body ?? undefined, redirect: "follow" });
	const bytes = new Uint8Array(await response.arrayBuffer());
	const out = {};
	response.headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return { status: response.status, headers: out, body: bytes };
};

const runId = randomBytes(4).toString("hex");
const oldRefKey = `acc-e2e-${runId}-photo-`;
const oldOrphanKey = `acc-e2e-${runId}-orphan-`;

log("统一对象名 · 真实存储端到端");
log(`  端点 ${config.endpoint}`);
log(`  桶   ${config.bucket}${String(env.ACC_S3_PUBLIC_URL_BASE ?? "") ? `（公开地址 ${config.publicUrlBase}）` : ""}`);
log(`  本次运行标记 ${runId}（造出来的 key 都带它，跑完按 key 精确清理）`);
log();

let vaultDir = "";
/** 造出来的全部 key（清理与复查都用它，不靠"猜"）。 */
const created = [];

try {
	await withLoadedTs(["src/s3/client", "src/plugin/migrate-flow", "src/cache/index"], async (mod) => {
		const { createS3Client, publicUrlFor } = mod;
		const { unifyObjectNames } = mod;
		const { CacheIndex } = mod;

		const client = createS3Client(config, { transport: fetchTransport });

		// ── 1. 在桶里造两个"旧形状"的对象（一个被引用、一个没人引用）──
		const refBytes = Buffer.from(randomBytes(512));
		const orphanBytes = Buffer.from(`orphan ${runId} ${"x".repeat(64)}`, "utf8");
		const refHash = sha256(refBytes);
		const orphanHash = sha256(orphanBytes);
		const refOld = `${oldRefKey}${refHash}.png`;
		const orphanOld = `${oldOrphanKey}${orphanHash}.txt`;
		const refNew = `${refHash}.png`;
		const orphanNew = `${orphanHash}.txt`;
		created.push(refOld, orphanOld, refNew, orphanNew);

		const putRef = await client.putObject(refOld, refBytes, "image/png");
		const putOrphan = await client.putObject(orphanOld, orphanBytes, "text/plain");
		check("夹具：两个旧形状对象已写入真实桶", Boolean(putRef.etag || putRef.key) && Boolean(putOrphan.key), putRef.key);
		log(`     · ${refOld}（${refBytes.length} B，会被笔记引用）`);
		log(`     · ${orphanOld}（${orphanBytes.length} B，没人引用）`);

		// ── 2. 临时库：一篇引用旧地址的笔记 ＋ 一份真索引 ──
		vaultDir = mkdtempSync(join(tmpdir(), "acc-migrate-real-"));
		mkdirSync(join(vaultDir, "notes"), { recursive: true });
		mkdirSync(join(vaultDir, ".obsidian/plugins/acc-e2e"), { recursive: true });
		const notePath = "notes/a.md";
		writeFileSync(join(vaultDir, notePath), `# 迁移夹具\n\n![](${publicUrlFor(config, refOld)})\n`, "utf8");

		// ⚠️ `createAppMock` 返回的是 `{ app, vault, calls, … }`，不是 app 本身
		const { app } = createAppMock(vaultDir);
		const index = new CacheIndex(
			[
				{
					key: refOld,
					cachePath: "attachments/photo.png",
					remoteUrl: publicUrlFor(config, refOld),
					size: refBytes.length,
					contentType: "image/png",
					etag: "",
					uploadedAt: new Date().toISOString(),
					lastUsedAt: 0,
					sourceName: "photo.png",
				},
			],
			[refOld, orphanOld]
		);

		const states = [];
		const ctx = {
			app,
			// 插件目录给临时库里的一个空目录：删除留痕会真写一份，但写在临时库里
			manifest: { dir: ".obsidian/plugins/acc-e2e" },
			settings: { debugLogging: false, sharedBucket: true, s3: { ...config } },
			t: (key) => key,
			currentIndex: () => index,
			hostContext: () => ({ persistIndex: async () => undefined }),
			buildClient: () => client,
			confirmMaintenance: async () => true,
		};

		// ── 3. 跑真流程 ──
		const result = await unifyObjectNames(ctx, {
			client,
			setState: async (state) => {
				states.push(state);
			},
		});

		check("预检分档：1 个待复制 + 1 个无引用可删", result.counts.copy === 1 && result.counts.drop === 1, JSON.stringify(result.counts));
		check("闸门全绿（没有残留、没有缺新对象、没有读不到的篇）", result.blocked === "", result.blocked);
		check("状态位 running → idle", states.join(",") === "running,idle", states.join(","));

		// ── 4. 真实桶的结论（这一段替身证明不了：只有服务端能回答）──
		const refNewHead = await client.headObject(refNew);
		const refOldHead = await client.headObject(refOld);
		const orphanOldHead = await client.headObject(orphanOld);
		const orphanNewHead = await client.headObject(orphanNew);

		check("★ 新 key 真的在，且长度与源一致", Boolean(refNewHead) && refNewHead.size === refBytes.length, JSON.stringify(refNewHead));
		check("★ 旧 key 已 404（删旧真的发生了）", refOldHead === null, JSON.stringify(refOldHead));
		check("★ 没人引用的那条：旧 key 删了、也**没有**复制出新对象", orphanOldHead === null && orphanNewHead === null, JSON.stringify({ orphanOldHead, orphanNewHead }));

		// ── 5. 本地侧：笔记、索引、台账、留痕 ──
		const text = readFileSync(join(vaultDir, notePath), "utf8");
		check("★ 笔记里的链接改成新地址", text.includes(publicUrlFor(config, refNew)), text.slice(-120));
		check("笔记里不再出现旧地址", !text.includes(publicUrlFor(config, refOld)));
		check("索引条目搬到新 key", index.has(refNew) && !index.has(refOld), index.keys().join(","));
		check("台账搬到新 key（否则清理端不认领它）", index.wasUploaded(refNew) && !index.wasUploaded(refOld));
		const deleteLog = (() => {
			try {
				return readFileSync(join(vaultDir, ".obsidian/plugins/acc-e2e/.deleted-objects.log"), "utf8");
			} catch {
				return "";
			}
		})();
		check("★ 删掉的旧对象留了痕，且标记 migration", deleteLog.includes("migration") && deleteLog.includes(refOld), deleteLog.slice(0, 120));

		// ── 6. 幂等：再跑一次应该什么都不做 ──
		const again = await unifyObjectNames(ctx, { client, setState: async () => undefined });
		check(
			"★ 第二次运行四项全 0（幂等）",
			again.counts.copy === 0 && again.counts.relink === 0 && again.counts.drop === 0 && again.counts.unknown === 0,
			JSON.stringify(again.counts)
		);
		check("第二次没有复制、没有删除", again.copied === 0 && again.deleted === 0, `${again.copied}/${again.deleted}`);
	});
} catch (error) {
	failures += 1;
	log(`  ✗ 运行中断：${error?.stack ?? error}`);
} finally {
	// ── 清理：按 key 精确删，再复查一遍"我造的东西一个都不剩" ──
	if (created.length > 0) {
		try {
			await withLoadedTs("src/s3/client", async (mod) => {
				const client = mod.createS3Client(config, { transport: fetchTransport });
				for (const key of created) {
					try {
						await client.deleteObject(key);
					} catch {
						// 本来就不在也算干净（清理要尽量做完，不因一条失败中断）
					}
				}
				const left = [];
				for (const key of created) {
					if (await client.headObject(key)) left.push(key);
				}
				check("清理：本次造出来的 key 在桶里一个都不剩", left.length === 0, left.join(", "));
			});
		} catch (error) {
			failures += 1;
			log(`  ✗ 清理失败（请手工删掉带 acc-e2e-${runId} 的对象）：${error?.message ?? error}`);
		}
	}
	if (vaultDir) {
		try {
			rmSync(vaultDir, { recursive: true, force: true });
		} catch {
			log(`  · 临时库没删掉：${vaultDir}`);
		}
	}
}

log();
if (failures === 0) {
	log("═".repeat(78));
	log("✓ 真实存储上的统一对象名通过");
	log("═".repeat(78));
} else {
	log("═".repeat(78));
	log(`✗ 有 ${failures} 项未通过（见上）`);
	log("═".repeat(78));
	process.exitCode = 1;
}
