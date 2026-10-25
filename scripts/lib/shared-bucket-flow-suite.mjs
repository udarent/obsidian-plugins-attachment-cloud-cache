/**
 * 「共享桶接线」套件（`src/plugin/shared-bucket-flow.ts`）。
 *
 * 这一层只做三件事：把 S3 客户端包成声明 I/O、给出本设备身份、在关掉时**一个请求都不发**。
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
	sharedBucket: true,
	vaultId: "v1",
	deviceId: "d1",
	...over,
});

export async function runSharedBucketFlowSuite(mod) {
	const { identityOf, declarationIoFor, rememberReferences, sharedBucketGuardFor } = mod;

	// ============================================================
	// 1. 身份：形状不对就不参与（宁可不判，也别写到别人的前缀里）
	// ============================================================
	{
		assert.deepEqual(identityOf(settings()), { vault: "v1", device: "d1" }, "合法的身份原样给出");
		// ⚠️ 先钉**危险形状**（能写到别的前缀），再钉"缺省"：变异验证取的是第一条失败的断言，
		// 那条必须正好是"这一层最该拦的东西"。
		assert.equal(identityOf(settings({ vaultId: ".." })), null, "★ 带 `..` 的一律不认（否则能写到别的前缀）");
		assert.equal(identityOf(settings({ deviceId: "a/b" })), null, "★ 带斜杠的一律不认");
		assert.equal(identityOf(settings({ deviceId: "D1" })), null, "大写不认（与声明层的 id 形状同一份判据）");
		assert.equal(identityOf(settings({ vaultId: "" })), null, "空 vaultId ⇒ 没有身份");
		assert.equal(identityOf(settings({ deviceId: "" })), null, "空 deviceId ⇒ 没有身份");
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
	// 3. 登记引用：开关关着时一个请求都不发；写失败要如实返回 false
	// ============================================================
	{
		const ref = { hash: "a".repeat(64), name: "a.png", ext: "png" };

		const offCtx = { settings: settings({ sharedBucket: false }), t: (key) => key };
		const offClient = fakeClient();
		assert.equal(await rememberReferences(offCtx, offClient, [ref]), true, "功能关着 ⇒ 直接放行");
		assert.equal(offClient.calls.length, 0, "★ 关着时一次请求都不发（不打开的人不该多出 ListBucket 依赖）");

		const okCtx = { settings: settings(), t: (key) => key };
		const okClient = fakeClient();
		assert.equal(await rememberReferences(okCtx, okClient, []), true, "没有引用 ⇒ 不写（空批不该产生一次 PUT）");
		assert.equal(okClient.calls.length, 0, "空批确实一个请求都没有");

		assert.equal(await rememberReferences(okCtx, okClient, [ref]), true, "正常登记返回 true");
		const put = okClient.calls.find((call) => call[0] === "put");
		assert.ok(put, "真的写了一份声明");
		assert.equal(put[1], "_acc/v1/v1/d1/head.json", "首次写到 head");
		assert.ok(put[3].includes(ref.hash), "声明的 refs 里要有这个哈希");

		const badIdCtx = { settings: settings({ deviceId: "" }), t: (key) => key };
		const badIdClient = fakeClient();
		assert.equal(await rememberReferences(badIdCtx, badIdClient, [ref]), false, "★ 身份缺失 ⇒ 不传（否则声明写不成）");
		assert.equal(badIdClient.calls.length, 0, "身份不合法时连读都不读");

		const failCtx = { settings: settings(), t: (key) => key };
		const failClient = fakeClient({ putError: new Error("AccessDenied") });
		assert.equal(await rememberReferences(failCtx, failClient, [ref]), false, "★ 写失败 ⇒ 返回 false（调用方据此中止上传）");
	}

	// ============================================================
	// 4. 守卫：开关关着 / 身份缺失都返回 null（= 不启用跨库判据）
	// ============================================================
	{
		const client = fakeClient({ files: [["_acc/v1/v1/d2/head.json", '{"v":1,"vault":"v1","device":"d2","updatedAt":"2026-10-25T00:00:00.000Z","refs":{}}']] });
		assert.equal(sharedBucketGuardFor({ settings: settings({ sharedBucket: false }) }, client), null, "关着 ⇒ 没有守卫");
		assert.equal(sharedBucketGuardFor({ settings: settings({ vaultId: "" }) }, client), null, "身份缺失 ⇒ 没有守卫");

		const guard = sharedBucketGuardFor({ settings: settings() }, client);
		assert.ok(guard, "打开且身份齐全 ⇒ 有守卫");
		const start = await guard.begin();
		assert.equal(start.ok, true, "桶里有别人的声明 ⇒ 可以判");
		assert.equal(start.declarationCount, 1, "报出读了几份声明");
		assert.equal(await guard.checkpoint(), "same", "没人动过 ⇒ same");
	}

	return { cases: 4 };
}
