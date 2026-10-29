/**
 * 「统一对象名」（CR-15）在**真实存储**上的端到端验证。
 *
 * ## 两种取凭据的方式（密钥都不进这个进程 / 不进仓库）
 *
 * | 方式 | 怎么用 | 密钥在哪 |
 * |---|---|---|
 * | **宿主代理**（默认） | 直接跑 `npm run verify:migrate`：启动 Obsidian，用**已配置好的插件**发现成的客户端 | 只在宿主内存里（脚本只拿到响应） |
 * | 环境变量 | `ACC_S3_*`（见下） | 当前 shell 的环境变量 |
 *
 * 宿主代理见 `lib/host-s3-client.mjs`：每次操作是一次 CDP `evaluate`，由宿主自己发请求。
 * **不读 `secretStorage`** —— 那是本项目的隐私边界（挖出来就等于把密钥复制到另一个进程）。
 *
 * ## 为什么需要它（单测证明不了的那一半）
 *
 * 替身客户端能证明"分档与闸门算得对"，但证明不了三件只有真服务端才回答的事：
 *
 * 1. **`CopyObject` 真的能复制**（`x-amz-copy-source` 的拼法与签名对不对 —— 拼错会回
 *    `SignatureDoesNotMatch` / `InvalidArgument`，而这类的报错完全不指向原因）；
 * 2. **复制后的长度与源一致**；
 * 3. **`DELETE` 之后 `HEAD` 真的是 404**（有的兼容实现对"已删除"的响应不一致）。
 *
 * ## ⚠️ 它会**写远端** —— 但只碰它自己造的那几个 key
 *
 * 一次运行会在桶里创建两个对象（一个被笔记引用、一个没人引用），跑完**删掉它们**
 *（包括复制出来的新对象）。判据是 `planMigration` 只遍历**上传台账**里的 key，
 * 所以桶里原有的对象**永远不会进候选**；为了万无一失，脚本仍然：
 *
 * - 所有造出来的 key 都带随机段（`acc-e2e-<run>-…`），清理按 key 精确删；
 * - 结束时逐个 `HEAD` 复查"我造的东西一个都不剩"，不剩才算通过；
 * - 临时库用 `mkdtemp`，跑完删掉 —— **不碰你自己的库**。
 *
 * ## 环境变量（全部可选）
 *
 * ```
 * ACC_S3_FROM_HOST=1                 # 强制宿主代理（不设时：没给 ACC_S3_* 就走宿主）
 * ACC_S3_ENDPOINT / ACC_S3_BUCKET / ACC_S3_REGION /
 * ACC_S3_ACCESS_KEY_ID / ACC_S3_SECRET_ACCESS_KEY /
 * ACC_S3_PUBLIC_URL_BASE / ACC_S3_FORCE_PATH_STYLE   # 环境变量模式
 * OBSIDIAN_EXE / OBSIDIAN_VAULT / OBSIDIAN_DEBUG_PORT / OBSIDIAN_DEBUG_WAIT  # 宿主模式
 * ```
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostClient, readS3Settings } from "./lib/host-s3-client.mjs";
import { withLoadedTs } from "./lib/load-ts.mjs";
import { createAppMock } from "./lib/mock-obsidian.mjs";
import { countObsidianProcesses, evaluate, launchAndAttach } from "./lib/obsidian-host.mjs";

const env = process.env;
const OBSIDIAN = env.OBSIDIAN_EXE ?? "C:/Program Files/Obsidian/Obsidian.exe";
const VAULT = env.OBSIDIAN_VAULT ?? "ObsidianVault";
const PORT = Number(env.OBSIDIAN_DEBUG_PORT ?? 9222);
const WAIT_SECONDS = Number(env.OBSIDIAN_DEBUG_WAIT ?? 90);

const envConfig = {
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

const explicitHostMode = String(env.ACC_S3_FROM_HOST ?? "").trim();
const hostMode =
	explicitHostMode === "1" ||
	(explicitHostMode !== "0" && (!envConfig.endpoint || !envConfig.bucket || !envConfig.accessKeyId));

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
 * Node 侧的传输实现（仅环境变量模式用）。
 *
 * ⚠️ 必须**注入**：`obsidian` 替身里的 `requestUrl` 是"默认拒绝一切请求"的
 *（它的存在只为让链接期过得去）。想验证真实网络路径，就得显式给一个真传输。
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

log("R25 · 真实存储端到端（统一对象名 ＋ 共享桶声明）");
log(`  取凭据方式 ${hostMode ? `宿主代理（${VAULT}）` : "环境变量 ACC_S3_*"}`);

if (!hostMode) {
	const missing = [
		["ACC_S3_ENDPOINT", envConfig.endpoint],
		["ACC_S3_BUCKET", envConfig.bucket],
		["ACC_S3_ACCESS_KEY_ID", envConfig.accessKeyId],
		["ACC_S3_SECRET_ACCESS_KEY", envConfig.secretAccessKey],
	].filter(([, value]) => !value);
	if (missing.length > 0) {
		console.error("缺少环境变量：" + missing.map(([name]) => name).join("、"));
		console.error("（不设 ACC_S3_* 会自动改走宿主代理：用已配置好的插件）");
		process.exit(2);
	}
}

/** 宿主代理模式下的句柄（`finally` 里收拾）。 */
let hostChild = null;
let hostCdp = null;
let client = null;

let vaultDir = "";
/** 造出来的全部 key（清理与复查都用它，不靠"猜"）。 */
const created = [];
/** 共享桶那一段写下的声明（另用一个前缀，清理时整段删）。 */
const sharedCreated = [];

try {
	// ── 0. 取配置与客户端 ──
	let config = envConfig;

	if (hostMode) {
		const running = countObsidianProcesses();
		if (running > 0) {
			console.error(`已有 ${running} 个 Obsidian 在跑（单实例）—— 先全部关掉，探针要独占调试端口。`);
			process.exit(2);
		}
		const attached = await launchAndAttach({ exe: OBSIDIAN, port: PORT, vault: VAULT, waitSeconds: WAIT_SECONDS, log });
		hostChild = attached.child;
		hostCdp = attached.client;

		const settings = await readS3Settings(evaluate, hostCdp);
		if (!settings.endpoint || !settings.bucket) {
			throw new Error(`插件还没配置存储（endpoint=${settings.endpoint || "空"} bucket=${settings.bucket || "空"}）`);
		}
		if (!settings.hasSecret) {
			throw new Error("插件拿不到密钥（`buildClient()` 是 null）—— 先在设置页把凭据填好");
		}
		config = {
			endpoint: settings.endpoint,
			bucket: settings.bucket,
			region: settings.region || "us-east-1",
			accessKeyId: "",
			secretAccessKey: "",
			...(settings.publicUrlBase ? { publicUrlBase: settings.publicUrlBase } : {}),
			forcePathStyle: settings.forcePathStyle,
		};
		client = createHostClient({ evaluate, client: hostCdp });
		log(`  端点 ${config.endpoint}`);
		log(`  桶   ${config.bucket}（区域 ${config.region}）`);
	} else {
		const { createS3Client } = await withLoadedTs("src/s3/client", async (mod) => mod);
		client = createS3Client(config, { transport: fetchTransport });
		log(`  端点 ${config.endpoint}`);
		log(`  桶   ${config.bucket}`);
	}

	log(`  本次运行标记 ${runId}（造出来的 key 都带它，跑完按 key 精确清理）`);
	log();

	// 链接与产品同源：`publicUrlFor` 会按路径段转义，笔记里写的就是它给出的那串
	const { publicUrlFor } = await withLoadedTs("src/s3/client", async (mod) => mod);

	await withLoadedTs(
		["src/plugin/migrate-flow", "src/cache/index", "src/plugin/shared-bucket-flow", "src/maintenance/shared-bucket"],
		async (mod) => {
		const { unifyObjectNames } = mod;
		const { CacheIndex } = mod;

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
		check("夹具：两个旧形状对象已写入真实桶", Boolean(putRef?.key) && Boolean(putOrphan?.key), JSON.stringify(putRef));
		log(`     · ${refOld}（${refBytes.length} B，会被笔记引用）`);
		log(`     · ${orphanOld}（${orphanBytes.length} B，没人引用）`);

		// ── 2. 临时库：一篇引用旧地址的笔记 ＋ 一份真索引 ──
		vaultDir = mkdtempSync(join(tmpdir(), "acc-migrate-real-"));
		mkdirSync(join(vaultDir, "notes"), { recursive: true });
		mkdirSync(join(vaultDir, ".obsidian/plugins/acc-e2e"), { recursive: true });
		const notePath = "notes/a.md";
		writeFileSync(join(vaultDir, notePath), `# 迁移夹具\n\n![](${publicUrlFor(config, refOld)})\n`, "utf8");

		// ⚠️ `createAppMock` 返回 `{ app, vault, calls, … }`，不是 app 本身
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
			settings: { debugLogging: false, s3: { ...config } },
			// ⚠️ 设备身份在上下文顶层（1.12.0 起不在 settings 上）。这里用独立的值：
			// 它不是共享桶那一段要断言的身份（那一段自己另给 `dev-a`），混用会让失败指向错的地方。
			deviceId: "dev-migrate",
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
		check(
			"★ 没人引用的那条：旧 key 删了、也**没有**复制出新对象",
			orphanOldHead === null && orphanNewHead === null,
			JSON.stringify({ orphanOldHead, orphanNewHead })
		);

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

		// ── 7. 共享桶声明（CR-13）在**真实桶**上读写一次 ──
		//
		// 这一段此前只有 mock：`_acc/v1/` 的写、读、跨设备否决都没在真服务端上跑过。
		// 用一个**本次专用的 vaultId**（`e2e-<run>`），跑完把整个前缀删干净。
		const { rememberReferences, forgetReferences, declarationIoFor } = mod;
		const { createSharedBucketGuard } = mod;

		const e2eVault = `e2e-${runId}`;
		const e2eDevice = "dev-a";
		const otherDevice = "dev-b";
		const sharedPrefix = `_acc/v1/${e2eVault}/`;
		const ownHead = `${sharedPrefix}${e2eDevice}/head.json`;
		const otherHead = `${sharedPrefix}${otherDevice}/head.json`;
		sharedCreated.push(ownHead, otherHead);

		const sharedCtx = {
			...ctx,
			settings: { ...ctx.settings, vaultId: e2eVault },
			// ⚠️ 设备身份在上下文顶层；这一段的身份是**它自己**的（`dev-a`），不是上面那份
			deviceId: e2eDevice,
		};

		const remembered = await rememberReferences(sharedCtx, client, [{ hash: refHash, name: "photo.png", ext: "png" }]);
		check("★ 共享桶：真实桶里写下了本设备的声明", remembered === true, String(remembered));

		const headText = (await client.getObject(ownHead)).data.toString("utf8");
		const head = JSON.parse(headText);
		check(
			"声明形状对（v / vault / device / refs）",
			head.v === 1 && head.vault === e2eVault && head.device === e2eDevice,
			headText.slice(0, 160)
		);
		check(
			"声明里记着原名与类型（纯哈希 key 靠它显示）",
			head.refs?.[refHash]?.name === "photo.png" && head.refs?.[refHash]?.ext === "png",
			JSON.stringify(head.refs?.[refHash] ?? null)
		);

		const guardA = createSharedBucketGuard({ io: declarationIoFor(client), self: { vault: e2eVault, device: e2eDevice } });
		const begunA = await guardA.begin();
		check("守卫：读得动真实桶里的声明", begunA.ok === true, JSON.stringify(begunA));
		if (begunA.ok) check("守卫：自己引用的**不算**被别人占用", begunA.isDenied(refHash) === false, "");

		// 另一台设备也引用同一个对象
		const foreign = JSON.stringify({
			v: 1,
			vault: e2eVault,
			device: otherDevice,
			updatedAt: new Date().toISOString(),
			refs: { [refHash]: { name: "photo.png", ext: "png", addedAt: new Date().toISOString() } },
		});
		await client.putObject(otherHead, Buffer.from(foreign, "utf8"), "application/json");

		const guardB = createSharedBucketGuard({ io: declarationIoFor(client), self: { vault: e2eVault, device: e2eDevice } });
		const begunB = await guardB.begin();
		check(
			"★★ 守卫：真实桶里**另一台设备**的引用会被读到并否决",
			begunB.ok === true && begunB.isDenied(refHash) === true,
			JSON.stringify(begunB)
		);
		if (begunB.ok) {
			check(
				"守卫：说得出是谁占着（设备 id 来自真实桶里的声明）",
				begunB.occupantsOf(refHash).some((who) => who.device === otherDevice),
				JSON.stringify(begunB.occupantsOf(refHash))
			);
		}

		const forgot = await forgetReferences(sharedCtx, client, [refHash]);
		check("摘引用：真实桶里那条消失", forgot === true, String(forgot));
		const after = JSON.parse((await client.getObject(ownHead)).data.toString("utf8"));
		check("★★ 摘完以后 refs 里没有它（声明是状态，不是流水账）", after.refs?.[refHash] === undefined, JSON.stringify(after.refs));
	});

	// ── 8. ⭐ 非 ASCII / 带空格的 key 在**真实服务商**上走完整一圈（R5 的验证缺口）──
	//
	// 此前只在替身与单测里验过。而"中文文件名"从 C2 起就是**常态**（默认模板把原名带进 key），
	// 一旦服务商对路径编码的宽容度与 AWS 不同，症状会是"上传成功但取不回来"或"签名对不上"。
	// 这里走的是与产品**同一套**拼地址（`publicUrlFor`）与签名（客户端），所以它证明的是
	// "用户笔记里那条链接在真实服务商上真的能打开"。
	{
		const chineseKey = `acc-e2e-${runId}-中文 名字 (1).png`;
		created.push(chineseKey);
		const bytes = Buffer.from(randomBytes(256));

		const put = await client.putObject(chineseKey, bytes, "image/png");
		check("★ 非 ASCII key：真实桶里 PUT 成功（签名与路径编码都被服务端接受）", Boolean(put?.key), JSON.stringify(put));

		const head = await client.headObject(chineseKey);
		check("★ 非 ASCII key：HEAD 回来且长度一致", Boolean(head) && head.size === bytes.length, JSON.stringify(head));

		const got = await client.getObject(chineseKey);
		check(
			"★★ 非 ASCII key：GET 回来**逐字节相同**（不是「看得到但内容是坏的」）",
			Buffer.compare(Buffer.from(got.data), bytes) === 0,
			`收到 ${got.data.length} B / 期望 ${bytes.length} B`
		);

		const listed = await client.listObjects({ prefix: `acc-e2e-${runId}-中文` });
		check(
			"★ 非 ASCII key：列举回来**逐字一致**（XML 转义没把它改形）",
			listed.objects.some((object) => object.key === chineseKey),
			JSON.stringify(listed.objects.map((object) => object.key))
		);

		// ⭐ 笔记里写的就是这个地址 —— 匿名取一次（桶是公开的，正是"别人打得开"那一条）
		const publicUrl = publicUrlFor(config, chineseKey);
		const anonymous = await fetch(publicUrl, { headers: { "cache-control": "no-cache" } });
		const anonymousBytes = Buffer.from(await anonymous.arrayBuffer());
		check(
			"★★ 非 ASCII key：**匿名**用笔记里那条地址能取回同样的字节（R5 的最终判据）",
			anonymous.status === 200 && Buffer.compare(anonymousBytes, bytes) === 0,
			`HTTP ${anonymous.status}，${anonymousBytes.length} B —— ${publicUrl}`
		);

		const removed = await client.deleteObject(chineseKey);
		const gone = await client.headObject(chineseKey);
		check("非 ASCII key：删掉之后 HEAD 真的 404", removed === true && gone === null, JSON.stringify({ removed, gone }));
	}
} catch (error) {
	failures += 1;
	log(`  ✗ 运行中断：${error?.stack ?? error}`);
} finally {
	// ── 清理：按 key 精确删，再复查一遍"我造的东西一个都不剩" ──
	if (created.length > 0 && client) {
		try {
			for (const key of created) {
				try {
					await client.deleteObject(key);
				} catch {
					// 本来就不在也算干净
				}
			}
			const left = [];
			for (const key of created) {
				if (await client.headObject(key)) left.push(key);
			}
			check("清理：本次造出来的 key 在桶里一个都不剩", left.length === 0, left.join(", "));
		} catch (error) {
			failures += 1;
			log(`  ✗ 清理失败（请手工删掉带 acc-e2e-${runId} 的对象）：${error?.message ?? error}`);
		}
	}
	// 共享桶那一段：先删两个 head，再按前缀复查"整段都不剩"
	if (sharedCreated.length > 0 && client) {
		try {
			for (const key of sharedCreated) {
				try {
					await client.deleteObject(key);
				} catch {
					/* 已经不在 */
				}
			}
			const prefix = `_acc/v1/e2e-${runId}/`;
			const left = await client.listObjects({ prefix });
			check("清理：共享桶那一段 `_acc/` 在桶里一个都不剩", left.objects.length === 0, left.objects.map((o) => o.key).join(", "));
		} catch (error) {
			failures += 1;
			log(`  ✗ 共享桶清理失败（请手工删掉 ${`_acc/v1/e2e-${runId}/`}）：${error?.message ?? error}`);
		}
	}
	if (vaultDir) {
		try {
			rmSync(vaultDir, { recursive: true, force: true });
		} catch {
			log(`  · 临时库没删掉：${vaultDir}`);
		}
	}
	// 宿主：先请它自己退出，再兜底收进程（它是单实例的，留着会卡住下一轮）
	if (hostCdp) {
		try {
			await evaluate(hostCdp, "app.quit()");
		} catch {
			/* 尽力而为 */
		}
	}
	if (hostChild) {
		try {
			hostChild.kill();
		} catch {
			/* 已经退了 */
		}
	}
}

log();
if (failures === 0) {
	log("═".repeat(78));
	log("✓ 真实存储上的 R25 通过（统一对象名 ＋ 共享桶声明）");
	log("═".repeat(78));
} else {
	log("═".repeat(78));
	log(`✗ 有 ${failures} 项未通过（见上）`);
	log("═".repeat(78));
	process.exitCode = 1;
}
