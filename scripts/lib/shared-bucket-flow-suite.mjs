/**
 * 「共享桶接线」套件（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 这一层只做三件事：把 S3 客户端包成声明 I/O、给出本设备身份、在**身份缺失时一个请求都不发**。
 * ⚠️ 2026-10-28：这里原有一层"共享桶开关关着就全部跳过"的分支，已删 —— 跨设备保护不再可选
 * （关着时删除链会整块跳过跨库判据，同桶里别的设备还在用的对象会被当孤儿删掉）。
 * 唯一剩下的早退条件是**身份缺失**。
 * 三者各自能坏成一种"看起来没事"的样子：
 * - 包装写错 ⇒ 读到的声明是空的 ⇒ 所有对象都像"没人引用"；
 * - 身份缺失却照拼前缀 ⇒ 所有设备写到同一个目录、声明互相覆盖；
 * - 开关关着还发请求 ⇒ 没打开功能的人莫名多出 `ListBucket` 权限报错。
 */

import assert from "node:assert/strict";

/** 造一个假 S3 客户端：记录调用、按需返回/抛错。 */
function fakeClient(options = {}) {
	const calls = [];
	const files = new Map(options.files ?? []);
	return {
		calls,
		files,
		listObjects: async (params) => {
			calls.push(["list", params]);
			if (options.listError) throw options.listError;
			const keys = [...files.keys()].filter((key) => key.startsWith(params?.prefix ?? "")).sort();
			return {
				objects: keys.map((key) => ({ key, size: 1, etag: "etag", lastModified: "2026-10-25T00:00:00.000Z" })),
				nextToken: null,
			};
		},
		getObject: async (key) => {
			calls.push(["get", key]);
			if (options.getError) throw options.getError;
			if (!files.has(key)) throw Object.assign(new Error("Not Found"), { status: 404 });
			return { key, data: new TextEncoder().encode(files.get(key)), contentType: "application/json", etag: "etag" };
		},
		putObject: async (key, data, contentType) => {
			calls.push(["put", key, contentType, new TextDecoder().decode(data)]);
			if (options.putError) throw options.putError;
			files.set(key, new TextDecoder().decode(data));
			return { key, url: `https://example/${key}`, etag: "etag" };
		},
		deleteObject: async (key) => {
			calls.push(["delete", key]);
			files.delete(key);
			return true;
		},
	};
}

const settings = (over = {}) => ({
	vaultId: "v1",
	...over,
});

export async function runSharedBucketFlowSuite(mod) {
	const {
		identityOf,
		declarationIoFor,
		rememberReferences,
		forgetReferences,
		syncDeclaration,
		sharedBucketGuardFor,
		rememberRenamedName,
		flushDeclarationNames,
	} = mod;

	// ============================================================
	// 1. 身份：形状不对就不参与（宁可不判，也别写到别人的前缀里）
	// ============================================================
	{
		// ⚠️ `identityOf` 吃的是**身份来源**（`vaultId` + `deviceId`），而这对值现在的来源是
		// **两处**：`vaultId` 在设置里、`deviceId` 在宿主本机存储（见 `types.ts` 的说明）。
		// 所以这里显式拼一份来源，不能直接把"设置对象"喂进去。
		const src = (over = {}) => ({ vaultId: "v1", deviceId: "d1", ...over });

		assert.deepEqual(identityOf(src()), { vault: "v1", device: "d1" }, "合法的身份原样给出");
		// ⚠️ 先钉**危险形状**（能写到别的前缀），再钉"缺省"：变异验证取的是第一条失败的断言，
		// 那条必须正好是"这一层最该拦的东西"。
		assert.equal(identityOf(src({ vaultId: ".." })), null, "★ 带 `..` 的一律不认（否则能写到别的前缀）");
		assert.equal(identityOf(src({ deviceId: "a/b" })), null, "★ 带斜杠的一律不认");
		assert.equal(identityOf(src({ deviceId: "D1" })), null, "大写不认（与声明层的 id 形状同一份判据）");
		assert.equal(identityOf(src({ vaultId: "" })), null, "空 vaultId ⇒ 没有身份");
		assert.equal(identityOf(src({ deviceId: "" })), null, "空 deviceId ⇒ 没有身份");
	}

	// ============================================================
	// 2. I/O 包装：四个动作都要如实转发（名字/参数/编码）
	// ============================================================
	{
		const client = fakeClient({ files: [["_acc/v1/v1/d1/head.json", '{"v":1}']] });
		const io = declarationIoFor(client);

		const page = await io.list("_acc/v1/", null, 1000);
		assert.equal(client.calls[0][0], "list", "list 要转发到 listObjects");
		assert.equal(client.calls[0][1].prefix, "_acc/v1/", "只列声明前缀");
		assert.equal(client.calls[0][1].maxKeys, 1000, "单页上限按声明层的口径");
		assert.equal("continuationToken" in client.calls[0][1], false, "第一页不带 token（不是空串）");
		assert.deepEqual(page.files, [{ key: "_acc/v1/v1/d1/head.json", lastModified: "2026-10-25T00:00:00.000Z" }], "映射成声明层的形状");
		assert.equal(page.nextToken, null, "没有下一页");

		const token = await io.list("_acc/v1/", "abc", 1000);
		assert.equal(client.calls[1][1].continuationToken, "abc", "后续页要带 token");
		assert.ok(token, "有返回值");

		const text = await io.get("_acc/v1/v1/d1/head.json");
		assert.equal(text, '{"v":1}', "读回来的是原文（UTF-8 解码）");
		assert.equal(await io.get("_acc/v1/v1/d1/missing.json"), null, "★ 404 ⇒ null（与「读失败」分开）");

		await io.put("_acc/v1/v1/d1/head.json", '{"v":1,"refs":{}}');
		const putCall = client.calls.find((call) => call[0] === "put");
		assert.equal(putCall[2], "application/json", "声明按 JSON 上传（否则浏览器/工具打开是下载）");
		assert.equal(putCall[3], '{"v":1,"refs":{}}', "字节要逐字一致");

		await io.remove("_acc/v1/v1/d1/seg-0001.json");
		assert.equal(client.calls.at(-1)[0], "delete", "remove 转发到 deleteObject");

		const failing = declarationIoFor(fakeClient({ getError: new Error("403 Forbidden") }));
		await assert.rejects(() => failing.get("_acc/v1/v1/d1/head.json"), /403/, "★ 非 404 的错误必须抛（那是「读失败」，不能当成「没人引用」）");
	}

	// ============================================================
	// 3. 登记引用：**没有身份**时一个请求都不发；写失败要如实返回 false
	// ============================================================
	{
		const ref = { hash: "a".repeat(64), name: "a.png", ext: "png" };

		// ⚠️ 先钉**不安全的那一面**：没有身份还去写，就会写到空前缀里、让所有设备互相覆盖。
		const noIdCtx = { settings: settings(), deviceId: "", t: (key) => key };
		const noIdClient = fakeClient();
		let outcome;
		await assert.doesNotReject(async () => {
			outcome = await rememberReferences(noIdCtx, noIdClient, [ref]);
		}, "★ 没有身份时不许抛（早退就是全部动作）");
		assert.equal(outcome, false, "★ 没有身份 ⇒ 拒绝登记（不假装成功）");
		assert.equal(noIdClient.calls.length, 0, "没有身份时一次请求都不发");

		const okCtx = { settings: settings(), deviceId: "d1", t: (key) => key };
		const okClient = fakeClient();
		assert.equal(await rememberReferences(okCtx, okClient, []), true, "没有引用 ⇒ 不写（空批不该产生一次 PUT）");
		assert.equal(okClient.calls.length, 0, "空批确实一个请求都没有");

		assert.equal(await rememberReferences(okCtx, okClient, [ref]), true, "正常登记返回 true");
		const put = okClient.calls.find((call) => call[0] === "put");
		assert.ok(put, "真的写了一份声明");
		assert.equal(put[1], "_acc/v1/v1/d1/head.json", "首次写到 head");
		assert.ok(put[3].includes(ref.hash), "声明的 refs 里要有这个哈希");

		const badIdCtx = { settings: settings({ deviceId: "" }), deviceId: "", t: (key) => key };
		const badIdClient = fakeClient();
		assert.equal(await rememberReferences(badIdCtx, badIdClient, [ref]), false, "★ 身份缺失 ⇒ 不传（否则声明写不成）");
		assert.equal(badIdClient.calls.length, 0, "身份不合法时连读都不读");

		const failCtx = { settings: settings(), deviceId: "d1", t: (key) => key };
		const failClient = fakeClient({ putError: new Error("AccessDenied") });
		assert.equal(await rememberReferences(failCtx, failClient, [ref]), false, "★ 写失败 ⇒ 返回 false（调用方据此中止上传）");
	}

	// ============================================================
	// 4. 守卫：只剩「身份缺失 ⇒ null」一个早退条件（开关已删）
	// ============================================================
	{
		const client = fakeClient({ files: [["_acc/v1/v1/d2/head.json", '{"v":1,"vault":"v1","device":"d2","updatedAt":"2026-10-25T00:00:00.000Z","refs":{}}']] });
		assert.equal(sharedBucketGuardFor({ settings: settings({ vaultId: "" }), deviceId: "d1" }, client), null, "身份缺失 ⇒ 没有守卫");
		assert.equal(sharedBucketGuardFor({ settings: settings(), deviceId: "" }, client), null, "设备身份缺失 ⇒ 没有守卫");

		const guard = sharedBucketGuardFor({ settings: settings(), deviceId: "d1" }, client);
		assert.ok(guard, "★ 身份齐全 ⇒ **一定有守卫**（不再有开关能把它关掉）");
		const start = await guard.begin();
		assert.equal(start.ok, true, "桶里有别人的声明 ⇒ 可以判");
		assert.equal(start.declarationCount, 1, "报出读了几份声明");
		assert.equal(await guard.checkpoint(), "same", "没人动过 ⇒ same");
	}

	// ============================================================
	// 5. 摘引用：对象真的没了之后，声明里那条必须消失
	// ============================================================
	{
		const hash = "b".repeat(64);
		const head = `_acc/v1/v1/d1/head.json`;
		const seeded = JSON.stringify({ v: 1, vault: "v1", device: "d1", updatedAt: "2026-10-25T00:00:00.000Z", refs: { [hash]: { name: "b.png", ext: "png", addedAt: "2026-10-25T00:00:00.000Z" } } });
		const ctx = { settings: settings(), deviceId: "d1", t: (key) => key };

		const client = fakeClient({ files: [[head, seeded]] });
		assert.equal(await forgetReferences(ctx, client, [hash]), true, "摘引用要成功");
		// ⚠️ 先钉"确实重写了"：变异验证取第一条失败的断言，而"根本没写"正是
		// "没摘引用"这个缺陷的第一形态（声明原样留着）。
		assert.equal(
			client.calls.filter((call) => call[0] === "put").length,
			1,
			"★ 删掉的对象必须触发一次声明重写（否则它永远留在声明里）"
		);
		const put = client.calls.find((call) => call[0] === "put");
		assert.equal(JSON.parse(put[3]).refs[hash], undefined, "声明里那条必须消失（否则永远替它做保护）");

		const offClient = fakeClient({ files: [[head, seeded]] });
		assert.equal(await forgetReferences({ settings: settings(), deviceId: "", t: (key) => key }, offClient, [hash]), false, "没有身份 ⇒ 不伪装成功");
		assert.equal(offClient.calls.length, 0, "没有身份时一个请求都不发");
		assert.equal(await forgetReferences(ctx, offClient, []), true, "没有哈希 ⇒ 什么都不做");
		assert.equal(offClient.calls.length, 0, "空批确实没有请求");
	}

	// ============================================================
	// 6. 整份对账：**没有身份**时连全库都不读
	// ============================================================
	{
		// ⚠️ 数一遍"读了几次全库"：只看返回值分不出"没读"和"读了但失败"（后者同样返回 false），
		// 而两者的代价差一整个全库扫描。
		let scans = 0;
		const counting = (over) => ({
			settings: settings(over),
				deviceId: "d1",
			app: {
				vault: {
					getMarkdownFiles: () => {
						scans += 1;
						return [];
					},
					getFiles: () => [],
					read: async () => "",
				},
			},
		});
		// ⚠️ 先钉「不许抛」：早退就是全部动作。少这一条的话，变异会崩在 `self.vault` 上，
		// 而套件报的是"读不到 null 的属性"——那不是这条规则的失败原因（本项目的老坑）。
		let off;
		await assert.doesNotReject(async () => {
			off = await syncDeclaration({ ...counting({}), deviceId: "" }, fakeClient());
		}, "★ 没有身份时不许抛（早退就是全部动作）");
		assert.equal(off, false, "没有身份 ⇒ 不对账");
		assert.equal(scans, 0, "★ 关着 ⇒ 连全库都不读（不是「读了但没写」）");
		const noId = await syncDeclaration(counting({ vaultId: "" }), fakeClient());
		assert.equal(noId, false, "身份缺失 ⇒ 不对账（否则会写到别的前缀）");
		assert.equal(scans, 0, "身份不合法时也不读全库");
	}

	// ============================================================
	// 7. 改名：写进声明；写不进去就**进待补队列**（CR-16）
	// ============================================================
	{
		const hash = "a".repeat(64);
		const head = "_acc/v1/v1/d1/head.json";
		const seeded = JSON.stringify({
			v: 1,
			vault: "v1",
			device: "d1",
			updatedAt: "2026-10-25T00:00:00.000Z",
			refs: { [hash]: { name: "旧名字.png", ext: "png", addedAt: "2026-10-01T00:00:00.000Z" } },
		});
		let persisted = 0;
		const ctx = (over = {}, deviceId = "d1") => ({
			settings: settings({ declarationNameBacklog: {}, ...over }),
				deviceId,
			hostContext: () => ({
				persistSettings: async () => {
					persisted += 1;
				},
			}),
			t: (key) => key,
		});

		// 7a. 关着 ⇒ off，零请求
		{
			const client = fakeClient({ files: [[head, seeded]] });
			const outcome = await rememberRenamedName(
				ctx({}, ""),
				client,
				{ hash, name: "新名字.png", ext: "png" }
			);
			assert.equal(outcome, "off", "没有身份 ⇒ 什么都不做");
			assert.equal(client.calls.length, 0, "★ 没有身份时一个请求都不发");
		}

		// 7b. 写成功：声明里的名字变了，`addedAt` **不变**（它是封存切块的排序依据）
		{
			const client = fakeClient({ files: [[head, seeded]] });
			const target = ctx();
			const outcome = await rememberRenamedName(target, client, { hash, name: "新名字.png", ext: "png" });
			assert.equal(outcome, "written", "写成功");
			const put = client.calls.find((call) => call[0] === "put");
			assert.ok(put, "真的重写了声明");
			const written = JSON.parse(put[3]);
			assert.equal(written.refs[hash].name, "新名字.png", "★ 声明里的显示名跟着改");
			assert.equal(
				written.refs[hash].addedAt,
				"2026-10-01T00:00:00.000Z",
				"★★ `addedAt` 不许因为改名而变（它是封存切块的排序依据）"
			);
			assert.deepEqual(target.settings.declarationNameBacklog, {}, "写成功 ⇒ 不需要入队");
		}

		// 7c. 写失败：进队列（改名在本地已经成功，不能因为这条回滚）
		{
			const client = fakeClient({ files: [[head, seeded]], putError: new Error("offline") });
			const target = ctx();
			const outcome = await rememberRenamedName(target, client, { hash, name: "新名字.png", ext: "png" });
			assert.equal(outcome, "queued", "★ 写不进去 ⇒ 记进待补队列");
			assert.equal(target.settings.declarationNameBacklog[hash]?.name, "新名字.png", "队列里是新名字");
			assert.ok(persisted > 0, "队列要落盘（否则重启就丢）");
		}

		// 7d. 声明里没有这个 hash ⇒ 不入队（那不是改名能修的）
		{
			const client = fakeClient({ files: [[head, seeded]] });
			const target = ctx();
			const outcome = await rememberRenamedName(target, client, { hash: "b".repeat(64), name: "x.png", ext: "png" });
			assert.equal(outcome, "written", "云端没这条 ⇒ 视为不用补");
			assert.deepEqual(target.settings.declarationNameBacklog, {}, "★ 不入队（否则它永远补不上）");
		}
	}

	// ============================================================
	// 8. 补写队列：空着零请求；成功结清；读失败原样留着
	// ============================================================
	{
		const hash = "c".repeat(64);
		const head = "_acc/v1/v1/d1/head.json";
		const seeded = JSON.stringify({
			v: 1,
			vault: "v1",
			device: "d1",
			updatedAt: "2026-10-25T00:00:00.000Z",
			refs: { [hash]: { name: "旧名字.png", ext: "png", addedAt: "2026-10-01T00:00:00.000Z" } },
		});
		let persisted = 0;
		const ctx = (backlog) => ({
			settings: settings({ declarationNameBacklog: backlog }),
				deviceId: "d1",
			hostContext: () => ({
				persistSettings: async () => {
					persisted += 1;
				},
			}),
			t: (key) => key,
		});

		// 8a. 空队列 ⇒ 0，且**一次请求都不发**（上传路径会频繁调到这里）
		{
			const client = fakeClient({ files: [[head, seeded]] });
			assert.equal(await flushDeclarationNames(ctx({}), client), 0, "空队列 ⇒ 0");
			assert.equal(client.calls.length, 0, "★ 空队列时一个请求都不发");
		}

		// 8b. 队列里那条在声明里 ⇒ 补写成功并结清
		{
			const client = fakeClient({ files: [[head, seeded]] });
			const target = ctx({ [hash]: { name: "新名字.png", ext: "png", at: "2026-10-25T01:00:00.000Z" } });
			assert.equal(await flushDeclarationNames(target, client), 1, "补了一条");
			assert.deepEqual(target.settings.declarationNameBacklog, {}, "★ 补成功才出队");
			const put = client.calls.find((call) => call[0] === "put");
			assert.equal(JSON.parse(put[3]).refs[hash].name, "新名字.png", "写进去的是队列里的名字");
			assert.ok(persisted > 0, "结清也要落盘");
		}

		// 8c. 读失败 ⇒ 0，队列原样留着（下次再补）
		{
			const backlog = { [hash]: { name: "新名字.png", ext: "png", at: "2026-10-25T01:00:00.000Z" } };
			const client = fakeClient({ files: [[head, seeded]], getError: new Error("denied") });
			const target = ctx(backlog);
			assert.equal(await flushDeclarationNames(target, client), 0, "读失败 ⇒ 一条都没补");
			assert.deepEqual(target.settings.declarationNameBacklog, backlog, "★★ 队列原样留着（丢了就永远补不上）");
		}
	}

	return { cases: 8 };
}
