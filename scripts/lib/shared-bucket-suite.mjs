/**
 * 「共享桶的跨库判据」套件（`src/maintenance/shared-bucket.ts`）。
 *
 * 这一层管的是**能不能删别人的东西**，以及**声明还准不准**（引用对账）。两组断言都按"错了会怎样"命名：
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
	const {
		occupancyOf,
		occupantsOtherThan,
		occupiedByOthers,
		createSharedBucketGuard,
		declareRefs,
		diffReferences,
		renameReference,
	} = mod;

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

	// ============================================================
	// 6. 引用对账：补上新引用、摘掉没引用的、改名只改名字
	// ============================================================
	{
		const a = "a".repeat(64);
		const b = "b".repeat(64);
		const c = "c".repeat(64);
		const now = "2026-10-25T12:00:00.000Z";
		const declared = new Map([
			[a, { name: "a.png", ext: "png", addedAt: "2026-10-01T00:00:00.000Z" }],
			[b, { name: "b.png", ext: "png", addedAt: "2026-10-02T00:00:00.000Z" }],
		]);

		// 6a. 引用集合里少了 b ⇒ 摘掉；多了 c ⇒ 补上；a 原样不动
		{
			const sync = diffReferences([`a-${a}.png`, `c-${c}.pdf`], declared, now);
			assert.equal(sync.removes.includes(a), false, "★ 仍在引用里的不该被摘（摘了它就失去保护，别的设备会删掉它）");
			assert.deepEqual(sync.removes, [b], "★ 声明里有、引用里没有 ⇒ 必须摘（否则永远替它做保护）");
			assert.equal(a in sync.adds, false, "★ 没变化的条目不该重写（每次对账都重写 = 写放大，addedAt 也会漂）");
			assert.equal(Object.keys(sync.adds).length, 1, "只补新的那条");
			assert.equal(sync.adds[c].name, "c.pdf", "名字从 key 反推（共享桶下 key 里可能没有名字）");
			assert.equal(sync.adds[c].ext, "pdf", "扩展名也要记");
			assert.equal(sync.adds[c].addedAt, now, "新条目用当前时间");
		}

		// 6b. 改名：只改 name，`addedAt` 必须保留（那是封存切块的排序依据）
		{
			const renamed = diffReferences([`新名字-${a}.png`], new Map([[a, declared.get(a)]]), now);
			assert.equal(renamed.adds[a].name, "新名字.png", "名字要跟着改");
			assert.equal(renamed.adds[a].addedAt, "2026-10-01T00:00:00.000Z", "★ addedAt 不许因为改名而变（否则封存顺序漂移）");
			assert.deepEqual(renamed.removes, [], "同一个 hash 还在引用里 ⇒ 不摘");
		}

		// 6c. 认不出哈希的老 key ⇒ 跳过，不猜
		{
			const sync = diffReferences(["legacy-object.png"], new Map(), now);
			assert.deepEqual(Object.keys(sync.adds), [], "★ 认不出身份就不写（猜出来的 hash 会让清理判错）");
			assert.deepEqual(sync.removes, [], "也不因此摘掉任何东西");
		}

		// 6d. 两个方向同时发生 ⇒ 一次调用里都带上（`planUpdates` 一次写完）
		{
			const sync = diffReferences([`c-${c}.png`], declared, now);
			assert.deepEqual(sync.removes.sort(), [a, b].sort(), "两条都摘掉");
			assert.equal(Object.keys(sync.adds).length, 1, "补一条");
		}
	}

	// ============================================================
	// 7. 改名只改 `name`，`addedAt` 必须沿用（CR-16）
	// ============================================================
	{
		const target = hash(7);
		const io = fakeIo([
			fileOf("v1", "d1", "head.json", { [target]: ref("旧名字.png", "2026-10-01T00:00:00.000Z") }),
		]);
		const out = await renameReference({ io, self: { vault: "v1", device: "d1" }, hash: target, name: "新名字.png", ext: "png" });
		assert.equal(out, "renamed", "改名言明就是 renamed");
		const put = io.ops.find((op) => op[0] === "put");
		assert.ok(put, "真的重写了声明");
		const written = JSON.parse(io.files.get(put[1]).text);
		assert.equal(written.refs[target].name, "新名字.png", "名字改了");
		assert.equal(
			written.refs[target].addedAt,
			"2026-10-01T00:00:00.000Z",
			"★★ addedAt 不许因为改名而变（它是封存切块的排序依据）"
		);

		// 声明里没有这个 hash ⇒ absent（那是"本地有、云端没记"，不归改名管）
		const absent = await renameReference({ io, self: { vault: "v1", device: "d1" }, hash: hash(8), name: "x.png", ext: "png" });
		assert.equal(absent, "absent", "没这条 ⇒ absent，调用方不该把它塞进待补队列");
	}

	return { cases: 7 };
}
