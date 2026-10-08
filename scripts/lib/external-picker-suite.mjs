/**
 * 「选择要缓存的外链图片」纯逻辑（`src/ui/external-picker-logic.ts`）的断言套件。
 *
 * ## 这里只断言**清单与勾选**，不断言弹窗
 *
 * 弹窗那一层（`external-picker-modal.ts`）在 Node 里点不了（宿主的 `Modal` 没有
 * 可编程 DOM），它靠真机探针验证。而"哪几行会出现、勾选怎么算"能穷举，
 * 也正是最容易错又不报错的地方 —— 所以全部放这里。
 *
 * 最要命的一条：**同一张图出现在两篇笔记里必须是两个条目**。
 * 合成一条的后果是其中一篇的链接没被改写（图进了存储、笔记还指着别人的服务器），
 * 而用户以为自己勾过了。
 */

import assert from "node:assert/strict";

export function runExternalPickerSuite(mod) {
	const { pickKey, buildPickItems, toggleSelection, selectEverything } = mod;

	const candidate = (url, notePath, host = "a.example.net") => ({ url, notePath, host });

	// ============================================================
	// 1. ⭐ 勾选的单位 = 笔记 + 地址
	// ============================================================
	{
		const a = pickKey({ url: "https://a.example.net/x.png", notePath: "notes/one.md" });
		const b = pickKey({ url: "https://a.example.net/x.png", notePath: "notes/two.md" });
		assert.notEqual(a, b, "★ 同一张图在两篇笔记里必须是两个键（否则其中一篇不会被处理）");
		assert.equal(a, pickKey({ url: "https://a.example.net/x.png", notePath: "notes/one.md" }), "同样的输入给同样的键");

		// 首尾空白不改变身份（候选那边也可能带着空白）
		assert.equal(
			pickKey({ url: "  https://a.example.net/x.png  ", notePath: " notes/one.md " }),
			a,
			"首尾空白要忽略"
		);

		// 药丸输入不抛错
		for (const bad of [null, undefined, {}, { url: 42 }, { url: "x" }]) {
			assert.equal(typeof pickKey(bad), "string", `奇怪输入要返回字符串：${JSON.stringify(bad)}`);
		}
		assert.notEqual(pickKey({ url: "x" }), pickKey({ notePath: "x" }), "只有地址、或只有路径的键不能撞成同一个");
	}

	// ============================================================
	// 2. buildPickItems：去重、丢坏条目、保持顺序
	// ============================================================
	{
		const items = buildPickItems([
			candidate("https://a.example.net/1.png", "notes/one.md"),
			candidate("https://a.example.net/1.png", "notes/two.md"),
			candidate("https://b.example.net/2.png", "notes/one.md", "b.example.net"),
		]);
		assert.equal(items.length, 3, "★ 三张图（其中两张同地址不同笔记）应当有三行");
		assert.deepEqual(
			items.map((item) => item.notePath),
			["notes/one.md", "notes/two.md", "notes/one.md"],
			"保持调用方给的顺序（命令那条链已按笔记分组）"
		);
		assert.equal(items[1].url, "https://a.example.net/1.png", "第二条是另一篇笔记里的同一张图");
		assert.equal(items[2].host, "b.example.net", "主机名要带上（清单里要显示）");
	}

	// 同一个"笔记 + 地址"重复出现 → 只留一行（防御性：候选链本该已经去过重）
	{
		const items = buildPickItems([
			candidate("https://a.example.net/1.png", "notes/one.md"),
			candidate("https://a.example.net/1.png", "notes/one.md"),
		]);
		assert.equal(items.length, 1, "★ 完全相同的条目只该出现一次（否则全选会提交两条一样的）");
	}

	// 缺字段的条目要丢掉（否则清单里会出现一行点不动、也提交不了的幽灵）
	for (const [label, list] of [
		["缺地址", [candidate("", "notes/one.md")]],
		["缺笔记", [candidate("https://a.example.net/1.png", "")]],
		["地址不是字符串", [{ url: 42, notePath: "notes/one.md" }]],
		["空列表", []],
		["null", null],
		["undefined", undefined],
	]) {
		assert.deepEqual(buildPickItems(list), [], `${label}：没有可用条目时应返回空清单`);
	}

	// ============================================================
	// 3. toggleSelection：不可变、非字符串键不生效
	// ============================================================
	{
		const items = buildPickItems([
			candidate("https://a.example.net/1.png", "notes/one.md"),
			candidate("https://a.example.net/2.png", "notes/one.md"),
		]);
		const first = items[0].key;
		const second = items[1].key;

		const empty = new Set();
		const one = toggleSelection(empty, first);
		assert.equal(one.has(first), true, "切换应勾上它");
		assert.equal(empty.size, 0, "★ 返回新的集合，不改原集合（改动调用方的东西会让状态有两个来源）");

		const two = toggleSelection(one, first);
		assert.equal(two.has(first), false, "再切一次应当取消勾选");
		assert.equal(one.has(first), true, "原集合不受影响");

		const both = toggleSelection(two, second);
		assert.equal(both.has(first), false, "取消勾选的那个保持取消");
		assert.equal(both.has(second), true, "另一个仍然勾着");

		for (const bad of ["", null, undefined, 42, {}]) {
			const unchanged = toggleSelection(one, bad);
			assert.equal(unchanged.has(first), true, `奇怪键不该改变选择：${JSON.stringify(bad)}`);
			assert.equal(unchanged.size, 1, `奇怪键不该增删条目：${JSON.stringify(bad)}`);
		}
	}

	// ============================================================
	// 4. selectEverything：勾**清单里每一行**，不多不少
	// ============================================================
	{
		const items = buildPickItems([
			candidate("https://a.example.net/1.png", "notes/one.md"),
			candidate("https://a.example.net/2.png", "notes/two.md"),
			candidate("https://b.example.net/3.png", "notes/three.md", "b.example.net"),
		]);
		const all = selectEverything(items);
		assert.equal(all.size, 3, "★ 全选要勾上清单里每一行");
		for (const item of items) assert.equal(all.has(item.key), true, `漏了：${item.key}`);

		assert.equal(selectEverything([]).size, 0, "空清单全选之后还是空的");
	}
}
