/**
 * 「共享桶的跨库判据」套件（`src/maintenance/shared-bucket.ts`）。
 *
 * 这一层管的是**能不能删别人的东西**。所以每组断言都按"错了会怎样"命名：
 * 少排除自己 ⇒ 自己引用过的永远删不掉；少了"没有声明"这一支 ⇒ 会删掉别的库还在用的对象；
 * 少了检查点 ⇒ 批量跑到一半别人新增了引用，后半批照删。
 */

import assert from "node:assert/strict";

/** 造一个合法哈希（64 位小写十六进制）。 */
const hash = (n) => n.toString(16).padStart(64, "0");

const ref = (name, addedAt = "2026-10-25T00:00:00.000Z") => ({ name, ext: "png", addedAt });

const decl = (vault, device, refs, updatedAt = "2026-10-25T00:00:00.000Z") => ({
	v: 1,
	vault,
	device,
	updatedAt,
	refs,
});

const entry = (vault, device, refs) => ({ vault, device, declaration: decl(vault, device, refs) });

/** 造一个假 io：`files` 是 key → { text, lastModified }；`fail` 可让 list/get/put 抛错。 */
function fakeIo(entries = [], fail = {}) {
	const files = new Map(entries);
	const ops = [];
	const io = {
		ops,
		files,
		list: async (prefix, token, maxKeys) => {
			if (fail.list) throw new Error(fail.list);
			const keys = [...files.keys()].filter((key) => key.startsWith(prefix)).sort();
			const from = token === null ? 0 : Number(token);
			const slice = keys.slice(from, from + maxKeys);
			const next = from + slice.length < keys.length ? String(from + slice.length) : null;
			return {
				files: slice.map((key) => ({ key, lastModified: files.get(key).lastModified })),
				nextToken: next,
			};
		},
		get: async (key) => {
			if (fail.get) throw new Error(fail.get);
			return files.has(key) ? files.get(key).text : null;
		},
		put: async (key, text) => {
			if (fail.put) throw new Error(fail.put);
			ops.push(["put", key]);
			files.set(key, { text, lastModified: "2026-10-25T10:00:00.000Z" });
		},
		remove: async (key) => {
			ops.push(["remove", key]);
			files.delete(key);
		},
	};
	return io;
}

const fileOf = (vault, device, name, refs, lastModified = "2026-10-25T00:00:00.000Z") => [
	`_acc/v1/${vault}/${device}/${name}`,
	{ text: JSON.stringify(decl(vault, device, refs)), lastModified },
];

export async function runSharedBucketSuite(mod) {
	const { occupancyOf, occupantsOtherThan, occupiedByOthers, createSharedBucketGuard, declareRefs } = mod;

	// ============================================================
	// 1. 占用表：同一台设备的多份文件要合并成一条
	// ============================================================
	{
		const table = occupancyOf([
			entry("v1", "d1", { [hash(1)]: ref("a.png") }),
			entry("v1", "d1", { [hash(1)]: ref("a.png"), [hash(2)]: ref("b.png") }),
			entry("v1", "d2", { [hash(2)]: ref("b.png") }),
		]);
		assert.deepEqual(
			table.get(hash(1)).map((who) => who.device),
			["d1"],
			"★ 同一台设备的 head 与段里都有同一个 hash ⇒ 只算一个占用者（否则提示里会写「2 台设备」）"
		);
		assert.equal(table.get(hash(2)).length, 2, "两台设备都引用 ⇒ 两个占用者");
		assert.equal(table.has(hash(3)), false, "没人引用的 hash 不在表里");
	}

	// ============================================================
	// 2. 判据：自己那份不算占用，别人的必须算
	// ============================================================
	{
		const table = occupancyOf([
			entry("v1", "d1", { [hash(1)]: ref("a.png") }),
			entry("v1", "d2", { [hash(2)]: ref("b.png") }),
			entry("v9", "d1", { [hash(3)]: ref("c.png") }),
		]);
		const self = { vault: "v1", device: "d1" };

		assert.deepEqual(occupantsOtherThan(table, hash(1), self), [], "★ 自己引用着不算占用（否则永远删不掉）");
		assert.deepEqual(
			occupantsOtherThan(table, hash(2), self).map((who) => who.device),
			["d2"],
			"同库的另一台设备引用着 ⇒ 占用"
		);
		assert.deepEqual(
			occupantsOtherThan(table, hash(3), self).map((who) => who.vault),
			["v9"],
			"★ 共用同一个桶的另一个库引用着 ⇒ 占用（这才是「多设备盲区」的真实形态）"
		);

		const denied = occupiedByOthers(table, [hash(1), hash(2), hash(3)], self);
		assert.deepEqual([...denied.keys()].sort(), [hash(2), hash(3)].sort(), "批量判据只挑出别人的");
	}

	// ============================================================
	// 3. 守卫：没有声明 / 读不到 / 读到，三种结论必须分得开
	// ============================================================
	{
		// 3a. ⭐ 一份声明都没有 ⇒ `no-declaration`，不是"没人引用"
		const empty = createSharedBucketGuard({ io: fakeIo(), self: { vault: "v1", device: "d1" } });
		const none = await empty.begin();
		assert.equal(none.ok, false, "★ 没有声明就不出候选（首次使用 / 别的设备都是旧版）");
		assert.equal(none.reason, "no-declaration", "原因要说成「没有可用的声明」而非「没人引用」");

		// 3b. 读失败 ⇒ `failed`，并把原始错误带出来
		const broken = createSharedBucketGuard({
			io: fakeIo([fileOf("v1", "d1", "head.json", { [hash(1)]: ref("a.png") })], { list: "403 Forbidden" }),
			self: { vault: "v1", device: "d1" },
		});
		const failed = await broken.begin();
		assert.equal(failed.ok, false, "★ 读不到声明不能判");
		assert.equal(failed.reason, "failed", "原因分类是 failed");
		assert.equal(failed.detail.includes("403"), true, "要能看出是权限问题");

		// 3c. 读到别人的声明 ⇒ 该 hash 被否决
		const io = fakeIo([
			fileOf("v1", "d1", "head.json", { [hash(1)]: ref("a.png") }),
			fileOf("v1", "d2", "head.json", { [hash(2)]: ref("b.png") }),
		]);
		const guard = createSharedBucketGuard({ io, self: { vault: "v1", device: "d1" } });
		const started = await guard.begin();
		assert.equal(started.ok, true, "有声明 ⇒ 可以判");
		assert.equal(started.isDenied(hash(1)), false, "只有自己引用 ⇒ 不被否决");
		assert.equal(started.isDenied(hash(2)), true, "★ 别的设备引用着 ⇒ 否决");
		assert.deepEqual(
			started.occupantsOf(hash(2)).map((who) => who.device),
			["d2"],
			"要能说出是谁占着（汇报里给出设备与时间）"
		);
		assert.equal(started.declarationCount, 2, "顺带报出读了几份声明");
	}

	// ============================================================
	// 4. 检查点：声明被人改过就必须喊停
	// ============================================================
	{
		const io = fakeIo([fileOf("v1", "d2", "head.json", { [hash(2)]: ref("b.png") })]);
		const guard = createSharedBucketGuard({ io, self: { vault: "v1", device: "d1" } });
		await guard.begin();

		assert.equal(await guard.checkpoint(), "same", "没人动 ⇒ same（否则整批都会被莫名其妙掐掉）");

		// 别的设备在删除期间新增了一条引用
		io.files.set(
			"_acc/v1/v1/d2/seg-0001.json",
			{ text: JSON.stringify(decl("v1", "d2", { [hash(5)]: ref("e.png") })), lastModified: "2026-10-25T11:00:00.000Z" }
		);
		assert.equal(await guard.checkpoint(), "changed", "★ 声明集合变了 ⇒ changed（停剩余批次）");

		const failing = fakeIo([fileOf("v1", "d2", "head.json", { [hash(2)]: ref("b.png") })]);
		const guard2 = createSharedBucketGuard({ io: failing, self: { vault: "v1", device: "d1" } });
		await guard2.begin();
		failing.list = async () => {
			throw new Error("ETIMEDOUT");
		};
		assert.equal(await guard2.checkpoint(), "failed", "★ 重算失败也要停（宁停不误删）");
	}

	// ============================================================
	// 5. 声明写入：先读现状、再写；读不到就不写
	// ============================================================
	{
		const self = { vault: "v1", device: "d1" };
		const now = () => new Date("2026-10-25T08:00:00.000Z");

		// 5a. 首次写：head 建起来
		const fresh = fakeIo();
		const first = await declareRefs({ io: fresh, self, now }, { [hash(1)]: ref("a.png") });
		assert.equal(first.ok, true, "空桶也能写（首份声明）");
		assert.deepEqual(
			fresh.ops.map(([, key]) => key),
			["_acc/v1/v1/d1/head.json"],
			"首份声明写到 head"
		);
		const written = JSON.parse(fresh.files.get("_acc/v1/v1/d1/head.json").text);
		assert.equal(Object.keys(written.refs).length, 1, "引用真的进去了");
		assert.equal(written.refs[hash(1)].name, "a.png", "显示名要记住（共享桶下 key 里可能没有名字）");
		assert.equal(written.updatedAt, "2026-10-25T08:00:00.000Z", "时间用注入的时钟");

		// 5b. 减引用：幂等（本来就没有也不报错）
		const second = await declareRefs({ io: fresh, self, now }, {}, [hash(9)]);
		assert.equal(second.ok, true, "减一个不存在的引用必须幂等");
		assert.equal(Object.keys(JSON.parse(fresh.files.get("_acc/v1/v1/d1/head.json").text).refs).length, 1, "别的引用不受影响");

		// 5c. ⭐ 读不到现状 ⇒ 不写（退化成"空现状"会覆盖已有引用）
		const unreadable = fakeIo([], { list: "403" });
		const refused = await declareRefs({ io: unreadable, self, now }, { [hash(1)]: ref("a.png") });
		assert.equal(refused.ok, false, "★ 读不到现状必须拒绝写");
		assert.equal(refused.reason, "read-failed", "原因要说成「读不到」，不是「写失败」");
		assert.equal(unreadable.ops.length, 0, "一个写动作都不许发生");

		// 5d. 写失败 ⇒ 如实回报（调用方据此中止本批上传）
		const failing = fakeIo([], { put: "500 InternalError" });
		const wrote = await declareRefs({ io: failing, self, now }, { [hash(1)]: ref("a.png") });
		assert.equal(wrote.ok, false, "★ 写失败必须让调用方中止本批");
		assert.equal(wrote.reason, "write-failed", "原因分类是 write-failed");
		assert.equal(wrote.detail.includes("500"), true, "原始错误要带出来");

		// 5e. id 不合法 ⇒ 也走 write-failed（绝静默不写）
		const bad = await declareRefs({ io: fakeIo(), self: { vault: "..", device: "d1" }, now }, { [hash(1)]: ref("a.png") });
		assert.equal(bad.ok, false, "★ id 不合法要失败（静默不写＝这一批对象没有保护）");
	}

	return { cases: 5 };
}
